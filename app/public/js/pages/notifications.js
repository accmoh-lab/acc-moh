import { esc, api, icon, state, wire, toast, ago, fdatetime, pill } from '../core.js';
import { pageHead, tabs } from '../ui.js';
export async function render(ctx) {
  const { el, query } = ctx;
  if (query.tab === 'prefs') return prefs(ctx);
  const r = await api('/notifications?limit=100');
  el.innerHTML = `${pageHead('الإشعارات', `${r.unread} غير مقروء`, `<button class="btn" data-act="all">تعليم الكل كمقروء</button><a class="btn ghost" href="#/notifications?tab=prefs">${icon('gear')} التفضيلات</a>`)}
   ${r.items.length ? `<div class="card"><div class="list">${r.items.map(n => `<a class="item" href="${esc(n.link || '#/notifications')}" data-id="${n.id}"><span class="dotc ${n.read_at ? 'gray' : 'red'}" style="margin-top:8px"></span><div class="grow"><span class="t" style="${n.read_at ? 'font-weight:500;color:var(--ink-2)' : ''}">${esc(n.title)}</span>${n.body ? `<span class="small muted">${esc(n.body)}</span>` : ''}<div class="tiny muted">${esc(n.event_ar || '')} · ${ago(n.created_at)}</div></div></a>`).join('')}</div></div>` : `<div class="card">${state('empty', 'لا توجد إشعارات', 'ستصلك تنبيهات الاجتماعات والمهام والمؤشرات هنا.')}</div>`}`;
  el.addEventListener('click', e => { const a = e.target.closest('a[data-id]'); if (a) api('/notifications/read', { method: 'POST', body: { ids: [Number(a.dataset.id)] } }).catch(() => { }); });
  wire(el, { all: async () => { await api('/notifications/read', { method: 'POST', body: { all: true } }); toast('تم'); ctx.reload(); } });
}
async function prefs(ctx) {
  const { el } = ctx;
  const p = await api('/notification-prefs');
  el.innerHTML = `${pageHead('تفضيلات الإشعارات', 'اختر القنوات لكل حدث لتقليل الإزعاج. تُمنع التكرارات تلقائيًا. البريد وPush حاليًا Mock (تُسجل ولا تُرسل).', '<a class="btn" href="#/notifications">رجوع</a>')}
   <div class="tablewrap"><table><thead><tr><th>الحدث</th><th>داخل التطبيق</th><th>البريد <span class="mock">Mock</span></th><th>Push <span class="mock">Mock</span></th></tr></thead><tbody>${p.map(x => `<tr data-e="${x.event}"><td>${esc(x.label)}${x.critical ? ' ' + pill('إلزامي', 'gray', 1) : ''}</td>${['in_app', 'email', 'push'].map(c => `<td><input type="checkbox" data-c="${c}" ${x[c] ? 'checked' : ''} ${c === 'in_app' && x.critical ? 'disabled' : ''} aria-label="${c}"></td>`).join('')}</tr>`).join('')}</tbody></table></div><button class="btn primary" style="margin-top:14px" data-act="save">حفظ</button>`;
  wire(el, { save: async () => { const prefs = [...el.querySelectorAll('tbody tr')].map(tr => ({ event: tr.dataset.e, ...Object.fromEntries([...tr.querySelectorAll('[data-c]')].map(i => [i.dataset.c, i.checked])) })); await api('/notification-prefs', { method: 'PUT', body: { prefs } }); toast('تم حفظ التفضيلات'); } });
}
