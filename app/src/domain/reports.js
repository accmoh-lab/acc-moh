'use strict';
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const perf = require('./perf');
const kpis = require('./kpis');
const targets = require('./targets');
const kpiEngine = require('../kpi_engine');
const periods = require('../periods');
const { toCsv } = require('./imports');
const { forbidden, notFound, bad, today, diffDays } = require('../util');

const C = (key, label) => ({ key, label });
const senior = u => u.isExec || u.isHR || (rbac.isManagerRole(u) && u.rank >= 3);
const mgr = u => rbac.isManagerRole(u) || u.isHR;
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);

const REPORTS = {
  meeting_effectiveness: { title: 'فعالية الاجتماعات', access: mgr, run(u, f) {
    const rows = db.all(`SELECT m.* FROM meetings m WHERE ${rbac.meetingVisibilitySql(u)} AND m.status IN ('closed','approved','minutes_draft','under_review') AND m.meeting_date BETWEEN ? AND ? ORDER BY m.meeting_date DESC LIMIT 300`, f.from, f.to);
    return { cols: [C('code', 'الرمز'), C('title', 'الاجتماع'), C('meeting_date', 'التاريخ'), C('participants', 'المدعوون'), C('attendance_pct', 'الحضور %'), C('decisions', 'القرارات'), C('tasks', 'المهام'), C('tasks_done_pct', 'إنجاز المهام %'), C('minutes', 'مدة فعلية (د)')],
      rows: rows.map(m => { const p = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN attendance = 'attended' THEN 1 ELSE 0 END) a FROM meeting_participants WHERE meeting_id = ?`, m.id); const t = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) d FROM tasks WHERE meeting_id = ? AND deleted_at IS NULL`, m.id);
        return { code: m.code, title: m.title, meeting_date: m.meeting_date, participants: p.n, attendance_pct: pct(p.a || 0, p.n), decisions: db.get('SELECT COUNT(*) n FROM decisions WHERE meeting_id = ? AND deleted_at IS NULL', m.id).n, tasks: t.n, tasks_done_pct: pct(t.d || 0, t.n), minutes: m.started_at && m.ended_at ? Math.round((new Date(m.ended_at) - new Date(m.started_at)) / 60000) : null }; }) };
  } },
  attendance: { title: 'الحضور', access: mgr, run(u, f) {
    const rows = db.all(`SELECT e.id, e.name, COUNT(*) invited, SUM(CASE WHEN p.attendance = 'attended' THEN 1 ELSE 0 END) attended, SUM(CASE WHEN p.attendance = 'absent' THEN 1 ELSE 0 END) absent, SUM(CASE WHEN p.attendance = 'excused' THEN 1 ELSE 0 END) excused
      FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id JOIN employees e ON e.id = p.employee_id WHERE ${rbac.meetingVisibilitySql(u)} AND m.meeting_date BETWEEN ? AND ? AND p.attendance IS NOT NULL GROUP BY e.id ORDER BY e.name`, f.from, f.to);
    return { cols: [C('name', 'الموظف'), C('invited', 'اجتماعات'), C('attended', 'حضر'), C('absent', 'غاب'), C('excused', 'معتذر'), C('rate', 'نسبة الحضور %')], rows: rows.map(r => ({ ...r, rate: pct(r.attended, r.invited) })) };
  } },
  decision_execution: { title: 'تنفيذ القرارات', access: mgr, run(u, f) {
    const rows = db.all(`SELECT d.*, m.code mcode, m.type mtype, m.dept_id mdept, m.bu_id mbu, m.company_id mco, m.confidentiality mconf, m.leader_id, m.secretary_id, (SELECT name FROM employees WHERE id = d.owner_id) owner, (SELECT COUNT(*) FROM tasks t WHERE t.decision_id = d.id AND t.deleted_at IS NULL) tn, (SELECT COUNT(*) FROM tasks t WHERE t.decision_id = d.id AND t.status = 'completed') td FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.deleted_at IS NULL AND d.decision_date BETWEEN ? AND ? ORDER BY d.decision_date DESC LIMIT 400`, f.from, f.to)
      .filter(d => rbac.canSeeDecision(u, d, { id: d.meeting_id, type: d.mtype, dept_id: d.mdept, bu_id: d.mbu, company_id: d.mco, confidentiality: d.mconf, leader_id: d.leader_id, secretary_id: d.secretary_id }));
    return { cols: [C('code', 'القرار'), C('text', 'النص'), C('mcode', 'الاجتماع'), C('owner', 'المسؤول'), C('status', 'الحالة'), C('effective_date', 'تاريخ السريان'), C('tn', 'مهام'), C('prog', 'إنجاز المهام %')], rows: rows.map(d => ({ ...d, text: d.text.slice(0, 90), prog: pct(d.td, d.tn) })) };
  } },
  task_performance: { title: 'أداء المهام', access: () => true, run(u, f) {
    const sc = rbac.isManagerRole(u) ? `AND (t.owner_id = ${u.id} OR o.manager_id = ${u.id} OR o.org_unit_id IN (${u.scopeIds.join(',') || 'NULL'}))` : `AND t.owner_id = ${u.id}`;
    const rows = db.all(`SELECT o.id, o.name, COUNT(*) total, SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) done, SUM(CASE WHEN t.status = 'completed' AND substr(t.completed_at,1,10) <= t.due_date THEN 1 ELSE 0 END) ontime, SUM(CASE WHEN t.status IN ('not_started','in_progress','pending_review','blocked') AND t.due_date < ? THEN 1 ELSE 0 END) overdue, AVG(t.progress) prog
      FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE ${rbac.taskVisibilitySql(u)} ${sc} AND t.status <> 'cancelled' AND t.due_date BETWEEN ? AND ? GROUP BY o.id ORDER BY o.name`, today(), f.from, f.to);
    return { cols: [C('name', 'المسؤول'), C('total', 'المهام'), C('done', 'مكتملة'), C('ontime_pct', 'في الموعد %'), C('overdue', 'متأخرة'), C('avg_prog', 'متوسط الإنجاز %')], rows: rows.map(r => ({ ...r, ontime_pct: pct(r.ontime, r.done), avg_prog: Math.round(r.prog) })) };
  } },
  overdue_tasks: { title: 'المهام المتأخرة', access: () => true, run(u, f) {
    const sc = rbac.isManagerRole(u) ? '' : `AND t.owner_id = ${u.id}`;
    const rows = db.all(`SELECT t.code, t.title, o.name owner, t.priority, t.due_date, t.status, t.source FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE ${rbac.taskVisibilitySql(u)} ${sc} AND t.due_date < ? AND t.status IN ('not_started','in_progress','pending_review','blocked') ORDER BY t.due_date LIMIT 500`, today());
    return { cols: [C('code', 'الرمز'), C('title', 'المهمة'), C('owner', 'المسؤول'), C('priority', 'الأولوية'), C('due_date', 'الاستحقاق'), C('days', 'أيام التأخر'), C('status', 'الحالة')], rows: rows.map(r => ({ ...r, days: diffDays(today(), r.due_date) })) };
  } },
  kpi_performance: { title: 'أداء مؤشرات KPI', access: () => true, run(u, f) {
    const key = f.period;
    const rows = db.all(`SELECT k.* FROM kpis k WHERE ${rbac.kpiVisibilitySql(u)} AND k.approval_status <> 'retired' ORDER BY k.level, k.code LIMIT 500`);
    return { cols: [C('code', 'الرمز'), C('name', 'المؤشر'), C('org', 'الوحدة'), C('period', 'الفترة'), C('target', 'المستهدف'), C('actual', 'الفعلي'), C('achievement', 'الإنجاز %'), C('status', 'الحالة'), C('quality', 'جودة البيانات')],
      rows: rows.map(k => { const pk = key || kpis.dueKey(k.frequency); const r = kpiEngine.getResult(k.id, pk); return { code: k.code, name: k.name, org: rbac.orgs().get(k.org_unit_id)?.name || 'موظف', period: pk, target: r?.target ?? k.target, actual: r?.actual ?? null, achievement: r?.achievement ?? null, status: r?.status || 'missing', quality: r?.data_quality || 'missing' }; }) };
  } },
  financial_achievement: { title: 'تحقيق الأهداف المالية', access: senior, run(u, f) {
    if (!targets.canSeeFin(u)) throw forbidden();
    const rows = db.all('SELECT * FROM financial_targets WHERE period_key = ? ORDER BY metric', f.period || kpis.dueKey('monthly')).filter(r => targets.visibleOrg(u, r.org_unit_id)).map(targets.row);
    return { cols: [C('metric_ar', 'المقياس'), C('label', 'البند'), C('org_name', 'الوحدة'), C('currency', 'العملة'), C('target', 'المستهدف'), C('actual', 'الفعلي'), C('variance', 'الانحراف'), C('achievement', 'الإنجاز %'), C('data_quality', 'جودة البيانات')], rows };
  } },
  department_performance: { title: 'أداء الأقسام', access: senior, run(u, f) { return unitReport(u, f, 'department'); } },
  business_unit_performance: { title: 'أداء وحدات النشاط', access: senior, run(u, f) { return unitReport(u, f, 'business_unit'); } },
  employee_performance: { title: 'أداء الموظفين', access: mgr, run(u, f) {
    const key = f.period || perf.defaultPeriodKey();
    const rows = db.all(`SELECT * FROM employees WHERE active = 1 AND deleted_at IS NULL ORDER BY name`).filter(e => rbac.canReviewPerformanceOf(u, e)).map(e => { const s = perf.scorecard({ type: 'employee', id: e.id }, key); const a = db.get(`SELECT a.stage, a.final_rating FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = ?`, key, e.id);
      return { name: e.name, org: rbac.orgs().get(e.org_unit_id)?.name, calculated: s.calculated_score, manager: s.manager_score, total: s.performance_score, stage: a?.stage || '-', final: a?.stage === 'final_approved' ? a.final_rating : '-' }; });
    return { cols: [C('name', 'الموظف'), C('org', 'الوحدة'), C('calculated', 'الدرجة المحسوبة'), C('manager', 'تقييم المدير'), C('total', 'الإجمالي'), C('stage', 'مرحلة التقييم'), C('final', 'التقييم النهائي المعتمد')], rows, note: 'تقرير سرّي: للمديرين وHR ضمن نطاقهم فقط.' };
  } },
  initiative_performance: { title: 'أداء المبادرات', access: mgr, run(u) {
    const rows = db.all(`SELECT i.* FROM initiatives i WHERE ${rbac.initiativeVisibilitySql(u)} ORDER BY i.target_date`);
    return { cols: [C('code', 'الرمز'), C('title', 'المبادرة'), C('status', 'الحالة'), C('progress', 'التقدم %'), C('target_date', 'التاريخ المستهدف'), C('owner', 'المالك'), C('tasks', 'المهام'), C('overdue', 'متأخرة')], rows: rows.map(i => ({ ...i, owner: db.get('SELECT name FROM employees WHERE id = ?', i.owner_id)?.name, tasks: db.get('SELECT COUNT(*) n FROM tasks WHERE initiative_id = ? AND deleted_at IS NULL', i.id).n, overdue: db.get(`SELECT COUNT(*) n FROM tasks WHERE initiative_id = ? AND due_date < ? AND status IN ('not_started','in_progress','pending_review','blocked')`, i.id, today()).n })) };
  } },
  period_comparison: { title: 'مقارنة الفترات', access: senior, run(u, f) {
    const org = Number(f.org_id) || [...rbac.orgs().values()].find(o => o.kind === 'company')?.id;
    const o = rbac.orgs().get(org); if (!o || !perf.orgSubjectType(o.kind)) throw notFound();
    if (!(u.isExec || u.isHR || rbac.inScope(u, org))) throw forbidden();
    const pers = db.all(`SELECT * FROM performance_periods WHERE kind = 'monthly' ORDER BY start_date DESC LIMIT 6`).reverse();
    return { cols: [C('period', 'الفترة'), C('status', 'حالة الفترة'), C('calculated', 'الدرجة المحسوبة'), C('total', 'الإجمالي'), C('source', 'المصدر')], rows: pers.map(p => { const s = perf.scorecard({ type: perf.orgSubjectType(o.kind), id: org }, p.key); return { period: p.label, status: p.status, calculated: s.calculated_score, total: s.performance_score, source: s.source === 'snapshot' ? `Snapshot v${s.snapshot_version}` : 'حيّ' }; }), note: `الوحدة: ${o.name}` };
  } },
};
function unitReport(u, f, kind) {
  const key = f.period || perf.defaultPeriodKey();
  const rows = [...rbac.orgs().values()].filter(o => o.kind === kind && (u.isExec || u.isHR || rbac.inScope(u, o.id))).map(o => { const s = perf.scorecard({ type: kind, id: o.id }, key); const p = perf.scorecard({ type: kind, id: o.id }, periods.prevKey(key)); const t = Object.fromEntries(s.components.map(c => [c.key, c.score])); return { name: o.name, calculated: s.calculated_score, total: s.performance_score, previous: p.performance_score ?? p.calculated_score, fin: t.kpi_financial, ops: t.kpi_operational, tasks: t.tasks }; });
  return { cols: [C('name', 'الوحدة'), C('calculated', 'الدرجة المحسوبة'), C('total', 'الإجمالي'), C('previous', 'الفترة السابقة'), C('fin', 'مالي'), C('ops', 'تشغيلي'), C('tasks', 'المهام')], rows, note: `الفترة: ${key}` };
}
H.get('/api/reports', ({ user }) => Object.entries(REPORTS).filter(([, r]) => r.access(user) && !user.isAdmin).map(([key, r]) => ({ key, title: r.title })));
H.get('/api/reports/:name', ({ user, params, query }) => {
  const r = REPORTS[params.name]; if (!r || user.isAdmin) throw notFound('التقرير غير موجود.');
  if (!r.access(user)) throw forbidden('هذا التقرير غير متاح لدورك.');
  const f = { from: query.from || '2000-01-01', to: query.to || '2100-01-01', period: query.period, org_id: query.org_id };
  const res = r.run(user, f);
  if (query.format === 'csv') {
    audit.log(user.id, 'export', 0, `report:${params.name}`, 'rows', null, res.rows.length);
    return { __raw: true, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${params.name}.csv"` }, body: toCsv(res.cols, res.rows) };
  }
  return { key: params.name, title: r.title, columns: res.cols, rows: res.rows.slice(0, Number(query.limit) || 300), total: res.rows.length, note: res.note || null };
});
