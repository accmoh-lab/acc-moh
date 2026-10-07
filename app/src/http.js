'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');
const auth = require('./auth');
const logger = require('./logger');

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, public: !!opts.public });
}
const get = (p, o, h) => route('GET', p, o, h);
const post = (p, o, h) => route('POST', p, o, h);
const put = (p, o, h) => route('PUT', p, o, h);
const del = (p, o, h) => route('DELETE', p, o, h);

function parseCookies(h) {
  return Object.fromEntries((h || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'حجم الطلب أكبر من المسموح.', 'TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};
if (process.env.HTTPS === '1') SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

// خلف Reverse Proxy (Render/Nginx) نأخذ عنوان المستخدم الحقيقي من X-Forwarded-For عند TRUST_PROXY=1
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || '';
}
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...SEC_HEADERS, ...(isBuf || typeof body === 'string' ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }), ...headers });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const started = Date.now();
  try {
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) {
        if (routes.some(x => x.re.test(url.pathname))) throw new HttpError(405, 'الطريقة غير مدعومة.', 'METHOD');
        throw new HttpError(404, 'المسار غير موجود.', 'NOT_FOUND');
      }
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const cookies = parseCookies(req.headers.cookie);
      let user = null;
      if (!r.public || cookies.sid) user = auth.userFromToken(cookies.sid);
      if (!r.public && !user) throw new HttpError(401, 'انتهت الجلسة. سجّل الدخول من جديد.', 'UNAUTHENTICATED');
      // حماية CSRF: الطلبات المغيِّرة يجب أن تحمل ترويسة لا يستطيع موقع خارجي إرسالها بدون CORS
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'acc') throw new HttpError(403, 'طلب غير موثوق.', 'CSRF');
      let body = {}; let raw = null;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        raw = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json') && raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'صيغة الطلب غير صحيحة.', 'BAD_JSON'); } }
      }
      const query = Object.fromEntries(url.searchParams);
      const out = await r.handler({ user, params, query, body, raw, req, res, cookies, ip: clientIp(req) });
      if (req.method !== 'GET') require('./cache').bump();
      if (out && out.__raw) { res.writeHead(out.status || 200, { ...SEC_HEADERS, ...out.headers }); res.end(out.body); }
      else {
        const { __headers, ...payload } = out && !Array.isArray(out) && typeof out === 'object' ? out : { __v: out };
        send(res, 200, out === undefined ? { ok: true } : (out && !Array.isArray(out) && typeof out === 'object' ? payload : out), __headers || {});
      }
      logger.info('api', { m: req.method, p: url.pathname, ms: Date.now() - started, u: user && user.id });
      return;
    }
    // ملفات الواجهة الثابتة + SPA fallback
    let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(file);
    send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.status, { error: { message: e.message, code: e.code, details: e.details } });
    } else {
      const id = Math.random().toString(36).slice(2, 10);
      logger.error('unhandled', { id, path: url.pathname, err: String(e && e.stack || e) });
      send(res, 500, { error: { message: 'تعذر إكمال العملية. حاول مرة أخرى، وإذا استمرت المشكلة أبلغ الدعم برقم المرجع.', code: 'INTERNAL', ref: id } });
    }
  }
}
module.exports = { route, get, post, put, del, handle, send, parseCookies };
