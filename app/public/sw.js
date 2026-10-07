// Service Worker مبسّط (PWA-ready): يخزّن الملفات الثابتة فقط. لا يخزّن استجابات الـAPI أبدًا.
const V = 'v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && /\.(css|js|woff2|svg)$/.test(u.pathname)) { const c = r.clone(); caches.open(V).then(ch => ch.put(e.request, c)); } return r; }).catch(() => caches.match(e.request)));
});
