'use strict';
const db = require('./db');

class HttpError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const bad = (m, details) => new HttpError(400, m, 'VALIDATION', details);
const forbidden = (m = 'لا تملك صلاحية لتنفيذ هذا الإجراء.') => new HttpError(403, m, 'FORBIDDEN');
const notFound = (m = 'السجل المطلوب غير موجود.') => new HttpError(404, m, 'NOT_FOUND');
const conflict = (m, code = 'CONFLICT') => new HttpError(409, m, code);

const nowIso = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "اليوم" يمكن تثبيته بمتغير بيئة للاختبار
const today = () => process.env.APP_TODAY || fmtDate(new Date());
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); };
const diffDays = (a, b) => Math.round((parseDate(a) - parseDate(b)) / 86400000);
const meetingStart = m => new Date(`${m.meeting_date}T${m.start_time}:00`);
const nowDate = () => (process.env.APP_TODAY ? new Date(`${process.env.APP_TODAY}T12:00:00`) : new Date());

function nextSeq(name) {
  return db.tx(() => {
    const r = db.get('SELECT last_value FROM sequences WHERE name = ?', name);
    const v = (r ? r.last_value : 0) + 1;
    if (r) db.run('UPDATE sequences SET last_value = ? WHERE name = ?', v, name);
    else db.run('INSERT INTO sequences(name, last_value) VALUES (?, ?)', name, v);
    return v;
  });
}
const code = (prefix, yearly = true) => {
  const y = today().slice(0, 4);
  const n = nextSeq(yearly ? `${prefix}-${y}` : prefix);
  return yearly ? `${prefix}-${y}-${String(n).padStart(4, '0')}` : `${prefix}-${String(n).padStart(4, '0')}`;
};

function setting(key, fallback) {
  const r = db.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : fallback;
}

// تحقق بسيط من المدخلات
function need(body, spec) {
  const out = {}; const errs = {};
  for (const [k, rule] of Object.entries(spec)) {
    let v = body[k];
    if (typeof v === 'string') v = v.trim();
    const [type, req, extra] = rule.split(':');
    if (v === undefined || v === null || v === '') {
      if (req === 'req') errs[k] = 'هذا الحقل مطلوب';
      out[k] = null; continue;
    }
    if (type === 'int') { v = Number(v); if (!Number.isInteger(v)) { errs[k] = 'قيمة غير صحيحة'; continue; } }
    else if (type === 'num') { v = Number(v); if (!Number.isFinite(v)) { errs[k] = 'قيمة غير صحيحة'; continue; } }
    else if (type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(parseDate(v))) { errs[k] = 'تاريخ غير صحيح'; continue; } }
    else if (type === 'time') { if (!/^\d{2}:\d{2}$/.test(v)) { errs[k] = 'وقت غير صحيح'; continue; } }
    else if (type === 'enum') { if (!extra.split('|').includes(v)) { errs[k] = 'قيمة غير مسموحة'; continue; } }
    else if (type === 'bool') { v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; }
    else if (type === 'str') { v = String(v); if (v.length > 5000) { errs[k] = 'النص أطول من المسموح'; continue; } }
    out[k] = v;
  }
  if (Object.keys(errs).length) throw bad('راجع الحقول المحددة وحاول مرة أخرى.', errs);
  return out;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

module.exports = { HttpError, bad, forbidden, notFound, conflict, nowIso, today, addDays, diffDays, parseDate, fmtDate, meetingStart, nowDate, nextSeq, code, setting, need, pick };
