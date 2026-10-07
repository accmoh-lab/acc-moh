'use strict';
// ذاكرة مؤقتة قصيرة العمر للحسابات الثقيلة؛ تُبطل بالكامل عند أي كتابة (بساطة مقصودة).
let version = 0; const store = new Map();
const bump = () => { version++; store.clear(); };
function memo(key, ttlMs, fn) {
  const e = store.get(key);
  if (e && e.v === version && Date.now() - e.t < ttlMs) return e.val;
  const val = fn(); store.set(key, { v: version, t: Date.now(), val }); return val;
}
module.exports = { bump, memo };
