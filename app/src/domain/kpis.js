'use strict';
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const notify = require('../notify');
const engine = require('../kpi_engine');
const periods = require('../periods');
const { need, bad, forbidden, notFound, conflict, nowIso, today, addDays, setting, pick } = require('../util');

const CAT_AR = { financial: 'مالي', operational: 'تشغيلي', strategic: 'استراتيجي' };
const TYPE_AR = { higher_better: 'الأعلى أفضل', lower_better: 'الأقل أفضل', target_range: 'نطاق مستهدف', exact_target: 'قيمة محددة', milestone: 'معالم (Milestone)', boolean: 'نعم/لا', formula: 'معادلة (Formula)' };

// أحدث فترة استحق إدخال بياناتها (انتهت وتجاوزت مهلة السماح)
function dueKey(freq, grace = setting('kpi_grace_days', 5)) {
  const f = freq === 'custom' ? 'monthly' : freq;
  let k = periods.keyFor(today(), f);
  while (periods.parseKey(k).end >= addDays(today(), -grace)) k = periods.prevKey(k);
  return k;
}
const orgName = id => rbac.orgs().get(id)?.name || null;
const empName = id => (id ? db.get('SELECT name FROM employees WHERE id = ?', id)?.name : null);

function loadKpi(user, id) {
  const k = db.get('SELECT * FROM kpis WHERE id = ? AND deleted_at IS NULL', id);
  if (!k || !rbac.canSeeKpi(user, k)) throw notFound('المؤشر غير موجود.');
  return k;
}
function canEditDef(user, k) {
  if (user.isAdmin) return false;
  if (k.owner_id === user.id && rbac.has(user, 'kpi_owner')) return true;
  if (user.isExec || user.isHR) return true;
  if (!k.org_unit_id) return false;
  return rbac.has(user, 'business_unit_manager', 'department_manager') && rbac.inScope(user, k.org_unit_id);
}
const canEnterData = (user, k) => !user.isAdmin && ([k.data_owner_id, k.owner_id].includes(user.id) || canEditDef(user, k) || (k.level === 'employee' && k.employee_id === user.id && !k.data_owner_id));
function dto(k, r) {
  return { ...k, category_ar: CAT_AR[k.category], type_ar: TYPE_AR[k.kpi_type], org_name: orgName(k.org_unit_id), employee_name: k.employee_id ? empName(k.employee_id) : null, owner_name: empName(k.owner_id), data_owner_name: empName(k.data_owner_id), reviewer_name: empName(k.reviewer_id),
    result: r || null };
}

H.get('/api/kpis', ({ user, query }) => {
  const w = [rbac.kpiVisibilitySql(user)]; const p = [];
  const eq = (c, v) => { if (v) { w.push(`${c} = ?`); p.push(v); } };
  eq('k.level', query.level); eq('k.category', query.category); eq('k.owner_id', query.owner_id); eq('k.employee_id', query.employee_id);
  if (query.mine === '1') { w.push('(k.owner_id = ? OR k.data_owner_id = ? OR k.employee_id = ?)'); p.push(user.id, user.id, user.id); }
  if (query.org_id) { const ids = rbac.subtree(Number(query.org_id)); w.push(`k.org_unit_id IN (${ids.join(',') || 'NULL'})`); }
  if (query.q) { w.push('(k.name LIKE ? OR k.code LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
  const pk = query.period || null;
  const rows = db.all(`SELECT k.* FROM kpis k WHERE ${w.join(' AND ')} ORDER BY k.level, k.code LIMIT 500`, ...p);
  const out = rows.map(k => {
    const key = pk || dueKey(k.frequency);
    const r = engine.getResult(k.id, key);
    return dto(k, r ? { ...r, period_key: key } : { period_key: key, status: 'missing', data_quality: 'missing', actual: null, target: k.target, achievement: null });
  }).filter(x => !query.status || x.result.status === query.status);
  return { total: out.length, items: out };
});

H.get('/api/kpis/:id', ({ user, params, query }) => {
  const k = loadKpi(user, params.id);
  const hist = db.all('SELECT r.*, e.name updated_by_name FROM kpi_results r LEFT JOIN employees e ON e.id = r.updated_by WHERE r.kpi_id = ? ORDER BY r.period_start DESC LIMIT 36', k.id);
  const key = query.period || dueKey(k.frequency);
  const vis = rows => rows.filter(r => { const kk = db.get('SELECT * FROM kpis WHERE id = ?', r.id); return rbac.canSeeKpi(user, kk); });
  return {
    ...dto(k, engine.getResult(k.id, key)), current_period: key, history: hist.reverse(),
    parent: k.parent_kpi_id ? db.get('SELECT id, code, name FROM kpis WHERE id = ?', k.parent_kpi_id) : null,
    children: vis(db.all('SELECT id, code, name, level, org_unit_id, employee_id FROM kpis WHERE parent_kpi_id = ? AND deleted_at IS NULL', k.id)).map(c => ({ ...c, org_name: orgName(c.org_unit_id), result: engine.getResult(c.id, key) })),
    tasks: db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.progress, o.name owner_name FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.kpi_id = ? AND ${rbac.taskVisibilitySql(user)} ORDER BY t.due_date`, k.id),
    meetings: db.all(`SELECT DISTINCT m.id, m.code, m.title, m.meeting_date, m.status FROM agenda_items a JOIN meetings m ON m.id = a.meeting_id WHERE a.related_kpi_id = ? AND ${rbac.meetingVisibilitySql(user)} ORDER BY m.meeting_date DESC`, k.id),
    initiatives: db.all(`SELECT i.id, i.code, i.title, i.status FROM initiative_kpis ik JOIN initiatives i ON i.id = ik.initiative_id WHERE ik.kpi_id = ? AND ${rbac.initiativeVisibilitySql(user)}`, k.id),
    can_edit: canEditDef(user, k), can_enter: canEnterData(user, k),
    can_verify: !user.isAdmin && (k.reviewer_id === user.id || canEditDef(user, k)),
  };
});

const SPEC = {
  code: 'str:req', name: 'str:req', description: 'str', category: 'enum:req:financial|operational|strategic', level: 'enum:req:group|company|business_unit|department|team|employee',
  org_unit_id: 'int', employee_id: 'int', owner_id: 'int:req', data_owner_id: 'int', reviewer_id: 'int', unit: 'str', currency: 'str',
  frequency: 'enum:req:weekly|monthly|quarterly|annual|custom', kpi_type: 'enum:req:higher_better|lower_better|target_range|exact_target|milestone|boolean|formula',
  baseline: 'num', target: 'num', range_min: 'num', range_max: 'num', formula: 'str', data_source: 'enum:opt:manual|odoo|spreadsheet|api|calculated|other', direction: 'enum:opt:higher|lower',
  weight: 'num', green_min: 'num', amber_min: 'num', cascade_type: 'enum:opt:cascaded|shared|independent', parent_kpi_id: 'int', rollup: 'enum:opt:sum|avg',
  effective_from: 'date', effective_to: 'date', approval_status: 'enum:opt:draft|submitted|approved|retired',
};
const AUDITED = ['target', 'formula', 'weight', 'owner_id', 'green_min', 'amber_min', 'kpi_type', 'range_min', 'range_max', 'data_owner_id', 'reviewer_id'];
function checkKpi(d, id) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(d.code)) throw bad('رمز KPI يتكون من أحرف إنجليزية كبيرة وأرقام و _ ويبدأ بحرف.', { code: 'صيغة غير صحيحة' });
  if (db.get('SELECT 1 x FROM kpis WHERE code = ? AND id <> ?', d.code, id || 0)) throw conflict('رمز KPI مستخدم بالفعل.', 'DUPLICATE');
  if (d.level === 'employee' ? !d.employee_id : !d.org_unit_id) throw bad(d.level === 'employee' ? 'اختر الموظف المرتبط بالمؤشر.' : 'اختر الوحدة التنظيمية.');
  if (d.effective_from && d.effective_to && d.effective_from > d.effective_to) throw bad('تاريخ بداية السريان بعد تاريخ نهايته.');
  if (d.parent_kpi_id && !db.get('SELECT 1 x FROM kpis WHERE id = ?', d.parent_kpi_id)) throw bad('المؤشر الأب غير موجود.');
  if (d.parent_kpi_id && d.parent_kpi_id === id) throw bad('المؤشر لا يمكن أن يكون أبًا لنفسه.');
  engine.validateKpi(d);
}
H.post('/api/kpis', ({ user, body }) => createKpi(user, body));
function createKpi(user, body) {
  if (!(user.isExec || user.isHR || rbac.has(user, 'business_unit_manager', 'department_manager', 'kpi_owner'))) throw forbidden();
  const d = need({ unit: '', frequency: 'monthly', data_source: 'manual', weight: 1, green_min: 100, amber_min: 85, cascade_type: 'independent', direction: 'higher', approval_status: 'approved', ...body }, SPEC);
  checkKpi(d);
  if (d.org_unit_id && !(user.isExec || user.isHR || rbac.inScope(user, d.org_unit_id))) throw forbidden('لا تملك نطاقًا على هذه الوحدة.');
  if (d.kpi_type === 'formula') d.data_source = 'calculated';
  const id = db.insert('kpis', { ...d, created_at: nowIso(), updated_at: nowIso() });
  audit.log(user.id, 'kpi', id, 'create', 'code', null, d.code);
  return { id };
}
H.put('/api/kpis/:id', ({ user, params, body }) => {
  const k = loadKpi(user, params.id);
  if (!canEditDef(user, k)) throw forbidden('تعديل تعريف المؤشر لمالكه أو لمدير ضمن النطاق.');
  const d = need({ ...k, ...body }, SPEC); checkKpi(d, k.id);
  if (d.kpi_type === 'formula') d.data_source = 'calculated';
  audit.diff(user.id, 'kpi', k.id, k, d, AUDITED, body.reason);
  db.update('kpis', k.id, { ...d, updated_at: nowIso() });
  return { ok: true };
});

// ---- النتائج ----
function loadForResult(user, id, period) {
  const k = loadKpi(user, id);
  if (!periods.parseKey(period)) throw bad('فترة غير صحيحة.');
  return k;
}
H.put('/api/kpis/:id/results/:period', ({ user, params, body }) => {
  const k = loadForResult(user, params.id, params.period);
  if (!canEnterData(user, k)) throw forbidden('إدخال البيانات لمالك البيانات (Data Owner) أو مدير ضمن النطاق.');
  const cur = engine.getResult(k.id, params.period);
  if (cur && ['verified', 'approved'].includes(cur.data_quality) && !body.reason) throw bad('البيانات معتمدة/موثّقة. اذكر سبب التعديل (سيعود الحالة إلى Draft).', { reason: 'مطلوب' });
  const r = engine.saveActual(user, k, params.period, { actual: body.actual === '' ? null : body.actual, target: body.target, note: body.note || body.reason, evidence: body.evidence });
  return r;
});
H.post('/api/kpis/:id/results/:period/:action', ({ user, params, body }) => {
  const k = loadForResult(user, params.id, params.period);
  const r = engine.getResult(k.id, params.period);
  if (!r || r.actual === null) throw conflict('لا توجد بيانات فعلية لهذه الفترة.');
  engine.assertPeriodEditable(params.period);
  const a = params.action;
  db.tx(() => {
    let to;
    if (a === 'submit') {
      if (!canEnterData(user, k)) throw forbidden();
      if (r.data_quality !== 'draft') throw conflict('الإرسال متاح للبيانات في حالة Draft فقط.'); to = 'submitted';
      if (k.reviewer_id) notify.send(k.reviewer_id, 'review_required', `بيانات KPI بانتظار التحقق: ${k.name}`, params.period, `#/kpis/${k.id}`, `kpirev:${k.id}:${params.period}`);
    } else if (a === 'verify') {
      if (!(k.reviewer_id === user.id || canEditDef(user, k))) throw forbidden('التحقق للمراجع المحدد.');
      if (r.updated_by === user.id && k.reviewer_id !== user.id && !user.isExec) throw forbidden('لا يمكن التحقق من بيانات أدخلتها بنفسك.');
      if (r.data_quality !== 'submitted') throw conflict('التحقق متاح للبيانات المرسلة فقط.'); to = 'verified';
    } else if (a === 'approve') {
      if (!(k.owner_id === user.id || user.isExec)) throw forbidden('الاعتماد لمالك المؤشر أو الإدارة التنفيذية.');
      if (r.data_quality !== 'verified') throw conflict('الاعتماد متاح للبيانات الموثّقة (Verified) فقط.'); to = 'approved';
    } else if (a === 'return') {
      if (!(k.reviewer_id === user.id || canEditDef(user, k))) throw forbidden();
      if (!body.reason) throw bad('سبب الإرجاع مطلوب.', { reason: 'مطلوب' }); to = 'draft';
      notify.send(k.data_owner_id || k.owner_id, 'kpi_update_required', `أُعيدت بيانات KPI للتعديل: ${k.name}`, body.reason, `#/kpis/${k.id}`);
    } else throw notFound();
    db.update('kpi_results', r.id, { data_quality: to, verified_by: to === 'verified' ? user.id : r.verified_by, updated_at: nowIso() });
    audit.log(user.id, 'kpi_result', r.id, a, 'data_quality', r.data_quality, to, body.reason || null);
    if (to === 'approved' && r.status === 'red') notify.send(k.owner_id, 'kpi_red', `KPI أحمر معتمد: ${k.name}`, `${r.achievement}%`, `#/kpis/${k.id}`, `red:${k.id}:${params.period}`);
  });
  return { ok: true };
});

// مؤشرات بانتظار إدخال بيانات الفترة المستحقة (للمستخدم)
H.get('/api/kpis-pending', ({ user }) => {
  const rows = db.all(`SELECT * FROM kpis WHERE deleted_at IS NULL AND approval_status = 'approved' AND data_source IN ('manual','spreadsheet','api','other') AND kpi_type <> 'formula' AND COALESCE(data_owner_id, owner_id) = ?`, user.id);
  return rows.map(k => { const key = dueKey(k.frequency); const r = engine.getResult(k.id, key); return { k, key, r }; })
    .filter(x => !x.r || x.r.actual === null || x.r.data_quality === 'draft')
    .map(x => ({ id: x.k.id, code: x.k.code, name: x.k.name, period_key: x.key, state: !x.r || x.r.actual === null ? 'missing' : 'draft' }));
});

// ---- فحص أوزان المؤشرات لوحدة ----
H.get('/api/kpis-weights/:org', ({ user, params }) => {
  const org = Number(params.org); if (!(user.isExec || user.isHR || rbac.inScope(user, org))) throw forbidden();
  const rows = db.all(`SELECT category, SUM(weight) w, COUNT(*) n FROM kpis WHERE org_unit_id = ? AND deleted_at IS NULL AND approval_status = 'approved' GROUP BY category`, org);
  return rows;
});

module.exports = { createKpi, canEnterData, dueKey, dto, CAT_AR, TYPE_AR, loadKpi };
