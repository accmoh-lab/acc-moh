'use strict';
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const notify = require('../notify');
const { need, bad, forbidden, notFound, nowIso, code, today } = require('../util');

const ST_AR = { planned: 'مخططة', active: 'نشطة', at_risk: 'معرضة للخطر', completed: 'مكتملة', cancelled: 'ملغاة' };
const empName = id => (id ? db.get('SELECT name FROM employees WHERE id = ?', id)?.name : null);
function load(user, id) {
  const i = db.get(`SELECT * FROM initiatives i WHERE i.id = ? AND ${rbac.initiativeVisibilitySql(user)}`, id);
  if (!i) throw notFound('المبادرة غير موجودة.');
  return i;
}
const canEdit = (u, i) => !u.isAdmin && (i.owner_id === u.id || i.sponsor_id === u.id || u.isExec || (rbac.isManagerRole(u) && u.rank >= 3 && rbac.inScope(u, i.org_unit_id)));
function row(i) {
  const tasks = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) done, SUM(CASE WHEN due_date < ? AND status IN ('not_started','in_progress','pending_review','blocked') THEN 1 ELSE 0 END) overdue FROM tasks WHERE initiative_id = ? AND deleted_at IS NULL`, today(), i.id);
  return { ...i, status_ar: ST_AR[i.status], owner_name: empName(i.owner_id), sponsor_name: empName(i.sponsor_id), org_name: rbac.orgs().get(i.org_unit_id)?.name, tasks_total: tasks.n, tasks_done: tasks.done || 0, tasks_overdue: tasks.overdue || 0 };
}
H.get('/api/initiatives', ({ user, query }) => {
  const rows = db.all(`SELECT * FROM initiatives i WHERE ${rbac.initiativeVisibilitySql(user)} ${query.status ? 'AND i.status = ?' : ''} ORDER BY CASE i.status WHEN 'at_risk' THEN 0 WHEN 'active' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, i.target_date`, ...(query.status ? [query.status] : []));
  return { total: rows.length, items: rows.map(row) };
});
H.get('/api/initiatives/:id', ({ user, params }) => {
  const i = load(user, params.id);
  return {
    ...row(i), can_edit: canEdit(user, i),
    kpis: db.all(`SELECT k.id, k.code, k.name FROM initiative_kpis x JOIN kpis k ON k.id = x.kpi_id WHERE x.initiative_id = ?`, i.id).filter(k => rbac.canSeeKpi(user, db.get('SELECT * FROM kpis WHERE id = ?', k.id))),
    meetings: db.all(`SELECT m.id, m.code, m.title, m.meeting_date, m.status FROM initiative_meetings x JOIN meetings m ON m.id = x.meeting_id WHERE x.initiative_id = ? AND ${rbac.meetingVisibilitySql(user)}`, i.id),
    decisions: db.all(`SELECT d.id, d.code, d.text, d.status, d.meeting_id FROM initiative_decisions x JOIN decisions d ON d.id = x.decision_id WHERE x.initiative_id = ?`, i.id).filter(d => { const dd = db.get('SELECT * FROM decisions WHERE id = ?', d.id); return rbac.canSeeDecision(user, dd, db.get('SELECT * FROM meetings WHERE id = ?', dd.meeting_id)); }),
    tasks: db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.progress, o.name owner_name FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.initiative_id = ? AND ${rbac.taskVisibilitySql(user)} ORDER BY t.due_date`, i.id),
  };
});
const SPEC = { title: 'str:req', objective: 'str', owner_id: 'int:req', sponsor_id: 'int', org_unit_id: 'int', start_date: 'date', target_date: 'date', status: 'enum:opt:planned|active|at_risk|completed|cancelled', progress: 'int', expected_impact: 'str', actual_impact: 'str', risk_note: 'str' };
function check(d) {
  if (d.start_date && d.target_date && d.start_date > d.target_date) throw bad('تاريخ البدء بعد التاريخ المستهدف.');
  if (d.progress !== null && (d.progress < 0 || d.progress > 100)) throw bad('نسبة التقدم بين 0 و100.');
  if (!db.get('SELECT 1 x FROM employees WHERE id = ? AND active = 1', d.owner_id)) throw bad('مالك المبادرة غير موجود.');
  if (d.status === 'at_risk' && !d.risk_note) throw bad('اذكر سبب الخطر (Risk Note) عند وضع المبادرة At Risk.', { risk_note: 'مطلوب' });
}
function links(id, body) {
  const set = (tbl, col, ids) => { if (!Array.isArray(ids)) return; db.run(`DELETE FROM ${tbl} WHERE initiative_id = ?`, id); for (const x of ids) db.run(`INSERT OR IGNORE INTO ${tbl}(initiative_id, ${col}) VALUES (?,?)`, id, x); };
  set('initiative_kpis', 'kpi_id', body.kpi_ids); set('initiative_meetings', 'meeting_id', body.meeting_ids); set('initiative_decisions', 'decision_id', body.decision_ids);
}
H.post('/api/initiatives', ({ user, body }) => {
  if (!(user.isExec || (rbac.isManagerRole(user) && user.rank >= 3))) throw forbidden('إنشاء المبادرات لمديري الأقسام فأعلى.');
  const d = need({ status: 'planned', progress: 0, ...body }, SPEC); check(d);
  return db.tx(() => { const id = db.insert('initiatives', { ...d, code: code('INI'), created_at: nowIso(), updated_at: nowIso() }); links(id, body); audit.log(user.id, 'initiative', id, 'create'); return { id }; });
});
H.put('/api/initiatives/:id', ({ user, params, body }) => {
  const i = load(user, params.id); if (!canEdit(user, i)) throw forbidden();
  const d = need({ ...i, ...body }, SPEC); check(d);
  db.tx(() => {
    audit.diff(user.id, 'initiative', i.id, i, d, ['status', 'progress', 'owner_id', 'target_date'], body.reason);
    db.update('initiatives', i.id, { ...d, updated_at: nowIso() }); links(i.id, body);
    if (d.status === 'at_risk' && i.status !== 'at_risk') for (const to of [i.sponsor_id, i.owner_id]) if (to && to !== user.id) notify.send(to, 'initiative_at_risk', `مبادرة معرضة للخطر: ${i.title}`, d.risk_note, `#/initiatives/${i.id}`, `ini:${i.id}:${today()}`);
  });
  return { ok: true };
});
module.exports = { ST_AR };
