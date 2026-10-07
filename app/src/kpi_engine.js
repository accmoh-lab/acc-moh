'use strict';
// محرك KPI: لكل نوع KPI طريقة حساب خاصة، وعتبات (Thresholds) مستقلة لكل KPI.
const db = require('./db');
const { conflict, bad, nowIso, forbidden } = require('./util');
const audit = require('./audit');
const periods = require('./periods');

const QUALITY_ORDER = ['missing', 'draft', 'submitted', 'verified', 'approved'];
const OFFICIAL = new Set(['verified', 'approved']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function achievementFor(k, actual, target = k.target) {
  if (actual === null || actual === undefined || Number.isNaN(actual)) return null;
  let a;
  switch (k.kpi_type) {
    case 'higher_better': a = target > 0 ? actual / target * 100 : (actual >= target ? 100 : 0); break;
    case 'lower_better': a = actual <= 0 ? 150 : (target > 0 ? target / actual * 100 : 0); break;
    case 'target_range': {
      const lo = k.range_min, hi = k.range_max; const w = (hi - lo) || 1;
      a = actual >= lo && actual <= hi ? 100 : 100 - (actual < lo ? lo - actual : actual - hi) / w * 100; break;
    }
    case 'exact_target': a = target === 0 ? (actual === 0 ? 100 : 0) : 100 - Math.abs(actual - target) / Math.abs(target) * 100; break;
    case 'milestone': a = target > 0 ? actual / target * 100 : 0; break;      // actual = نسبة إنجاز المعالم
    case 'boolean': a = actual >= 1 ? 100 : 0; break;
    case 'formula': a = k.direction === 'lower' ? (actual <= 0 ? 150 : target / actual * 100) : (target > 0 ? actual / target * 100 : 0); break;
    default: a = 0;
  }
  return Math.round(clamp(a, 0, 200) * 10) / 10;
}
function statusFor(k, ach) {
  if (ach === null) return 'missing';
  return ach >= k.green_min ? 'green' : ach >= k.amber_min ? 'amber' : 'red';
}

// ---- Formula parser آمن (أرقام، رموز KPI، + - * / وأقواس فقط) ----
function evalFormula(expr, lookup) {
  const tokens = String(expr).match(/\s*([A-Z][A-Z0-9_]*|\d+(?:\.\d+)?|[()+\-*/])/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== String(expr).replace(/\s/g, '')) throw bad('صيغة غير صحيحة: يُسمح بالأرقام ورموز KPI والعمليات + - * / والأقواس فقط.');
  const t = tokens.map(x => x.trim()); let i = 0;
  const peek = () => t[i], next = () => t[i++];
  function prim() {
    const x = next();
    if (x === undefined) throw bad('صيغة غير مكتملة');
    if (x === '(') { const v = expr_(); if (next() !== ')') throw bad('أقواس غير متوازنة'); return v; }
    if (x === '-') { const v = prim(); return v === null ? null : -v; }
    if (/^\d/.test(x)) return Number(x);
    return lookup(x);
  }
  function term() { let v = prim(); while (peek() === '*' || peek() === '/') { const op = next(); const r = prim(); v = v === null || r === null ? null : op === '*' ? v * r : (r === 0 ? null : v / r); } return v; }
  function expr_() { let v = term(); while (peek() === '+' || peek() === '-') { const op = next(); const r = term(); v = v === null || r === null ? null : op === '+' ? v + r : v - r; } return v; }
  const out = expr_();
  if (i < t.length) throw bad('صيغة غير صحيحة');
  return out;
}
const formulaCodes = f => [...new Set(String(f || '').match(/[A-Z][A-Z0-9_]*/g) || [])];

function validateKpi(k) {
  if (k.kpi_type === 'target_range') {
    if (k.range_min == null || k.range_max == null || k.range_min >= k.range_max) throw bad('حدّا النطاق المستهدف غير صحيحين: الحد الأدنى يجب أن يكون أقل من الأعلى.');
  } else if (k.kpi_type !== 'boolean' && k.kpi_type !== 'formula' && (k.target === null || k.target === undefined)) throw bad('القيمة المستهدفة (Target) مطلوبة.');
  if (k.kpi_type === 'formula') {
    if (!k.formula) throw bad('الصيغة مطلوبة لمؤشر من نوع Formula Based.');
    evalFormula(k.formula, c => { if (!db.get('SELECT 1 x FROM kpis WHERE code = ? AND deleted_at IS NULL', c)) throw bad(`رمز KPI غير معروف في الصيغة: ${c}`); return 1; });
    if (formulaCodes(k.formula).includes(k.code)) throw bad('الصيغة لا يمكن أن تشير إلى المؤشر نفسه.');
  }
  if (k.green_min < k.amber_min) throw bad('عتبة Green يجب ألا تقل عن عتبة Amber.');
  if (!k.owner_id) throw bad('لا يمكن حفظ KPI بدون مسؤول (Owner).');
  if (k.weight < 0) throw bad('الوزن لا يمكن أن يكون سالبًا.');
}

// الفترة المغطاة بفترة أداء معتمدة/مقفلة لا يُعدَّل فيها بصمت
function assertPeriodEditable(periodKey) {
  const p = periods.parseKey(periodKey); if (!p) throw bad('فترة غير صحيحة.');
  const blocked = db.get(`SELECT label, status FROM performance_periods WHERE status IN ('approved','locked') AND start_date <= ? AND end_date >= ?`, p.start, p.end);
  if (blocked) throw conflict(`الفترة «${blocked.label}» ${blocked.status === 'locked' ? 'مقفلة' : 'معتمدة'}. لا يمكن التعديل إلا بعد إعادة فتحها بإذن وسبب، أو بإنشاء سجل تسوية (Adjustment).`, 'PERIOD_LOCKED');
}

function getResult(kpiId, periodKey) { return db.get('SELECT * FROM kpi_results WHERE kpi_id = ? AND period_key = ?', kpiId, periodKey); }

function upsertResult(k, periodKey, fields, userId) {
  const p = periods.parseKey(periodKey);
  const cur = getResult(k.id, periodKey);
  const target = fields.target !== undefined ? fields.target : (cur && cur.target !== null ? cur.target : k.target);
  const actual = fields.actual !== undefined ? fields.actual : cur ? cur.actual : null;
  const ach = achievementFor(k, actual, target);
  const row = {
    target, actual, achievement: ach, status: statusFor(k, ach),
    data_quality: fields.data_quality || (cur ? cur.data_quality : (actual === null ? 'missing' : 'draft')),
    note: fields.note !== undefined ? fields.note : cur?.note ?? null,
    evidence: fields.evidence !== undefined ? fields.evidence : cur?.evidence ?? null,
    updated_by: userId ?? cur?.updated_by ?? null, updated_at: nowIso(),
  };
  if (actual === null) row.data_quality = 'missing';
  if (cur) { db.update('kpi_results', cur.id, row); return { ...cur, ...row }; }
  const id = db.insert('kpi_results', { kpi_id: k.id, period_key: periodKey, period_start: p.start, period_end: p.end, created_at: nowIso(), ...row });
  return { id, kpi_id: k.id, period_key: periodKey, ...row };
}

// تحديث المؤشرات المشتقة (Formula / Rollup) بعد تغيّر مدخلاتها
function recomputeDerived(kpiId, periodKey, userId, seen = new Set()) {
  const k = db.get('SELECT * FROM kpis WHERE id = ?', kpiId);
  if (!k || seen.has(k.id)) return; seen.add(k.id);
  // 1) Rollup للأب
  if (k.parent_kpi_id) {
    const parent = db.get('SELECT * FROM kpis WHERE id = ?', k.parent_kpi_id);
    if (parent && parent.rollup) {
      const kids = db.all(`SELECT r.actual, r.data_quality FROM kpis c LEFT JOIN kpi_results r ON r.kpi_id = c.id AND r.period_key = ? WHERE c.parent_kpi_id = ? AND c.deleted_at IS NULL`, periodKey, parent.id);
      const vals = kids.map(x => x.actual);
      let actual = null, q = 'missing';
      if (vals.length && vals.every(v => v !== null)) {
        actual = vals.reduce((a, b) => a + b, 0); if (parent.rollup === 'avg') actual /= vals.length;
        q = kids.map(x => x.data_quality).sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))[0];
      }
      upsertResult(parent, periodKey, { actual, data_quality: q }, userId);
      recomputeDerived(parent.id, periodKey, userId, seen);
    }
  }
  // 2) المؤشرات التي تعتمد على هذا الرمز في صيغتها
  for (const f of db.all(`SELECT * FROM kpis WHERE kpi_type = 'formula' AND formula LIKE ? AND deleted_at IS NULL`, `%${k.code}%`)) {
    if (!formulaCodes(f.formula).includes(k.code)) continue;
    const qs = [];
    const val = evalFormula(f.formula, c => {
      const kk = db.get('SELECT id FROM kpis WHERE code = ?', c); const r = kk && getResult(kk.id, periodKey);
      qs.push(r ? r.data_quality : 'missing'); return r ? r.actual : null;
    });
    const q = qs.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))[0] || 'missing';
    upsertResult(f, periodKey, { actual: val === null ? null : Math.round(val * 100) / 100, data_quality: val === null ? 'missing' : q }, userId);
    recomputeDerived(f.id, periodKey, userId, seen);
  }
}

// إدخال/تحديث نتيجة KPI لفترة (مع التدقيق وحماية الفترات المقفلة)
function saveActual(user, k, periodKey, { actual, target, note, evidence }) {
  assertPeriodEditable(periodKey);
  if (k.data_source === 'calculated' || k.kpi_type === 'formula') throw conflict('هذا المؤشر محسوب تلقائيًا من مؤشرات أخرى ولا يُدخل يدويًا.', 'CALCULATED');
  if (actual !== null && actual !== undefined && !Number.isFinite(Number(actual))) throw bad('القيمة الفعلية يجب أن تكون رقمًا.');
  return db.tx(() => {
    const cur = getResult(k.id, periodKey);
    const r = upsertResult(k, periodKey, { actual: actual === null || actual === '' ? null : Number(actual), target: target === undefined ? undefined : Number(target), note, evidence, data_quality: actual === null || actual === '' ? 'missing' : 'draft' }, user.id);
    audit.log(user.id, 'kpi_result', r.id, cur ? 'update' : 'create', 'actual', cur?.actual ?? null, r.actual, note || null);
    if (target !== undefined && cur && cur.target !== Number(target)) audit.log(user.id, 'kpi_result', r.id, 'update', 'target', cur.target, Number(target), note || null);
    recomputeDerived(k.id, periodKey, user.id);
    return getResult(k.id, periodKey);
  });
}

const QUALITY_FLOW = { submit: ['draft', 'submitted'], verify: ['submitted', 'verified'], approve: ['verified', 'approved'], return: [null, 'draft'] };

module.exports = { achievementFor, statusFor, evalFormula, formulaCodes, validateKpi, assertPeriodEditable, getResult, upsertResult, recomputeDerived, saveActual, QUALITY_ORDER, OFFICIAL, QUALITY_FLOW };
