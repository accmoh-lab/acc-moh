'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { HttpError, nowIso, bad } = require('./util');
const audit = require('./audit');
const rbac = require('./rbac');

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 8);
const MAX_FAILS = 5;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function checkPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw))
    throw bad('كلمة المرور يجب ألا تقل عن 10 أحرف، وتحتوي على حرف كبير وصغير ورقم.');
}

// TOTP (RFC 6238) — جاهز لتفعيل MFA؛ لا توجد شاشة تسجيل (Enrollment) بعد.
function totp(secretHex, t = Date.now()) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex')).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const verifyTotp = (secret, code) => [-1, 0, 1].some(d => totp(secret, Date.now() + d * 30000) === String(code));

// تحديد معدل المحاولات (Rate limiting) في الذاكرة — يُستبدل بـRedis عند تعدد الخوادم
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'RATE_LIMIT');
  arr.push(now); hits.set(key, arr);
}

let DUMMY = null;   // تجزئة وهمية لتوحيد زمن الاستجابة ومنع كشف الحسابات
function login({ email, password, mfa }, ip, ua) {
  rateLimit('login:' + ip, 30, 60000);
  const generic = new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'BAD_CREDENTIALS');
  const e = db.get('SELECT * FROM employees WHERE lower(email) = lower(?) AND deleted_at IS NULL', String(email || '').trim());
  if (!e || !e.can_login || !e.active) { DUMMY ||= hashPassword('dummy-Password1'); verifyPassword(String(password || ''), DUMMY); throw generic; }
  if (e.locked_until && e.locked_until > nowIso()) throw new HttpError(423, 'تم إيقاف الحساب مؤقتًا بعد محاولات فاشلة. حاول لاحقًا.', 'LOCKED');
  if (!verifyPassword(String(password || ''), e.password_hash)) {
    const fails = e.failed_logins + 1;
    db.update('employees', e.id, { failed_logins: fails, locked_until: fails >= MAX_FAILS ? new Date(Date.now() + 10 * 60000).toISOString() : null });
    audit.log(e.id, 'session', e.id, 'login_failed');
    throw generic;
  }
  if (e.mfa_enabled) {
    if (!mfa) throw new HttpError(401, 'أدخل رمز التحقق الثنائي.', 'MFA_REQUIRED');
    if (!verifyTotp(e.mfa_secret, mfa)) throw new HttpError(401, 'رمز التحقق غير صحيح.', 'MFA_BAD');
  }
  db.update('employees', e.id, { failed_logins: 0, locked_until: null });
  const token = crypto.randomBytes(32).toString('hex');
  db.insert('sessions', { token_hash: sha(token), employee_id: e.id, created_at: nowIso(), expires_at: new Date(Date.now() + SESSION_HOURS * 3600000).toISOString(), ip, user_agent: (ua || '').slice(0, 200) });
  audit.log(e.id, 'session', e.id, 'login');
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s) return null;
  if (s.expires_at < nowIso()) { db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash); return null; }
  return rbac.loadUser(s.employee_id);
}
function logout(token) { if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token)); }
function revokeAll(employeeId) { db.run('DELETE FROM sessions WHERE employee_id = ?', employeeId); }

function requestReset(email) {
  const e = db.get('SELECT * FROM employees WHERE lower(email) = lower(?) AND can_login = 1 AND active = 1', String(email || ''));
  if (!e) return null;                                                     // لا نكشف وجود الحساب
  const token = crypto.randomBytes(24).toString('hex');
  db.insert('password_resets', { token_hash: sha(token), employee_id: e.id, expires_at: new Date(Date.now() + 3600000).toISOString() });
  db.insert('outbox', { channel: 'email', employee_id: e.id, subject: 'إعادة تعيين كلمة المرور', body: `رابط إعادة التعيين: /#/reset?token=${token}`, mock: 1, created_at: nowIso() });
  return token;
}
function resetPassword(token, newPassword) {
  checkPolicy(newPassword);
  const r = db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha(String(token || '')));
  if (!r || r.used_at || r.expires_at < nowIso()) throw bad('رابط إعادة التعيين غير صالح أو منتهي.');
  db.tx(() => {
    db.update('employees', r.employee_id, { password_hash: hashPassword(newPassword), failed_logins: 0, locked_until: null });
    db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', nowIso(), r.token_hash);
    revokeAll(r.employee_id);
    audit.log(r.employee_id, 'employee', r.employee_id, 'password_reset');
  });
}
function changePassword(user, current, next) {
  const e = db.get('SELECT password_hash FROM employees WHERE id = ?', user.id);
  if (!verifyPassword(current || '', e.password_hash)) throw bad('كلمة المرور الحالية غير صحيحة.');
  checkPolicy(next);
  db.update('employees', user.id, { password_hash: hashPassword(next) });
  audit.log(user.id, 'employee', user.id, 'password_change');
}

module.exports = { hashPassword, verifyPassword, checkPolicy, login, userFromToken, logout, revokeAll, requestReset, resetPassword, changePassword, totp, rateLimit, SESSION_HOURS };
