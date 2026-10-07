'use strict';
// بيانات تجريبية واقعية لشركة «فاست تريد» (أسماء وأرقام وهمية). تُنشأ عبر منطق التطبيق نفسه حيثما أمكن.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.TZ = process.env.TZ || 'Africa/Cairo';
const db = require('./db');
const auth = require('./auth');
const rbac = require('./rbac');
const kpiEngine = require('./kpi_engine');
const periods = require('./periods');
const notify = require('./notify');
const { code, today, addDays, nowIso, fmtDate } = require('./util');

const DEMO_PASSWORD = 'Demo@2026!';
let rnd;
function prng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function seed() {
  rnd = prng(2026);
  const T = n => addDays(today(), n);
  const now = nowIso();
  const meetings = require('./domain/meetings');
  const perf = require('./domain/perf');
  const orgId = {}, E = {}, K = {};
  db.tx(() => {
    // ---------- الإعدادات ----------
    const S = { prep_release_hours: 48, kpi_grace_days: 5, fin_variance_threshold_pct: 10, score_cap: 120, calibration_enabled: true, attention_score_below: 70, final_rating_approvers: ['executive', 'hr_admin'], base_currency: 'EGP' };
    for (const [k, v] of Object.entries(S)) db.insert('settings', { key: k, value: JSON.stringify(v), description: 'قيمة تجريبية قابلة للضبط', updated_at: now });
    db.insert('fx_rates', { currency: 'EGP', rate_to_base: 1, as_of: T(0) }); db.insert('fx_rates', { currency: 'USD', rate_to_base: 48.5, as_of: T(0) }); db.insert('fx_rates', { currency: 'EUR', rate_to_base: 52, as_of: T(0) });

    // ---------- الهيكل التنظيمي ----------
    const org = (c, name, kind, parent, en) => { orgId[c] = db.insert('org_units', { code: c, name, name_en: en, kind, parent_id: parent ? orgId[parent] : null, currency: 'EGP', created_at: now, updated_at: now }); };
    org('FT-GRP', 'مجموعة فاست تريد', 'group', null, 'Fast Trade Group');
    org('FT-TRD', 'فاست تريد للتجارة', 'company', 'FT-GRP', 'Fast Trade Trading');
    org('BU-COM', 'وحدة الأعمال التجارية', 'business_unit', 'FT-TRD'); org('BU-SHD', 'وحدة الخدمات المشتركة', 'business_unit', 'FT-TRD');
    org('DEPT-SALES', 'المبيعات', 'department', 'BU-COM', 'Sales'); org('DEPT-OPS', 'العمليات', 'department', 'BU-COM', 'Operations');
    org('DEPT-FIN', 'المالية', 'department', 'BU-SHD', 'Finance'); org('DEPT-IT', 'تقنية المعلومات', 'department', 'BU-SHD', 'IT'); org('DEPT-HR', 'الموارد البشرية', 'department', 'BU-SHD', 'HR');
    org('T-KA', 'فريق كبار العملاء', 'team', 'DEPT-SALES'); org('T-FS', 'فريق المبيعات الميدانية', 'team', 'DEPT-SALES');
    org('T-WH', 'فريق المستودعات', 'team', 'DEPT-OPS'); org('T-DIST', 'فريق التوزيع', 'team', 'DEPT-OPS');
    org('FT-LOG', 'فاست تريد للخدمات اللوجستية', 'company', 'FT-GRP', 'Fast Trade Logistics');
    org('BU-LOG', 'وحدة النقل', 'business_unit', 'FT-LOG'); db.update('org_units', orgId['FT-LOG'], { currency: 'USD' }); org('DEPT-TRN', 'النقل والتوزيع', 'department', 'BU-LOG');
    rbac.invalidateOrg();

    // ---------- الموظفون ----------
    const pw = auth.hashPassword(DEMO_PASSWORD);
    const emp = (no, name, title, orgCode, mgr, role, login, extra = {}) => {
      const lin = rbac.lineage(orgId[orgCode]);
      E[no] = db.insert('employees', { emp_no: no, name, job_title: title, email: `${login}@fasttrade.demo`, phone: extra.phone || null, org_unit_id: orgId[orgCode], ...lin, manager_id: mgr ? E[mgr] : null, active: extra.active ?? 1, system_role: role, scope_org_id: extra.scope ? orgId[extra.scope] : null, password_hash: pw, can_login: extra.active === 0 ? 0 : 1, is_demo: 1, created_at: now, updated_at: now });
      for (const g of extra.grants || []) db.insert('employee_grants', { employee_id: E[no], role: g, created_at: now });
    };
    emp('E001', 'عمر الفاروق', 'الرئيس التنفيذي', 'FT-TRD', null, 'executive', 'omar', { scope: 'FT-GRP', grants: ['board_member'] });
    emp('E002', 'د. ليلى الحداد', 'رئيسة مجلس الإدارة', 'FT-GRP', null, 'employee', 'layla', { grants: ['board_member'] });
    emp('E003', 'هناء السيد', 'أمينة سر المجلس', 'FT-GRP', 'E001', 'employee', 'hana', { grants: ['board_secretary', 'meeting_secretary'] });
    emp('E010', 'طارق منصور', 'مدير وحدة الأعمال التجارية', 'BU-COM', 'E001', 'business_unit_manager', 'tarek');
    emp('E011', 'نادية الشريف', 'مديرة وحدة الخدمات المشتركة', 'BU-SHD', 'E001', 'business_unit_manager', 'nadia');
    emp('E020', 'سامي القاضي', 'مدير المبيعات', 'DEPT-SALES', 'E010', 'department_manager', 'sami');
    emp('E021', 'ياسر عبد الله', 'مدير المالية', 'DEPT-FIN', 'E011', 'department_manager', 'yasser', { grants: ['kpi_owner', 'data_owner'] });
    emp('E022', 'مها رضوان', 'مديرة العمليات', 'DEPT-OPS', 'E010', 'department_manager', 'maha');
    emp('E023', 'خالد البنا', 'مدير تقنية المعلومات', 'DEPT-IT', 'E011', 'department_manager', 'khaled', { grants: ['kpi_owner'] });
    emp('E024', 'رنا الخطيب', 'مديرة الموارد البشرية', 'DEPT-HR', 'E011', 'hr_admin', 'rana', { grants: ['performance_reviewer'] });
    emp('E030', 'أحمد زيدان', 'قائد فريق كبار العملاء', 'T-KA', 'E020', 'team_leader', 'ahmed');
    emp('E031', 'هالة مرزوق', 'قائدة فريق المبيعات الميدانية', 'T-FS', 'E020', 'team_leader', 'hala');
    emp('E032', 'كريم نصار', 'قائد فريق المستودعات', 'T-WH', 'E022', 'team_leader', 'kareem');
    emp('E040', 'محمود عادل', 'مسؤول حسابات كبار العملاء', 'T-KA', 'E030', 'employee', 'mahmoud');
    emp('E041', 'سلمى فؤاد', 'مسؤولة حسابات كبار العملاء', 'T-KA', 'E030', 'employee', 'salma');
    emp('E042', 'إبراهيم حسن', 'مندوب مبيعات', 'T-FS', 'E031', 'employee', 'ibrahim');
    emp('E043', 'دينا مصطفى', 'مندوبة مبيعات', 'T-FS', 'E031', 'employee', 'dina');
    emp('E044', 'عمرو سالم', 'محاسب أول', 'DEPT-FIN', 'E021', 'employee', 'amr', { grants: ['data_owner'] });
    emp('E045', 'فاطمة نبيل', 'محاسبة', 'DEPT-FIN', 'E021', 'employee', 'fatma');
    emp('E046', 'وليد جمال', 'أمين مستودع', 'T-WH', 'E032', 'employee', 'waleed');
    emp('E047', 'نورا عاطف', 'منسقة توزيع', 'T-DIST', 'E022', 'employee', 'nora');
    emp('E048', 'هشام رأفت', 'مهندس دعم فني', 'DEPT-IT', 'E023', 'employee', 'hesham');
    emp('E049', 'أميرة صلاح', 'أخصائية موارد بشرية', 'DEPT-HR', 'E024', 'employee', 'amira');
    emp('E060', 'ماجد سليم', 'مدير النقل والتوزيع', 'DEPT-TRN', 'E001', 'department_manager', 'maged');
    emp('E061', 'علاء رشدي', 'منسق نقل', 'DEPT-TRN', 'E060', 'employee', 'alaa');
    emp('E090', 'مدير النظام', 'System Administrator', 'DEPT-IT', 'E023', 'system_admin', 'admin');
    emp('E099', 'محمد التهامي', 'مندوب مبيعات (سابق)', 'T-FS', 'E031', 'employee', 'mohamed.old', { active: 0 });

    // ---------- Scorecards ----------
    const sc = (orgCode, name, w) => db.insert('scorecard_configs', { org_unit_id: orgCode ? orgId[orgCode] : null, name, weights: JSON.stringify(w), updated_at: now });
    sc(null, 'الافتراضي', perf.DEFAULT_WEIGHTS);
    sc('DEPT-SALES', 'المبيعات', { kpi_financial: 40, kpi_operational: 15, kpi_strategic: 5, tasks: 10, meeting_actions: 5, initiatives: 5, manager_assessment: 20 });
    sc('DEPT-IT', 'تقنية المعلومات', { kpi_financial: 5, kpi_operational: 40, kpi_strategic: 15, tasks: 15, meeting_actions: 5, initiatives: 10, manager_assessment: 10 });
    sc('DEPT-FIN', 'المالية', { kpi_financial: 25, kpi_operational: 30, kpi_strategic: 5, tasks: 15, meeting_actions: 5, initiatives: 5, manager_assessment: 15 });

    // ---------- KPIs ----------
    const kpi = (c, name, o) => {
      const lvl = o.level; const orgCode = o.org; const ow = E[o.owner];
      K[c] = db.insert('kpis', { code: c, name, description: o.desc || null, category: o.cat || 'operational', level: lvl, org_unit_id: orgCode ? orgId[orgCode] : null, employee_id: o.emp ? E[o.emp] : null, owner_id: ow, data_owner_id: E[o.data || o.owner], reviewer_id: o.rev ? E[o.rev] : null,
        unit: o.unit || '', currency: o.cur || null, frequency: o.freq || 'monthly', kpi_type: o.type || 'higher_better', baseline: o.baseline ?? null, target: o.target ?? null, range_min: o.min ?? null, range_max: o.max ?? null, formula: o.formula || null,
        data_source: o.src || 'manual', direction: o.dir || 'higher', weight: o.w ?? 1, green_min: o.g ?? 100, amber_min: o.a ?? 85, cascade_type: o.cascade || 'independent', parent_kpi_id: o.parent ? K[o.parent] : null, rollup: o.rollup || null,
        effective_from: '2026-01-01', approval_status: 'approved', created_at: now, updated_at: now });
    };
    kpi('REV_M', 'إيرادات المبيعات الشهرية', { level: 'company', org: 'FT-TRD', owner: 'E001', data: 'E044', rev: 'E021', cat: 'financial', unit: 'جنيه', cur: 'EGP', target: 12000000, w: 3, g: 100, a: 90, cascade: 'cascaded', rollup: 'sum', src: 'calculated', desc: 'مجموع إيرادات فرق المبيعات' });
    kpi('REV_KA', 'إيرادات كبار العملاء', { level: 'team', org: 'T-KA', owner: 'E030', data: 'E040', rev: 'E020', cat: 'financial', unit: 'جنيه', cur: 'EGP', target: 7000000, w: 2, g: 100, a: 90, cascade: 'cascaded', parent: 'REV_M' });
    kpi('REV_FS', 'إيرادات المبيعات الميدانية', { level: 'team', org: 'T-FS', owner: 'E031', data: 'E042', rev: 'E020', cat: 'financial', unit: 'جنيه', cur: 'EGP', target: 5000000, w: 2, g: 100, a: 90, cascade: 'cascaded', parent: 'REV_M' });
    kpi('GP_M', 'مجمل الربح الشهري', { level: 'company', org: 'FT-TRD', owner: 'E001', data: 'E044', rev: 'E021', cat: 'financial', unit: 'جنيه', cur: 'EGP', target: 2900000, w: 2, g: 100, a: 90 });
    kpi('GM_PCT', 'هامش الربح الإجمالي', { level: 'company', org: 'FT-TRD', owner: 'E021', cat: 'financial', unit: '%', type: 'formula', formula: 'GP_M/REV_M*100', target: 24, w: 2, g: 100, a: 92, src: 'calculated' });
    kpi('ERP_MS', 'تقدم مشروع ERP (معالم)', { level: 'company', org: 'FT-TRD', owner: 'E023', cat: 'strategic', unit: '%', freq: 'quarterly', type: 'milestone', target: 100, w: 2, g: 95, a: 85 });
    kpi('COM_PROFIT', 'ربحية وحدة الأعمال التجارية', { level: 'business_unit', org: 'BU-COM', owner: 'E010', data: 'E044', rev: 'E021', cat: 'financial', unit: 'جنيه', cur: 'EGP', target: 1600000, w: 2, g: 100, a: 90 });
    kpi('SHD_COST', 'تكلفة الخدمات المشتركة', { level: 'business_unit', org: 'BU-SHD', owner: 'E011', data: 'E044', rev: 'E021', cat: 'financial', unit: 'جنيه', cur: 'EGP', type: 'lower_better', target: 900000, w: 2, g: 100, a: 92 });
    kpi('DISC_RNG', 'نسبة الخصم الممنوح', { level: 'department', org: 'DEPT-SALES', owner: 'E020', data: 'E031', rev: 'E010', cat: 'financial', unit: '%', type: 'target_range', min: 2, max: 4, target: 3, w: 1, g: 100, a: 70, desc: 'يجب أن تبقى بين 2% و4%' });
    kpi('SALES_CONV', 'معدل تحويل العروض إلى طلبات', { level: 'department', org: 'DEPT-SALES', owner: 'E020', data: 'E031', rev: 'E010', unit: '%', target: 30, w: 2, g: 100, a: 85 });
    kpi('COLL_PCT', 'نسبة التحصيل', { level: 'department', org: 'DEPT-FIN', owner: 'E021', data: 'E044', rev: 'E011', cat: 'financial', unit: '%', target: 92, w: 3, g: 100, a: 92 });
    kpi('CLOSE_DAYS', 'أيام إقفال الدفاتر', { level: 'department', org: 'DEPT-FIN', owner: 'E021', data: 'E045', rev: 'E011', unit: 'يوم', type: 'lower_better', target: 5, w: 1, g: 100, a: 80 });
    kpi('OTD_PCT', 'التسليم في الموعد', { level: 'department', org: 'DEPT-OPS', owner: 'E022', data: 'E047', rev: 'E010', unit: '%', target: 95, w: 3, g: 100, a: 95 });
    kpi('INV_DAYS', 'أيام المخزون', { level: 'department', org: 'DEPT-OPS', owner: 'E022', data: 'E046', rev: 'E010', cat: 'financial', unit: 'يوم', type: 'lower_better', target: 45, w: 2, g: 100, a: 88 });
    kpi('UPTIME', 'توفر الأنظمة', { level: 'department', org: 'DEPT-IT', owner: 'E023', data: 'E048', rev: 'E011', unit: '%', target: 99.5, w: 3, g: 100, a: 99 });
    kpi('TICKETS_SLA', 'التذاكر المحلولة ضمن SLA', { level: 'department', org: 'DEPT-IT', owner: 'E023', data: 'E048', rev: 'E011', unit: '%', target: 90, w: 2, g: 100, a: 90 });
    kpi('TTH_DAYS', 'متوسط زمن التوظيف', { level: 'department', org: 'DEPT-HR', owner: 'E024', data: 'E049', rev: 'E011', unit: 'يوم', type: 'lower_better', target: 30, w: 2, g: 100, a: 85 });
    kpi('TURNOVER', 'معدل دوران الموظفين', { level: 'department', org: 'DEPT-HR', owner: 'E024', data: 'E049', rev: 'E011', cat: 'strategic', unit: '%', type: 'lower_better', target: 8, w: 1, g: 100, a: 85 });
    kpi('AUDIT_OK', 'اكتمال التدقيق الداخلي السنوي', { level: 'department', org: 'DEPT-FIN', owner: 'E021', data: 'E021', rev: 'E011', cat: 'strategic', unit: 'نعم/لا', freq: 'annual', type: 'boolean', target: 1, w: 1 });
    kpi('LOG_OTD', 'التسليم في الموعد (لوجستيات)', { level: 'department', org: 'DEPT-TRN', owner: 'E060', rev: 'E001', unit: '%', target: 94, w: 2 });
    const empK = (c, name, empNo, o) => kpi(c, name, { level: 'employee', emp: empNo, owner: o.owner || 'E030', data: empNo, rev: o.owner || 'E030', ...o });
    empK('NEW_ACC_40', 'حسابات كبار العملاء الجديدة', 'E040', { owner: 'E030', unit: 'حساب', target: 4, w: 3, cat: 'financial', g: 100, a: 75 });
    empK('NEW_ACC_41', 'حسابات كبار العملاء الجديدة', 'E041', { owner: 'E030', unit: 'حساب', target: 4, w: 3, cat: 'financial', g: 100, a: 75 });
    empK('VISITS_42', 'الزيارات الميدانية', 'E042', { owner: 'E031', unit: 'زيارة', target: 60, w: 2 });
    empK('VISITS_43', 'الزيارات الميدانية', 'E043', { owner: 'E031', unit: 'زيارة', target: 60, w: 2 });
    empK('CLOSE_44', 'دقة التسويات البنكية', 'E044', { owner: 'E021', unit: '%', target: 99, w: 2, g: 100, a: 97 });
    empK('RECON_45', 'عدد القيود المراجعة', 'E045', { owner: 'E021', unit: 'قيد', target: 400, w: 2 });
    empK('STOCK_46', 'دقة المخزون', 'E046', { owner: 'E032', unit: '%', target: 98, w: 3, g: 100, a: 96 });
    empK('DELIV_47', 'تسليم الطلبات في الموعد', 'E047', { owner: 'E022', unit: '%', target: 95, w: 3, g: 100, a: 94 });
    empK('SLA_48', 'التذاكر المحلولة ضمن SLA', 'E048', { owner: 'E023', unit: '%', target: 90, w: 3 });
    empK('HIRE_49', 'اكتمال ملفات التوظيف', 'E049', { owner: 'E024', unit: '%', target: 100, w: 2, g: 100, a: 90 });

    // ---------- نتائج KPI (آخر 6 أشهر) ----------
    const cur = today().slice(0, 7); const mk = [6, 5, 4, 3, 2, 1].map(n => periods.prevKey(n === 1 ? cur : null) && null);
    let keys = []; let k = cur; for (let i = 0; i < 6; i++) { k = periods.prevKey(k); keys.unshift(k); }       // آخر 6 أشهر مكتملة
    const sepKey = keys[5], augKey = keys[4];
    const user = E['E044'];
    const series = {
      REV_KA: [6.8e6, 6.9e6, 7.2e6, 6.7e6, 6.4e6, 5.8e6], REV_FS: [4.6e6, 4.9e6, 5.1e6, 4.5e6, 4.2e6, 3.8e6], GP_M: [2.75e6, 2.85e6, 2.95e6, 2.7e6, 2.55e6, 2.3e6],
      COM_PROFIT: [1.5e6, 1.55e6, 1.65e6, 1.5e6, 1.5e6, 1.45e6], SHD_COST: [0.88e6, 0.9e6, 0.89e6, 0.91e6, 0.93e6, 0.95e6],
      DISC_RNG: [3.1, 3.4, 3.6, 3.8, 4.0, 4.4], SALES_CONV: [31, 32, 30, 30, 29, 28],
      COLL_PCT: [93, 94, 92, 90, 86, 78], CLOSE_DAYS: [5, 5, 6, 5, 6, 7], OTD_PCT: [96, 95, 96, 97, 96, 96], INV_DAYS: [44, 46, 45, 46, 47, 48],
      UPTIME: [99.7, 99.6, 99.8, 99.5, 99.7, 99.7], TICKETS_SLA: [91, 92, 90, 89, 91, 93], TTH_DAYS: [28, 29, 31, 32, 33, 34], TURNOVER: [7, 7.5, 8, 8, 9, 9.5], LOG_OTD: [93, 95, 94, 94, 95, 96],
      NEW_ACC_40: [4, 5, 3, 4, 3, 2], NEW_ACC_41: [4, 4, 5, 4, 5, 5], VISITS_42: [58, 61, 57, 59, 63, 62], VISITS_43: [55, 50, 48, 52, 47, 45], CLOSE_44: [99.2, 99.0, 99.4, 98.8, 99.1, 99.3], RECON_45: [410, 395, 420, 405, 398, 415],
      STOCK_46: [98.4, 98.1, 97.9, 98.2, 98.5, 98.0], DELIV_47: [96, 95, 97, 96, 95, null], SLA_48: [91, 90, 92, 88, 91, null], HIRE_49: [100, 95, 100, 95, 92, 90],
    };
    const qualityFor = (i, kc) => {
      if (i <= 4) return 'approved';
      if (['COLL_PCT'].includes(kc)) return 'submitted'; if (['UPTIME', 'CLOSE_DAYS'].includes(kc)) return 'draft';
      return 'verified';
    };
    const nonSept = new Set(['TURNOVER', 'TICKETS_SLA']);
    for (const [kc, vals] of Object.entries(series)) {
      const kk = db.get('SELECT * FROM kpis WHERE code = ?', kc);
      vals.forEach((v, i) => {
        if (v === null || (i === 5 && nonSept.has(kc))) return;                  // بيانات ناقصة لسبتمبر (Missing)
        if (kk.kpi_type === 'lower_better' && false) return;
        const r = kpiEngine.upsertResult(kk, keys[i], { actual: v, data_quality: qualityFor(i, kc) }, E['E044']);
        kpiEngine.recomputeDerived(kk.id, keys[i], E['E044']);
      });
    }
    // مؤشرات المعالم والبوليان (ربع سنوي/سنوي)
    const erp = db.get("SELECT * FROM kpis WHERE code = 'ERP_MS'"); const ck = periods.keyFor(addDays(today(), -100), 'quarterly');
    [['Q1', 25, 30], ['Q2', 45, 50], ['Q3', 60, 65]].forEach(([q, a, t], i) => { const key = `2026-${q}`; kpiEngine.upsertResult(erp, key, { actual: a, target: t, data_quality: i < 2 ? 'approved' : 'verified' }, E['E023']); });
    kpiEngine.upsertResult(db.get("SELECT * FROM kpis WHERE code = 'AUDIT_OK'"), '2025', { actual: 1, data_quality: 'approved' }, E['E021']);
    // أدخل آخر قيم Aug كمعتمدة لـREV_M/GM_PCT المشتقة
    for (const kc of ['REV_M', 'GM_PCT']) { const kk = db.get('SELECT id FROM kpis WHERE code = ?', kc); db.run('UPDATE kpi_results SET data_quality = ? WHERE kpi_id = ? AND period_key <= ?', 'approved', kk.id, augKey); db.run('UPDATE kpi_results SET data_quality = ? WHERE kpi_id = ? AND period_key = ?', 'approved', kk.id, sepKey); }

    // ---------- الأهداف المالية ----------
    const finRows = [
      ['revenue', 'إيرادات المبيعات', 'FT-TRD', 'EGP', 12e6, [11.4e6, 11.2e6, 10.6e6, 9.6e6], 0, 'REV_M'],
      ['gross_profit', 'مجمل الربح', 'FT-TRD', 'EGP', 2.9e6, [2.75e6, 2.7e6, 2.55e6, 2.3e6], 0, 'GP_M'],
      ['ebitda', 'EBITDA', 'FT-TRD', 'EGP', 1.4e6, [1.3e6, 1.25e6, 1.2e6, 1.05e6], 0, null],
      ['expenses', 'المصروفات التشغيلية', 'FT-TRD', 'EGP', 1.9e6, [1.85e6, 1.9e6, 2.0e6, 2.15e6], 1, null],
      ['cash_flow', 'صافي التدفق النقدي', 'FT-TRD', 'EGP', 1.2e6, [1.25e6, 1.2e6, 1.18e6, 1.15e6], 0, null],
      ['collection', 'التحصيل', 'DEPT-FIN', 'EGP', 11e6, [10.5e6, 10.4e6, 9.5e6, 8.6e6], 0, 'COLL_PCT'],
      ['receivables', 'الذمم المدينة', 'DEPT-FIN', 'EGP', 14e6, [13.5e6, 14.1e6, 14.6e6, 15.2e6], 1, null],
      ['inventory', 'قيمة المخزون', 'DEPT-OPS', 'EGP', 9e6, [8.9e6, 9.1e6, 9.3e6, 9.4e6], 1, 'INV_DAYS'],
      ['budget', 'موازنة تقنية المعلومات', 'DEPT-IT', 'EGP', 350e3, [340e3, 352e3, 360e3, 372e3], 1, null],
      ['revenue', 'إيرادات النقل', 'FT-LOG', 'USD', 150e3, [148e3, 152e3, 146e3, 141e3], 0, null],
    ];
    const fkeys = keys.slice(2);
    for (const [metric, label, oc, cur_, tgt, acts, low, rk] of finRows) {
      fkeys.forEach((fk, i) => { const p = periods.parseKey(fk); db.insert('financial_targets', { metric, label, org_unit_id: orgId[oc], period_key: fk, period_start: p.start, period_end: p.end, currency: cur_, target: tgt, actual: acts[i], lower_is_better: low, data_source: i < 2 ? 'manual' : 'manual', data_quality: i < 2 ? 'approved' : (i === 2 ? 'verified' : 'submitted'), related_kpi_id: rk ? K[rk] : null, updated_by: E['E044'], created_at: now, updated_at: now }); });
      const pc = periods.parseKey(cur); db.insert('financial_targets', { metric, label, org_unit_id: orgId[oc], period_key: cur, period_start: pc.start, period_end: pc.end, currency: cur_, target: tgt, actual: null, lower_is_better: low, data_source: 'manual', data_quality: 'missing', related_kpi_id: rk ? K[rk] : null, updated_by: E['E044'], created_at: now, updated_at: now });
    }

    // ---------- المبادرات ----------
    const ini = (title, o) => db.insert('initiatives', { code: code('INI'), title, objective: o.obj, owner_id: E[o.owner], sponsor_id: o.sponsor ? E[o.sponsor] : null, org_unit_id: o.org ? orgId[o.org] : null, start_date: T(o.start), target_date: T(o.end), status: o.status, progress: o.p, expected_impact: o.impact, actual_impact: o.actual || null, risk_note: o.risk || null, created_at: now, updated_at: now });
    const INI1 = ini('خطة تنشيط مبيعات الربع الأخير', { obj: 'تعويض فجوة الإيرادات عبر تحفيز كبار العملاء وتكثيف الزيارات', owner: 'E020', sponsor: 'E010', org: 'DEPT-SALES', start: -30, end: 60, status: 'at_risk', p: 25, impact: 'استعادة 1.5 مليون جنيه شهريًا من الإيرادات', risk: 'تأخر اعتماد ميزانية الحوافز وضعف التنفيذ الميداني' });
    const INI2 = ini('تطبيق نظام ERP — المرحلة الثانية', { obj: 'ربط المبيعات والمخزون والمالية في نظام واحد', owner: 'E023', sponsor: 'E001', org: 'DEPT-IT', start: -120, end: 90, status: 'active', p: 60, impact: 'خفض زمن إقفال الدفاتر إلى 4 أيام' });
    const INI3 = ini('رفع كفاءة المخزون', { obj: 'تخفيض أيام المخزون إلى 45 يومًا', owner: 'E022', sponsor: 'E010', org: 'DEPT-OPS', start: -60, end: 45, status: 'active', p: 40, impact: 'تحرير 600 ألف جنيه من رأس المال العامل' });
    const INI4 = ini('برنامج استبقاء المواهب', { obj: 'خفض معدل دوران الموظفين', owner: 'E024', sponsor: 'E011', org: 'DEPT-HR', start: 15, end: 180, status: 'planned', p: 0, impact: 'خفض الدوران إلى 8%' });
    const INI5 = ini('ترقية بوابة العملاء', { obj: 'تمكين العملاء من تتبع الطلبات ذاتيًا', owner: 'E023', sponsor: 'E010', org: 'DEPT-IT', start: -150, end: -20, status: 'completed', p: 100, impact: 'خفض مكالمات الدعم 20%', actual: 'انخفضت المكالمات 17%' });
    for (const [i, kc] of [[INI1, 'REV_M'], [INI3, 'INV_DAYS'], [INI2, 'GM_PCT'], [INI4, 'TURNOVER']]) db.insert('initiative_kpis', { initiative_id: i, kpi_id: K[kc] });

    // ---------- المهام ----------
    const taskIds = {};
    const task = (key, o) => {
      const ow = db.get('SELECT * FROM employees WHERE id = ?', E[o.owner]);
      const id = db.insert('tasks', { code: code('TSK'), title: o.title, description: o.desc || null, source: o.source || 'operational', meeting_id: o.meeting || null, decision_id: o.decision || null, agenda_item_id: o.agenda || null, kpi_id: o.kpi ? K[o.kpi] : null, initiative_id: o.ini || null,
        owner_id: ow.id, reviewer_id: o.rev ? E[o.rev] : null, company_id: ow.company_id, bu_id: ow.bu_id, dept_id: ow.dept_id, priority: o.pr || 'medium', weight: o.w || 1, start_date: o.start ?? null, due_date: o.due, status: o.status || 'not_started', progress: o.p ?? (o.status === 'completed' ? 100 : 0),
        blocked_reason: o.blocked || null, expected_resolution: o.resolve || null, evidence_required: o.ev ? 1 : 0, requires_approval: o.appr ? 1 : 0, approval_status: o.status === 'completed' && o.appr ? 'approved' : o.status === 'pending_review' ? 'pending' : 'none', confidentiality: o.conf || 'normal',
        recurrence: o.rec || 'none', series_id: o.series || null, occurrence_no: o.occ || null, created_by: E[o.by || 'E020'], created_at: o.created || now, updated_at: o.updated || now, completed_at: o.done || null });
      if (key) taskIds[key] = id;
      db.insert('task_events', { task_id: id, actor_id: E[o.by || 'E020'], action: 'created', to_status: 'not_started', created_at: o.created || now });
      return id;
    };

    // اجتماعات: نبني الاجتماعات أولًا ثم المهام المرتبطة
    const ts = (n, hhmm) => ({ date: T(n), time: hhmm });
    const mtg = (key, o) => {
      const l = db.get('SELECT * FROM employees WHERE id = ?', E[o.leader]);
      const lin = o.type === 'board' ? { company_id: null, bu_id: null, dept_id: null } : { company_id: o.company ? orgId[o.company] : l.company_id, bu_id: o.bu ? orgId[o.bu] : (o.dept ? rbac.lineage(orgId[o.dept]).bu_id : null), dept_id: o.dept ? orgId[o.dept] : null };
      const id = db.insert('meetings', { code: code('MTG'), title: o.title, type: o.type, ...lin, leader_id: l.id, secretary_id: o.sec ? E[o.sec] : null, meeting_date: o.date, start_time: o.time, duration_min: o.dur || 60, location: o.loc || (o.mode === 'online' ? null : 'قاعة الاجتماعات الرئيسية'), mode: o.mode || 'in_person', provider: o.provider || 'none', url: o.url || null,
        objective: o.obj, required_preparation: o.reqprep || null, confidentiality: o.type === 'board' ? 'board' : (o.conf || 'normal'), status: o.status, series_id: o.series || null, recurrence: o.rec || 'none', prev_meeting_id: o.prev || null, started_at: o.started || null, ended_at: o.ended || null, created_by: l.id, created_at: now, updated_at: now });
      const ids = [...new Set([l.id, ...(o.parts || []).map(p => E[p])])];
      for (const pid of ids) {
        const att = o.attend ? (o.attend[Object.keys(E).find(k => E[k] === pid)] || 'attended') : null;
        db.insert('meeting_participants', { meeting_id: id, employee_id: pid, optional: 0, invitation: pid === l.id ? 'accepted' : (o.declined && o.declined.includes(Object.keys(E).find(k => E[k] === pid)) ? 'declined' : (rnd() < 0.7 ? 'accepted' : 'invited')), attendance: att, attendance_mode: att === 'attended' ? (o.mode === 'online' ? 'online' : (o.mode === 'hybrid' && rnd() < 0.4 ? 'online' : 'in_person')) : null });
      }
      (o.agenda || []).forEach((a, i) => { db.insert('agenda_items', { meeting_id: id, seq: i + 1, topic: a.t, presenter_id: a.p ? E[a.p] : null, objective: a.o || null, type: a.type || 'discussion', est_min: a.m || 10, prep_notes: a.prep || null, required_data: a.data || null, required_decision: a.dec || null, status: a.s || 'pending', discussion_notes: a.notes || null, related_kpi_id: a.kpi ? K[a.kpi] : null, created_at: now, updated_at: now }); if (a.kpi) db.run('INSERT OR IGNORE INTO meeting_kpis(meeting_id, kpi_id) VALUES (?,?)', id, K[a.kpi]); });
      taskIds['m_' + key] = id; return id;
    };
    const agendaId = (mid, seq) => db.get('SELECT id FROM agenda_items WHERE meeting_id = ? AND seq = ?', mid, seq).id;
    const decision = (mid, o) => { const m = db.get('SELECT * FROM meetings WHERE id = ?', mid); const id = db.insert('decisions', { code: code('DEC'), meeting_id: mid, agenda_item_id: o.agenda || null, text: o.text, decision_date: o.date || m.meeting_date, owner_id: E[o.owner], responsible_dept_id: db.get('SELECT dept_id FROM employees WHERE id = ?', E[o.owner]).dept_id, effective_date: o.eff || null, status: o.status || 'open', evidence: o.evidence || null, confidentiality: m.confidentiality, created_by: m.leader_id, created_at: now, updated_at: now }); if (o.agenda) db.run('UPDATE agenda_items SET related_decision_id = ? WHERE id = ?', id, o.agenda); return id; };
    const closeMeeting = (mid, summary, next) => { const parts = db.all(`SELECT p.employee_id, e.name, p.invitation, p.attendance, p.attendance_mode, p.optional FROM meeting_participants p JOIN employees e ON e.id = p.employee_id WHERE p.meeting_id = ?`, mid); db.insert('minutes', { meeting_id: mid, summary, next_meeting_note: next || null, attendance_snapshot: JSON.stringify(parts), approved_by: db.get('SELECT leader_id FROM meetings WHERE id = ?', mid).leader_id, approved_at: now, updated_at: now }); };

    const mgmtParts = ['E010', 'E011', 'E020', 'E021', 'E022', 'E023', 'E024'];
    // (1) اجتماع الإدارة السابق — منبع السيناريو الرئيسي
    const m1 = mtg('mgmt_past', { title: 'اجتماع الإدارة الأسبوعي — مراجعة الأداء', type: 'management', leader: 'E001', sec: 'E010', parts: mgmtParts, ...ts(-12, '10:00'), dur: 90, mode: 'hybrid', provider: 'teams', url: 'https://teams.microsoft.example/mock/mgmt-past', obj: 'مراجعة أداء الشهر السابق واتخاذ قرارات تصحيحية', status: 'closed', attend: { E023: 'absent', E024: 'excused' }, prev: null,
      agenda: [{ t: 'مراجعة أداء الشهر السابق', p: 'E010', type: 'information', m: 15, s: 'completed' }, { t: 'انخفاض الإيرادات الشهرية', p: 'E020', type: 'decision_required', m: 25, s: 'completed', kpi: 'REV_M', dec: 'خطة تصحيحية بمسؤول وموعد', notes: 'الإيرادات أقل من المستهدف بسبب ضعف نشاط كبار العملاء وتأخر التسليمات الميدانية.' }, { t: 'ضعف التحصيل', p: 'E021', type: 'decision_required', m: 20, s: 'completed', kpi: 'COLL_PCT', notes: 'تراجع التحصيل إلى 86% مع زيادة الذمم المتأخرة.' }, { t: 'متابعة مشروع ERP', p: 'E023', type: 'follow_up', m: 15, s: 'completed' }] });
    const decRev = decision(m1, { agenda: agendaId(m1, 2), text: 'إطلاق خطة تحفيز مبيعات كبار العملاء وتكثيف الزيارات الميدانية لتعويض فجوة الإيرادات خلال 45 يومًا', owner: 'E020', eff: T(-5), status: 'in_progress' });
    const decColl = decision(m1, { agenda: agendaId(m1, 3), text: 'مراجعة سياسة الائتمان وتسريع تحصيل المتأخرات التي تجاوزت 60 يومًا', owner: 'E021', eff: T(-2), status: 'in_progress' });
    const decErp = decision(m1, { agenda: agendaId(m1, 4), text: 'اعتماد ميزانية المرحلة الثانية من ERP', owner: 'E023', eff: T(-8), status: 'implemented', evidence: 'تم اعتماد الميزانية بقرار الإدارة المالية وتحويل الدفعة الأولى' });
    closeMeeting(m1, 'ناقش الاجتماع انخفاض الإيرادات إلى 80% من المستهدف وضعف التحصيل. اتُّخذت قرارات تصحيحية للمبيعات والائتمان، واعتُمدت ميزانية المرحلة الثانية من ERP.', 'متابعة تنفيذ القرارين الأول والثاني ومراجعة الإيرادات');
    const tPlan = task('plan', { title: 'إعداد الخطة التصحيحية لتعويض فجوة الإيرادات', desc: 'خطة تشمل أهداف كبار العملاء، جدول الزيارات، وحوافز الفريق', source: 'corrective_action', meeting: m1, decision: decRev, agenda: agendaId(m1, 2), kpi: 'REV_M', ini: INI1, owner: 'E020', rev: 'E010', pr: 'critical', w: 3, start: T(-11), due: T(4), status: 'in_progress', p: 60, appr: 1, ev: 1, by: 'E001', created: new Date(Date.now() - 12 * 864e5).toISOString() });
    const tCredit = task('credit', { title: 'تحديث سياسة الائتمان وحدود العملاء', source: 'meeting', meeting: m1, decision: decColl, agenda: agendaId(m1, 3), kpi: 'COLL_PCT', owner: 'E021', rev: 'E011', pr: 'critical', w: 3, start: T(-11), due: T(-3), status: 'in_progress', p: 70, appr: 1, by: 'E001', created: new Date(Date.now() - 12 * 864e5).toISOString() });
    const tList = task('arlist', { title: 'حصر العملاء المتأخرين أكثر من 60 يومًا', source: 'meeting', meeting: m1, decision: decColl, agenda: agendaId(m1, 3), kpi: 'COLL_PCT', owner: 'E044', rev: 'E021', pr: 'high', w: 2, start: T(-11), due: T(-6), status: 'pending_review', p: 100, appr: 1, ev: 1, by: 'E021', updated: new Date(Date.now() - 5 * 864e5).toISOString() });
    db.insert('task_evidence', { task_id: tList, note: 'قائمة العملاء المتأخرين (نسخة Excel) مع أعمار الديون', submitted_by: E['E044'], created_at: new Date(Date.now() - 5 * 864e5).toISOString() });
    db.run(`UPDATE tasks SET approval_status = 'pending' WHERE id = ?`, tList);
    const tIncent = task('incent', { title: 'اعتماد ميزانية الحوافز الاستثنائية للمبيعات', source: 'meeting', meeting: m1, decision: decRev, owner: 'E021', rev: 'E011', pr: 'high', w: 2, start: T(-9), due: T(2), status: 'in_progress', p: 40, by: 'E001' });
    const tLaunch = task('launch', { title: 'إطلاق حوافز كبار العملاء', source: 'initiative', ini: INI1, decision: decRev, owner: 'E020', pr: 'high', w: 2, start: T(0), due: T(10), status: 'blocked', blocked: 'بانتظار اعتماد ميزانية الحوافز من المالية', resolve: T(3), by: 'E010' });
    db.insert('task_dependencies', { task_id: tLaunch, depends_on_id: tIncent, reason: 'لا يمكن إطلاق الحوافز قبل اعتماد ميزانيتها', expected_resolution: T(2) });
    task('erp_budget', { title: 'تحويل الدفعة الأولى لمرحلة ERP', source: 'meeting', meeting: m1, decision: decErp, owner: 'E021', pr: 'medium', start: T(-11), due: T(-7), status: 'completed', p: 100, done: new Date(Date.now() - 8 * 864e5).toISOString(), by: 'E001' });

    // (2) اجتماع مبيعات سابق
    const salesParts = ['E030', 'E031', 'E040', 'E041', 'E042', 'E043'];
    const m2 = mtg('sales_past', { title: 'اجتماع المبيعات الأسبوعي', type: 'department', leader: 'E020', dept: 'DEPT-SALES', parts: salesParts, sec: 'E030', ...ts(-5, '09:30'), dur: 60, obj: 'مراجعة المبيعات وتحديد سقف الخصومات', status: 'closed', attend: { E043: 'excused' }, rec: 'weekly', series: 'sales-wk',
      agenda: [{ t: 'مراجعة أرقام الأسبوع', p: 'E030', type: 'information', s: 'completed' }, { t: 'ارتفاع نسبة الخصم الممنوح', p: 'E031', type: 'decision_required', s: 'completed', kpi: 'DISC_RNG' }, { t: 'خطة الزيارات الميدانية', p: 'E031', type: 'discussion', s: 'completed' }] });
    const decDisc = decision(m2, { agenda: agendaId(m2, 2), text: 'تحديد سقف الخصم عند 4% وأي تجاوز يحتاج موافقة مدير المبيعات', owner: 'E020', eff: T(-4), status: 'in_progress' });
    closeMeeting(m2, 'تمت مراجعة المبيعات، وتم الاتفاق على سقف الخصم وجدول الزيارات الميدانية.', 'متابعة أثر سقف الخصم على الطلبات');
    task('visits', { title: 'زيارة 10 عملاء كبار وتوثيق نتائج الزيارات', source: 'meeting', meeting: m2, owner: 'E040', rev: 'E030', pr: 'high', w: 2, start: T(-5), due: T(-1), status: 'in_progress', p: 50, by: 'E020' });
    task('quotes', { title: 'تحديث نماذج عروض الأسعار حسب سقف الخصم الجديد', source: 'meeting', meeting: m2, decision: decDisc, owner: 'E031', pr: 'medium', start: T(-5), due: T(3), status: 'in_progress', p: 30, by: 'E020' });
    task('crm', { title: 'تسجيل نتائج الزيارات في CRM', source: 'meeting', meeting: m2, owner: 'E041', pr: 'low', start: T(-4), due: T(6), status: 'not_started', by: 'E020' });

    // (3) اجتماع الإدارة القادم (جاهز + حزمة تحضير منشورة ومتاحة)
    const m3 = mtg('mgmt_next', { title: 'اجتماع الإدارة — متابعة الإيرادات والتحصيل', type: 'management', leader: 'E001', sec: 'E010', parts: mgmtParts, ...ts(1, '10:00'), dur: 90, mode: 'hybrid', provider: 'teams', url: 'https://teams.microsoft.example/mock/mgmt-next', obj: 'متابعة تنفيذ قرارات الإيرادات والتحصيل وقياس أثرها', reqprep: 'يرجى مراجعة أرقام الشهر الماضي وإحضار حالة تنفيذ كل قرار', prev: m1, status: 'ready',
      agenda: [{ t: 'متابعة قرار الخطة التصحيحية للإيرادات', p: 'E020', type: 'follow_up', m: 20, kpi: 'REV_M', prep: 'جهّز حالة الخطة ومعدل الزيارات', data: 'تقدم الخطة، الإيراد اليومي' }, { t: 'تحصيل المتأخرات وسياسة الائتمان', p: 'E021', type: 'decision_required', m: 25, kpi: 'COLL_PCT', dec: 'اعتماد سياسة الائتمان الجديدة' }, { t: 'نتائج الربع الثالث وخطة الربع الرابع', p: 'E010', type: 'discussion', m: 25 }, { t: 'مخاطر المبادرات', p: 'E001', type: 'information', m: 10 }] });
    // إتاحة الحزمة
    db.update('meetings', m3, { prep_pack: JSON.stringify(meetings.buildPack(db.get('SELECT * FROM meetings WHERE id = ?', m3))), prep_published_at: now, prep_released_at: now, status: 'ready' });
    db.run('UPDATE meetings SET status = ? WHERE id = ?', 'ready', m3);
    // مرفق على اجتماع الإدارة القادم
    const FILES = process.env.FILES_DIR || path.join(__dirname, '..', 'data', 'files'); fs.mkdirSync(FILES, { recursive: true });
    const putFile = (entity, id, name, text, by) => { const key = crypto.randomUUID(); fs.writeFileSync(path.join(FILES, key), text); return db.insert('attachments', { entity_type: entity, entity_id: id, filename: name, mime: 'text/plain', size: Buffer.byteLength(text), storage_key: key, uploaded_by: E[by], created_at: now }); };
    putFile('meeting', m3, 'ملخص-الإيرادات-سبتمبر.txt', 'ملخص الإيرادات: الفعلي 9.6 مليون جنيه مقابل 12 مليون (80%). أكبر انخفاض في فريق كبار العملاء.', 'E010');

    // (4) اجتماع مبيعات أونلاين خلال دقائق
    const soon = new Date(Date.now() + 20 * 60000); const p2 = n => String(n).padStart(2, '0');
    const soonDate = fmtDate(soon), soonTime = `${p2(soon.getHours())}:${p2(soon.getMinutes())}`;
    const m4 = mtg('sales_online', { title: 'اجتماع المبيعات — متابعة الخطة التصحيحية', type: 'department', leader: 'E020', dept: 'DEPT-SALES', parts: salesParts, sec: 'E030', date: soonDate, time: soonTime, dur: 45, mode: 'online', provider: 'google_meet', url: 'https://meet.google.example/mock/sales-sync', obj: 'مراجعة تقدم الخطة التصحيحية وتوزيع الأهداف على الفريق', prev: m2, rec: 'weekly', series: 'sales-wk', status: 'ready',
      agenda: [{ t: 'حالة الخطة التصحيحية', p: 'E020', type: 'follow_up', m: 15, kpi: 'REV_M', prep: 'اقرأ ملخص الخطة قبل الاجتماع' }, { t: 'أهداف الزيارات الأسبوع القادم', p: 'E031', type: 'discussion', m: 15 }, { t: 'سقف الخصم وأثره', p: 'E020', type: 'information', m: 10, kpi: 'DISC_RNG' }] });
    db.update('meetings', m4, { prep_pack: JSON.stringify(meetings.buildPack(db.get('SELECT * FROM meetings WHERE id = ?', m4))), prep_published_at: now, prep_released_at: now });

    // (5) اجتماع بحزمة تحضير متأخرة
    mtg('collect_late', { title: 'اجتماع تحصيل المستحقات (متعدد الأقسام)', type: 'cross_functional', leader: 'E021', parts: ['E020', 'E022', 'E044', 'E045'], ...ts(1, '13:00'), dur: 60, obj: 'الاتفاق على خطة تحصيل مع المبيعات والعمليات', status: 'preparation', company: 'FT-TRD',
      agenda: [{ t: 'حصر العملاء المتأخرين', p: 'E044', type: 'information', m: 15 }, { t: 'خطة التواصل مع العملاء', p: 'E020', type: 'discussion', m: 25 }] });

    // (6) Board القادم و(7) Board السابق
    const bParts = ['E001', 'E002', 'E003'];
    mtg('board_next', { title: 'اجتماع مجلس الإدارة — نتائج الربع الثالث', type: 'board', leader: 'E002', sec: 'E003', parts: bParts, ...ts(9, '11:00'), dur: 120, obj: 'مراجعة نتائج الربع الثالث واعتماد التوجهات المالية', status: 'preparation',
      agenda: [{ t: 'النتائج المالية للربع الثالث', p: 'E001', type: 'information', m: 40 }, { t: 'قرار الاستثمار في التوسع اللوجستي', p: 'E001', type: 'decision_required', m: 40, dec: 'اعتماد أو تأجيل التوسع' }, { t: 'تقرير المخاطر', p: 'E003', type: 'information', m: 20 }] });
    const mB = mtg('board_past', { title: 'اجتماع مجلس الإدارة — الموازنة المبدئية 2027', type: 'board', leader: 'E002', sec: 'E003', parts: bParts, ...ts(-40, '11:00'), dur: 120, obj: 'اعتماد الإطار المبدئي لموازنة 2027', status: 'closed',
      agenda: [{ t: 'الإطار المبدئي للموازنة', p: 'E001', type: 'decision_required', s: 'completed' }, { t: 'سقف الاستثمار في ERP', p: 'E001', type: 'decision_required', s: 'completed' }] });
    const decB = decision(mB, { agenda: agendaId(mB, 2), text: 'اعتماد سقف استثمار قدره 4 مليون جنيه لمشروع ERP على مرحلتين', owner: 'E001', eff: T(-30), status: 'in_progress' });
    closeMeeting(mB, 'اعتمد المجلس الإطار المبدئي للموازنة وسقف الاستثمار في ERP.', 'متابعة استهلاك الميزانية في الاجتماع القادم');
    task('board_task', { title: 'إعداد دراسة جدوى التوسع اللوجستي للمجلس', source: 'meeting', meeting: mB, owner: 'E001', rev: 'E002', pr: 'high', w: 3, start: T(-30), due: T(20), status: 'in_progress', p: 35, conf: 'board', by: 'E003' });
    putFile('meeting', mB, 'محضر-الموازنة-سري.txt', 'وثيقة سرية للمجلس: سقف الاستثمار في ERP 4 مليون جنيه. لا يُوزَّع خارج المجلس.', 'E003');

    // (8) اجتماع متكرر لتقنية المعلومات
    const itParts = ['E048']; const itBase = { title: 'اجتماع تقنية المعلومات الأسبوعي', type: 'department', leader: 'E023', dept: 'DEPT-IT', parts: itParts, time: '09:00', dur: 30, mode: 'in_person', obj: 'متابعة المشاريع والتذاكر', rec: 'weekly', series: 'it-wk' };
    const itA = mtg('it1', { ...itBase, date: T(-12), status: 'closed', agenda: [{ t: 'حالة التذاكر', s: 'completed' }] }); closeMeeting(itA, 'مراجعة التذاكر المفتوحة.');
    const itB = mtg('it2', { ...itBase, date: T(-5), status: 'closed', prev: itA, agenda: [{ t: 'حالة التذاكر', s: 'completed' }, { t: 'جاهزية ERP', s: 'completed' }] }); closeMeeting(itB, 'جاهزية بيئة الاختبار لـERP.');
    const itC = mtg('it3', { ...itBase, date: T(2), status: 'preparation_published', prev: itB, agenda: [{ t: 'حالة التذاكر' }, { t: 'اختبار ERP' }] });
    db.update('meetings', itC, { prep_pack: JSON.stringify(meetings.buildPack(db.get('SELECT * FROM meetings WHERE id = ?', itC))), prep_published_at: now, prep_released_at: now });

    // (9) لجنة، (10) وحدة أعمال، (11) اجتماع مباشر الآن، (12) محضر قيد المراجعة
    mtg('committee', { title: 'لجنة الائتمان', type: 'committee', leader: 'E021', parts: ['E020', 'E010', 'E044'], ...ts(14, '12:00'), dur: 60, obj: 'مراجعة حدود الائتمان للعملاء الكبار', status: 'draft', company: 'FT-TRD' });
    const m10 = mtg('bu_com', { title: 'اجتماع وحدة الأعمال التجارية', type: 'business_unit', leader: 'E010', bu: 'BU-COM', parts: ['E020', 'E022'], ...ts(4, '11:00'), dur: 60, obj: 'مراجعة أداء المبيعات والعمليات وخطة الربع الرابع', status: 'preparation_published', agenda: [{ t: 'أداء الربع الثالث', p: 'E010', type: 'information' }, { t: 'خطة الربع الرابع', p: 'E020', type: 'discussion' }] });
    db.update('meetings', m10, { prep_pack: JSON.stringify(meetings.buildPack(db.get('SELECT * FROM meetings WHERE id = ?', m10))), prep_published_at: now });
    const started = new Date(Date.now() - 10 * 60000); const mLive = mtg('ops_live', { title: 'اجتماع العمليات اليومي', type: 'department', leader: 'E022', dept: 'DEPT-OPS', parts: ['E032', 'E046', 'E047'], date: fmtDate(started), time: `${p2(started.getHours())}:${p2(started.getMinutes())}`, dur: 30, obj: 'متابعة طلبات اليوم ومشاكل التسليم', status: 'live', started: started.toISOString(),
      agenda: [{ t: 'طلبات اليوم', p: 'E047', type: 'information', s: 'completed', m: 5 }, { t: 'تأخر شحنات الموردين', p: 'E046', type: 'discussion', s: 'discussing', m: 15, notes: 'تأخر شحنتين بسبب النقل.' }, { t: 'جاهزية جرد نهاية الشهر', p: 'E032', type: 'decision_required', m: 10 }] });
    db.run(`UPDATE meeting_participants SET attendance = 'attended', attendance_mode = 'in_person' WHERE meeting_id = ? AND employee_id IN (?,?)`, mLive, E['E022'], E['E032']);
    const mHr = mtg('hr_review', { title: 'اجتماع الموارد البشرية — الاستقطاب', type: 'department', leader: 'E024', dept: 'DEPT-HR', parts: ['E049'], ...ts(-3, '10:00'), dur: 45, obj: 'مراجعة مؤشرات الاستقطاب', status: 'under_review', agenda: [{ t: 'ارتفاع زمن التوظيف', p: 'E049', type: 'decision_required', s: 'completed', kpi: 'TTH_DAYS' }] });
    db.run(`UPDATE meeting_participants SET attendance = 'attended', attendance_mode = 'in_person' WHERE meeting_id = ?`, mHr);
    db.insert('minutes', { meeting_id: mHr, summary: 'ناقش الاجتماع ارتفاع زمن التوظيف إلى 34 يومًا، وتم الاتفاق على تبسيط خطوات الموافقة.', updated_at: now });
    const decHr = decision(mHr, { agenda: agendaId(mHr, 1), text: 'تقليص مراحل اعتماد التوظيف من 4 مراحل إلى مرحلتين', owner: 'E024', eff: T(14) });

    // المهام التشغيلية الإضافية
    task('closing_series1', { title: 'إقفال الشهر المالي', source: 'recurring', owner: 'E044', rev: 'E021', pr: 'high', w: 2, start: T(-95), due: T(-70), status: 'completed', p: 100, appr: 1, ev: 1, rec: 'monthly', series: 'close-m', occ: 1, done: new Date(Date.now() - 71 * 864e5).toISOString(), by: 'E021' });
    task('closing_series2', { title: 'إقفال الشهر المالي', source: 'recurring', owner: 'E044', rev: 'E021', pr: 'high', w: 2, start: T(-65), due: T(-40), status: 'completed', p: 100, appr: 1, ev: 1, rec: 'monthly', series: 'close-m', occ: 2, done: new Date(Date.now() - 39 * 864e5).toISOString(), by: 'E021' });
    task('closing_series3', { title: 'إقفال الشهر المالي', source: 'recurring', owner: 'E044', rev: 'E021', pr: 'high', w: 2, start: T(-35), due: T(-10), status: 'completed', p: 100, appr: 1, ev: 1, rec: 'monthly', series: 'close-m', occ: 3, done: new Date(Date.now() - 7 * 864e5).toISOString(), by: 'E021' });
    task('closing_series4', { title: 'إقفال الشهر المالي', source: 'recurring', owner: 'E044', rev: 'E021', pr: 'high', w: 2, start: T(-5), due: T(20), status: 'in_progress', p: 20, appr: 1, ev: 1, rec: 'monthly', series: 'close-m', occ: 4, by: 'E021' });
    task('erp_test', { title: 'تنفيذ اختبار قبول المستخدم لوحدة المخزون في ERP', source: 'initiative', ini: INI2, owner: 'E048', rev: 'E023', pr: 'high', w: 2, start: T(-10), due: T(5), status: 'in_progress', p: 55, by: 'E023' });
    task('integration', { title: 'ربط نظام التحصيل الإلكتروني', source: 'project', owner: 'E023', pr: 'high', w: 2, start: T(-20), due: T(7), status: 'blocked', blocked: 'بانتظار موافقة المورد على بيئة الاختبار', resolve: T(5), by: 'E011' });
    task('stock_count', { title: 'جرد مستودع الجملة وتسوية الفروقات', source: 'kpi', kpi: 'INV_DAYS', ini: INI3, owner: 'E046', rev: 'E032', pr: 'medium', w: 2, start: T(-3), due: T(8), status: 'in_progress', p: 30, by: 'E022' });
    task('slow_stock', { title: 'خطة تصريف المخزون بطيء الحركة', source: 'initiative', ini: INI3, owner: 'E022', pr: 'high', w: 2, start: T(-10), due: T(-2), status: 'in_progress', p: 45, by: 'E010' });
    task('hiring', { title: 'تبسيط إجراءات الموافقة على التوظيف', source: 'meeting', meeting: mHr, decision: decHr, owner: 'E049', rev: 'E024', pr: 'medium', start: T(-2), due: T(12), status: 'not_started', by: 'E024' });
    task('retention', { title: 'إعداد مسودة برنامج استبقاء المواهب', source: 'initiative', ini: INI4, owner: 'E049', pr: 'low', start: T(10), due: T(30), status: 'not_started', by: 'E024' });
    task('ops_daily', { title: 'تحديث لوحة متابعة التسليم اليومية', source: 'operational', owner: 'E047', rev: 'E022', pr: 'medium', start: T(-2), due: T(0), status: 'in_progress', p: 80, by: 'E022' });
    task('ops_route', { title: 'إعادة جدولة مسارات التوزيع للأسبوع القادم', source: 'operational', owner: 'E047', pr: 'medium', start: T(0), due: T(3), status: 'not_started', by: 'E022' });
    task('fin_report', { title: 'إعداد تقرير التدفقات النقدية الأسبوعي', source: 'operational', owner: 'E045', rev: 'E021', pr: 'medium', start: T(-1), due: T(2), status: 'in_progress', p: 50, by: 'E021' });
    task('policy_hr', { title: 'تحديث دليل السياسات', source: 'operational', owner: 'E049', pr: 'low', start: T(-14), due: T(-4), status: 'in_progress', p: 70, by: 'E024' });
    task('ka_prop', { title: 'إعداد عرض متكامل لعميل كبير (مجموعة النور)', source: 'kpi', kpi: 'NEW_ACC_40', owner: 'E040', rev: 'E030', pr: 'high', w: 2, start: T(-4), due: T(6), status: 'in_progress', p: 40, by: 'E030' });
    task('field_plan', { title: 'خطة زيارات الأسبوع القادم', source: 'operational', owner: 'E043', pr: 'medium', start: T(0), due: T(4), status: 'not_started', by: 'E031' });
    task('lg_route', { title: 'مراجعة تكلفة الرحلات الشهرية', source: 'operational', owner: 'E061', rev: 'E060', pr: 'medium', start: T(-3), due: T(5), status: 'in_progress', p: 20, by: 'E060' });
    // مهام تاريخية مكتملة لتغذية الأداء السابق
    const owners = ['E040', 'E041', 'E042', 'E043', 'E044', 'E045', 'E046', 'E047', 'E048', 'E049'];
    const monthsBack = [[-95, -65], [-65, -35], [-35, -6]];
    for (const [a, b] of monthsBack) for (const o of owners) {
      for (let i = 0; i < 2; i++) { const due = T(Math.round(a + rnd() * (b - a))); const late = rnd() < 0.2 ? Math.round(2 + rnd() * 4) : 0; const meet = rnd() < 0.3; const open = false; rnd();
        task(null, { title: ['تحديث تقرير المتابعة الأسبوعي', 'مراجعة بيانات العملاء', 'تجهيز مستندات الاجتماع', 'إغلاق ملاحظات المراجعة', 'تحديث لوحة المؤشرات'][Math.floor(rnd() * 5)], source: meet ? 'meeting' : 'operational', owner: o, pr: ['low', 'medium', 'medium', 'high'][Math.floor(rnd() * 4)], w: 1 + Math.floor(rnd() * 2), start: addDays(due, -7), due, status: open ? 'in_progress' : 'completed', p: open ? 60 : 100, done: open ? null : new Date(new Date(due + 'T12:00:00').getTime() + late * 864e5).toISOString(), by: 'E020' }); }
    }

    // ---------- فترات الأداء والتقييمات ----------
    const per = (key, status, version = 1) => { const p = periods.parseKey(key); return db.insert('performance_periods', { key, kind: p.kind, label: p.label, start_date: p.start, end_date: p.end, status, version, created_at: now, updated_at: now }); };
    keys.forEach((kk, i) => per(kk, i < 4 ? 'approved' : i === 4 ? 'approved' : 'under_review'));
    const octId = per(cur, 'open');
    // تقييمات الفترات قبل الإقفال
    const reportsOfSami = ['E040', 'E041', 'E042', 'E043'];
    const asmt = (pk, emp, o) => { const p = db.get('SELECT id FROM performance_periods WHERE key = ?', pk); const id = db.insert('assessments', { period_id: p.id, employee_id: E[emp], manager_score: o.score, manager_comment: o.comment, proposed_rating: o.rating, final_rating: o.stage === 'final_approved' ? o.rating : null, stage: o.stage, feedback_for_employee: o.fb || null, development_actions: o.dev || null, assessed_by: E[o.by], approved_by: o.stage === 'final_approved' ? E['E024'] : null, approved_at: o.stage === 'final_approved' ? now : null, created_at: now, updated_at: now }); db.insert('assessment_stages', { assessment_id: id, stage: o.stage, actor_id: E[o.by], comment: 'تم الاعتماد', created_at: now }); return id; };
    for (const e of ['E040', 'E041', 'E042', 'E043']) for (const pk of keys.slice(0, 5)) {
      const sco = 70 + Math.round(rnd() * 25); asmt(pk, e, { score: sco, comment: 'أداء مقبول مع فرص للتحسين في المتابعة.', rating: sco >= 90 ? 'يتجاوز التوقعات' : sco >= 75 ? 'يحقق التوقعات' : 'يحتاج إلى تحسين', stage: 'final_approved', by: e === 'E040' || e === 'E041' ? 'E030' : 'E031', fb: 'شكرًا على الالتزام، ننتظر تحسنًا في الجانب الميداني.', dev: 'دورة في إدارة الحسابات الكبرى' });
    }
    // سبتمبر (قيد المراجعة): مراحل مختلفة
    asmt(sepKey, 'E040', { score: 58, comment: 'تراجع واضح في استقطاب حسابات جديدة وتأخر في تقارير الزيارات.', rating: 'يحتاج إلى تحسين', stage: 'manager_review', by: 'E030' });
    asmt(sepKey, 'E041', { score: 88, comment: 'أداء ممتاز والتزام بالمواعيد.', rating: 'يحقق التوقعات', stage: 'department_review', by: 'E030' });
    asmt(sepKey, 'E042', { score: 82, comment: 'جيد، يحتاج دعم في العروض.', rating: 'يحقق التوقعات', stage: 'management_calibration', by: 'E031' });
    // Check-ins
    db.insert('checkins', { employee_id: E['E040'], period_key: sepKey, kind: 'monthly', achievements: 'أنهيت اتفاق مع عميل جديد واحد وحسّنت التوثيق.', challenges: 'صعوبة الوصول لصانع القرار في عميلين كبيرين.', blockers: 'عرض الأسعار ينتظر موافقة المبيعات.', support_required: 'جلسة مع المدير لوضع خطة للحسابات المتعثرة.', employee_comment: 'أحتاج دعمًا أكبر في الربع الأخير.', status: 'submitted', created_at: now, updated_at: now });
    db.insert('checkins', { employee_id: E['E041'], period_key: sepKey, kind: 'monthly', achievements: 'تجاوزت هدف الحسابات.', status: 'draft', created_at: now, updated_at: now });
    db.insert('checkins', { employee_id: E['E042'], period_key: sepKey, kind: 'monthly', achievements: 'زيارات منتظمة.', challenges: 'ازدحام المسارات.', manager_comment: 'أحسنت، ركّز على جودة العروض.', agreed_actions: 'تدريب على إعداد العروض خلال أسبوعين', status: 'reviewed', created_at: now, updated_at: now });
    // قفل الفترات المعتمدة قبل Aug (إنشاء Snapshots عبر منطق التطبيق)
    for (const kk of keys.slice(0, 5)) { const p = db.get('SELECT * FROM performance_periods WHERE key = ?', kk); db.update('performance_periods', p.id, { status: 'locked', locked_at: now, locked_by: E['E024'] }); perf.lockPeriod({ ...p, status: 'locked' }, { id: E['E024'] }); }
    // إعادة فتح مسجّلة في التدقيق لتوضيح الدورة (Jul) مع سبب
    const { log } = require('./audit');
    log(E['E024'], 'period', db.get('SELECT id FROM performance_periods WHERE key = ?', keys[2]).id, 'reopen', 'status', 'locked', 'under_review', 'تصحيح خطأ إدخال مبيعات فريق كبار العملاء');
    log(E['E024'], 'period', db.get('SELECT id FROM performance_periods WHERE key = ?', keys[2]).id, 'transition', 'status', 'under_review', 'locked', 'إعادة الإقفال بعد التصحيح');
    log(E['E001'], 'kpi', K.REV_M, 'update', 'target', '11500000', '12000000', 'رفع المستهدف وفق موازنة 2026');
    log(E['E020'], 'task', taskIds.plan, 'update', 'due_date', T(-1), T(4), 'مد المهلة لاستكمال خطة الحوافز');
    log(E['E011'], 'task', taskIds.credit, 'update', 'owner_id', String(E['E044']), String(E['E021']), 'نقل المسؤولية لمدير المالية');

    // الاستيراد الأخير: تأكد من وجود تسلسلات
  });
  return { ok: true };
}

function resetFiles() {
  for (const f of [db.DB_PATH, db.DB_PATH + '-wal', db.DB_PATH + '-shm']) if (fs.existsSync(f)) fs.rmSync(f);
  const dir = process.env.FILES_DIR || path.join(__dirname, '..', 'data', 'files'); if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}
module.exports = { seed, resetFiles, DEMO_PASSWORD };

if (require.main === module) {
  if (process.argv.includes('--reset')) resetFiles();
  db.open();
  require('./routes');
  seed();
  // توليد الإشعارات الأولية عبر الأتمتة الفعلية
  const r = require('./automation').runAll();
  const n = require('./db');
  // إشعارات إضافية مرتبطة بسيناريو العرض
  const { E_ } = {};
  console.log('seeded', JSON.stringify(r));
}
