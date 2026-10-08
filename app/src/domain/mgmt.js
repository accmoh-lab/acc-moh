'use strict';
// Management Attention + لوحات Home حسب الدور
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const cache = require('../cache');
const periods = require('../periods');
const kpiEngine = require('../kpi_engine');
const perf = require('./perf');
const kpis = require('./kpis');
const targets = require('./targets');
const meetings = require('./meetings');
const { forbidden, today, diffDays, addDays, setting } = require('../util');

const SEV = { critical: 0, high: 1, medium: 2 };
const iso = v => `\u2066${v}\u2069`;
const nf = v => (v === null || v === undefined ? '—' : iso(Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })));
const TST = { not_started: 'لم تبدأ', in_progress: 'قيد التنفيذ', pending_review: 'بانتظار المراجعة', blocked: 'معطّلة' };
const empName = id => (id ? db.get('SELECT name FROM employees WHERE id = ?', id)?.name : null);

function attentionItems(user) {
  if (user.isAdmin) return [];
  const items = []; const t0 = today();
  const push = i => items.push(i);
  const seeAll = user.isExec || user.isHR;
  const scopeKpi = k => seeAll || rbac.inScope(user, k.org_unit_id) || k.owner_id === user.id;

  // 1) KPIs حمراء (بيانات مرسلة فأعلى فقط، وليست Draft)
  const reds = db.all(`SELECT k.*, r.period_key, r.achievement, r.actual, r.target tgt, r.period_end, r.data_quality FROM kpis k JOIN kpi_results r ON r.kpi_id = k.id
     WHERE k.deleted_at IS NULL AND k.approval_status <> 'retired' AND k.level <> 'employee' AND r.status = 'red' AND r.data_quality IN ('submitted','verified','approved')`);
  const latest = new Map();
  for (const r of reds) { const c = latest.get(r.id); if (!c || r.period_key > c.period_key) latest.set(r.id, r); }
  for (const r of latest.values()) {
    if (r.period_key < kpis.dueKey(r.frequency) && r.period_key !== kpis.dueKey(r.frequency)) { /* قديم: نعرض فقط الأحدث المستحق */ const cur = kpiEngine.getResult(r.id, kpis.dueKey(r.frequency)); if (cur && cur.status !== 'red') continue; }
    if (!scopeKpi(r)) continue;
    const handled = db.get(`SELECT m.code, m.id FROM agenda_items a JOIN meetings m ON m.id = a.meeting_id WHERE a.related_kpi_id = ? AND m.deleted_at IS NULL AND m.status NOT IN ('cancelled') AND m.meeting_date >= date(?, '-14 day') ORDER BY m.meeting_date DESC LIMIT 1`, r.id, t0);
    const task = db.get(`SELECT code, id, status FROM tasks WHERE kpi_id = ? AND deleted_at IS NULL AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1`, r.id);
    push({ id: `kpi-${r.id}`, type: 'red_kpi', severity: r.achievement < 70 || r.category === 'financial' ? 'critical' : 'high', title: `KPI أحمر: ${r.name}`,
      detail: `الإنجاز ${nf(r.achievement)}% — الفعلي ${nf(r.actual)} مقابل المستهدف ${nf(r.tgt)} ${r.unit || ''} · الفترة ${iso(r.period_key)}`, owner_name: empName(r.owner_id), owner_id: r.owner_id, age_days: Math.max(0, diffDays(t0, r.period_end)),
      impact: r.category === 'financial' ? 'أثر مالي مباشر' : 'أثر على الأداء التشغيلي', source: { type: 'kpi', id: r.id, label: r.code }, recommended: handled || task ? 'تابع تنفيذ الإجراء المسجّل' : 'أضف المؤشر إلى جدول اجتماع الإدارة وحدّد إجراءً تصحيحيًا',
      follow_up: { meeting: handled ? { id: handled.id, code: handled.code } : null, task: task ? { id: task.id, code: task.code, status: task.status } : null }, action: handled || task ? null : 'create_meeting', kpi_id: r.id });
  }
  // 2) انحرافات مالية كبيرة (آخر فترة لكل مقياس/وحدة)
  if (targets.canSeeFin(user)) {
    const rows = db.all(`SELECT f.* FROM financial_targets f WHERE f.actual IS NOT NULL AND f.data_quality IN ('submitted','verified','approved') AND f.period_key = (SELECT MAX(period_key) FROM financial_targets x WHERE x.metric = f.metric AND x.org_unit_id = f.org_unit_id AND x.label = f.label AND x.actual IS NOT NULL)`);
    for (const f of rows) {
      if (!targets.visibleOrg(user, f.org_unit_id)) continue; const x = targets.row(f);
      if (!x.major) continue;
      push({ id: `fin-${f.id}`, type: 'financial_variance', severity: Math.abs(x.variance_pct) >= 20 ? 'critical' : 'high', title: `انحراف مالي: ${f.label} — ${x.org_name}`,
        detail: `الفعلي ${nf(f.actual)} مقابل المستهدف ${nf(f.target)} ${f.currency} · الانحراف ${nf(x.variance_pct)}% · ${iso(f.period_key)}`, owner_name: null, age_days: Math.max(0, diffDays(t0, f.period_end)),
        impact: 'تأثير على النتائج المالية', source: { type: 'target', id: f.id, label: f.period_key }, recommended: 'راجع أسباب الانحراف في اجتماع المالية/الإدارة واعتمد خطة تعويض', action: f.related_kpi_id ? 'create_meeting' : null, kpi_id: f.related_kpi_id });
    }
  }
  // 3 + 4) مهام حرجة متأخرة / معطّلة
  const tv = rbac.taskVisibilitySql(user, 't');
  const scopeTask = `(t.owner_id = ${user.id} OR ${seeAll ? '1=1' : `COALESCE(t.dept_id, t.bu_id, t.company_id) IN (${user.scopeIds.join(',') || 'NULL'})`})`;
  for (const t of db.all(`SELECT t.*, o.name owner_name FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE ${tv} AND ${scopeTask} AND t.priority IN ('critical','high') AND t.status IN ('not_started','in_progress','pending_review','blocked') AND t.due_date < ?`, t0)) {
    const age = diffDays(t0, t.due_date);
    push({ id: `task-${t.id}`, type: 'overdue_task', severity: t.priority === 'critical' || age > 7 ? 'critical' : 'high', title: `مهمة ${t.priority === 'critical' ? 'حرجة' : 'عالية الأولوية'} متأخرة: ${t.title}`,
      detail: `متأخرة ${age} يومًا — ${TST[t.status] || t.status}`, owner_name: t.owner_name, owner_id: t.owner_id, age_days: age, impact: t.kpi_id || t.decision_id ? 'تؤثر على تنفيذ قرار/مؤشر' : 'تأخر في التنفيذ', source: { type: 'task', id: t.id, label: t.code }, recommended: 'تواصل مع المسؤول وحدّد موعدًا جديدًا أو صعّد العائق' });
  }
  for (const t of db.all(`SELECT t.*, o.name owner_name FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE ${tv} AND ${scopeTask} AND t.priority IN ('critical','high') AND t.status = 'blocked' AND t.due_date >= ?`, t0)) {
    push({ id: `blk-${t.id}`, type: 'blocked_task', severity: t.priority === 'critical' ? 'critical' : 'high', title: `مهمة معطّلة: ${t.title}`, detail: t.blocked_reason || '', owner_name: t.owner_name, owner_id: t.owner_id, age_days: Math.max(0, diffDays(t0, t.updated_at.slice(0, 10))), impact: 'عائق يمنع التقدم', source: { type: 'task', id: t.id, label: t.code }, recommended: 'أزل العائق أو صعّده للإدارة' });
  }
  // 5) قرارات لم تُنفَّذ
  for (const d of db.all(`SELECT d.*, m.type mtype, m.dept_id mdept, m.bu_id mbu, m.company_id mco, m.confidentiality mconf, m.leader_id, m.secretary_id, m.code mcode FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.deleted_at IS NULL AND d.status IN ('open','in_progress') AND ((d.effective_date IS NOT NULL AND d.effective_date < ?) OR (d.effective_date IS NULL AND d.decision_date < date(?, '-30 day')))`, t0, t0)) {
    const meeting = { id: d.meeting_id, type: d.mtype, dept_id: d.mdept, bu_id: d.mbu, company_id: d.mco, confidentiality: d.mconf, leader_id: d.leader_id, secretary_id: d.secretary_id };
    if (!rbac.canSeeDecision(user, d, meeting) || !(seeAll || d.owner_id === user.id || rbac.inScope(user, d.responsible_dept_id))) continue;
    const ref = d.effective_date || d.decision_date;
    push({ id: `dec-${d.id}`, type: 'decision_not_implemented', severity: diffDays(t0, ref) > 14 ? 'high' : 'medium', title: `قرار لم يُنفَّذ: ${d.code}`, detail: d.text.slice(0, 140), owner_name: empName(d.owner_id), owner_id: d.owner_id, age_days: diffDays(t0, ref), impact: 'قرار إداري لم ينعكس على التنفيذ', source: { type: 'decision', id: d.id, label: d.code }, recommended: 'اطلب تقرير تنفيذ من المسؤول أو أضفه لاجتماع المتابعة' });
  }
  // 6) مبادرات معرضة للخطر
  for (const i of db.all(`SELECT * FROM initiatives i WHERE i.status = 'at_risk' AND ${rbac.initiativeVisibilitySql(user)}`)) {
    push({ id: `ini-${i.id}`, type: 'initiative_at_risk', severity: 'high', title: `مبادرة معرضة للخطر: ${i.title}`, detail: i.risk_note || `التقدم ${nf(i.progress)}%`, owner_name: empName(i.owner_id), owner_id: i.owner_id, age_days: Math.max(0, diffDays(t0, i.updated_at.slice(0, 10))), impact: 'قد لا تتحقق الفائدة المتوقعة', source: { type: 'initiative', id: i.id, label: i.code }, recommended: 'راجع خطة الاستعادة مع المالك والراعي' });
  }
  // 7) بيانات KPI ناقصة للفترة المستحقة
  for (const k of db.all(`SELECT * FROM kpis WHERE deleted_at IS NULL AND approval_status = 'approved' AND level <> 'employee' AND kpi_type <> 'formula' AND data_source <> 'calculated'`)) {
    if (!scopeKpi(k)) continue; const key = kpis.dueKey(k.frequency); const r = kpiEngine.getResult(k.id, key);
    if (r && r.actual !== null) continue;
    const p = periods.parseKey(key);
    push({ id: `miss-${k.id}`, type: 'missing_kpi_data', severity: 'medium', title: `بيانات ناقصة: ${k.name}`, detail: `لم تُدخل بيانات الفترة ${iso(key)}`, owner_name: empName(k.data_owner_id || k.owner_id), owner_id: k.data_owner_id || k.owner_id, age_days: Math.max(0, diffDays(t0, p.end)), impact: 'لا يمكن تقييم الأداء بدون بيانات', source: { type: 'kpi', id: k.id, label: k.code }, recommended: 'ذكّر مالك البيانات بإدخال القيمة' });
  }
  // 8) اعتمادات معلّقة
  for (const t of db.all(`SELECT t.*, o.name owner_name, r.name rev FROM tasks t JOIN employees o ON o.id = t.owner_id LEFT JOIN employees r ON r.id = t.reviewer_id WHERE ${tv} AND ${scopeTask} AND t.status = 'pending_review' AND t.updated_at < ?`, new Date(Date.now() - 3 * 864e5).toISOString())) {
    push({ id: `rv-${t.id}`, type: 'pending_approval', severity: 'medium', title: `مهمة بانتظار الاعتماد: ${t.title}`, detail: `المراجع: ${t.rev || 'المدير المباشر'}`, owner_name: t.rev, owner_id: t.reviewer_id, age_days: diffDays(t0, t.updated_at.slice(0, 10)), impact: 'تأخير اعتماد الإنجاز', source: { type: 'task', id: t.id, label: t.code }, recommended: 'اطلب من المراجع الاعتماد أو الإرجاع' });
  }
  for (const p of db.all(`SELECT * FROM performance_periods WHERE status = 'under_review'`)) {
    if (user.isExec || user.isHR) push({ id: `per-${p.id}`, type: 'pending_approval', severity: 'medium', title: `فترة أداء بانتظار الاعتماد: ${p.label}`, detail: 'الفترة قيد المراجعة', owner_name: null, age_days: Math.max(0, diffDays(t0, p.end_date)), impact: 'لا يمكن إقفال النتائج التاريخية', source: { type: 'period', id: p.id, label: p.key }, recommended: 'راجع الفجوات ثم اعتمد الفترة' });
  }
  // 9) حزم تحضير متأخرة
  for (const m of db.all(`SELECT m.* FROM meetings m WHERE ${rbac.meetingVisibilitySql(user)} AND m.status IN ('draft','preparation') AND m.meeting_date >= ? AND m.meeting_date <= ?`, t0, addDays(t0, 3))) {
    if (meetings.prepState(m) !== 'late') continue; if (!(seeAll || rbac.inScope(user, rbac.meetingOrg(m)) || m.leader_id === user.id)) continue;
    push({ id: `prep-${m.id}`, type: 'late_prep_pack', severity: 'high', title: `حزمة تحضير متأخرة: ${m.title}`, detail: `الاجتماع ${m.meeting_date} ${m.start_time}`, owner_name: empName(m.leader_id), owner_id: m.leader_id, age_days: 0, impact: 'الحضور لن يتهيأ قبل الاجتماع', source: { type: 'meeting', id: m.id, label: m.code }, recommended: 'انشر حزمة التحضير فورًا' });
  }
  items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.age_days - a.age_days);
  return items;
}

const TYPE_AR = { red_kpi: 'KPI أحمر', financial_variance: 'انحراف مالي', overdue_task: 'مهمة حرجة متأخرة', blocked_task: 'مهمة معطّلة', decision_not_implemented: 'قرار غير منفّذ', initiative_at_risk: 'مبادرة معرضة للخطر', missing_kpi_data: 'بيانات ناقصة', pending_approval: 'اعتماد معلّق', late_prep_pack: 'حزمة تحضير متأخرة' };
H.get('/api/attention', ({ user, query }) => {
  if (!(user.isExec || user.isHR || (rbac.isManagerRole(user) && user.rank >= 3))) throw forbidden('Management Attention للمديرين فأعلى.');
  let items = cache.memo(`att:${user.id}`, 15000, () => attentionItems(user));
  const counts = {}; for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
  if (query.type) items = items.filter(i => i.type === query.type);
  if (query.severity) items = items.filter(i => i.severity === query.severity);
  return { total: items.length, counts, types: TYPE_AR, items: items.slice(0, 200) };
});

// ---------- Home حسب الدور ----------
function home(user) {
  const t0 = today(); const key = perf.defaultPeriodKey();
  const out = { role: user.system_role, date: t0, period_key: key };
  if (user.isAdmin) {
    out.admin = { users: db.get('SELECT COUNT(*) n FROM employees WHERE can_login = 1 AND active = 1').n, employees: db.get('SELECT COUNT(*) n FROM employees WHERE active = 1').n, audit_today: db.get('SELECT COUNT(*) n FROM audit_log WHERE ts >= ?', t0).n, integrations: require('../integrations').list() };
    return out;
  }
  const mv = rbac.meetingVisibilitySql(user);
  const mine = `(m.leader_id = ${user.id} OR m.secretary_id = ${user.id} OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.employee_id = ${user.id}))`;
  const mrows = db.all(`SELECT m.* FROM meetings m WHERE ${mv} AND ${mine} AND m.meeting_date >= ? AND m.status NOT IN ('cancelled','closed','approved') ORDER BY m.meeting_date, m.start_time LIMIT 8`, t0);
  out.meetings = mrows.map(m => meetings.listRow(user, m));
  out.next_meeting = out.meetings[0] || null;
  out.meetings_today = out.meetings.filter(m => m.meeting_date === t0);
  out.prep_to_review = out.meetings.filter(m => m.prep_released && !m.is_leader && ['preparation_published', 'ready'].includes(m.status));
  out.tasks = {
    open: db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.priority, t.progress FROM tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status IN ('not_started','in_progress','blocked','pending_review') ORDER BY t.due_date LIMIT 8`, user.id),
    open_count: db.get(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND deleted_at IS NULL AND status IN ('not_started','in_progress','blocked','pending_review')`, user.id).n,
    overdue_count: db.get(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND deleted_at IS NULL AND due_date < ? AND status IN ('not_started','in_progress','blocked','pending_review')`, user.id, t0).n,
    to_review: db.all(`SELECT t.id, t.code, t.title, o.name owner_name FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.status = 'pending_review' AND t.deleted_at IS NULL AND (t.reviewer_id = ? OR (t.reviewer_id IS NULL AND o.manager_id = ?)) LIMIT 8`, user.id, user.id),
  };
  out.my_kpis = db.all(`SELECT * FROM kpis k WHERE k.deleted_at IS NULL AND k.approval_status = 'approved' AND (k.employee_id = ? OR k.owner_id = ? OR k.data_owner_id = ?) ORDER BY k.level DESC, k.code LIMIT 12`, user.id, user.id, user.id)
    .map(k => { const kk = kpis.dueKey(k.frequency); const r = kpiEngine.getResult(k.id, kk); return { id: k.id, code: k.code, name: k.name, unit: k.unit, level: k.level, period_key: kk, actual: r?.actual ?? null, target: r?.target ?? k.target, achievement: r?.achievement ?? null, status: r?.status || 'missing', data_quality: r?.data_quality || 'missing' }; });
  out.kpi_updates_required = require('./kpis') && db.all(`SELECT * FROM kpis WHERE deleted_at IS NULL AND approval_status = 'approved' AND data_source IN ('manual','spreadsheet','api','other') AND kpi_type <> 'formula' AND COALESCE(data_owner_id, owner_id) = ?`, user.id)
    .map(k => { const kk = kpis.dueKey(k.frequency); const r = kpiEngine.getResult(k.id, kk); return { id: k.id, name: k.name, period_key: kk, r }; }).filter(x => !x.r || x.r.actual === null || x.r.data_quality === 'draft').map(x => ({ id: x.id, name: x.name, period_key: x.period_key, state: !x.r || x.r.actual === null ? 'missing' : 'draft' }));
  const sc = perf.scorecard({ type: 'employee', id: user.id }, key);
  const raw = db.get(`SELECT a.stage FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = ?`, key, user.id);
  out.performance = { period_key: key, calculated_score: sc.calculated_score, previous: perf.scorecard({ type: 'employee', id: user.id }, periods.prevKey(key)).calculated_score, components: sc.components.filter(c => c.key !== 'manager_assessment').map(c => ({ key: c.key, label: c.label, score: c.score, weight: c.weight })) };
  out.checkin = db.get('SELECT status FROM checkins WHERE employee_id = ? AND period_key = ?', user.id, key) || { status: 'none' };
  out.notifications = db.all('SELECT id, title, body, link, event, created_at, read_at FROM notifications WHERE employee_id = ? ORDER BY id DESC LIMIT 6', user.id);
  out.unread = db.get('SELECT COUNT(*) n FROM notifications WHERE employee_id = ? AND read_at IS NULL', user.id).n;

  if (rbac.isManagerRole(user) || user.isHR) {
    const team = H.teamCache ? null : null;
    const reports = db.all(`SELECT * FROM employees WHERE active = 1 AND deleted_at IS NULL AND manager_id = ?`, user.id);
    const rows = reports.map(e => {
      const s = perf.scorecard({ type: 'employee', id: e.id }, key);
      const od = db.get(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND deleted_at IS NULL AND due_date < ? AND status IN ('not_started','in_progress','pending_review','blocked')`, e.id, t0).n;
      const red = db.get(`SELECT COUNT(*) n FROM kpis k JOIN kpi_results r ON r.kpi_id = k.id WHERE k.employee_id = ? AND r.period_key = ? AND r.status = 'red' AND r.data_quality IN ('submitted','verified','approved')`, e.id, kpis.dueKey('monthly')).n;
      const attention = []; if (s.calculated_score !== null && s.calculated_score < setting('attention_score_below', 70)) attention.push('درجة منخفضة'); if (od >= 2) attention.push(`${od} مهام متأخرة`); if (red) attention.push(`${red} KPI أحمر`);
      return { id: e.id, name: e.name, job_title: e.job_title, score: s.calculated_score, overdue: od, red, attention };
    });
    const scored = rows.filter(r => r.score !== null);
    const sc2 = user.scopeIds.length ? user.scopeIds.join(',') : 'NULL';
    out.manager = {
      team_count: rows.length, team_score: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length * 10) / 10 : null, needs_attention: rows.filter(r => r.attention.length),
      overdue_team_tasks: db.all(`SELECT t.id, t.code, t.title, t.due_date, o.name owner_name, t.priority FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.deleted_at IS NULL AND t.due_date < ? AND t.status IN ('not_started','in_progress','pending_review','blocked') AND (o.manager_id = ? OR o.org_unit_id IN (${sc2})) AND o.id <> ? AND ${rbac.taskVisibilitySql(user)} ORDER BY t.due_date LIMIT 8`, t0, user.id, user.id),
      red_kpis: db.all(`SELECT k.id, k.code, k.name, r.achievement, r.period_key FROM kpis k JOIN kpi_results r ON r.kpi_id = k.id WHERE r.status = 'red' AND r.data_quality IN ('submitted','verified','approved') AND r.period_key IN (?, ?, ?) AND k.deleted_at IS NULL AND k.approval_status <> 'retired' AND k.level <> 'employee' AND k.org_unit_id IN (${sc2}) ORDER BY r.achievement LIMIT 8`, kpis.dueKey('monthly'), kpis.dueKey('quarterly'), kpis.dueKey('annual')),
      pending_checkins: db.get(`SELECT COUNT(*) n FROM checkins c JOIN employees e ON e.id = c.employee_id WHERE e.manager_id = ? AND c.status = 'submitted'`, user.id).n,
      pending_assessments: db.get(`SELECT COUNT(*) n FROM employees e WHERE e.manager_id = ? AND e.active = 1 AND NOT EXISTS (SELECT 1 FROM assessments a JOIN performance_periods p ON p.id = a.period_id WHERE p.key = ? AND a.employee_id = e.id)`, user.id, kpis.dueKey('monthly')).n,
      team_meetings: db.all(`SELECT m.* FROM meetings m WHERE ${mv} AND m.meeting_date >= ? AND m.status NOT IN ('cancelled','closed','approved') AND m.type IN ('department','business_unit') ORDER BY m.meeting_date LIMIT 5`, t0).map(m => meetings.listRow(user, m)),
    };
  }
  if (user.isExec || user.isHR || user.system_role === 'business_unit_manager') {
    const company = [...rbac.orgs().values()].find(o => o.kind === 'company' && (user.isExec || user.isHR ? true : user.company_id === o.id));
    const cid = user.isExec || user.isHR ? company.id : user.bu_id;
    const root = perf.scorecard({ type: user.isExec || user.isHR ? 'company' : 'business_unit', id: cid }, key);
    const bus = rbac.orgs().get(company.id).children.map(id => rbac.orgs().get(id)).filter(o => o.kind === 'business_unit' && (user.isExec || user.isHR || rbac.inScope(user, o.id)));
    const fin = targets.canSeeFin(user) ? (() => { const fk = kpis.dueKey('monthly'); const rows = db.all(`SELECT * FROM financial_targets WHERE period_key = ? AND actual IS NOT NULL`, fk).filter(r => targets.visibleOrg(user, r.org_unit_id)).map(targets.row); const rev = rows.filter(r => r.metric === 'revenue'); const tgt = rev.reduce((a, r) => a + r.target_base, 0), act = rev.reduce((a, r) => a + r.actual_base, 0); return { period_key: fk, revenue_target: tgt, revenue_actual: act, achievement: tgt ? Math.round(act / tgt * 1000) / 10 : null, major: rows.filter(r => r.major).length }; })() : null;
    const kp = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN r.status = 'green' THEN 1 ELSE 0 END) g, SUM(CASE WHEN r.status = 'amber' THEN 1 ELSE 0 END) a, SUM(CASE WHEN r.status = 'red' THEN 1 ELSE 0 END) r, AVG(MIN(r.achievement, 120)) avg FROM kpis k JOIN kpi_results r ON r.kpi_id = k.id WHERE k.deleted_at IS NULL AND k.approval_status <> 'retired' AND k.level <> 'employee' AND r.period_key = ? AND r.data_quality IN ('verified','approved')`, kpis.dueKey('monthly'));
    const ts = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) done, SUM(CASE WHEN status = 'completed' AND substr(completed_at,1,10) <= due_date THEN 1 ELSE 0 END) ontime, SUM(CASE WHEN due_date < ? AND status IN ('not_started','in_progress','pending_review','blocked') THEN 1 ELSE 0 END) overdue FROM tasks WHERE deleted_at IS NULL AND status <> 'cancelled' AND due_date BETWEEN ? AND ? AND confidentiality <> 'board'`, t0, periods.parseKey(key).start, periods.parseKey(key).end);
    const dec = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status IN ('implemented','closed') THEN 1 ELSE 0 END) done FROM decisions WHERE deleted_at IS NULL AND status <> 'cancelled' AND confidentiality <> 'board'`);
    const att = cache.memo(`att:${user.id}`, 15000, () => attentionItems(user));
    out.executive = {
      scope_name: user.isExec || user.isHR ? company.name : rbac.orgs().get(user.bu_id).name, performance: { score: root.performance_score ?? root.calculated_score, previous: perf.scorecard({ type: user.isExec || user.isHR ? 'company' : 'business_unit', id: cid }, periods.prevKey(key)).performance_score },
      financial: fin, kpi: { total: kp.n, green: kp.g || 0, amber: kp.a || 0, red: kp.r || 0, avg_achievement: kp.avg ? Math.round(kp.avg * 10) / 10 : null },
      tasks: { total: ts.n, completion_pct: ts.n ? Math.round((ts.done || 0) / ts.n * 100) : null, on_time_pct: ts.done ? Math.round((ts.ontime || 0) / ts.done * 100) : null, overdue: ts.overdue || 0 },
      decisions: { total: dec.n, executed_pct: dec.n ? Math.round((dec.done || 0) / dec.n * 100) : null, unimplemented: att.filter(i => i.type === 'decision_not_implemented').length },
      initiatives_at_risk: db.all(`SELECT i.id, i.code, i.title, i.progress FROM initiatives i WHERE i.status = 'at_risk' AND ${rbac.initiativeVisibilitySql(user)}`),
      bu: bus.map(b => { const s = perf.scorecard({ type: 'business_unit', id: b.id }, key); const p = perf.scorecard({ type: 'business_unit', id: b.id }, periods.prevKey(key)); return { id: b.id, name: b.name, score: s.performance_score ?? s.calculated_score, previous: p.performance_score ?? p.calculated_score }; }),
      attention_top: att.slice(0, 5), attention_total: att.length, critical_overdue: att.filter(i => i.type === 'overdue_task').slice(0, 5),
    };
  }
  return out;
}
H.get('/api/home', ({ user }) => home(user));

module.exports = { attentionItems };
