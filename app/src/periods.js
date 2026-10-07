'use strict';
const { parseDate, fmtDate, addDays, bad } = require('./util');

const pad = n => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function isoWeekRange(y, w) {
  const jan4 = new Date(y, 0, 4); const dow = (jan4.getDay() + 6) % 7;
  const mon = new Date(y, 0, 4 - dow + (w - 1) * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [fmtDate(mon), fmtDate(sun)];
}
// period key -> {kind,start,end,label}
function parseKey(key) {
  let m;
  if ((m = /^(\d{4})-(\d{2})$/.exec(key))) { const y = +m[1], mo = +m[2]; if (mo < 1 || mo > 12) throw bad('فترة غير صحيحة'); return { kind: 'monthly', start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`, label: `${MONTHS_AR[mo - 1]} ${y}` }; }
  if ((m = /^(\d{4})-Q([1-4])$/.exec(key))) { const y = +m[1], q = +m[2]; const sm = (q - 1) * 3 + 1; return { kind: 'quarterly', start: `${y}-${pad(sm)}-01`, end: `${y}-${pad(sm + 2)}-${pad(lastDay(y, sm + 2))}`, label: `الربع ${q} ${y}` }; }
  if ((m = /^(\d{4})$/.exec(key))) return { kind: 'annual', start: `${m[1]}-01-01`, end: `${m[1]}-12-31`, label: `سنة ${m[1]}` };
  if ((m = /^(\d{4})-W(\d{2})$/.exec(key))) { const [s, e] = isoWeekRange(+m[1], +m[2]); return { kind: 'weekly', start: s, end: e, label: `الأسبوع ${+m[2]} / ${m[1]}` }; }
  return null;
}
function keyFor(date, freq) {
  const y = +date.slice(0, 4), mo = +date.slice(5, 7);
  if (freq === 'monthly') return `${y}-${pad(mo)}`;
  if (freq === 'quarterly') return `${y}-Q${Math.ceil(mo / 3)}`;
  if (freq === 'annual') return `${y}`;
  if (freq === 'weekly') {
    const d = parseDate(date); const t = new Date(d); t.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const w1 = new Date(t.getFullYear(), 0, 4); const wk = 1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
    return `${t.getFullYear()}-W${pad(wk)}`;
  }
  return `${y}-${pad(mo)}`;
}
const prevKey = key => {
  const p = parseKey(key); if (!p) return null;
  return keyFor(addDays(p.start, -1), p.kind);
};
const nextKey = key => { const p = parseKey(key); return keyFor(addDays(p.end, 1), p.kind); };

module.exports = { parseKey, keyFor, prevKey, nextKey, MONTHS_AR };
