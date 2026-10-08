'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const notify = require('../notify');
const { need, bad, forbidden, notFound, conflict, nowIso, today, addDays, code, pick, diffDays } = require('../util');

const OPEN = ['not_started', 'in_progress', 'pending_review', 'blocked'];
const STATUS_AR = { not_started: 'لم تبدأ', in_progress: 'قيد التنفيذ', pending_review: 'بانتظار المراجعة', completed: 'مكتملة', blocked: 'معطّلة', cancelled: 'ملغاة' };
const SOURCE_AR = { meeting: 'اجتماع', management: 'الإدارة', kpi: 'KPI', initiative: 'مبادرة', operational: 'تشغيلية', project: 'مشروع', recurring: 'متكررة', corrective_action: 'إجراء تصحيحي' };
const FLOW = {
  not_started: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['not_started', 'blocked', 'completed', 'cancelled'],
  pending_review: [],                                    // يخرج منها بالمراجعة فقط
  blocked: ['in_progress', 'not_started', 'cancelled'],
  completed: ['in_progress'],                            // إعادة فتح للمدير فقط
  cancelled: ['not_started'],
};
const emp = id => db.get('SELECT * FROM employees WHERE id = ?', id);

function dto(t) {
  const overdue = OPEN.includes(t.status) && t.due_date < today();
  return { ...t, status_ar: STATUS_AR[t.status], source_ar: SOURCE_AR[t.source], overdue, days_overdue: overdue ? diffDays(today(), t.due_date) : 0 };
}
function loadTask(user, id, { manage = false } = {}) {
  const t = db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', id);
  if (!t || !rbac.canSeeTask(user, t)) throw notFound('المهمة غير موجودة.');
  if (manage && !canManage(user, t)) throw forbidden('تعديل هذه المهمة متاح لمسؤولها أو لمدير ضمن نطاقه.');
  return t;
}
function isManagerOf(user, t) {
  if (!rbac.isManagerRole(user)) return false;
  const o = emp(t.owner_id);
  return (o && (o.manager_id === user.id || rbac.inScope(user, o.org_unit_id))) || rbac.inScope(user, t.dept_id || t.bu_id || t.company_id);
}
function canManage(user, t) {
  return t.owner_id === user.id || t.created_by === user.id && !t.reviewer_id || isManagerOf(user, t)
    || !!db.get('SELECT 1 x FROM task_contributors WHERE task_id = ? AND employee_id = ?', t.id, user.id);
}
const canAssignTo = (user, ownerId) => {
  if (ownerId === user.id) return true;
  const o = emp(ownerId); if (!o) return false;
  return rbac.isManagerRole(user) && (o.manager_id === user.id || rbac.inScope(user, o.org_unit_id));
};
function logEvent(t, user, action, from, to, note) {
  db.insert('task_events', { task_id: t.id, actor_id: user ? user.id : null, action, from_status: from, to_status: to, note: note || null, created_at: nowIso() });
}
function blockers(taskId) {
  return db.all(`SELECT t.id, t.code, t.title, t.status, d.reason, d.expected_resolution FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
    WHERE d.task_id = ? AND t.status NOT IN ('completed','cancelled') AND t.deleted_at IS NULL`, taskId);
}

// ---------- القائمة ----------
function buildWhere(user, query) {
  const w = [rbac.taskVisibilitySql(user)]; const p = [];
  const view = query.view;
  if (view === 'my') { w.push(`(t.owner_id = ? OR EXISTS (SELECT 1 FROM task_contributors c WHERE c.task_id = t.id AND c.employee_id = ?))`); p.push(user.id, user.id); }
  else if (view === 'team') {
    if (!rbac.isManagerRole(user)) throw forbidden();
    w.push(`t.owner_id IN (SELECT id FROM employees WHERE (manager_id = ? OR org_unit_id IN (${user.scopeIds.join(',') || 'NULL'})) AND id <> ?)`); p.push(user.id, user.id);
  } else if (view === 'department') {
    if (!rbac.isManagerRole(user)) throw forbidden();
    const dept = Number(query.dept_id) || user.dept_id; const ids = rbac.subtree(dept).filter(i => user.isHR || user.scopeSet.has(i));
    w.push(`t.dept_id IN (${ids.join(',') || 'NULL'})`);
  } else if (view === 'business_unit') {
    if (user.rank < 4 && !user.isHR) throw forbidden();
    const bu = Number(query.bu_id) || user.bu_id; w.push('t.bu_id = ?'); p.push(bu);
  } else if (view === 'management') {
    if (user.rank < 3 && !user.isHR) throw forbidden();
    w.push(`(t.source IN ('management','kpi','initiative','corrective_action') OR t.meeting_id IN (SELECT id FROM meetings WHERE type IN ('management','board','committee','cross_functional')))`);
  }
  const eq = (col, v) => { if (v) { w.push(`${col} = ?`); p.push(v); } };
  eq('t.owner_id', query.owner_id); eq('t.dept_id', view === 'department' ? null : query.dept_id); eq('t.bu_id', view === 'business_unit' ? null : query.bu_id);
  eq('t.priority', query.priority); eq('t.source', query.source); eq('t.kpi_id', query.kpi_id); eq('t.meeting_id', query.meeting_id); eq('t.initiative_id', query.initiative_id);
  if (query.status) { const s = query.status.split(',').filter(x => STATUS_AR[x]); if (s.length) { w.push(`t.status IN (${db.ph(s)})`); p.push(...s); } }
  if (query.due_from) { w.push('t.due_date >= ?'); p.push(query.due_from); }
  if (query.due_to) { w.push('t.due_date <= ?'); p.push(query.due_to); }
  if (query.overdue === '1') { w.push(`t.due_date < ? AND t.status IN ('not_started','in_progress','pending_review','blocked')`); p.push(today()); }
  if (query.q) { w.push('(t.title LIKE ? OR t.code LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
  return { where: w.join(' AND '), p };
}
H.get('/api/tasks', ({ user, query }) => {
  const { where, p } = buildWhere(user, query);
  const limit = Math.min(Number(query.limit) || 100, 500), offset = Number(query.offset) || 0;
  const total = db.get(`SELECT COUNT(*) n FROM tasks t WHERE ${where}`, ...p).n;
  const rows = db.all(`SELECT t.*, o.name owner_name, r.name reviewer_name, k.code kpi_code, m.code meeting_code, i.code initiative_code,
      (SELECT COUNT(*) FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_id WHERE d.task_id = t.id AND b.status NOT IN ('completed','cancelled')) blocked_by_count
    FROM tasks t JOIN employees o ON o.id = t.owner_id LEFT JOIN employees r ON r.id = t.reviewer_id LEFT JOIN kpis k ON k.id = t.kpi_id LEFT JOIN meetings m ON m.id = t.meeting_id LEFT JOIN initiatives i ON i.id = t.initiative_id
    WHERE ${where} ORDER BY CASE WHEN t.status IN ('completed','cancelled') THEN 1 ELSE 0 END, t.due_date ASC, t.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  return { total, items: rows.map(dto) };
});
H.get('/api/tasks/summary', ({ user, query }) => {
  const { where, p } = buildWhere(user, query);
  const r = db.all(`SELECT t.status, COUNT(*) n, SUM(CASE WHEN t.due_date < ? AND t.status IN ('not_started','in_progress','pending_review','blocked') THEN 1 ELSE 0 END) overdue FROM tasks t WHERE ${where} GROUP BY t.status`, today(), ...p);
  const by = Object.fromEntries(r.map(x => [x.status, x.n]));
  return { total: r.reduce((a, x) => a + x.n, 0), by_status: by, overdue: r.reduce((a, x) => a + (x.overdue || 0), 0) };
});

// ---------- الإنشاء ----------
const SPEC = {
  title: 'str:req', description: 'str', source: 'enum:opt:meeting|management|kpi|initiative|operational|project|recurring|corrective_action', source_ref: 'str',
  meeting_id: 'int', decision_id: 'int', agenda_item_id: 'int', kpi_id: 'int', initiative_id: 'int',
  owner_id: 'int:req', reviewer_id: 'int', priority: 'enum:opt:low|medium|high|critical', weight: 'int', start_date: 'date', due_date: 'date:req',
  evidence_required: 'bool', requires_approval: 'bool', recurrence: 'enum:opt:none|daily|weekly|monthly|quarterly|custom', recurrence_interval_days: 'int',
};
function validateTask(user, d, t) {
  if (d.start_date && d.start_date > d.due_date) throw bad('تاريخ البدء لا يمكن أن يكون بعد تاريخ الاستحقاق.', { due_date: 'قبل تاريخ البدء' });
  if (d.weight !== null && (d.weight < 1 || d.weight > 10)) throw bad('الوزن بين 1 و10.', { weight: 'غير صحيح' });
  const owner = emp(d.owner_id);
  if (!owner || !owner.active) throw bad('مسؤول المهمة غير موجود أو غير نشط.', { owner_id: 'اختر موظفًا نشطًا' });
  if (!t || t.owner_id !== d.owner_id) if (!canAssignTo(user, d.owner_id)) throw forbidden('يمكنك إسناد المهام لنفسك أو لموظفي نطاقك فقط.');
  if (d.requires_approval) {
    d.reviewer_id = d.reviewer_id || owner.manager_id;
    if (!d.reviewer_id) throw bad('المهمة تتطلب اعتمادًا ويجب تحديد مراجع.', { reviewer_id: 'مطلوب' });
  }
  if (d.reviewer_id && d.reviewer_id === d.owner_id) throw bad('المراجع يجب أن يكون شخصًا آخر غير المسؤول.', { reviewer_id: 'غير صحيح' });
  if (d.reviewer_id && !emp(d.reviewer_id)) throw bad('المراجع غير موجود.');
  if (d.recurrence === 'custom' && !(d.recurrence_interval_days > 0)) throw bad('حدّد عدد أيام التكرار المخصص.');
  return owner;
}
H.post('/api/tasks', ({ user, body }) => createTask(user, body));
function createTask(user, body) {
  const d = need({ source: 'operational', priority: 'medium', weight: 1, recurrence: 'none', evidence_required: false, requires_approval: false, ...body }, SPEC);
  const owner = validateTask(user, d);
  let m = null;
  if (d.meeting_id) {
    m = db.get('SELECT * FROM meetings WHERE id = ?', d.meeting_id);
    if (!m || !rbac.canSeeMeeting(user, m)) throw bad('الاجتماع غير موجود.');
    if (!rbac.canEditMeeting(user, m) && !(user.rank >= 3)) throw forbidden('إنشاء مهام من الاجتماع لقائده أو سكرتيره.');
    d.source = d.source === 'operational' ? 'meeting' : d.source;
  }
  if (d.decision_id && !db.get('SELECT 1 x FROM decisions WHERE id = ?', d.decision_id)) throw bad('القرار غير موجود.');
  if (d.kpi_id && !db.get('SELECT 1 x FROM kpis WHERE id = ?', d.kpi_id)) throw bad('KPI غير موجود.');
  if (d.initiative_id && !db.get('SELECT 1 x FROM initiatives WHERE id = ?', d.initiative_id)) throw bad('المبادرة غير موجودة.');
  if (d.agenda_item_id && !db.get('SELECT 1 x FROM agenda_items WHERE id = ?', d.agenda_item_id)) throw bad('بند الأجندة غير موجود.');
  const id = db.tx(() => {
    const series = d.recurrence !== 'none' ? crypto.randomBytes(4).toString('hex') : null;
    const tid = db.insert('tasks', {
      ...d, code: code('TSK'), company_id: owner.company_id, bu_id: owner.bu_id, dept_id: owner.dept_id, approval_status: d.requires_approval ? 'none' : 'none',
      confidentiality: m && rbac.isBoardMeeting(m) ? 'board' : (m ? m.confidentiality : 'normal'),
      series_id: series, occurrence_no: series ? 1 : null, source: series && d.source === 'operational' ? 'recurring' : d.source,
      status: 'not_started', progress: 0, created_by: user.id, created_at: nowIso(), updated_at: nowIso(),
    });
    for (const c of body.contributor_ids || []) db.run('INSERT OR IGNORE INTO task_contributors(task_id, employee_id) VALUES (?,?)', tid, c);
    logEvent({ id: tid }, user, 'created', null, 'not_started');
    audit.log(user.id, 'task', tid, 'create', 'owner_id', null, d.owner_id);
    if (d.owner_id !== user.id) notify.send(d.owner_id, 'task_assigned', `أُسندت إليك مهمة: ${d.title}`, `الاستحقاق ${d.due_date}`, `#/tasks/${tid}`);
    if (d.decision_id) db.run(`UPDATE decisions SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'open'`, nowIso(), d.decision_id);
    return tid;
  });
  return { id, code: db.get('SELECT code FROM tasks WHERE id = ?', id).code };
}

// ---------- التفاصيل ----------
H.get('/api/tasks/:id', ({ user, params }) => {
  const t = loadTask(user, params.id);
  const name = id => (id ? emp(id)?.name : null);
  const mgr = canManage(user, t);
  const isReviewer = t.reviewer_id === user.id || (!t.reviewer_id && isManagerOf(user, t));
  const trace = {
    meeting: t.meeting_id ? db.get('SELECT m.id, m.code, m.title, m.meeting_date, m.status, m.type FROM meetings m WHERE m.id = ?', t.meeting_id) : null,
    agenda: t.agenda_item_id ? db.get('SELECT id, topic, seq FROM agenda_items WHERE id = ?', t.agenda_item_id) : null,
    decision: t.decision_id ? db.get('SELECT id, code, text, status FROM decisions WHERE id = ?', t.decision_id) : null,
    kpi: t.kpi_id ? db.get('SELECT id, code, name FROM kpis WHERE id = ?', t.kpi_id) : null,
    initiative: t.initiative_id ? db.get('SELECT id, code, title, status FROM initiatives WHERE id = ?', t.initiative_id) : null,
  };
  if (trace.meeting) { const mm = db.get('SELECT * FROM meetings WHERE id = ?', t.meeting_id); if (!rbac.canSeeMeeting(user, mm)) trace.meeting = { restricted: true }; }
  if (trace.decision) { const dd = db.get('SELECT * FROM decisions WHERE id = ?', t.decision_id); const mm = db.get('SELECT * FROM meetings WHERE id = ?', dd.meeting_id); if (!rbac.canSeeDecision(user, dd, mm)) trace.decision = { restricted: true }; }
  if (trace.kpi) { const kk = db.get('SELECT * FROM kpis WHERE id = ?', t.kpi_id); if (!rbac.canSeeKpi(user, kk)) trace.kpi = { restricted: true }; }
  return {
    ...dto(t), owner_name: name(t.owner_id), reviewer_name: name(t.reviewer_id), created_by_name: name(t.created_by),
    dept_name: rbac.orgs().get(t.dept_id)?.name, contributors: db.all('SELECT e.id, e.name FROM task_contributors c JOIN employees e ON e.id = c.employee_id WHERE c.task_id = ?', t.id),
    blocked_by: blockers(t.id),
    blocking: db.all(`SELECT b.id, b.code, b.title, b.status, d.reason FROM task_dependencies d JOIN tasks b ON b.id = d.task_id WHERE d.depends_on_id = ? AND b.deleted_at IS NULL`, t.id),
    dependencies_all: db.all('SELECT depends_on_id id, reason, expected_resolution FROM task_dependencies WHERE task_id = ?', t.id),
    evidence: db.all(`SELECT ev.id, ev.note, ev.created_at, e.name submitted_by_name, a.id attachment_id, a.filename FROM task_evidence ev JOIN employees e ON e.id = ev.submitted_by LEFT JOIN attachments a ON a.id = ev.attachment_id WHERE ev.task_id = ? ORDER BY ev.id`, t.id),
    events: db.all(`SELECT ev.*, e.name actor_name FROM task_events ev LEFT JOIN employees e ON e.id = ev.actor_id WHERE ev.task_id = ? ORDER BY ev.id`, t.id),
    series: t.series_id ? db.all('SELECT id, code, occurrence_no, due_date, status, completed_at FROM tasks WHERE series_id = ? ORDER BY occurrence_no', t.series_id) : [],
    trace,
    perms: { can_manage: mgr, is_owner: t.owner_id === user.id, can_review: isReviewer && t.status === 'pending_review' && t.owner_id !== user.id, can_edit_all: isManagerOf(user, t) || t.created_by === user.id,
      allowed: allowedFor(user, t) },
  };
});
function allowedFor(user, t) {
  const mgr = isManagerOf(user, t);
  const own = t.owner_id === user.id || !!db.get('SELECT 1 x FROM task_contributors WHERE task_id = ? AND employee_id = ?', t.id, user.id);
  if (!own && !mgr) return [];
  let a = (FLOW[t.status] || []).slice();
  if (t.status === 'completed' && !mgr) a = [];
  if (t.status === 'cancelled' && !mgr) a = [];
  if (t.status === 'in_progress' && (t.requires_approval)) a = a.filter(x => x !== 'completed').concat('submit');
  if (t.status === 'in_progress' && !t.requires_approval && t.evidence_required) a = a.filter(x => x !== 'completed').concat('submit');
  return a.map(x => (x === 'submit' ? 'pending_review' : x));
}

// ---------- التحديث ----------
H.put('/api/tasks/:id', ({ user, params, body }) => {
  const t = loadTask(user, params.id, { manage: true });
  if (t.status === 'completed' || t.status === 'cancelled') throw conflict('لا يمكن تعديل مهمة منتهية. أعد فتحها أولًا.');
  const full = t.created_by === user.id || isManagerOf(user, t);
  const allowedOwner = ['description', 'progress'];
  const d = need({ ...t, ...body }, { ...SPEC, progress: 'int' });
  const upd = {};
  if (full) {
    validateTask(user, d, t);
    Object.assign(upd, pick(d, ['title', 'description', 'priority', 'weight', 'start_date', 'due_date', 'owner_id', 'reviewer_id', 'evidence_required', 'requires_approval', 'kpi_id', 'initiative_id']));
  } else {
    for (const k of Object.keys(body)) if (!allowedOwner.includes(k)) throw forbidden('يمكنك تحديث الوصف ونسبة الإنجاز فقط. التعديلات الأخرى للمدير.');
    if (body.description !== undefined) upd.description = d.description;
  }
  if (body.progress !== undefined) {
    if (!(d.progress >= 0 && d.progress <= 100)) throw bad('نسبة الإنجاز بين 0 و100.');
    if (t.status === 'pending_review') throw conflict('المهمة بانتظار المراجعة؛ لا يمكن تغيير نسبة الإنجاز.');
    upd.progress = d.progress; if (d.progress > 0 && t.status === 'not_started') upd.status = 'in_progress';
  }
  if (upd.due_date && upd.due_date !== t.due_date) { logEvent(t, user, 'due_date_changed', null, null, `${t.due_date} ← ${upd.due_date}`); audit.log(user.id, 'task', t.id, 'update', 'due_date', t.due_date, upd.due_date, body.reason); }
  if (upd.owner_id && upd.owner_id !== t.owner_id) {
    const o = emp(upd.owner_id); Object.assign(upd, { company_id: o.company_id, bu_id: o.bu_id, dept_id: o.dept_id });
    logEvent(t, user, 'owner_changed', null, null, `${t.owner_id} → ${upd.owner_id}`);
    notify.send(upd.owner_id, 'task_assigned', `أُسندت إليك مهمة: ${t.title}`, `الاستحقاق ${upd.due_date || t.due_date}`, `#/tasks/${t.id}`);
  }
  audit.diff(user.id, 'task', t.id, t, upd, ['owner_id', 'priority', 'weight', 'reviewer_id', 'title'], body.reason);
  db.update('tasks', t.id, { ...upd, updated_at: nowIso() });
  return { ok: true };
});

function nextOccurrence(t, actor) {
  if (t.recurrence === 'none' || !t.series_id) return null;
  if (db.get('SELECT 1 x FROM tasks WHERE series_id = ? AND occurrence_no > ?', t.series_id, t.occurrence_no)) return null;
  const add = d => { const x = new Date(d); return x; };
  const step = (s, n, unit) => { const d = new Date(s + 'T00:00:00'); if (unit === 'm') d.setMonth(d.getMonth() + n); else d.setDate(d.getDate() + n); const p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const [n, u] = { daily: [1, 'd'], weekly: [7, 'd'], monthly: [1, 'm'], quarterly: [3, 'm'], custom: [t.recurrence_interval_days || 1, 'd'] }[t.recurrence];
  const due = step(t.due_date, n, u); const start = t.start_date ? step(t.start_date, n, u) : null;
  const id = db.insert('tasks', { ...pick(t, ['title', 'description', 'source', 'source_ref', 'meeting_id', 'decision_id', 'agenda_item_id', 'kpi_id', 'initiative_id', 'owner_id', 'reviewer_id', 'company_id', 'bu_id', 'dept_id', 'priority', 'weight', 'evidence_required', 'requires_approval', 'confidentiality', 'recurrence', 'recurrence_interval_days', 'series_id']), code: code('TSK'), start_date: start, due_date: due, occurrence_no: t.occurrence_no + 1, status: 'not_started', progress: 0, approval_status: 'none', created_by: t.created_by, created_at: nowIso(), updated_at: nowIso() });
  logEvent({ id }, actor, 'created', null, 'not_started', `تكرار تلقائي بعد ${t.code}`);
  notify.send(t.owner_id, 'task_assigned', `مهمة متكررة جديدة: ${t.title}`, `الاستحقاق ${due}`, `#/tasks/${id}`);
  return id;
}

// ---------- الحالة / التسليم / المراجعة ----------
function setStatus(user, t, to, reason, extra = {}) {
  const upd = { status: to, updated_at: nowIso(), ...extra };
  if (to === 'completed') { upd.progress = 100; upd.completed_at = nowIso(); }
  if (t.status === 'completed' && to === 'in_progress') { upd.completed_at = null; upd.approval_status = 'none'; }
  if (to !== 'blocked' && t.status === 'blocked') { upd.blocked_reason = null; upd.expected_resolution = null; }
  db.update('tasks', t.id, upd);
  logEvent(t, user, 'status', t.status, to, reason);
  audit.log(user.id, 'task', t.id, 'status', 'status', t.status, to, reason || null);
  if (to === 'completed') nextOccurrence({ ...t, ...upd }, user);
}
H.post('/api/tasks/:id/status', ({ user, params, body }) => {
  const t = loadTask(user, params.id, { manage: true });
  const to = body.to;
  if (to === 'pending_review') return submitCompletion(user, t, body);
  if (!allowedFor(user, t).includes(to)) throw conflict(`لا يمكن نقل المهمة من «${STATUS_AR[t.status]}» إلى «${STATUS_AR[to]}»${t.status === 'in_progress' && to === 'completed' ? '. هذه المهمة تتطلب تسليم الإنجاز للمراجعة.' : '.'}`, 'BAD_TRANSITION');
  return db.tx(() => {
    const extra = {};
    if (to === 'blocked') {
      if (!body.reason) throw bad('سبب التعطيل مطلوب.', { reason: 'مطلوب' });
      extra.blocked_reason = body.reason; extra.expected_resolution = body.expected_resolution || null;
    }
    if (to === 'cancelled' && !body.reason) throw bad('سبب الإلغاء مطلوب.', { reason: 'مطلوب' });
    if (t.status === 'completed' && to === 'in_progress' && !isManagerOf(user, t)) throw forbidden('إعادة فتح المهمة المكتملة للمدير.');
    if (['in_progress', 'completed'].includes(to)) {
      const b = blockers(t.id);
      if (b.length) throw conflict(`المهمة تعتمد على مهام غير مكتملة: ${b.map(x => x.code).join('، ')}`, 'BLOCKED_BY_DEPENDENCY');
    }
    if (to === 'completed' && t.evidence_required && !db.get('SELECT 1 x FROM task_evidence WHERE task_id = ?', t.id)) throw bad('أرفق دليل الإنجاز (Evidence) قبل إكمال المهمة.', { evidence: 'مطلوب' });
    setStatus(user, t, to, body.reason, extra);
    return { status: to };
  });
});
function submitCompletion(user, t, body) {
  if (!(t.owner_id === user.id || isManagerOf(user, t))) throw forbidden();
  if (!['in_progress', 'not_started'].includes(t.status)) throw conflict('تسليم الإنجاز متاح للمهام قيد التنفيذ فقط.', 'BAD_TRANSITION');
  if (!t.requires_approval && !t.evidence_required) throw conflict('هذه المهمة لا تحتاج مراجعة؛ يمكن إكمالها مباشرة.', 'BAD_TRANSITION');
  const b = blockers(t.id); if (b.length) throw conflict(`المهمة تعتمد على مهام غير مكتملة: ${b.map(x => x.code).join('، ')}`, 'BLOCKED_BY_DEPENDENCY');
  if (t.evidence_required && !db.get('SELECT 1 x FROM task_evidence WHERE task_id = ?', t.id)) throw bad('أرفق دليل الإنجاز (Evidence) قبل التسليم.', { evidence: 'مطلوب' });
  return db.tx(() => {
    if (t.requires_approval) {
      setStatus(user, t, 'pending_review', body.reason, { approval_status: 'pending', progress: 100 });
      notify.send(t.reviewer_id || emp(t.owner_id).manager_id, 'review_required', `مهمة بانتظار مراجعتك: ${t.title}`, null, `#/tasks/${t.id}`, `rev:${t.id}:${Date.now()}`);
    } else setStatus(user, t, 'completed', body.reason);
    return { status: t.requires_approval ? 'pending_review' : 'completed' };
  });
}
H.post('/api/tasks/:id/review', ({ user, params, body }) => {
  const t = loadTask(user, params.id);
  if (t.status !== 'pending_review') throw conflict('المهمة ليست بانتظار المراجعة.');
  const reviewerOk = t.reviewer_id === user.id || (!t.reviewer_id && isManagerOf(user, t));
  if (!reviewerOk) throw forbidden('المراجعة للمراجع المحدد للمهمة فقط.');
  if (t.owner_id === user.id) throw forbidden('لا يمكن مراجعة مهمتك بنفسك.');
  const d = need(body, { decision: 'enum:req:approve|return', reason: 'str' });
  if (d.decision === 'return' && !d.reason) throw bad('سبب الإرجاع مطلوب.', { reason: 'مطلوب' });
  db.tx(() => {
    if (d.decision === 'approve') { setStatus(user, t, 'completed', d.reason, { approval_status: 'approved', return_reason: null }); }
    else {
      setStatus(user, t, 'in_progress', d.reason, { approval_status: 'returned', return_reason: d.reason, progress: Math.min(t.progress, 90) });
      notify.send(t.owner_id, 'task_returned', `أُعيدت المهمة للتعديل: ${t.title}`, d.reason, `#/tasks/${t.id}`, `ret:${t.id}:${Date.now()}`);
    }
  });
  return { ok: true };
});
H.post('/api/tasks/:id/evidence', ({ user, params, body }) => {
  const t = loadTask(user, params.id, { manage: true });
  if (['completed', 'cancelled'].includes(t.status)) throw conflict('المهمة منتهية.');
  const d = need(body, { note: 'str:req', attachment_id: 'int' });
  if (d.attachment_id && !db.get(`SELECT 1 x FROM attachments WHERE id = ? AND entity_type = 'task' AND entity_id = ?`, d.attachment_id, t.id)) throw bad('المرفق غير مرتبط بهذه المهمة.');
  const id = db.insert('task_evidence', { task_id: t.id, note: d.note, attachment_id: d.attachment_id, submitted_by: user.id, created_at: nowIso() });
  logEvent(t, user, 'evidence', null, null, d.note.slice(0, 120));
  return { id };
});
H.put('/api/tasks/:id/dependencies', ({ user, params, body }) => {
  const t = loadTask(user, params.id, { manage: true });
  if (!(t.created_by === user.id || isManagerOf(user, t))) throw forbidden();
  const deps = Array.isArray(body.dependencies) ? body.dependencies : [];
  db.tx(() => {
    for (const d of deps) {
      if (d.depends_on_id === t.id) throw bad('المهمة لا تعتمد على نفسها.');
      const o = db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', d.depends_on_id);
      if (!o || !rbac.canSeeTask(user, o)) throw bad('مهمة الاعتماد غير موجودة.');
      // منع الدورات: هل تعتمد o (مباشرة/غير مباشرة) على t؟
      const seen = new Set(); const st = [o.id];
      while (st.length) { const x = st.pop(); if (x === t.id) throw bad('هذا الاعتماد ينشئ حلقة دائرية بين المهام.'); if (seen.has(x)) continue; seen.add(x); st.push(...db.all('SELECT depends_on_id id FROM task_dependencies WHERE task_id = ?', x).map(r => r.id)); }
    }
    db.run('DELETE FROM task_dependencies WHERE task_id = ?', t.id);
    for (const d of deps) db.insert('task_dependencies', { task_id: t.id, depends_on_id: d.depends_on_id, reason: d.reason || null, expected_resolution: d.expected_resolution || null });
    audit.log(user.id, 'task', t.id, 'update', 'dependencies', null, deps.map(d => d.depends_on_id).join(','));
  });
  return { ok: true };
});
H.post('/api/tasks/:id/next-occurrence', ({ user, params }) => {
  const t = loadTask(user, params.id, { manage: true });
  if (t.recurrence === 'none') throw bad('المهمة ليست متكررة.');
  const id = nextOccurrence(t, user);
  if (!id) throw conflict('يوجد تكرار لاحق بالفعل.');
  return { id };
});

module.exports = { createTask, OPEN, STATUS_AR, SOURCE_AR, dto, isManagerOf };
