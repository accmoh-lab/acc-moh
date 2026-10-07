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
  if (query.active === '1') rows = rows.filter(e => e.active);
  if (query.dept_id) rows = rows.filter(e => String(e.dept_id) === query.dept_id);
  const org = rbac.orgs();
  return rows.map(e => ({ ...empRow(e), org_name: org.get(e.org_unit_id)?.name, manager_name: rows.find(x => x.id === e.manager_id)?.name || null }));
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
    const kpis = db.get('SELECT COUNT(*) n FROM kpis WHERE (owner_id = ? OR data_owner_id = ?) AND deleted_at IS NULL', e.id, e.id).n;
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

module.exports = { meDto, createEmployee };
