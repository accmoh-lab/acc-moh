'use strict';
// RBAC + Scope: الدور وحده لا يكفي؛ كل صلاحية تُقيَّد بنطاق الوصول (Access Scope).
const db = require('./db');
const { forbidden } = require('./util');

// ---------- شجرة المنظمة (مخزّنة مؤقتًا) ----------
let orgCache = null;
function orgs() {
  if (!orgCache) {
    const rows = db.all('SELECT id, parent_id, kind, name, code, currency FROM org_units WHERE deleted_at IS NULL');
    const byId = new Map(rows.map(r => [r.id, { ...r, children: [] }]));
    for (const r of byId.values()) if (r.parent_id && byId.get(r.parent_id)) byId.get(r.parent_id).children.push(r.id);
    orgCache = byId;
  }
  return orgCache;
}
const invalidateOrg = () => { orgCache = null; };
function subtree(id) {
  const m = orgs(); const out = []; const st = [id];
  while (st.length) { const x = st.pop(); if (!m.has(x)) continue; out.push(x); st.push(...m.get(x).children); }
  return out;
}
function ancestors(id) {
  const m = orgs(); const out = []; let x = m.get(id);
  while (x) { out.push(x.id); x = x.parent_id ? m.get(x.parent_id) : null; }
  return out;
}
// قسم/وحدة/شركة لأي عقدة تنظيمية
function lineage(orgId) {
  const m = orgs(); const r = { company_id: null, bu_id: null, dept_id: null, team_id: null };
  for (const id of ancestors(orgId)) {
    const k = m.get(id).kind;
    if (k === 'company') r.company_id = id; else if (k === 'business_unit') r.bu_id = id;
    else if (k === 'department') r.dept_id = id; else if (k === 'team') r.team_id = id;
  }
  return r;
}

// ---------- المستخدم ----------
const ROLE_RANK = { employee: 1, team_leader: 2, department_manager: 3, business_unit_manager: 4, executive: 5, hr_admin: 4, system_admin: 0 };

function loadUser(id) {
  const e = db.get('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', id);
  if (!e || !e.active) return null;
  const grants = db.all('SELECT role, org_unit_id FROM employee_grants WHERE employee_id = ?', id);
  const roleSet = new Set([e.system_role, ...grants.filter(g => g.role !== 'extra_scope').map(g => g.role)]);
  let scopeIds = [];
  const lin = lineage(e.org_unit_id);
  const base = e.scope_org_id
    || (e.system_role === 'team_leader' ? (lin.team_id || e.org_unit_id)
      : e.system_role === 'department_manager' ? (lin.dept_id || e.org_unit_id)
      : e.system_role === 'business_unit_manager' ? (lin.bu_id || e.org_unit_id)
      : e.system_role === 'executive' || e.system_role === 'hr_admin' ? (lin.company_id || e.org_unit_id) : null);
  if (base) scopeIds.push(...subtree(base));
  for (const g of grants) if (g.role === 'extra_scope' && g.org_unit_id) scopeIds.push(...subtree(g.org_unit_id));
  if (e.system_role === 'hr_admin') scopeIds = [...orgs().keys()];            // HR يرى كل الموظفين
  scopeIds = [...new Set(scopeIds)];
  const { password_hash, mfa_secret, ...pub } = e;
  return {
    ...pub, roles: roleSet, scopeIds, scopeSet: new Set(scopeIds),
    lineageIds: ancestors(e.org_unit_id),
    isBoard: roleSet.has('board_member') || roleSet.has('board_secretary'),
    isAdmin: e.system_role === 'system_admin',
    isExec: e.system_role === 'executive', isHR: e.system_role === 'hr_admin',
    rank: ROLE_RANK[e.system_role] ?? 1,
  };
}

const has = (u, ...roles) => roles.some(r => u.roles.has(r));
function requireRole(u, ...roles) { if (!has(u, ...roles)) throw forbidden(); }
const inScope = (u, orgId) => !!orgId && u.scopeSet.has(orgId);
const isManagerRole = u => u.rank >= 2 && !u.isAdmin;           // team leader فأعلى
const isSeniorManager = u => has(u, 'executive', 'business_unit_manager', 'department_manager', 'hr_admin');

// ---------- الموظفون ----------
function canSeeEmployee(u, emp) {
  if (!emp) return false;
  if (u.id === emp.id || u.isAdmin || u.isHR) return true;
  if (emp.manager_id === u.id || emp.functional_manager_id === u.id) return true;
  return isManagerRole(u) && inScope(u, emp.org_unit_id);
}
// من يحق له الاطلاع على تفاصيل الأداء (تقييمات وتعليقات المدير): الموظف نفسه للجزء المعتمد فقط، سلسلة الإدارة، HR
function canReviewPerformanceOf(u, emp) {
  if (!emp || u.isAdmin) return false;                // مدير النظام لا يقرأ التقييمات (فصل المهام)
  if (u.id === emp.id) return false;
  if (u.isHR) return true;
  if (emp.manager_id === u.id) return true;
  if (has(u, 'performance_reviewer') && inScope(u, emp.org_unit_id)) return true;
  return isManagerRole(u) && inScope(u, emp.org_unit_id);
}
function canSeePerformanceOf(u, emp) { return u.id === emp.id || canReviewPerformanceOf(u, emp); }

// ---------- الاجتماعات ----------
const meetingOrg = m => m.dept_id || m.bu_id || m.company_id;
const isBoardMeeting = m => m.type === 'board' || m.confidentiality === 'board';
function meetingRole(u, m, participantIds) {
  const roles = [];
  if (m.leader_id === u.id) roles.push('leader');
  if (m.secretary_id === u.id) roles.push('secretary');
  if (participantIds && participantIds.has(u.id)) roles.push('participant');
  return roles;
}
function participantSet(meetingId) {
  return new Set(db.all('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', meetingId).map(r => r.employee_id));
}
function canSeeMeeting(u, m, parts) {
  if (u.isAdmin) return false;
  parts = parts || participantSet(m.id);
  const mine = meetingRole(u, m, parts).length > 0;
  if (isBoardMeeting(m)) return u.isBoard || mine;     // المدير وحده لا يكفي لحضور Board
  if (mine) return true;
  if (m.confidentiality === 'confidential') return u.isExec && inScope(u, meetingOrg(m));
  return isManagerRole(u) && inScope(u, meetingOrg(m));
}
// هل المستخدم يرى محتوى حساسًا (قرارات/مستندات/مهام) في اجتماع Board؟
const canSeeBoardContent = u => u.isBoard;
function canEditMeeting(u, m) { return m.leader_id === u.id || m.secretary_id === u.id; }

// ---------- فلاتر SQL للقوائم ----------
function taskVisibilitySql(u, alias = 't') {
  const a = alias; const inList = u.scopeIds.length ? u.scopeIds.join(',') : 'NULL';
  const related = `(${a}.owner_id = ${u.id} OR ${a}.reviewer_id = ${u.id} OR ${a}.created_by = ${u.id}
    OR EXISTS (SELECT 1 FROM task_contributors tc WHERE tc.task_id = ${a}.id AND tc.employee_id = ${u.id}))`;
  const scoped = isManagerRole(u)
    ? `(COALESCE(${a}.dept_id, ${a}.bu_id, ${a}.company_id) IN (${inList})
        OR ${a}.owner_id IN (SELECT id FROM employees WHERE org_unit_id IN (${inList}) OR manager_id = ${u.id}))` : '0=1';
  const conf = `(${a}.confidentiality = 'normal'
    OR (${a}.confidentiality = 'confidential' AND (${related} OR (${u.isExec ? 1 : 0} = 1 AND ${scoped})))
    OR (${a}.confidentiality = 'board' AND (${u.isBoard ? 1 : 0} = 1 OR ${a}.owner_id = ${u.id} OR ${a}.reviewer_id = ${u.id})))`;
  return `(${a}.deleted_at IS NULL AND (${related} OR ${u.isAdmin ? '0=1' : scoped}) AND ${conf})`;
}
function canSeeTask(u, t) {
  if (!t || t.deleted_at) return false;
  const row = db.get(`SELECT 1 AS ok FROM tasks t WHERE t.id = ? AND ${taskVisibilitySql(u)}`, t.id);
  return !!row;
}
function meetingVisibilitySql(u, alias = 'm') {
  const a = alias; const sc = u.scopeIds.length ? u.scopeIds.join(',') : 'NULL';
  if (u.isAdmin) return '0=1';
  const mine = `(${a}.leader_id = ${u.id} OR ${a}.secretary_id = ${u.id}
    OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = ${a}.id AND p.employee_id = ${u.id}))`;
  const inScopeSql = `COALESCE(${a}.dept_id, ${a}.bu_id, ${a}.company_id) IN (${sc})`;
  const isBoardSql = `(${a}.type = 'board' OR ${a}.confidentiality = 'board')`;
  // Board: بالدور فقط (board_member/board_secretary) أو بدعوة مباشرة؛ نطاق المدير لا يكفي
  return `(${a}.deleted_at IS NULL AND (
     (${isBoardSql} AND (${u.isBoard ? 1 : 0} = 1 OR ${mine}))
     OR (NOT ${isBoardSql} AND (${mine}
         OR (${isManagerRole(u) ? 1 : 0} = 1 AND ${a}.confidentiality = 'normal' AND ${inScopeSql})
         OR (${u.isExec ? 1 : 0} = 1 AND ${a}.confidentiality = 'confidential' AND ${inScopeSql})))))`;
}

// ---------- KPI ----------
function canSeeKpi(u, k) {
  if (u.isAdmin) return true;                                   // الإعدادات فقط (لا نتائج حساسة للأفراد)
  if ([k.owner_id, k.data_owner_id, k.reviewer_id, k.employee_id].includes(u.id)) return true;
  if (k.level === 'employee') {
    const emp = db.get('SELECT * FROM employees WHERE id = ?', k.employee_id);
    return !!emp && canReviewPerformanceOf(u, emp);
  }
  if (k.org_unit_id && (u.lineageIds.includes(k.org_unit_id) || inScope(u, k.org_unit_id))) return true;
  return u.isExec || u.isHR;
}
function kpiVisibilitySql(u, alias = 'k') {
  const a = alias; const sc = u.scopeIds.length ? u.scopeIds.join(',') : 'NULL';
  const lin = u.lineageIds.join(',');
  const mine = `${a}.owner_id = ${u.id} OR ${a}.data_owner_id = ${u.id} OR ${a}.reviewer_id = ${u.id} OR ${a}.employee_id = ${u.id}`;
  if (u.isAdmin) return `${a}.deleted_at IS NULL AND ${a}.level <> 'employee'`;
  const empLevel = (isManagerRole(u) || u.isHR)
    ? `OR (${a}.level = 'employee' AND ${a}.employee_id IN (SELECT id FROM employees WHERE ${u.isHR ? '1=1' : `org_unit_id IN (${sc}) OR manager_id = ${u.id}`}))` : '';
  return `(${a}.deleted_at IS NULL AND (${mine} OR (${a}.level <> 'employee' AND (${a}.org_unit_id IN (${lin}) OR ${a}.org_unit_id IN (${sc}) ${u.isExec ? 'OR 1=1' : ''})) ${empLevel}))`;
}

// ---------- مبادرات / قرارات ----------
function canSeeDecision(u, d, meeting) {
  if (d.confidentiality === 'board' || isBoardMeeting(meeting)) return u.isBoard;
  if (d.owner_id === u.id) return true;
  return canSeeMeeting(u, meeting) || (isManagerRole(u) && inScope(u, d.responsible_dept_id));
}
function initiativeVisibilitySql(u, alias = 'i') {
  const a = alias; const sc = u.scopeIds.length ? u.scopeIds.join(',') : 'NULL';
  if (u.isAdmin) return '0=1';
  return `(${a}.deleted_at IS NULL AND (${a}.owner_id = ${u.id} OR ${a}.sponsor_id = ${u.id}
     OR EXISTS (SELECT 1 FROM tasks tk WHERE tk.initiative_id = ${a}.id AND (tk.owner_id = ${u.id} OR tk.reviewer_id = ${u.id}))
     ${isManagerRole(u) ? `OR ${a}.org_unit_id IN (${sc}) OR ${a}.org_unit_id IS NULL` : ''}))`;
}

module.exports = {
  orgs, invalidateOrg, subtree, ancestors, lineage, loadUser, has, requireRole, inScope, isManagerRole, isSeniorManager,
  canSeeEmployee, canReviewPerformanceOf, canSeePerformanceOf,
  meetingOrg, isBoardMeeting, participantSet, meetingRole, canSeeMeeting, canSeeBoardContent, canEditMeeting,
  taskVisibilitySql, canSeeTask, meetingVisibilitySql, canSeeKpi, kpiVisibilitySql, canSeeDecision, initiativeVisibilitySql, ROLE_RANK,
};
