'use strict';
const db = require('./db');
const { nowIso } = require('./util');

// سجل تدقيق للتغييرات المهمة: المستخدم، الوقت، القيمة القديمة والجديدة، والسبب
function log(userId, entity, entityId, action, field = null, oldV = null, newV = null, reason = null) {
  const s = v => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  db.run('INSERT INTO audit_log(user_id, ts, entity, entity_id, action, field, old_value, new_value, reason) VALUES (?,?,?,?,?,?,?,?,?)',
    userId, nowIso(), entity, entityId, action, field, s(oldV), s(newV), reason);
}
// سجّل الحقول المتغيّرة فقط
function diff(userId, entity, entityId, before, after, fields, reason) {
  for (const f of fields) {
    if (after[f] !== undefined && String(before[f] ?? '') !== String(after[f] ?? '')) log(userId, entity, entityId, 'update', f, before[f], after[f], reason);
  }
}
module.exports = { log, diff };
