'use strict';
// محرك الأداء: Scorecards بأوزان قابلة للضبط + Snapshots تاريخية + دورة حياة الفترات + التقييم والمعايرة.
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const notify = require('../notify');
const cache = require('../cache');
const periods = require('../periods');
const kpiEngine = require('../kpi_engine');
const { need, bad, forbidden, notFound, conflict, nowIso, today, setting, diffDays, addDays } = require('../util');

const COMPONENTS = {
  kpi_financial: 'مؤشرات مالية', kpi_operational: 'مؤشرات تشغيلية', kpi_strategic: 'مؤشرات استراتيجية',
  tasks: 'المهام', meeting_actions: 'إجراءات الاجتماعات', initiatives: 'المبادرات', manager_assessment: 'تقييم المدير',
};
const DEFAULT_WEIGHTS = { kpi_financial: 20, kpi_operational: 25, kpi_strategic: 10, tasks: 15, meeting_actions: 10, initiatives: 5, manager_assessment: 15 };
const PRIORITY_FACTOR = { low: 0.5, medium: 1, high: 1.5, critical: 2 };
// قيم تجريبية افتراضية (Demo defaults) — تحتاج اعتماد سياسة الشركة قبل الاستخدام الحقيقي
const DEFAULT_BANDS = [[110, 'يتجاوز التوقعات بشكل كبير'], [100, 'يتجاوز التوقعات'], [85, 'يحقق التوقعات'], [70, 'يحتاج إلى تحسين'], [0, 'دون التوقعات']];
const bands = () => setting('rating_bands', DEFAULT_BANDS);
const ratingFor = s => (s === null || s === undefined ? null : (bands().find(([min]) => s >= min) || bands().at(-1))[1]);
const r1 = v => (v === null ? null : Math.round(v * 10) / 10);

function weightsFor(subject) {
  let orgId = subject.type === 'employee' ? db.get('SELECT org_unit_id FROM employees WHERE id = ?', subject.id)?.org_unit_id : subject.id;
  for (const id of rbac.ancestors(orgId)) {
    const c = db.get('SELECT * FROM scorecard_configs WHERE org_unit_id = ?', id);
    if (c) return { weights: JSON.parse(c.weights), source: rbac.orgs().get(id)?.name, config_id: c.id };
  }
  const d = db.get('SELECT * FROM scorecard_configs WHERE org_unit_id IS NULL');
  return d ? { weights: JSON.parse(d.weights), source: 'الافتراضي', config_id: d.id } : { weights: DEFAULT_WEIGHTS, source: 'الافتراضي', config_id: null };
}
function validateWeights(w) {
  const keys = Object.keys(COMPONENTS);
  for (const k of Object.keys(w)) if (!keys.includes(k)) throw bad(`مكوّن غير معروف: ${k}`);
  let sum = 0; for (const k of keys) { const v = Number(w[k] ?? 0); if (!(v >= 0 && v <= 100)) throw bad('كل وزن بين 0 و100.'); sum += v; }
  if (Math.round(sum * 100) / 100 !== 100) throw bad(`مجموع الأوزان يجب أن يساوي 100%. المجموع الحالي ${sum}%.`);
}

function periodRange(key) {
  const p = db.get('SELECT * FROM performance_periods WHERE key = ?', key);
  if (p) return { key, start: p.start_date, end: p.end_date, label: p.label, status: p.status, id: p.id, version: p.version };
  const x = periods.parseKey(key); if (!x) throw bad('فترة غير صحيحة.');
  return { key, start: x.start, end: x.end, label: x.label, status: null, id: null };
}

// --- حساب Scorecard حيّ ---
function computeLive(subject, per) {
  const { weights, source } = weightsFor(subject);
  const cap = setting('score_cap', 120);
  const isEmp = subject.type === 'employee';
  const orgIds = isEmp ? [] : rbac.subtree(subject.id);
  const kpis = db.all(`SELECT * FROM kpis WHERE deleted_at IS NULL AND approval_status = 'approved' AND ${isEmp ? 'employee_id = ?' : `level <> 'employee' AND org_unit_id = ?`}
    AND (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?)`, subject.id, per.end, per.start);
  const kpiRows = kpis.map(k => {
    const rs = db.all('SELECT * FROM kpi_results WHERE kpi_id = ? AND ((period_start >= ? AND period_end <= ?) OR (period_start <= ? AND period_end >= ?)) AND actual IS NOT NULL', k.id, per.start, per.end, per.start, per.end);
    const official = rs.filter(r => kpiEngine.OFFICIAL.has(r.data_quality));
    const use = official.length ? official : [];
    const ach = use.length ? use.reduce((a, r) => a + r.achievement, 0) / use.length : null;
    const last = (use.length ? use : rs).sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
    return {
      id: k.id, code: k.code, name: k.name, category: k.category, weight: k.weight, unit: k.unit,
      target: last ? last.target : k.target, actual: last ? last.actual : null, achievement: ach === null ? null : r1(ach),
      status: ach === null ? 'missing' : kpiEngine.statusFor(k, ach), quality: last ? last.data_quality : 'missing',
      counted: ach !== null, excluded_reason: ach !== null ? null : (rs.length ? 'بيانات غير معتمدة (Draft/Submitted)' : 'لا توجد بيانات'),
    };
  });
  const comps = {};
  for (const cat of ['financial', 'operational', 'strategic']) {
    const rows = kpiRows.filter(k => k.category === cat);
    const counted = rows.filter(k => k.counted && k.weight > 0);
    const wsum = counted.reduce((a, k) => a + k.weight, 0);
    comps[`kpi_${cat}`] = { score: wsum ? r1(counted.reduce((a, k) => a + Math.min(k.achievement, cap) * k.weight, 0) / wsum) : null, detail: { kpis: rows, counted: counted.length, total: rows.length } };
  }
  // المهام وإجراءات الاجتماعات: تُقيَّم المهام التي استحقت داخل الفترة فقط، مع وزن الأولوية
  const owners = isEmp ? [subject.id] : db.all(`SELECT id FROM employees WHERE org_unit_id IN (${orgIds.join(',') || 'NULL'}) AND deleted_at IS NULL`).map(r => r.id);
  const taskRows = owners.length ? db.all(`SELECT id, code, title, source, status, priority, weight, due_date, completed_at, approval_status FROM tasks WHERE deleted_at IS NULL AND status <> 'cancelled' AND due_date >= ? AND due_date <= ? AND owner_id IN (${db.ph(owners)})`, per.start, per.end, ...owners) : [];
  const asOf = today() < per.end ? today() : per.end;
  const scoreTask = t => {
    const done = t.completed_at ? t.completed_at.slice(0, 10) : null;
    if (t.status === 'completed') return done && done <= t.due_date ? 100 : 70;
    if (t.status === 'pending_review') return t.due_date >= asOf ? 85 : 40;
    return t.due_date < asOf ? 0 : null;           // لم يحن موعدها بعد: لا تُحتسب
  };
  const agg = rows => {
    let ws = 0, sc = 0; const st = { total: rows.length, completed: 0, on_time: 0, late: 0, overdue: 0, open: 0 };
    for (const t of rows) {
      const s = scoreTask(t);
      if (t.status === 'completed') { st.completed++; (s === 100 ? st.on_time++ : st.late++); }
      else if (t.due_date < today()) st.overdue++; else st.open++;
      if (s === null) continue; const w = t.weight * PRIORITY_FACTOR[t.priority]; ws += w; sc += s * w;
    }
    return { score: ws ? r1(sc / ws) : null, detail: st };
  };
  comps.tasks = agg(taskRows.filter(t => t.source !== 'meeting'));
  comps.meeting_actions = agg(taskRows.filter(t => t.source === 'meeting'));
  // المبادرات
  const inis = db.all(`SELECT * FROM initiatives WHERE deleted_at IS NULL AND status <> 'cancelled' AND (start_date IS NULL OR start_date <= ?) AND (target_date IS NULL OR target_date >= ? OR status <> 'completed') AND ${isEmp ? 'owner_id = ?' : `org_unit_id IN (${orgIds.join(',') || 'NULL'})`}`, per.end, per.start, ...(isEmp ? [subject.id] : []));
  const iscore = inis.map(i => {
    if (i.status === 'completed') return 100; if (i.status === 'at_risk') return Math.min(50, i.progress);
    const total = i.start_date && i.target_date ? Math.max(diffDays(i.target_date, i.start_date), 1) : 0;
    const exp = total ? Math.max(0, Math.min(100, diffDays(asOf, i.start_date) / total * 100)) : 0;
    return exp <= 0 ? 100 : Math.min(100, i.progress / exp * 100);
  });
  comps.initiatives = { score: iscore.length ? r1(iscore.reduce((a, b) => a + b, 0) / iscore.length) : null, detail: { count: inis.length, items: inis.map(i => ({ id: i.id, code: i.code, title: i.title, status: i.status, progress: i.progress })) } };
  // تقييم المدير (للموظف فقط)
  const asmt = isEmp ? db.get('SELECT a.* FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = ?', per.key, subject.id) : null;
  comps.manager_assessment = { score: asmt && asmt.manager_score !== null ? asmt.manager_score : null, detail: { stage: asmt?.stage || null } };

  const list = Object.keys(COMPONENTS).map(key => ({ key, label: COMPONENTS[key], weight: Number(weights[key] || 0), score: comps[key].score, available: comps[key].score !== null, detail: comps[key].detail }));
  const sys = list.filter(c => c.key !== 'manager_assessment' && c.available && c.weight > 0);
  const sysW = sys.reduce((a, c) => a + c.weight, 0);
  const calculated = sysW ? r1(sys.reduce((a, c) => a + c.score * c.weight, 0) / sysW) : null;
  const all = list.filter(c => c.available && c.weight > 0); const allW = all.reduce((a, c) => a + c.weight, 0);
  const total = allW ? r1(all.reduce((a, c) => a + c.score * c.weight, 0) / allW) : null;
  return {
    subject, period: { key: per.key, label: per.label, start: per.start, end: per.end, status: per.status }, source: 'live', weights_source: source, weights,
    components: list, calculated_score: calculated, manager_score: comps.manager_assessment.score, performance_score: total, suggested_rating: ratingFor(total),
    coverage: { used_weight: allW, total_weight: 100 },
  };
}
function scorecard(subject, key) {
  const per = periodRange(key);
  if (per.status === 'locked' && per.id) {
    const s = db.get(`SELECT * FROM period_snapshots WHERE period_id = ? AND subject_type = ? AND subject_id = ? ORDER BY version DESC LIMIT 1`, per.id, subject.type, subject.id);
    if (s) return { ...JSON.parse(s.payload), source: 'snapshot', snapshot_version: s.version, snapshot_at: s.created_at };
  }
  return cache.memo(`sc:${subject.type}:${subject.id}:${key}`, 20000, () => computeLive(subject, per));
}

// ---------- الصلاحيات ----------
function loadEmp(id) { return db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', id); }
function assertPerfAccess(user, emp) { if (!emp || !rbac.canSeePerformanceOf(user, emp)) throw notFound('الموظف غير موجود.'); }
const orgSubjectType = kind => ({ team: 'team', department: 'department', business_unit: 'business_unit', company: 'company' })[kind];
function assertOrgAccess(user, orgId) {
  const o = rbac.orgs().get(orgId);
  if (!o || !orgSubjectType(o.kind)) throw notFound('الوحدة غير موجودة.');
  if (user.isAdmin) throw forbidden();
  if (!(user.isExec || user.isHR || (rbac.isManagerRole(user) && rbac.inScope(user, orgId)) || (user.rank >= 3 && user.lineageIds.includes(orgId)))) throw forbidden('لا تملك نطاقًا على هذه الوحدة.');
  return o;
}
// الفترة الافتراضية للعرض = آخر فترة شهرية انتهت (لها بيانات كاملة)، وإلا الفترة الجارية
function defaultPeriodKey() {
  const p = db.get(`SELECT key FROM performance_periods WHERE kind = 'monthly' AND end_date < ? ORDER BY start_date DESC LIMIT 1`, today());
  return p ? p.key : periods.keyFor(today(), 'monthly');
}
const sanitizeForEmployee = (sc, asmt) => sc;   // القيم التفصيلية تخص الموظف نفسه

// ---------- نقاط النهاية ----------
H.get('/api/periods', ({ user }) => {
  const rows = db.all('SELECT * FROM performance_periods ORDER BY start_date DESC');
  return rows;
});
function employeePerf(user, id, query) {
  const e = loadEmp(id); assertPerfAccess(user, e);
  const key = query.period || defaultPeriodKey();
  const sc = scorecard({ type: 'employee', id: e.id }, key);
  const prev = periods.prevKey(key); const ps = scorecard({ type: 'employee', id: e.id }, prev);
  const own = e.id === user.id;
  const asmt = db.get(`SELECT a.* FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = ?`, key, e.id);
  const reviewer = rbac.canReviewPerformanceOf(user, e);
  let assessment = null;
  if (asmt) {
    if (reviewer) assessment = { ...asmt };
    else if (own && asmt.stage === 'final_approved') assessment = { stage: asmt.stage, final_rating: asmt.final_rating, manager_score: asmt.manager_score, feedback_for_employee: asmt.feedback_for_employee, development_actions: asmt.development_actions, approved_at: asmt.approved_at };
    else if (own) assessment = { stage: asmt.stage, pending: true };      // لا نكشف تعليقات المدير قبل الاعتماد النهائي
  }
  // الموظف لا يرى درجة المدير قبل الاعتماد النهائي
  const view = own && !reviewer && !(asmt && asmt.stage === 'final_approved') ? { ...sc, manager_score: null, components: sc.components.map(c => c.key === 'manager_assessment' ? { ...c, score: null, available: false } : c), performance_score: sc.calculated_score, suggested_rating: null } : sc;
  return {
    employee: { id: e.id, name: e.name, job_title: e.job_title, org_name: rbac.orgs().get(e.org_unit_id)?.name }, scorecard: view, previous: { key: prev, performance_score: ps.performance_score, calculated_score: ps.calculated_score },
    assessment, can_review: reviewer, history: db.all(`SELECT p.key, p.label, s.performance_score, s.calculated_score, s.rating FROM period_snapshots s JOIN performance_periods p ON p.id = s.period_id WHERE s.subject_type = 'employee' AND s.subject_id = ? AND s.version = (SELECT MAX(version) FROM period_snapshots x WHERE x.period_id = s.period_id AND x.subject_type = s.subject_type AND x.subject_id = s.subject_id) ORDER BY p.start_date`, e.id),
    development: own ? db.all(`SELECT p.label, a.development_actions FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE a.employee_id = ? AND a.stage = 'final_approved' AND a.development_actions IS NOT NULL ORDER BY p.start_date DESC LIMIT 3`, e.id) : null,
  };
}
H.get('/api/performance/employee/:id', ({ user, params, query }) => employeePerf(user, params.id, query));
H.get('/api/performance/me', ({ user, query }) => {
  if (user.isAdmin) throw forbidden('حساب مدير النظام لا يملك بيانات أداء.');
  return employeePerf(user, user.id, query);
});
function orgPerf(user, orgId, query) {
  const o = assertOrgAccess(user, Number(orgId));
  const key = query.period || defaultPeriodKey();
  const sc = scorecard({ type: orgSubjectType(o.kind), id: o.id }, key);
  const prev = periods.prevKey(key);
  const ps = scorecard({ type: orgSubjectType(o.kind), id: o.id }, prev);
  const children = rbac.orgs().get(o.id).children.map(id => rbac.orgs().get(id)).filter(c => orgSubjectType(c.kind) && (user.isExec || user.isHR || rbac.inScope(user, c.id))).map(c => {
    const s = scorecard({ type: orgSubjectType(c.kind), id: c.id }, key);
    return { id: c.id, name: c.name, kind: c.kind, performance_score: s.performance_score, calculated_score: s.calculated_score, components: s.components.map(x => ({ key: x.key, score: x.score })) };
  });
  let employees = [];
  if (o.kind === 'team' || o.kind === 'department') {
    employees = db.all(`SELECT * FROM employees WHERE org_unit_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY name`, o.id).filter(e => rbac.canReviewPerformanceOf(user, e)).map(e => {
      const s = scorecard({ type: 'employee', id: e.id }, key); return { id: e.id, name: e.name, job_title: e.job_title, calculated_score: s.calculated_score, performance_score: s.performance_score };
    });
  }
  return { unit: { id: o.id, name: o.name, kind: o.kind }, scorecard: sc, previous: { key: prev, performance_score: ps.performance_score, calculated_score: ps.calculated_score }, children, employees,
    path: rbac.ancestors(o.id).reverse().map(id => ({ id, name: rbac.orgs().get(id).name, kind: rbac.orgs().get(id).kind })) };
}
H.get('/api/performance/org/:id', ({ user, params, query }) => orgPerf(user, params.id, query));
// فريقي: الموظفون الذين أراجع أداءهم
H.get('/api/performance/team', ({ user, query }) => {
  if (!rbac.isManagerRole(user) && !user.isHR) throw forbidden();
  const key = query.period || defaultPeriodKey();
  const emps = db.all(`SELECT * FROM employees WHERE active = 1 AND deleted_at IS NULL AND id <> ? ORDER BY name`, user.id).filter(e => (e.manager_id === user.id) || (query.all === '1' && rbac.canReviewPerformanceOf(user, e)));
  const rows = emps.map(e => {
    const s = scorecard({ type: 'employee', id: e.id }, key);
    const od = db.get(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND deleted_at IS NULL AND due_date < ? AND status IN ('not_started','in_progress','pending_review','blocked')`, e.id, today()).n;
    const red = db.get(`SELECT COUNT(*) n FROM kpis k JOIN kpi_results r ON r.kpi_id = k.id WHERE k.employee_id = ? AND r.period_key = ? AND r.status = 'red' AND r.data_quality IN ('submitted','verified','approved')`, e.id, key).n;
    const ci = db.get(`SELECT status FROM checkins WHERE employee_id = ? AND period_key = ?`, e.id, key);
    const a = db.get(`SELECT a.stage FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = ?`, key, e.id);
    const attention = [];
    if (s.calculated_score !== null && s.calculated_score < setting('attention_score_below', 70)) attention.push('درجة الأداء منخفضة');
    if (od >= 2) attention.push(`${od} مهام متأخرة`); if (red) attention.push(`${red} KPI أحمر`);
    return { id: e.id, name: e.name, job_title: e.job_title, calculated_score: s.calculated_score, performance_score: s.performance_score, overdue_tasks: od, red_kpis: red, checkin_status: ci?.status || 'none', assessment_stage: a?.stage || null, attention };
  });
  const scored = rows.filter(r => r.calculated_score !== null);
  return { period_key: key, rows, team_score: scored.length ? r1(scored.reduce((a, r) => a + r.calculated_score, 0) / scored.length) : null, count: rows.length };
});
H.get('/api/performance/drilldown', ({ user, query }) => {
  // للإدارة: المجموعة ← الشركة ← وحدة النشاط ← القسم ← الفريق
  const id = Number(query.org) || (user.isExec || user.isHR ? [...rbac.orgs().values()].find(o => o.kind === 'company')?.id : user.dept_id);
  return orgPerf(user, id, query);
});

// ---------- Scorecard configs ----------
H.get('/api/scorecards', ({ user }) => {
  if (!(user.isExec || user.isHR)) throw forbidden();
  return { components: COMPONENTS, default: DEFAULT_WEIGHTS, configs: db.all('SELECT c.*, o.name org_name FROM scorecard_configs c LEFT JOIN org_units o ON o.id = c.org_unit_id').map(c => ({ ...c, weights: JSON.parse(c.weights) })), bands: bands(), bands_note: 'قيم تجريبية (Demo defaults) تحتاج اعتماد سياسة التقييم.' };
});
H.put('/api/scorecards', ({ user, body }) => {
  if (!(user.isExec || user.isHR)) throw forbidden('تعديل أوزان Scorecard للإدارة التنفيذية أو HR.');
  validateWeights(body.weights || {});
  const orgId = body.org_unit_id || null;
  if (orgId && !rbac.orgs().has(orgId)) throw bad('الوحدة غير موجودة.');
  const old = db.get('SELECT * FROM scorecard_configs WHERE IFNULL(org_unit_id,0) = ?', orgId || 0);
  db.tx(() => {
    if (old) db.update('scorecard_configs', old.id, { weights: JSON.stringify(body.weights), updated_by: user.id, updated_at: nowIso() });
    else db.insert('scorecard_configs', { org_unit_id: orgId, name: body.name || 'Scorecard', weights: JSON.stringify(body.weights), updated_by: user.id, updated_at: nowIso() });
    audit.log(user.id, 'scorecard', orgId || 0, 'update', 'weights', old?.weights ?? null, JSON.stringify(body.weights), body.reason);
  });
  return { ok: true };
});

// ---------- دورة حياة الفترة ----------
function periodChecks(per) {
  const kpiMissing = db.get(`SELECT COUNT(*) n FROM kpis k WHERE k.deleted_at IS NULL AND k.approval_status = 'approved' AND k.kpi_type <> 'formula' AND NOT EXISTS (SELECT 1 FROM kpi_results r WHERE r.kpi_id = k.id AND r.actual IS NOT NULL AND r.period_start >= ? AND r.period_end <= ?)`, per.start_date, per.end_date).n;
  const draft = db.get(`SELECT COUNT(*) n FROM kpi_results WHERE period_start >= ? AND period_end <= ? AND data_quality IN ('draft','submitted')`, per.start_date, per.end_date).n;
  const pendingTasks = db.get(`SELECT COUNT(*) n FROM tasks WHERE status = 'pending_review' AND due_date BETWEEN ? AND ? AND deleted_at IS NULL`, per.start_date, per.end_date).n;
  const asm = db.get(`SELECT COUNT(*) n FROM assessments WHERE period_id = ? AND stage <> 'final_approved'`, per.id).n;
  return { kpi_missing: kpiMissing, data_not_final: draft, tasks_pending_review: pendingTasks, assessments_not_final: asm, has_gaps: kpiMissing + draft + pendingTasks + asm > 0 };
}
H.get('/api/periods/:id', ({ user, params }) => {
  const p = db.get('SELECT * FROM performance_periods WHERE id = ?', params.id); if (!p) throw notFound();
  return { ...p, checks: periodChecks(p), adjustments: db.all('SELECT a.*, e.name by_name FROM period_adjustments a JOIN employees e ON e.id = a.created_by WHERE a.period_id = ? ORDER BY a.id DESC', p.id),
    snapshots: db.all(`SELECT version, MIN(created_at) created_at, COUNT(*) subjects FROM period_snapshots WHERE period_id = ? GROUP BY version ORDER BY version DESC`, p.id),
    audit: db.all(`SELECT a.*, e.name user_name FROM audit_log a LEFT JOIN employees e ON e.id = a.user_id WHERE a.entity = 'period' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30`, p.id) };
});
H.post('/api/periods', ({ user, body }) => {
  if (!(user.isExec || user.isHR)) throw forbidden();
  const d = need(body, { key: 'str:req', label: 'str', start_date: 'date', end_date: 'date' });
  const x = periods.parseKey(d.key) || (d.start_date && d.end_date ? { kind: 'custom', start: d.start_date, end: d.end_date, label: d.label || d.key } : null);
  if (!x) throw bad('مفتاح الفترة غير صحيح (مثال 2026-10 أو 2026-Q4)، أو حدّد تاريخي البداية والنهاية للفترة المخصصة.');
  if (x.start > x.end) throw bad('تاريخ البداية بعد النهاية.');
  if (db.get('SELECT 1 x FROM performance_periods WHERE key = ?', d.key)) throw conflict('الفترة موجودة بالفعل.', 'DUPLICATE');
  const id = db.insert('performance_periods', { key: d.key, kind: x.kind, label: d.label || x.label, start_date: x.start, end_date: x.end, created_at: nowIso(), updated_at: nowIso() });
  audit.log(user.id, 'period', id, 'create'); return { id };
});
function lockPeriod(per, user) {
  const subjects = [];
  for (const e of db.all(`SELECT id FROM employees WHERE active = 1 AND deleted_at IS NULL`)) subjects.push({ type: 'employee', id: e.id });
  for (const o of rbac.orgs().values()) if (orgSubjectType(o.kind)) subjects.push({ type: orgSubjectType(o.kind), id: o.id });
  const rng = { key: per.key, start: per.start_date, end: per.end_date, label: per.label, status: 'locked', id: per.id };
  for (const s of subjects) {
    const sc = computeLive(s, { ...rng, status: 'locked' });
    let payload = { ...sc, source: 'snapshot' };
    if (s.type === 'employee') {
      const a = db.get('SELECT * FROM assessments WHERE period_id = ? AND employee_id = ?', per.id, s.id);
      payload.final_rating = a && a.stage === 'final_approved' ? a.final_rating : null;
    }
    db.insert('period_snapshots', { period_id: per.id, version: per.version, subject_type: s.type, subject_id: s.id, payload: JSON.stringify(payload), calculated_score: sc.calculated_score, performance_score: sc.performance_score, rating: payload.final_rating || sc.suggested_rating, created_at: nowIso() });
  }
  return subjects.length;
}
H.post('/api/periods/:id/transition', ({ user, params, body }) => {
  if (!(user.isExec || user.isHR)) throw forbidden('إدارة الفترات للإدارة التنفيذية أو HR.');
  const p = db.get('SELECT * FROM performance_periods WHERE id = ?', params.id); if (!p) throw notFound();
  const to = body.to; const flow = { open: 'under_review', under_review: 'approved', approved: 'locked' };
  if (flow[p.status] !== to) throw conflict(`لا يمكن الانتقال من ${p.status} إلى ${to}. المسار: Open ← Under Review ← Approved ← Locked.`, 'BAD_TRANSITION');
  if (to === 'under_review' && p.end_date >= today()) throw conflict('لا يمكن بدء مراجعة فترة لم تنتهِ بعد.', 'PERIOD_NOT_ENDED');
  const checks = periodChecks(p);
  if (to === 'approved' && checks.has_gaps && !body.acknowledge_gaps) throw conflict('توجد فجوات في بيانات الفترة. راجعها أو أكّد المتابعة صراحةً.', 'HAS_GAPS');
  db.tx(() => {
    let n = null;
    db.update('performance_periods', p.id, { status: to, updated_at: nowIso(), ...(to === 'locked' ? { locked_at: nowIso(), locked_by: user.id } : {}) });
    if (to === 'locked') n = lockPeriod(p, user);
    audit.log(user.id, 'period', p.id, 'transition', 'status', p.status, to, body.reason || (body.acknowledge_gaps ? 'اعتماد مع الإقرار بالفجوات' : null));
    return n;
  });
  return { status: to };
});
H.post('/api/periods/:id/reopen', ({ user, params, body }) => {
  if (!(user.isExec || user.isHR)) throw forbidden('إعادة فتح الفترة للإدارة التنفيذية أو HR.');
  const p = db.get('SELECT * FROM performance_periods WHERE id = ?', params.id); if (!p) throw notFound();
  if (!['approved', 'locked'].includes(p.status)) throw conflict('الفترة غير معتمدة أو مقفلة.');
  if (!body.reason || String(body.reason).trim().length < 5) throw bad('سبب إعادة الفتح مطلوب (5 أحرف على الأقل).', { reason: 'مطلوب' });
  db.tx(() => {
    db.update('performance_periods', p.id, { status: 'under_review', version: p.version + 1, reopen_count: p.reopen_count + 1, locked_at: null, updated_at: nowIso() });
    audit.log(user.id, 'period', p.id, 'reopen', 'status', p.status, 'under_review', body.reason);
  });
  cache.bump();
  return { status: 'under_review', version: p.version + 1 };
});
// سجل تسوية (Adjustment) على فترة مقفلة دون المساس بالـSnapshot
H.post('/api/periods/:id/adjustments', ({ user, params, body }) => {
  if (!(user.isExec || user.isHR)) throw forbidden();
  const p = db.get('SELECT * FROM performance_periods WHERE id = ?', params.id); if (!p) throw notFound();
  if (!['approved', 'locked'].includes(p.status)) throw conflict('التسوية للفترات المعتمدة/المقفلة فقط.');
  const d = need(body, { entity: 'str:req', entity_id: 'int', field: 'str', old_value: 'str', new_value: 'str', reason: 'str:req' });
  const id = db.insert('period_adjustments', { ...d, period_id: p.id, created_by: user.id, created_at: nowIso() });
  audit.log(user.id, 'period', p.id, 'adjustment', d.field, d.old_value, d.new_value, d.reason);
  return { id };
});

// ---------- التقييم والمعايرة ----------
const STAGES = ['manager_review', 'department_review', 'management_calibration', 'final_approved'];
const STAGE_AR = { manager_review: 'مراجعة المدير', department_review: 'مراجعة القسم', management_calibration: 'معايرة الإدارة', final_approved: 'معتمد نهائيًا' };
function asmtFor(user, periodKey, empId) {
  const per = db.get('SELECT * FROM performance_periods WHERE key = ?', periodKey); if (!per) throw notFound('الفترة غير موجودة.');
  const e = loadEmp(empId); if (!e || !rbac.canReviewPerformanceOf(user, e)) throw notFound('الموظف غير موجود.');
  return { per, e, a: db.get('SELECT * FROM assessments WHERE period_id = ? AND employee_id = ?', per.id, e.id) };
}
function lockedCheck(per) { if (['approved', 'locked'].includes(per.status)) throw conflict('الفترة معتمدة/مقفلة؛ لا يمكن تعديل التقييم إلا بإعادة فتح الفترة.', 'PERIOD_LOCKED'); }
H.put('/api/assessments/:period/:emp', ({ user, params, body }) => {
  const { per, e, a } = asmtFor(user, params.period, params.emp); lockedCheck(per);
  const d = need(body, { manager_score: 'num', manager_comment: 'str', proposed_rating: 'str', feedback_for_employee: 'str', development_actions: 'str' });
  if (d.manager_score !== null && (d.manager_score < 0 || d.manager_score > 100)) throw bad('درجة المدير بين 0 و100.', { manager_score: 'غير صحيحة' });
  const isMgr = e.manager_id === user.id || user.isHR || (rbac.isManagerRole(user) && rbac.inScope(user, e.org_unit_id));
  if (!isMgr) throw forbidden();
  if (a && a.stage === 'final_approved') throw conflict('التقييم معتمد نهائيًا.');
  db.tx(() => {
    if (a) {
      audit.diff(user.id, 'assessment', a.id, a, d, ['manager_score', 'proposed_rating'], body.reason);
      db.update('assessments', a.id, { ...d, assessed_by: user.id, updated_at: nowIso() });
    } else {
      const id = db.insert('assessments', { ...d, period_id: per.id, employee_id: e.id, assessed_by: user.id, stage: 'manager_review', created_at: nowIso(), updated_at: nowIso() });
      audit.log(user.id, 'assessment', id, 'create', 'manager_score', null, d.manager_score);
    }
  });
  return { ok: true };
});
H.post('/api/assessments/:period/:emp/advance', ({ user, params, body }) => {
  const { per, e, a } = asmtFor(user, params.period, params.emp); lockedCheck(per);
  if (!a) throw conflict('أدخل التقييم أولًا.');
  const calib = setting('calibration_enabled', true);
  let next = STAGES[STAGES.indexOf(a.stage) + 1];
  if (!next) throw conflict('التقييم معتمد نهائيًا.');
  if (!calib && next !== 'final_approved' && a.stage !== 'manager_review') next = 'final_approved';
  // من يحق له كل مرحلة (سياسة افتراضية قابلة للضبط)
  const approvers = setting('final_rating_approvers', ['executive', 'hr_admin']);
  if (a.stage === 'manager_review' && !(e.manager_id === user.id || user.isHR || rbac.has(user, 'department_manager', 'business_unit_manager', 'executive'))) throw forbidden();
  if (a.stage === 'department_review' && !(rbac.has(user, 'department_manager', 'business_unit_manager', 'executive', 'hr_admin') && (rbac.inScope(user, e.org_unit_id) || user.isHR))) throw forbidden('مراجعة القسم لمدير القسم.');
  if (a.stage === 'management_calibration' && !approvers.some(r => rbac.has(user, r))) throw forbidden('الاعتماد النهائي للإدارة التنفيذية أو HR.');
  if (next === 'final_approved') {
    if (!approvers.some(r => rbac.has(user, r))) throw forbidden('الاعتماد النهائي للإدارة التنفيذية أو HR.');
    const fr = body.final_rating || a.proposed_rating;
    if (!fr) throw bad('حدد التقييم النهائي المعتمد.', { final_rating: 'مطلوب' });
    if (!bands().some(b => b[1] === fr)) throw bad('التقييم غير ضمن القائمة المعتمدة.', { final_rating: 'غير صحيح' });
    if (a.manager_score === null) throw bad('درجة المدير غير مدخلة.');
  }
  db.tx(() => {
    db.update('assessments', a.id, { stage: next, ...(next === 'final_approved' ? { final_rating: body.final_rating || a.proposed_rating, approved_by: user.id, approved_at: nowIso() } : {}), updated_at: nowIso() });
    db.insert('assessment_stages', { assessment_id: a.id, stage: next, actor_id: user.id, comment: body.comment || null, created_at: nowIso() });
    audit.log(user.id, 'assessment', a.id, 'stage', 'stage', a.stage, next, body.comment || null);
    if (next === 'final_approved') { audit.log(user.id, 'assessment', a.id, 'rating', 'final_rating', a.final_rating, body.final_rating || a.proposed_rating); notify.send(e.id, 'performance_review_pending', 'اعتُمد تقييم أدائك', per.label, '#/performance'); }
  });
  return { stage: next };
});
H.post('/api/assessments/:period/:emp/return', ({ user, params, body }) => {
  const { per, a } = asmtFor(user, params.period, params.emp); lockedCheck(per);
  if (!a || a.stage === 'manager_review') throw conflict('لا توجد مرحلة سابقة.');
  if (a.stage === 'final_approved') throw conflict('التقييم معتمد نهائيًا. أعد فتح الفترة لتعديله.');
  if (!body.comment) throw bad('سبب الإرجاع مطلوب.', { comment: 'مطلوب' });
  const prev = STAGES[STAGES.indexOf(a.stage) - 1];
  db.update('assessments', a.id, { stage: prev, updated_at: nowIso() });
  db.insert('assessment_stages', { assessment_id: a.id, stage: prev, actor_id: user.id, comment: `إرجاع: ${body.comment}`, created_at: nowIso() });
  audit.log(user.id, 'assessment', a.id, 'return', 'stage', a.stage, prev, body.comment);
  return { stage: prev };
});
H.get('/api/assessments/:period/:emp', ({ user, params }) => {
  const { a } = asmtFor(user, params.period, params.emp);
  return a ? { ...a, stage_ar: STAGE_AR[a.stage], bands: bands().map(b => b[1]), trail: db.all(`SELECT s.*, e.name actor_name FROM assessment_stages s LEFT JOIN employees e ON e.id = s.actor_id WHERE assessment_id = ? ORDER BY s.id`, a.id) } : { stage: null, bands: bands().map(b => b[1]) };
});

// ---------- Check-ins ----------
const CI_FIELDS = ['achievements', 'challenges', 'blockers', 'support_required', 'employee_comment'];
H.get('/api/checkins', ({ user, query }) => {
  if (query.employee_id && Number(query.employee_id) !== user.id) {
    const e = loadEmp(query.employee_id); if (!e || !rbac.canReviewPerformanceOf(user, e)) throw notFound();
    return db.all('SELECT * FROM checkins WHERE employee_id = ? ORDER BY period_key DESC LIMIT 24', e.id);
  }
  return db.all('SELECT * FROM checkins WHERE employee_id = ? ORDER BY period_key DESC LIMIT 24', user.id);
});
H.get('/api/checkins-due', ({ user }) => {
  if (!rbac.isManagerRole(user)) throw forbidden();
  const key = defaultPeriodKey();
  return db.all(`SELECT c.*, e.name employee_name FROM checkins c JOIN employees e ON e.id = c.employee_id WHERE e.manager_id = ? AND c.status = 'submitted' ORDER BY c.updated_at`, user.id);
});
H.put('/api/checkins/me/:period', ({ user, params, body }) => {
  if (user.isAdmin) throw forbidden();
  if (!periods.parseKey(params.period)) throw bad('فترة غير صحيحة.');
  const kind = body.kind === 'weekly' ? 'weekly' : 'monthly';
  const cur = db.get('SELECT * FROM checkins WHERE employee_id = ? AND period_key = ? AND kind = ?', user.id, params.period, kind);
  if (cur && cur.status === 'reviewed') throw conflict('تمت مراجعة هذا Check-in ولا يمكن تعديله.');
  const f = Object.fromEntries(CI_FIELDS.map(k => [k, body[k] ?? cur?.[k] ?? null]));
  if (body.submit && !(f.achievements || f.challenges)) throw bad('اكتب الإنجازات أو التحديات قبل الإرسال.');
  const status = body.submit ? 'submitted' : 'draft';
  let id;
  if (cur) { db.update('checkins', cur.id, { ...f, status, updated_at: nowIso() }); id = cur.id; }
  else id = db.insert('checkins', { ...f, employee_id: user.id, period_key: params.period, kind, status, created_at: nowIso(), updated_at: nowIso() });
  if (body.submit && user.manager_id) notify.send(user.manager_id, 'review_required', `Check-in جديد من ${user.name}`, params.period, '#/team', `ci:${id}`);
  return { id, status };
});
H.put('/api/checkins/:id/review', ({ user, params, body }) => {
  const c = db.get('SELECT * FROM checkins WHERE id = ?', params.id); if (!c) throw notFound();
  const e = loadEmp(c.employee_id); if (!e || !rbac.canReviewPerformanceOf(user, e)) throw notFound();
  if (c.status === 'draft') throw conflict('لم يُرسل الموظف الـCheck-in بعد.');
  db.update('checkins', c.id, { manager_comment: body.manager_comment || null, agreed_actions: body.agreed_actions || null, status: 'reviewed', updated_at: nowIso() });
  return { ok: true };
});

module.exports = { lockPeriod, scorecard, computeLive, COMPONENTS, DEFAULT_WEIGHTS, defaultPeriodKey, ratingFor, periodChecks, bands, orgSubjectType };
