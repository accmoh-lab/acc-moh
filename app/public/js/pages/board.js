import { esc, api, qs, icon, L, lp, pill, ltr, fdate, ftime, state, wire } from '../core.js';
import { pageHead, empty } from '../ui.js';
export async function render(ctx) {
  const { el, me } = ctx;
  if (!me.is_board) { el.innerHTML = state('lock', 'مساحة مجلس الإدارة مقيدة', 'متاحة لأعضاء المجلس وأمين السر فقط. دور المدير لا يمنح صلاحية الوصول.'); return; }
  const [m, d, t] = await Promise.all([api('/meetings' + qs({ type: 'board', limit: 50 })), api('/decisions'), api('/tasks' + qs({ limit: 200 }))]);
  const bm = new Set(m.items.map(x => x.id));
  const decs = d.filter(x => x.confidentiality === 'board');
  const tasks = t.items.filter(x => x.confidentiality === 'board');
  const docs = (await Promise.all(m.items.map(x => api('/meetings/' + x.id).then(r => r.attachments.map(a => ({ ...a, mt: x.title }))).catch(() => [])))).flat();
  el.innerHTML = `${pageHead('مجلس الإدارة', 'مساحة منفصلة أمنيًا: الاجتماعات والقرارات والمستندات والمهام بسرية Board.', me.roles.includes('board_secretary') ? `<a class="btn primary" href="#/meetings/new?type=board">${icon('plus')} اجتماع مجلس</a>` : '')}
   <div class="alert mockbar small">${icon('shield')} الوصول هنا يعتمد على عضوية المجلس فقط، ويُحمى من الخادم وليس بإخفاء الأزرار. (سياسة سرية المجلس النهائية تحتاج اعتمادًا.)</div>
   <div class="grid g2" style="margin-top:16px"><div class="card"><header><h3>اجتماعات المجلس</h3></header>${m.items.length ? `<div class="list">${m.items.map(x => `<a class="item" href="#/meetings/${x.id}"><div class="grow"><span class="t">${esc(x.title)}</span><span class="small muted">${fdate(x.meeting_date)} · ${ftime(x.start_time)}</span></div>${lp(L.meetingStatus, x.status)}</a>`).join('')}</div>` : empty('لا توجد.')}</div>
   <div class="card"><header><h3>قرارات المجلس</h3></header>${decs.length ? `<div class="list">${decs.map(x => `<a class="item" href="#/decisions/${x.id}"><div class="grow"><span class="t">${esc(x.text)}</span><span class="small muted">${ltr(x.code)} · ${esc(x.owner_name)}</span></div>${lp(L.decision, x.status)}</a>`).join('')}</div>` : empty('لا توجد.')}</div>
   <div class="card"><header><h3>مستندات المجلس</h3></header>${docs.length ? `<div class="list">${docs.map(a => `<a class="item" href="/api/attachments/${a.id}/download">${icon('file')}<div class="grow"><span class="t">${esc(a.filename)}</span><span class="small muted">${esc(a.mt)}</span></div></a>`).join('')}</div>` : empty('لا توجد.')}</div>
   <div class="card"><header><h3>إجراءات المجلس</h3></header>${tasks.length ? `<div class="list">${tasks.map(x => `<a class="item" href="#/tasks/${x.id}"><div class="grow"><span class="t">${esc(x.title)}</span><span class="small muted">${esc(x.owner_name)} · ${fdate(x.due_date)}</span></div>${lp(L.taskStatus, x.status)}</a>`).join('')}</div>` : empty('لا توجد.')}</div></div>`;
}
