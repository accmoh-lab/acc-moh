'use strict';
// استيراد CSV: Template ← Preview (تحقق + كشف التكرار + تقرير أخطاء) ← Commit. والتصدير حسب الصلاحية.
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const kpiEngine = require('../kpi_engine');
const tasksMod = require('./tasks');
const kpisMod = require('./kpis');
const targetsMod = require('./targets');
const orgMod = require('./org');
const { bad, forbidden, notFound, nowIso, HttpError } = require('../util');

function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map(h => h.trim());
  return { header, rows: rows.slice(1).map((r, i) => ({ line: i + 2, data: Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])) })) };
}
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (cols, rows) => '﻿' + [cols.map(c => csvCell(c.label)).join(','), ...rows.map(r => cols.map(c => csvCell(r[c.key])).join(','))].join('\r\n');
const num = v => (v === '' || v === undefined ? null : Number(v));
const empByNo = no => db.get('SELECT * FROM employees WHERE emp_no = ? AND deleted_at IS NULL', no);
const orgByCode = c => db.get('SELECT * FROM org_units WHERE code = ? AND deleted_at IS NULL', c);

const DEFS = {
  employees: {
    label: 'الموظفون', roles: u => u.isHR || u.isAdmin, header: ['emp_no', 'name', 'job_title', 'email', 'phone', 'org_code', 'manager_emp_no', 'active'], example: ['EMP-100', 'اسم الموظف', 'محاسب', 'name@company.com', '', 'DEPT-FIN', 'EMP-021', '1'],
    key: d => d.emp_no,
    existing: d => db.get('SELECT * FROM employees WHERE emp_no = ? OR lower(email) = lower(?)', d.emp_no, d.email),
    check(d, user) {
      const e = []; if (!d.emp_no) e.push('emp_no مطلوب'); if (!d.name) e.push('name مطلوب'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || '')) e.push('بريد غير صحيح');
      if (!orgByCode(d.org_code)) e.push(`org_code غير موجود: ${d.org_code}`); if (d.manager_emp_no && !empByNo(d.manager_emp_no)) e.push(`المدير غير موجود: ${d.manager_emp_no}`);
      return e;
    },
    apply(d, user, ex) {
      const org = orgByCode(d.org_code); const mgr = d.manager_emp_no ? empByNo(d.manager_emp_no) : null;
      const body = { emp_no: d.emp_no, name: d.name, job_title: d.job_title || '-', email: d.email, phone: d.phone || null, org_unit_id: org.id, manager_id: mgr?.id || null, active: d.active === '0' ? 0 : 1 };
      if (ex) { const l = rbac.lineage(org.id); db.update('employees', ex.id, { ...body, ...l, updated_at: nowIso() }); audit.log(user.id, 'employee', ex.id, 'import_update'); return ex.id; }
      return orgMod.createEmployee(user, body).id;
    },
  },
  tasks: {
    label: 'المهام', roles: u => rbac.isManagerRole(u), header: ['title', 'owner_emp_no', 'due_date', 'start_date', 'priority', 'source', 'description', 'kpi_code', 'reviewer_emp_no'], example: ['إعداد تقرير المبيعات', 'EMP-040', '2026-11-30', '', 'medium', 'operational', '', '', ''],
    key: d => d.title + '|' + d.owner_emp_no + '|' + d.due_date,
    existing: d => db.get(`SELECT t.* FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE t.title = ? AND o.emp_no = ? AND t.due_date = ? AND t.deleted_at IS NULL`, d.title, d.owner_emp_no, d.due_date),
    check(d) {
      const e = []; if (!d.title) e.push('title مطلوب'); if (!empByNo(d.owner_emp_no)) e.push(`المسؤول غير موجود: ${d.owner_emp_no}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.due_date || '')) e.push('due_date صيغته YYYY-MM-DD'); if (d.start_date && d.start_date > d.due_date) e.push('تاريخ البدء بعد الاستحقاق');
      if (d.priority && !['low', 'medium', 'high', 'critical'].includes(d.priority)) e.push('priority غير صحيحة'); if (d.kpi_code && !db.get('SELECT 1 x FROM kpis WHERE code = ?', d.kpi_code)) e.push('kpi_code غير موجود');
      return e;
    },
    apply(d, user) { const k = d.kpi_code ? db.get('SELECT id FROM kpis WHERE code = ?', d.kpi_code) : null; return tasksMod.createTask(user, { title: d.title, owner_id: empByNo(d.owner_emp_no).id, due_date: d.due_date, start_date: d.start_date || null, priority: d.priority || 'medium', source: d.source || 'operational', description: d.description, kpi_id: k?.id || null, reviewer_id: d.reviewer_emp_no ? empByNo(d.reviewer_emp_no)?.id : null }).id; },
  },
  kpis: {
    label: 'مؤشرات الأداء', roles: u => u.isExec || u.isHR || rbac.has(u, 'business_unit_manager', 'department_manager'), header: ['code', 'name', 'category', 'level', 'org_code', 'owner_emp_no', 'kpi_type', 'unit', 'frequency', 'target', 'green_min', 'amber_min', 'weight'], example: ['SALES_NEW', 'عملاء جدد', 'operational', 'department', 'DEPT-SALES', 'EMP-020', 'higher_better', 'عميل', 'monthly', '20', '100', '85', '1'],
    key: d => d.code, existing: d => db.get('SELECT * FROM kpis WHERE code = ?', d.code),
    check(d) {
      const e = []; if (!/^[A-Z][A-Z0-9_]*$/.test(d.code || '')) e.push('code: أحرف كبيرة وأرقام و _'); if (!d.name) e.push('name مطلوب');
      if (!['financial', 'operational', 'strategic'].includes(d.category)) e.push('category غير صحيحة'); if (!['department', 'business_unit', 'company', 'team', 'group'].includes(d.level)) e.push('level غير صحيح (للموظفين استخدم الواجهة)');
      if (!orgByCode(d.org_code)) e.push('org_code غير موجود'); if (!empByNo(d.owner_emp_no)) e.push('المالك غير موجود');
      if (!['higher_better', 'lower_better', 'exact_target', 'milestone', 'boolean'].includes(d.kpi_type)) e.push('kpi_type غير مدعوم في الاستيراد'); if (num(d.target) === null || Number.isNaN(num(d.target))) e.push('target رقم مطلوب');
      return e;
    },
    apply(d, user) { return kpisMod.createKpi(user, { code: d.code, name: d.name, category: d.category, level: d.level, org_unit_id: orgByCode(d.org_code).id, owner_id: empByNo(d.owner_emp_no).id, data_owner_id: empByNo(d.owner_emp_no).id, kpi_type: d.kpi_type, unit: d.unit || '', frequency: d.frequency || 'monthly', target: num(d.target), green_min: num(d.green_min) ?? 100, amber_min: num(d.amber_min) ?? 85, weight: num(d.weight) ?? 1 }).id; },
  },
  targets: {
    label: 'الأهداف المالية', roles: u => u.isExec || u.isHR || rbac.has(u, 'business_unit_manager', 'department_manager'), header: ['metric', 'label', 'org_code', 'period_key', 'currency', 'target', 'actual'], example: ['revenue', 'إيرادات المبيعات', 'DEPT-SALES', '2026-11', 'EGP', '5000000', ''],
    key: d => [d.metric, d.label, d.org_code, d.period_key].join('|'),
    existing: d => { const o = orgByCode(d.org_code); return o && db.get('SELECT * FROM financial_targets WHERE metric = ? AND label = ? AND org_unit_id = ? AND period_key = ?', d.metric, d.label, o.id, d.period_key); },
    check(d) { const e = []; if (!orgByCode(d.org_code)) e.push('org_code غير موجود'); if (!d.label) e.push('label مطلوب'); if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(d.period_key || '')) e.push('period_key غير صحيح'); if (num(d.target) === null || Number.isNaN(num(d.target))) e.push('target رقم مطلوب'); if (d.actual && Number.isNaN(num(d.actual))) e.push('actual غير صحيح'); return e; },
    apply(d, user) { return targetsMod.createTarget(user, { metric: d.metric, label: d.label, org_unit_id: orgByCode(d.org_code).id, period_key: d.period_key, currency: d.currency || 'EGP', target: num(d.target), actual: d.actual === '' ? null : num(d.actual) }).id; },
  },
  actuals: {
    label: 'القيم الفعلية لـKPI', roles: u => !u.isAdmin, header: ['kpi_code', 'period_key', 'actual', 'note'], example: ['REV_M', '2026-10', '10500000', ''],
    key: d => d.kpi_code + '|' + d.period_key, existing: d => { const k = db.get('SELECT id FROM kpis WHERE code = ?', d.kpi_code); return k && kpiEngine.getResult(k.id, d.period_key); },
    check(d, user) {
      const e = []; const k = db.get('SELECT * FROM kpis WHERE code = ? AND deleted_at IS NULL', d.kpi_code);
      if (!k) e.push('kpi_code غير موجود'); else { if (!rbac.canSeeKpi(user, k) || !kpisMod.canEnterData(user, k)) e.push('لا تملك صلاحية إدخال بيانات هذا المؤشر'); if (k.kpi_type === 'formula' || k.data_source === 'calculated') e.push('المؤشر محسوب تلقائيًا'); }
      if (!/^\d{4}-(\d{2}|Q[1-4]|W\d{2})$|^\d{4}$/.test(d.period_key || '')) e.push('period_key غير صحيح'); if (d.actual === '' || Number.isNaN(Number(d.actual))) e.push('actual رقم مطلوب');
      try { if (!e.length) kpiEngine.assertPeriodEditable(d.period_key); } catch (x) { e.push(x.message); }
      return e;
    },
    apply(d, user) { const k = db.get('SELECT * FROM kpis WHERE code = ?', d.kpi_code); return kpiEngine.saveActual(user, k, d.period_key, { actual: Number(d.actual), note: d.note || 'استيراد CSV' }).id; },
  },
};
function def(user, entity) {
  const d = DEFS[entity]; if (!d) throw notFound('نوع الاستيراد غير معروف.');
  if (!d.roles(user)) throw forbidden('الاستيراد غير متاح لدورك.'); return d;
}
function analyze(user, d, csv) {
  const p = parseCsv(csv);
  const missing = d.header.filter((h, i) => !p.header.includes(h));
  if (missing.length) throw bad(`أعمدة ناقصة في الملف: ${missing.join('، ')}. نزّل القالب واستخدمه.`);
  if (p.rows.length > 2000) throw bad('الحد الأقصى 2000 صف في الملف الواحد.');
  const seen = new Map();
  return p.rows.map(r => {
    const k = d.key(r.data); const errors = d.check(r.data, user);
    const dupInFile = seen.has(k); seen.set(k, r.line);
    const ex = errors.length ? null : d.existing(r.data);
    return { line: r.line, data: r.data, errors: dupInFile ? [...errors, `مكرر داخل الملف (السطر ${seen.get(k)})`] : errors, duplicate: !!ex || dupInFile, action: errors.length ? 'error' : ex ? 'duplicate' : 'create' };
  });
}
H.get('/api/import/:entity/template', ({ user, params }) => {
  const d = def(user, params.entity);
  return { __raw: true, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="template-${params.entity}.csv"` }, body: toCsv(d.header.map(h => ({ key: h, label: h })), [Object.fromEntries(d.header.map((h, i) => [h, d.example[i]]))]) };
});
H.get('/api/import', ({ user }) => Object.entries(DEFS).filter(([, d]) => d.roles(user)).map(([key, d]) => ({ key, label: d.label, header: d.header })));
H.post('/api/import/:entity/preview', ({ user, params, body }) => {
  const d = def(user, params.entity); const rows = analyze(user, d, body.csv);
  return { total: rows.length, valid: rows.filter(r => r.action === 'create').length, duplicates: rows.filter(r => r.action === 'duplicate').length, errors: rows.filter(r => r.action === 'error').length, rows: rows.slice(0, 200) };
});
H.post('/api/import/:entity/commit', ({ user, params, body }) => {
  const d = def(user, params.entity); const rows = analyze(user, d, body.csv);
  const errs = rows.filter(r => r.action === 'error');
  if (errs.length && !body.skip_errors) throw new HttpError(400, `يوجد ${errs.length} صفًا بأخطاء. صحّحها أو اختر تجاهل الأخطاء.`, 'VALIDATION', { errors: errs.slice(0, 50).map(r => ({ line: r.line, errors: r.errors })) });
  let created = 0, updated = 0, skipped = 0;
  db.tx(() => {
    for (const r of rows) {
      if (r.action === 'error') { skipped++; continue; }
      if (r.action === 'duplicate') {
        if (body.update_existing && ['employees', 'actuals'].includes(params.entity)) { d.apply(r.data, user, d.existing(r.data)); updated++; } else skipped++;
        continue;
      }
      d.apply(r.data, user); created++;
    }
    audit.log(user.id, 'import', 0, params.entity, 'rows', null, `${created} جديد / ${updated} محدّث / ${skipped} متجاهل`);
  });
  return { created, updated, skipped };
});

// ---------- التصدير ----------
function exporter(user, entity) {
  const ctl = require('../http');
  if (entity === 'tasks') {
    const rows = db.all(`SELECT t.code, t.title, o.emp_no owner_emp_no, o.name owner, t.status, t.priority, t.source, t.start_date, t.due_date, t.progress FROM tasks t JOIN employees o ON o.id = t.owner_id WHERE ${rbac.taskVisibilitySql(user)} ORDER BY t.due_date LIMIT 5000`);
    return { cols: ['code', 'title', 'owner_emp_no', 'owner', 'status', 'priority', 'source', 'start_date', 'due_date', 'progress'], rows };
  }
  if (entity === 'employees') {
    if (!(user.isHR || user.isAdmin)) throw forbidden('تصدير الموظفين لـHR أو مدير النظام.');
    return { cols: ['emp_no', 'name', 'job_title', 'email', 'phone', 'org_code', 'manager_emp_no', 'active'], rows: db.all(`SELECT e.emp_no, e.name, e.job_title, e.email, e.phone, o.code org_code, m.emp_no manager_emp_no, e.active FROM employees e JOIN org_units o ON o.id = e.org_unit_id LEFT JOIN employees m ON m.id = e.manager_id WHERE e.deleted_at IS NULL ORDER BY e.emp_no`) };
  }
  if (entity === 'kpis') return { cols: ['code', 'name', 'category', 'level', 'kpi_type', 'target', 'unit', 'frequency'], rows: db.all(`SELECT k.* FROM kpis k WHERE ${rbac.kpiVisibilitySql(user)} ORDER BY k.code`) };
  throw notFound();
}
H.get('/api/export/:entity', ({ user, params }) => {
  const { cols, rows } = exporter(user, params.entity);
  audit.log(user.id, 'export', 0, params.entity, 'rows', null, rows.length);
  return { __raw: true, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${params.entity}.csv"` }, body: toCsv(cols.map(c => ({ key: c, label: c })), rows) };
});

module.exports = { parseCsv, toCsv };
