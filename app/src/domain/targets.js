'use strict';
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const periods = require('../periods');
const kpiEngine = require('../kpi_engine');
const { need, bad, forbidden, notFound, conflict, nowIso, setting } = require('../util');

const METRIC_AR = { revenue: 'الإيرادات', gross_profit: 'مجمل الربح', gross_margin: 'هامش الربح الإجمالي', ebitda: 'EBITDA', collection: 'التحصيل', expenses: 'المصروفات', budget: 'الموازنة', budget_variance: 'انحراف الموازنة', cash_flow: 'Cash Flow', receivables: 'الذمم المدينة', inventory: 'المخزون', custom: 'مؤشر مخصص' };

const canSeeFin = u => !u.isAdmin && (u.isExec || u.isHR || (rbac.isManagerRole(u) && u.rank >= 3) || rbac.has(u, 'kpi_owner'));
const visibleOrg = (u, orgId) => u.isExec || u.isHR || rbac.inScope(u, orgId) || u.lineageIds.includes(orgId);
const canEditFin = (u, orgId) => !u.isAdmin && (u.isExec || u.isHR || (rbac.has(u, 'business_unit_manager', 'department_manager', 'kpi_owner') && rbac.inScope(u, orgId)));

function fxRate(cur) { if (!cur) return 1; const r = db.get('SELECT rate_to_base FROM fx_rates WHERE currency = ?', cur); return r ? r.rate_to_base : null; }
function calc(r) {
  const has = r.actual !== null && r.actual !== undefined;
  const variance = has ? r.actual - r.target : null;
  let ach = null;
  if (has && r.target) ach = r.lower_is_better ? (r.actual <= 0 ? 150 : r.target / r.actual * 100) : r.actual / r.target * 100;
  ach = ach === null ? null : Math.round(Math.min(ach, 200) * 10) / 10;
  const thr = setting('fin_variance_threshold_pct', 10);     // قيمة تجريبية قابلة للضبط
  const varPct = has && r.target ? Math.round((variance / Math.abs(r.target)) * 1000) / 10 : null;
  const adverse = has && (r.lower_is_better ? variance > 0 : variance < 0);
  return { variance, variance_pct: varPct, achievement: ach, major: adverse && varPct !== null && Math.abs(varPct) >= thr, adverse };
}
function row(r) {
  const base = setting('base_currency', 'EGP'); const fx = fxRate(r.currency);
  return { ...r, ...calc(r), metric_ar: METRIC_AR[r.metric], org_name: rbac.orgs().get(r.org_unit_id)?.name, base_currency: base, fx_rate: fx, target_base: fx ? r.target * fx : null, actual_base: fx && r.actual !== null ? r.actual * fx : null };
}

H.get('/api/targets', ({ user, query }) => {
  if (!canSeeFin(user)) throw forbidden('الأهداف المالية متاحة للمديرين فأعلى.');
  const w = []; const p = [];
  if (query.period) { w.push('period_key = ?'); p.push(query.period); }
  if (query.metric) { w.push('metric = ?'); p.push(query.metric); }
  if (query.org_id) { const ids = rbac.subtree(Number(query.org_id)); w.push(`org_unit_id IN (${ids.join(',')})`); }
  const rows = db.all(`SELECT * FROM financial_targets ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY period_start DESC, metric LIMIT 500`, ...p).filter(r => visibleOrg(user, r.org_unit_id));
  return { total: rows.length, items: rows.map(row), metrics: METRIC_AR };
});
H.get('/api/targets/periods', ({ user }) => {
  if (!canSeeFin(user)) throw forbidden();
  return db.all('SELECT DISTINCT period_key, period_start FROM financial_targets ORDER BY period_start DESC LIMIT 24').map(r => r.period_key);
});
const SPEC = { metric: 'enum:req:revenue|gross_profit|gross_margin|ebitda|collection|expenses|budget|budget_variance|cash_flow|receivables|inventory|custom', label: 'str:req', org_unit_id: 'int:req', period_key: 'str:req', currency: 'str', target: 'num:req', actual: 'num', lower_is_better: 'bool', data_source: 'enum:opt:manual|odoo|spreadsheet|api|calculated|other', related_kpi_id: 'int' };
function guardPeriod(key) { kpiEngine.assertPeriodEditable(key); }
H.post('/api/targets', ({ user, body }) => createTarget(user, body));
function createTarget(user, body) {
  const d = need({ currency: setting('base_currency', 'EGP'), data_source: 'manual', lower_is_better: false, ...body }, SPEC);
  const p = periods.parseKey(d.period_key); if (!p) throw bad('الفترة غير صحيحة (مثال: 2026-09 أو 2026-Q3).', { period_key: 'غير صحيحة' });
  if (!canEditFin(user, d.org_unit_id)) throw forbidden();
  if (!rbac.orgs().has(d.org_unit_id)) throw bad('الوحدة غير موجودة.');
  if (fxRate(d.currency) === null) throw bad('العملة غير معرّفة في أسعار الصرف.', { currency: 'غير معروفة' });
  guardPeriod(d.period_key);
  if (db.get('SELECT 1 x FROM financial_targets WHERE metric = ? AND label = ? AND org_unit_id = ? AND period_key = ?', d.metric, d.label, d.org_unit_id, d.period_key)) throw conflict('يوجد هدف بنفس المقياس والوحدة والفترة.', 'DUPLICATE');
  const id = db.insert('financial_targets', { ...d, period_start: p.start, period_end: p.end, data_quality: d.actual === null ? 'missing' : 'draft', updated_by: user.id, created_at: nowIso(), updated_at: nowIso() });
  audit.log(user.id, 'financial_target', id, 'create', 'target', null, d.target);
  return { id };
}
H.put('/api/targets/:id', ({ user, params, body }) => {
  const t = db.get('SELECT * FROM financial_targets WHERE id = ?', params.id);
  if (!t || !visibleOrg(user, t.org_unit_id) || !canSeeFin(user)) throw notFound();
  if (!canEditFin(user, t.org_unit_id)) throw forbidden();
  guardPeriod(t.period_key);
  const d = need({ ...t, ...body }, { target: 'num:req', actual: 'num', data_source: 'enum:opt:manual|odoo|spreadsheet|api|calculated|other' });
  if (['verified', 'approved'].includes(t.data_quality) && !body.reason) throw bad('البيانات موثّقة/معتمدة. اذكر سبب التعديل.', { reason: 'مطلوب' });
  const upd = { target: d.target, actual: d.actual, data_source: d.data_source, data_quality: d.actual === null ? 'missing' : (body.data_quality && ['submitted', 'verified', 'approved'].includes(body.data_quality) ? body.data_quality : 'draft'), updated_by: user.id, updated_at: nowIso() };
  audit.diff(user.id, 'financial_target', t.id, t, upd, ['target', 'actual', 'data_source'], body.reason);
  db.update('financial_targets', t.id, upd);
  return { ok: true };
});
H.post('/api/targets/:id/:action', ({ user, params, body }) => {
  const t = db.get('SELECT * FROM financial_targets WHERE id = ?', params.id);
  if (!t || !canSeeFin(user) || !visibleOrg(user, t.org_unit_id)) throw notFound();
  if (!canEditFin(user, t.org_unit_id)) throw forbidden();
  guardPeriod(t.period_key);
  const map = { submit: ['draft', 'submitted'], verify: ['submitted', 'verified'], approve: ['verified', 'approved'] };
  const m = map[params.action]; if (!m) throw notFound();
  if (t.actual === null) throw conflict('لا توجد قيمة فعلية.');
  if (t.data_quality !== m[0]) throw conflict(`الإجراء متاح عندما تكون الحالة ${m[0]}.`);
  if (params.action !== 'submit' && t.updated_by === user.id && !user.isExec) throw forbidden('يلزم شخص آخر للتحقق/الاعتماد (فصل المهام).');
  audit.log(user.id, 'financial_target', t.id, params.action, 'data_quality', t.data_quality, m[1]);
  db.update('financial_targets', t.id, { data_quality: m[1], updated_at: nowIso() });
  return { ok: true };
});
// ملخص لفترة، مجمّع بالعملة الأساسية لكل مقياس
H.get('/api/targets-summary', ({ user, query }) => {
  if (!canSeeFin(user)) throw forbidden();
  const key = query.period; if (!key) throw bad('حدد الفترة.');
  const rows = db.all('SELECT * FROM financial_targets WHERE period_key = ?', key).filter(r => visibleOrg(user, r.org_unit_id));
  const byMetric = {};
  for (const r of rows) {
    const x = row(r); if (x.fx_rate === null) continue;
    const g = byMetric[r.metric] ||= { metric: r.metric, metric_ar: METRIC_AR[r.metric], target: 0, actual: 0, n: 0, missing: 0, lower_is_better: r.lower_is_better, currency_mixed: false };
    if (r.metric === 'gross_margin') { g.target = g.target * g.n + r.target; g.actual = r.actual === null ? g.actual : g.actual * g.n + r.actual; g.n++; g.target /= g.n; g.actual /= g.n; continue; }
    g.target += x.target_base; if (r.actual === null) g.missing++; else g.actual += x.actual_base; g.n++;
  }
  return Object.values(byMetric).map(g => ({ ...g, ...calc({ target: g.target, actual: g.missing === g.n ? null : g.actual, lower_is_better: g.lower_is_better }), base_currency: setting('base_currency', 'EGP') }));
});

module.exports = { createTarget, calc, row, canSeeFin, visibleOrg, METRIC_AR };
