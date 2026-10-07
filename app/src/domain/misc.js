'use strict';
// notifications · search · trace · audit · integrations · settings
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const notify = require('../notify');
const integ = require('../integrations');
const audit = require('../audit');
const kpis = require('./kpis');
const { need, bad, forbidden, notFound, nowIso, setting } = require('../util');

// ---------- Notifications ----------
H.get('/api/notifications', ({ user, query }) => {
  const rows = db.all(`SELECT * FROM notifications WHERE employee_id = ? ${query.unread === '1' ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, user.id, Math.min(Number(query.limit) || 50, 200));
  return { items: rows.map(r => ({ ...r, event_ar: notify.EVENTS[r.event] })), unread: db.get('SELECT COUNT(*) n FROM notifications WHERE employee_id = ? AND read_at IS NULL', user.id).n };
});
H.get('/api/notifications/count', ({ user }) => ({ unread: db.get('SELECT COUNT(*) n FROM notifications WHERE employee_id = ? AND read_at IS NULL', user.id).n }));
H.post('/api/notifications/read', ({ user, body }) => {
  if (body.all) db.run('UPDATE notifications SET read_at = ? WHERE employee_id = ? AND read_at IS NULL', nowIso(), user.id);
  else if (Array.isArray(body.ids) && body.ids.length) db.run(`UPDATE notifications SET read_at = ? WHERE employee_id = ? AND read_at IS NULL AND id IN (${db.ph(body.ids)})`, nowIso(), user.id, ...body.ids);
  return { ok: true };
});
H.get('/api/notification-prefs', ({ user }) => Object.entries(notify.EVENTS).map(([event, label]) => ({ event, label, critical: notify.CRITICAL.has(event), ...(({ in_app, email, push }) => ({ in_app, email, push }))(db.get('SELECT * FROM notification_prefs WHERE employee_id = ? AND event = ?', user.id, event) || { in_app: 1, email: 0, push: 0 }) })));
H.put('/api/notification-prefs', ({ user, body }) => {
  for (const p of body.prefs || []) {
    if (!notify.EVENTS[p.event]) continue;
    const inApp = notify.CRITICAL.has(p.event) ? 1 : (p.in_app ? 1 : 0);
    db.run(`INSERT INTO notification_prefs(employee_id, event, in_app, email, push) VALUES (?,?,?,?,?) ON CONFLICT(employee_id, event) DO UPDATE SET in_app = excluded.in_app, email = excluded.email, push = excluded.push`, user.id, p.event, inApp, p.email ? 1 : 0, p.push ? 1 : 0);
  }
  return { ok: true };
});

// ---------- Global search (يحترم الصلاحيات) ----------
H.get('/api/search', ({ user, query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 2) return { groups: [] };
  const like = `%${q}%`; const groups = [];
  const meet = db.all(`SELECT m.id, m.code, m.title, m.meeting_date FROM meetings m WHERE ${rbac.meetingVisibilitySql(user)} AND (m.title LIKE ? OR m.code LIKE ? OR m.objective LIKE ?) ORDER BY m.meeting_date DESC LIMIT 6`, like, like, like);
  if (meet.length) groups.push({ type: 'meeting', label: 'الاجتماعات', items: meet.map(m => ({ id: m.id, title: m.title, sub: `${m.code} · ${m.meeting_date}`, link: `#/meetings/${m.id}` })) });
  const dec = db.all(`SELECT d.*, m.type mtype, m.dept_id mdept, m.bu_id mbu, m.company_id mco, m.confidentiality mconf, m.leader_id, m.secretary_id FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.deleted_at IS NULL AND (d.text LIKE ? OR d.code LIKE ?) ORDER BY d.id DESC LIMIT 40`, like, like)
    .filter(d => rbac.canSeeDecision(user, d, { id: d.meeting_id, type: d.mtype, dept_id: d.mdept, bu_id: d.mbu, company_id: d.mco, confidentiality: d.mconf, leader_id: d.leader_id, secretary_id: d.secretary_id })).slice(0, 6);
  if (dec.length) groups.push({ type: 'decision', label: 'القرارات', items: dec.map(d => ({ id: d.id, title: d.text.slice(0, 80), sub: d.code, link: `#/decisions/${d.id}` })) });
  const tasks = db.all(`SELECT t.id, t.code, t.title, t.due_date FROM tasks t WHERE ${rbac.taskVisibilitySql(user)} AND (t.title LIKE ? OR t.code LIKE ?) ORDER BY t.id DESC LIMIT 6`, like, like);
  if (tasks.length) groups.push({ type: 'task', label: 'المهام', items: tasks.map(t => ({ id: t.id, title: t.title, sub: `${t.code} · ${t.due_date}`, link: `#/tasks/${t.id}` })) });
  const kp = db.all(`SELECT k.id, k.code, k.name FROM kpis k WHERE ${rbac.kpiVisibilitySql(user)} AND (k.name LIKE ? OR k.code LIKE ?) LIMIT 6`, like, like);
  if (kp.length) groups.push({ type: 'kpi', label: 'مؤشرات الأداء', items: kp.map(k => ({ id: k.id, title: k.name, sub: k.code, link: `#/kpis/${k.id}` })) });
  const ini = db.all(`SELECT i.id, i.code, i.title FROM initiatives i WHERE ${rbac.initiativeVisibilitySql(user)} AND (i.title LIKE ? OR i.code LIKE ?) LIMIT 6`, like, like);
  if (ini.length) groups.push({ type: 'initiative', label: 'المبادرات', items: ini.map(i => ({ id: i.id, title: i.title, sub: i.code, link: `#/initiatives/${i.id}` })) });
  if (rbac.isManagerRole(user) || user.isHR || user.isAdmin) {
    const emps = db.all(`SELECT * FROM employees WHERE deleted_at IS NULL AND (name LIKE ? OR emp_no LIKE ? OR email LIKE ?) LIMIT 30`, like, like, like).filter(e => rbac.canSeeEmployee(user, e)).slice(0, 6);
    if (emps.length) groups.push({ type: 'employee', label: 'الموظفون', items: emps.map(e => ({ id: e.id, title: e.name, sub: `${e.emp_no} · ${e.job_title}`, link: user.isAdmin ? '#/admin/employees' : `#/performance/employee/${e.id}` })) });
  }
  return { groups };
});

// ---------- Trace: KPI ↔ Meeting ↔ Decision ↔ Task ↔ Evidence (كل عقدة تُصفّى حسب الصلاحية) ----------
H.get('/api/trace/:type/:id', ({ user, params }) => {
  const nodes = []; const edges = []; const seen = new Set();
  const add = (type, id, label, sub, link, status) => { const k = `${type}:${id}`; if (!seen.has(k)) { seen.add(k); nodes.push({ key: k, type, id, label, sub, link, status }); } return k; };
  const edge = (a, b, label) => edges.push({ from: a, to: b, label });
  const kpiNode = id => { const k = db.get('SELECT * FROM kpis WHERE id = ?', id); if (!k || !rbac.canSeeKpi(user, k)) return null; const r = db.get('SELECT * FROM kpi_results WHERE kpi_id = ? AND actual IS NOT NULL ORDER BY period_start DESC LIMIT 1', id); return add('kpi', k.id, k.name, r ? `${r.period_key} · ${r.achievement}%` : k.code, `#/kpis/${k.id}`, r?.status); };
  const meetNode = id => { const m = db.get('SELECT * FROM meetings WHERE id = ?', id); if (!m || !rbac.canSeeMeeting(user, m)) return null; return add('meeting', m.id, m.title, `${m.code} · ${m.meeting_date}`, `#/meetings/${m.id}`, m.status); };
  const decNode = id => { const d = db.get('SELECT * FROM decisions WHERE id = ?', id); if (!d) return null; const m = db.get('SELECT * FROM meetings WHERE id = ?', d.meeting_id); if (!rbac.canSeeDecision(user, d, m)) return null; return add('decision', d.id, d.text.slice(0, 70), d.code, `#/decisions/${d.id}`, d.status); };
  const taskNode = id => { const t = db.get('SELECT t.*, o.name oname FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.id = ?', id); if (!t || !rbac.canSeeTask(user, t)) return null; return add('task', t.id, t.title, `${t.code} · ${t.oname} · ${t.due_date}`, `#/tasks/${t.id}`, t.status); };
  const iniNode = id => { const i = db.get(`SELECT * FROM initiatives i WHERE i.id = ? AND ${rbac.initiativeVisibilitySql(user)}`, id); return i ? add('initiative', i.id, i.title, i.code, `#/initiatives/${i.id}`, i.status) : null; };
  const link = (a, b, l) => { if (a && b) edge(a, b, l); };
  const expandTask = t => {
    const tn = taskNode(t.id); if (!tn) return;
    if (t.decision_id) link(decNode(t.decision_id), tn, 'ينتج عنه');
    if (t.meeting_id) link(meetNode(t.meeting_id), t.decision_id ? decNode(t.decision_id) : tn, t.decision_id ? 'يصدر عنه' : 'ينتج عنه');
    if (t.kpi_id) link(kpiNode(t.kpi_id), tn, 'سبب إنشائها');
    if (t.initiative_id) link(tn, iniNode(t.initiative_id), 'ضمن');
    for (const ev of db.all('SELECT note FROM task_evidence WHERE task_id = ? ORDER BY id DESC LIMIT 2', t.id)) { const en = add('evidence', `${t.id}-${ev.note.slice(0, 8)}`, ev.note.slice(0, 60), 'Evidence', `#/tasks/${t.id}`, 'done'); edge(tn, en, 'دليل'); }
  };
  const id = Number(params.id);
  if (params.type === 'task') { const t = db.get('SELECT * FROM tasks WHERE id = ?', id); if (!t || !rbac.canSeeTask(user, t)) throw notFound(); expandTask(t); if (t.agenda_item_id) { const a = db.get('SELECT * FROM agenda_items WHERE id = ?', t.agenda_item_id); if (a && a.related_kpi_id) link(kpiNode(a.related_kpi_id), t.meeting_id ? meetNode(t.meeting_id) : null, 'جدول في'); } }
  else if (params.type === 'kpi') {
    const k = db.get('SELECT * FROM kpis WHERE id = ?', id); if (!k || !rbac.canSeeKpi(user, k)) throw notFound(); kpiNode(id);
    for (const a of db.all('SELECT * FROM agenda_items WHERE related_kpi_id = ?', id)) { const mn = meetNode(a.meeting_id); link(kpiNode(id), mn, 'جدول في'); }
    for (const t of db.all('SELECT * FROM tasks WHERE kpi_id = ? AND deleted_at IS NULL', id)) expandTask(t);
    for (const d of db.all('SELECT d.id FROM decisions d JOIN agenda_items a ON a.id = d.agenda_item_id WHERE a.related_kpi_id = ?', id)) { const dn = decNode(d.id); const dd = db.get('SELECT meeting_id FROM decisions WHERE id = ?', d.id); link(meetNode(dd.meeting_id), dn, 'قرار'); }
  } else if (params.type === 'decision') {
    const d = db.get('SELECT * FROM decisions WHERE id = ?', id); const m = d && db.get('SELECT * FROM meetings WHERE id = ?', d.meeting_id); if (!d || !rbac.canSeeDecision(user, d, m)) throw notFound();
    const dn = decNode(id); link(meetNode(d.meeting_id), dn, 'قرار');
    if (d.agenda_item_id) { const a = db.get('SELECT * FROM agenda_items WHERE id = ?', d.agenda_item_id); if (a?.related_kpi_id) link(kpiNode(a.related_kpi_id), meetNode(d.meeting_id), 'جدول في'); }
    for (const t of db.all('SELECT * FROM tasks WHERE decision_id = ? AND deleted_at IS NULL', id)) expandTask(t);
  } else if (params.type === 'meeting') {
    const m = db.get('SELECT * FROM meetings WHERE id = ?', id); if (!m || !rbac.canSeeMeeting(user, m)) throw notFound(); meetNode(id);
    for (const a of db.all('SELECT * FROM agenda_items WHERE meeting_id = ? AND related_kpi_id IS NOT NULL', id)) link(kpiNode(a.related_kpi_id), meetNode(id), 'جدول في');
    for (const d of db.all('SELECT id FROM decisions WHERE meeting_id = ? AND deleted_at IS NULL', id)) link(meetNode(id), decNode(d.id), 'قرار');
    for (const t of db.all('SELECT * FROM tasks WHERE meeting_id = ? AND deleted_at IS NULL', id)) expandTask(t);
  } else throw notFound();
  return { nodes, edges };
});

// ---------- Audit (لمدير النظام وHR) ----------
H.get('/api/audit', ({ user, query }) => {
  if (!(user.isAdmin || user.isHR)) throw forbidden('سجل التدقيق لمدير النظام أو HR.');
  const w = []; const p = [];
  if (query.entity) { w.push('a.entity = ?'); p.push(query.entity); }
  if (query.entity_id) { w.push('a.entity_id = ?'); p.push(query.entity_id); }
  if (query.user_id) { w.push('a.user_id = ?'); p.push(query.user_id); }
  if (query.action) { w.push('a.action = ?'); p.push(query.action); }
  const limit = Math.min(Number(query.limit) || 100, 500), offset = Number(query.offset) || 0;
  const total = db.get(`SELECT COUNT(*) n FROM audit_log a ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`, ...p).n;
  // المستخدم HR لا يرى سجلات الأمان (الجلسات/الصلاحيات)
  const items = db.all(`SELECT a.*, e.name user_name FROM audit_log a LEFT JOIN employees e ON e.id = a.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).filter(a => user.isAdmin || !['session', 'employee_access'].includes(a.entity));
  return { total, items };
});
H.get('/api/audit/entity/:entity/:id', ({ user, params }) => {
  // تاريخ تغييرات سجل بعينه لمن يستطيع رؤيته (مهمة/KPI/اجتماع)
  const ok = { task: () => rbac.canSeeTask(user, db.get('SELECT * FROM tasks WHERE id = ?', params.id)), kpi: () => rbac.canSeeKpi(user, db.get('SELECT * FROM kpis WHERE id = ?', params.id) || {}), meeting: () => { const m = db.get('SELECT * FROM meetings WHERE id = ?', params.id); return m && rbac.canSeeMeeting(user, m); } }[params.entity];
  if (!ok || !ok()) throw notFound();
  return db.all('SELECT a.ts, a.action, a.field, a.old_value, a.new_value, a.reason, e.name user_name FROM audit_log a LEFT JOIN employees e ON e.id = a.user_id WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT 100', params.entity, params.id);
});

// ---------- Integrations / Settings ----------
H.get('/api/integrations', ({ user }) => integ.list());
H.get('/api/settings', ({ user }) => {
  if (!(user.isAdmin || user.isExec || user.isHR)) throw forbidden();
  return db.all('SELECT key, value, description FROM settings ORDER BY key').map(s => ({ ...s, value: JSON.parse(s.value) }));
});
const SETTING_RULES = { prep_release_hours: v => Number.isInteger(v) && v > 0 && v <= 336, kpi_grace_days: v => Number.isInteger(v) && v >= 0 && v <= 30, fin_variance_threshold_pct: v => typeof v === 'number' && v > 0 && v <= 100, score_cap: v => typeof v === 'number' && v >= 100 && v <= 200, calibration_enabled: v => typeof v === 'boolean', attention_score_below: v => typeof v === 'number' && v > 0 && v <= 100, final_rating_approvers: v => Array.isArray(v) && v.length && v.every(r => ['executive', 'hr_admin', 'business_unit_manager'].includes(r)) };
H.put('/api/settings/:key', ({ user, params, body }) => {
  if (!(user.isAdmin || user.isExec || user.isHR)) throw forbidden();
  const rule = SETTING_RULES[params.key]; if (!rule) throw notFound('إعداد غير معروف أو غير قابل للتعديل.');
  if (!rule(body.value)) throw bad('قيمة الإعداد غير صحيحة.');
  const old = db.get('SELECT value FROM settings WHERE key = ?', params.key);
  db.run('INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', params.key, JSON.stringify(body.value), nowIso());
  audit.log(user.id, 'setting', 0, 'update', params.key, old?.value, JSON.stringify(body.value), body.reason);
  return { ok: true };
});
H.get('/api/health', { public: true }, () => ({ ok: true, time: nowIso() }));
