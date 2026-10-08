'use strict';
// auth + organization + employees
const db = require('../db');
const H = require('../http');
const auth = require('../auth');
const rbac = require('../rbac');
const audit = require('../audit');
const { need, bad, forbidden, notFound, conflict, nowIso, pick } = require('../util');

const COOKIE = (v, maxAge) => `sid=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.HTTPS === '1' ? '; Secure' : ''}`;

function meDto(u) {
  const org = rbac.orgs();
  const nm = id => (id && org.get(id) ? org.get(id).name : null);
  return {
    id: u.id, emp_no: u.emp_no, name: u.name, job_title: u.job_title, email: u.email, system_role: u.system_role,
    roles: [...u.roles], org_unit: nm(u.org_unit_id), dept: nm(u.dept_id), bu: nm(u.bu_id), company: nm(u.company_id),
    is_board: u.isBoard, is_admin: u.isAdmin, is_exec: u.isExec, is_hr: u.isHR, is_manager: rbac.isManagerRole(u),
    scope_count: u.scopeIds.length, manager_id: u.manager_id,
    // أعلام للواجهة فقط؛ التحقق الفعلي يتم في الخادم
    can: {
      create_meeting: rbac.isManagerRole(u) || rbac.has(u, 'meeting_leader', 'meeting_secretary', 'board_secretary'),
      manage_kpis: rbac.isSeniorManager(u) || rbac.has(u, 'kpi_owner'),
      manage_periods: u.isExec || u.isHR,
      admin: u.isAdmin, import: u.isAdmin || u.isHR || u.isExec, assign_others: rbac.isManagerRole(u),
      see_team: rbac.isManagerRole(u) || u.isHR, see_attention: rbac.isManagerRole(u) && u.rank >= 3 || u.isExec || u.isHR,
      see_executive: u.isExec || u.isHR || rbac.has(u, 'business_unit_manager'),
    },
  };
}
const empRow = e => ({ id: e.id, emp_no: e.emp_no, name: e.name, job_title: e.job_title, email: e.email, phone: e.phone, org_unit_id: e.org_unit_id, company_id: e.company_id, bu_id: e.bu_id, dept_id: e.dept_id, team_id: e.team_id, manager_id: e.manager_id, functional_manager_id: e.functional_manager_id, active: e.active, system_role: e.system_role, scope_org_id: e.scope_org_id, can_login: e.can_login, mfa_enabled: e.mfa_enabled, is_demo: e.is_demo });

// ----- auth -----
H.post('/api/auth/login', { public: true }, ({ body, ip, req, res }) => {
  const token = auth.login(body, ip, req.headers['user-agent']);
  const u = auth.userFromToken(token);
  return { user: meDto(u), __headers: { 'Set-Cookie': COOKIE(token, auth.SESSION_HOURS * 3600) } };
});
H.post('/api/auth/logout', { public: true }, ({ cookies }) => { auth.logout(cookies.sid); return { ok: true, __headers: { 'Set-Cookie': COOKIE('', 0) } }; });
H.get('/api/auth/me', ({ user }) => meDto(user));
H.post('/api/auth/forgot', { public: true }, ({ body, ip }) => {
  auth.rateLimit('forgot:' + ip, 10, 60000);
  const t = auth.requestReset(body.email);
  // في وضع Demo فقط نعيد الرمز لتجربة المسار بدون بريد حقيقي
  return { ok: true, message: 'إذا كان البريد مسجلًا فسيصلك رابط إعادة التعيين.', demo_token: process.env.DEMO_MODE === '1' ? t : undefined };
});
H.post('/api/auth/reset', { public: true }, ({ body }) => { auth.resetPassword(body.token, body.password); return { ok: true }; });
H.post('/api/auth/change-password', ({ user, body }) => { auth.changePassword(user, body.current, body.password); return { ok: true }; });
H.get('/api/auth/demo-accounts', { public: true }, () => {
  if (process.env.DEMO_MODE !== '1') return [];
  return db.all(`SELECT email, name, job_title, system_role FROM employees WHERE is_demo = 1 AND can_login = 1 AND email IN ('mahmoud@fasttrade.demo','sami@fasttrade.demo','tarek@fasttrade.demo','omar@fasttrade.demo','layla@fasttrade.demo','admin@fasttrade.demo','rana@fasttrade.demo') ORDER BY id`);
});

// ----- org -----
H.get('/api/org/tree', ({ user }) => {
  const m = rbac.orgs();
  return [...m.values()].map(o => ({ id: o.id, parent_id: o.parent_id, kind: o.kind, name: o.name, code: o.code, currency: o.currency }));
});
H.get('/api/directory', ({ user }) => {
  const q = db.all('SELECT id, name, job_title, org_unit_id, dept_id, bu_id, company_id, team_id, manager_id FROM employees WHERE active = 1 AND deleted_at IS NULL ORDER BY name');
  return q;
});
H.post('/api/org/units', ({ user, body }) => {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const d = need(body, { code: 'str:req', name: 'str:req', kind: 'enum:req:group|company|business_unit|department|team', parent_id: 'int', currency: 'str' });
  if (db.get('SELECT 1 x FROM org_units WHERE code = ?', d.code)) throw conflict('رمز الوحدة مستخدم بالفعل.');
  if (d.kind !== 'group' && !d.parent_id) throw bad('الوحدة التنظيمية تحتاج وحدة أب.');
  const id = db.insert('org_units', { ...d, currency: d.currency || 'EGP', created_at: nowIso(), updated_at: nowIso() });
  rbac.invalidateOrg(); audit.log(user.id, 'org_unit', id, 'create');
  return { id };
});

// ----- employees -----
function withLineage(d) { return { ...d, ...rbac.lineage(d.org_unit_id) }; }
H.get('/api/employees', ({ user, query }) => {
  let rows = db.all('SELECT * FROM employees WHERE deleted_at IS NULL ORDER BY emp_no');
  if (!(user.isAdmin || user.isHR)) rows = rows.filter(e => rbac.canSeeEmployee(user, e));
  if (query.q) rows = rows.filter(e => (e.name + e.emp_no + e.email).toLowerCase().includes(query.q.toLowerCase()));
  if (query.active === '1' || query.status === 'active') rows = rows.filter(e => e.active);
  if (query.status === 'archived') rows = rows.filter(e => !e.active);
  if (query.dept_id) rows = rows.filter(e => String(e.dept_id) === query.dept_id);
  const org = rbac.orgs();
  const names = new Map(db.all('SELECT id, name FROM employees').map(r => [r.id, r.name]));
  return rows.map(e => ({ ...empRow(e), org_name: org.get(e.org_unit_id)?.name, manager_name: names.get(e.manager_id) || null }));
});
H.get('/api/employees/:id', ({ user, params }) => {
  const e = db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', params.id);
  if (!e || !rbac.canSeeEmployee(user, e)) throw notFound();
  const grants = (user.isAdmin || user.isHR) ? db.all('SELECT role, org_unit_id FROM employee_grants WHERE employee_id = ?', e.id) : undefined;
  return { ...empRow(e), grants };
});
const EMP_SPEC = { emp_no: 'str:req', name: 'str:req', job_title: 'str:req', email: 'str:req', phone: 'str', org_unit_id: 'int:req', manager_id: 'int', functional_manager_id: 'int', active: 'bool' };
function checkEmp(d, id) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) throw bad('البريد الإلكتروني غير صحيح.', { email: 'بريد غير صحيح' });
  if (db.get('SELECT 1 x FROM employees WHERE lower(email) = lower(?) AND id <> ?', d.email, id || 0)) throw conflict('يوجد موظف بنفس البريد الإلكتروني.', 'DUPLICATE');
  if (db.get('SELECT 1 x FROM employees WHERE emp_no = ? AND id <> ?', d.emp_no, id || 0)) throw conflict('رقم الموظف مستخدم بالفعل.', 'DUPLICATE');
  if (!rbac.orgs().has(d.org_unit_id)) throw bad('الوحدة التنظيمية غير موجودة.');
  if (d.manager_id && id && d.manager_id === id) throw bad('لا يمكن أن يكون الموظف مديرًا لنفسه.');
}
H.post('/api/employees', ({ user, body }) => createEmployee(user, body));
function createEmployee(user, body) {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const d = need(body, EMP_SPEC); checkEmp(d);
  const id = db.insert('employees', { ...withLineage(d), active: d.active ?? 1, system_role: 'employee', can_login: 0, created_at: nowIso(), updated_at: nowIso() });
  audit.log(user.id, 'employee', id, 'create', 'emp_no', null, d.emp_no);
  return { id };
}
H.put('/api/employees/:id', ({ user, params, body }) => {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const e = db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', params.id); if (!e) throw notFound();
  const d = need({ ...e, ...body }, EMP_SPEC); checkEmp(d, e.id);
  if (e.active && d.active === 0) {
    const open = db.get(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, e.id).n;
    const kpis = db.get(`SELECT COUNT(*) n FROM kpis WHERE (owner_id = ? OR data_owner_id = ?) AND deleted_at IS NULL AND approval_status <> 'retired'`, e.id, e.id).n;
    if (open || kpis) throw conflict(`لا يمكن إيقاف الموظف: لديه ${open} مهمة مفتوحة و${kpis} مؤشر KPI مسؤول عنه. أعد إسنادها أولًا.`, 'HAS_OPEN_WORK');
    auth.revokeAll(e.id);
  }
  const upd = { ...withLineage(d), updated_at: nowIso() };
  audit.diff(user.id, 'employee', e.id, e, upd, ['name', 'job_title', 'org_unit_id', 'manager_id', 'active', 'email']);
  db.update('employees', e.id, upd);
  return { ok: true };
});
// الأدوار والنطاق وتمكين الدخول: لمدير النظام فقط، وكلها تُدقَّق
H.put('/api/employees/:id/access', ({ user, params, body }) => {
  rbac.requireRole(user, 'system_admin');
  const e = db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', params.id); if (!e) throw notFound();
  const d = need(body, { system_role: 'enum:req:employee|team_leader|department_manager|business_unit_manager|executive|hr_admin|system_admin', scope_org_id: 'int', can_login: 'bool' });
  if (e.id === user.id && d.system_role !== e.system_role) throw forbidden('لا يمكنك تغيير دورك بنفسك.');
  db.tx(() => {
    audit.diff(user.id, 'employee_access', e.id, e, d, ['system_role', 'scope_org_id', 'can_login'], body.reason);
    db.update('employees', e.id, { ...d, updated_at: nowIso() });
    if (Array.isArray(body.grants)) {
      const old = db.all('SELECT role, org_unit_id FROM employee_grants WHERE employee_id = ?', e.id);
      db.run('DELETE FROM employee_grants WHERE employee_id = ?', e.id);
      for (const g of body.grants) db.insert('employee_grants', { employee_id: e.id, role: g.role, org_unit_id: g.org_unit_id || null, created_at: nowIso() });
      audit.log(user.id, 'employee_access', e.id, 'update', 'grants', old, body.grants, body.reason);
    }
    if (d.system_role !== e.system_role || d.can_login === 0) auth.revokeAll(e.id);   // تطبيق الصلاحيات الجديدة فورًا
    if (body.new_password) { auth.checkPolicy(body.new_password); db.update('employees', e.id, { password_hash: auth.hashPassword(body.new_password) }); audit.log(user.id, 'employee_access', e.id, 'password_set'); }
  });
  return { ok: true };
});

// ----- الهيكل التنظيمي: تعديل الاسم وحذف الوحدات الفارغة -----
H.put('/api/org/units/:id', ({ user, params, body }) => {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const o = db.get('SELECT * FROM org_units WHERE id = ? AND deleted_at IS NULL', params.id); if (!o) throw notFound();
  const d = need({ ...o, ...body }, { name: 'str:req', name_en: 'str', currency: 'str' });
  if (d.currency && !db.get('SELECT 1 x FROM fx_rates WHERE currency = ?', d.currency)) throw bad('العملة غير معرّفة.');
  audit.diff(user.id, 'org_unit', o.id, o, d, ['name', 'currency']);
  db.update('org_units', o.id, { name: d.name, name_en: d.name_en, currency: d.currency || o.currency, updated_at: nowIso() });
  rbac.invalidateOrg();
  return { ok: true };
});
H.del('/api/org/units/:id', ({ user, params }) => {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const o = db.get('SELECT * FROM org_units WHERE id = ? AND deleted_at IS NULL', params.id); if (!o) throw notFound();
  const used = db.get(`SELECT (SELECT COUNT(*) FROM org_units WHERE parent_id = ? AND deleted_at IS NULL) + (SELECT COUNT(*) FROM employees WHERE org_unit_id = ?)
    + (SELECT COUNT(*) FROM kpis WHERE org_unit_id = ?) + (SELECT COUNT(*) FROM financial_targets WHERE org_unit_id = ?) n`, o.id, o.id, o.id, o.id).n;
  if (used) throw conflict('لا يمكن حذف الوحدة: تحتوي وحدات فرعية أو موظفين أو مؤشرات أو أهداف. انقلها أولًا.', 'IN_USE');
  db.update('org_units', o.id, { deleted_at: nowIso(), updated_at: nowIso() });
  rbac.invalidateOrg(); audit.log(user.id, 'org_unit', o.id, 'delete', 'name', o.name, null);
  return { ok: true };
});

// ----- الأرشفة والاستعادة والحذف للموظفين -----
function workload(id) {
  const n = (sql, ...p) => db.get(sql, ...p).n;
  return {
    open_tasks: n(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, id),
    reviews: n(`SELECT COUNT(*) n FROM tasks WHERE reviewer_id = ? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, id),
    kpis: n(`SELECT COUNT(*) n FROM kpis WHERE (owner_id = ? OR data_owner_id = ?) AND deleted_at IS NULL AND approval_status <> 'retired'`, id, id),
    initiatives: n(`SELECT COUNT(*) n FROM initiatives WHERE owner_id = ? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, id),
    meetings_led: n(`SELECT COUNT(*) n FROM meetings WHERE leader_id = ? AND status IN ('draft','preparation','preparation_published','ready') AND deleted_at IS NULL`, id),
    reports: n(`SELECT COUNT(*) n FROM employees WHERE manager_id = ? AND active = 1 AND deleted_at IS NULL`, id),
  };
}
const totalWork = w => Object.values(w).reduce((a, b) => a + b, 0);
function loadEmpForAdmin(user, id) {
  rbac.requireRole(user, 'system_admin', 'hr_admin');
  const e = db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', id); if (!e) throw notFound('الموظف غير موجود.');
  if (e.id === user.id) throw forbidden('لا يمكنك تنفيذ هذا الإجراء على حسابك.');
  return e;
}
H.get('/api/employees/:id/workload', ({ user, params }) => { const e = loadEmpForAdmin(user, params.id); return workload(e.id); });
H.post('/api/employees/:id/archive', ({ user, params, body }) => {
  const e = loadEmpForAdmin(user, params.id);
  if (!e.active) throw conflict('الموظف مؤرشف بالفعل.');
  const w = workload(e.id);
  const to = body.reassign_to ? db.get('SELECT * FROM employees WHERE id = ? AND active = 1 AND deleted_at IS NULL', body.reassign_to) : null;
  if (body.reassign_to && (!to || to.id === e.id)) throw bad('الموظف البديل غير صحيح أو غير نشط.', { reassign_to: 'غير صحيح' });
  if (totalWork(w) && !to) throw new (require('../util').HttpError)(409, 'لدى الموظف أعمال مفتوحة. اختر موظفًا بديلًا لنقلها إليه قبل الأرشفة.', 'HAS_OPEN_WORK', w);
  db.tx(() => {
    if (to) {
      const why = `أرشفة ${e.name}`;
      for (const t of db.all(`SELECT id FROM tasks WHERE owner_id = ? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, e.id)) {
        db.update('tasks', t.id, { owner_id: to.id, company_id: to.company_id, bu_id: to.bu_id, dept_id: to.dept_id, updated_at: nowIso() });
        db.insert('task_events', { task_id: t.id, actor_id: user.id, action: 'owner_changed', note: `${why} — نُقلت إلى ${to.name}`, created_at: nowIso() });
        audit.log(user.id, 'task', t.id, 'update', 'owner_id', e.id, to.id, why);
      }
      db.run(`UPDATE tasks SET reviewer_id = ?, updated_at = ? WHERE reviewer_id = ? AND status NOT IN ('completed','cancelled')`, to.id === e.id ? null : to.id, nowIso(), e.id);
      db.run(`UPDATE tasks SET reviewer_id = NULL WHERE reviewer_id = owner_id`);
      db.run(`UPDATE kpis SET owner_id = ?, updated_at = ? WHERE owner_id = ? AND approval_status <> 'retired'`, to.id, nowIso(), e.id);
      db.run(`UPDATE kpis SET data_owner_id = ?, updated_at = ? WHERE data_owner_id = ? AND approval_status <> 'retired'`, to.id, nowIso(), e.id);
      db.run(`UPDATE initiatives SET owner_id = ?, updated_at = ? WHERE owner_id = ? AND status NOT IN ('completed','cancelled')`, to.id, nowIso(), e.id);
      for (const m of db.all(`SELECT id FROM meetings WHERE leader_id = ? AND status IN ('draft','preparation','preparation_published','ready')`, e.id)) {
        db.update('meetings', m.id, { leader_id: to.id, updated_at: nowIso() });
        db.run('INSERT OR IGNORE INTO meeting_participants(meeting_id, employee_id, invitation) VALUES (?,?,?)', m.id, to.id, 'accepted');
      }
      db.run('UPDATE employees SET manager_id = ?, updated_at = ? WHERE manager_id = ? AND id <> ?', to.id, nowIso(), e.id, to.id);
      audit.log(user.id, 'employee', e.id, 'reassign_work', 'reassign_to', null, to.id, JSON.stringify(w));
    }
    db.update('employees', e.id, { active: 0, can_login: 0, updated_at: nowIso() });
    auth.revokeAll(e.id);
    audit.log(user.id, 'employee', e.id, 'archive', 'active', 1, 0, body.reason || null);
  });
  return { ok: true, moved: to ? w : null };
});
H.post('/api/employees/:id/restore', ({ user, params, body }) => {
  const e = loadEmpForAdmin(user, params.id);
  if (e.active) throw conflict('الموظف نشط بالفعل.');
  db.update('employees', e.id, { active: 1, can_login: e.password_hash ? 1 : 0, failed_logins: 0, locked_until: null, updated_at: nowIso() });
  audit.log(user.id, 'employee', e.id, 'restore', 'active', 0, 1, body.reason || null);
  return { ok: true };
});
// الحذف النهائي مسموح فقط لموظف بلا أي سجل (أُضيف بالخطأ مثلًا). غير ذلك: أرشفة للحفاظ على التاريخ.
H.del('/api/employees/:id', ({ user, params }) => {
  const e = loadEmpForAdmin(user, params.id);
  const refs = db.get(`SELECT
    (SELECT COUNT(*) FROM tasks WHERE owner_id = :i OR reviewer_id = :i OR created_by = :i) + (SELECT COUNT(*) FROM task_contributors WHERE employee_id = :i)
    + (SELECT COUNT(*) FROM task_evidence WHERE submitted_by = :i) + (SELECT COUNT(*) FROM task_events WHERE actor_id = :i)
    + (SELECT COUNT(*) FROM meetings WHERE leader_id = :i OR secretary_id = :i OR created_by = :i) + (SELECT COUNT(*) FROM meeting_participants WHERE employee_id = :i)
    + (SELECT COUNT(*) FROM decisions WHERE owner_id = :i OR created_by = :i) + (SELECT COUNT(*) FROM minutes WHERE approved_by = :i)
    + (SELECT COUNT(*) FROM kpis WHERE owner_id = :i OR data_owner_id = :i OR reviewer_id = :i OR employee_id = :i)
    + (SELECT COUNT(*) FROM kpi_results WHERE updated_by = :i OR verified_by = :i) + (SELECT COUNT(*) FROM financial_targets WHERE updated_by = :i)
    + (SELECT COUNT(*) FROM initiatives WHERE owner_id = :i OR sponsor_id = :i)
    + (SELECT COUNT(*) FROM assessments WHERE employee_id = :i OR assessed_by = :i OR approved_by = :i) + (SELECT COUNT(*) FROM assessment_stages WHERE actor_id = :i)
    + (SELECT COUNT(*) FROM checkins WHERE employee_id = :i) + (SELECT COUNT(*) FROM period_adjustments WHERE created_by = :i)
    + (SELECT COUNT(*) FROM scorecard_configs WHERE updated_by = :i) + (SELECT COUNT(*) FROM performance_periods WHERE locked_by = :i)
    + (SELECT COUNT(*) FROM attachments WHERE uploaded_by = :i) + (SELECT COUNT(*) FROM employees WHERE manager_id = :i OR functional_manager_id = :i) n`.replace(/:i/g, String(Number(e.id)))).n;
  if (refs) throw conflict(`لا يمكن حذف الموظف نهائيًا لأن له ${refs} سجلًا مرتبطًا (اجتماعات، مهام، مؤشرات أو تقييمات). استخدم الأرشفة للحفاظ على التاريخ.`, 'HAS_HISTORY');
  db.tx(() => {
    for (const t of ['employee_grants', 'sessions', 'password_resets', 'notifications', 'notification_prefs']) db.run(`DELETE FROM ${t} WHERE employee_id = ?`, e.id);
    db.run('DELETE FROM employees WHERE id = ?', e.id);
    audit.log(user.id, 'employee', e.id, 'delete', 'emp_no', `${e.emp_no} — ${e.name}`, null);
  });
  return { ok: true };
});

module.exports = { meDto, createEmployee };
