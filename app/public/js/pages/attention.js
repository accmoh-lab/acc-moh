import { $, rich, esc, api, qs, icon, L, lp, pill, state, wire, toast, opts } from '../core.js';
import { pageHead } from '../ui.js';
const LINK = s => ({ kpi: `#/kpis/${s.id}`, task: `#/tasks/${s.id}`, decision: `#/decisions/${s.id}`, initiative: `#/initiatives/${s.id}`, meeting: `#/meetings/${s.id}`, target: '#/targets', period: `#/performance/periods?id=${s.id}` })[s.type];
export async function render(ctx) {
  const { el, query } = ctx;
  const r = await api('/attention' + qs({ type: query.type, severity: query.severity }));
  const go = o => { location.hash = '#/attention' + qs({ type: query.type, severity: query.severity, ...o }); };
  el.innerHTML = `${pageHead('Management Attention', 'الاستثناءات فقط: ما يحتاج قرارًا أو تدخلًا الآن، مرتبًا حسب الخطورة والعمر. كل بند مرتبط بمصدره وبالإجراء المقترح.')}
   <div class="grid g4 keep2" style="margin-bottom:14px">${Object.entries(r.types).filter(([k]) => r.counts[k]).map(([k, l]) => `<div class="card stat clickable" data-act="t" data-v="${query.type === k ? '' : k}" style="${query.type === k ? 'border-color:var(--brand-2);background:var(--brand-soft)' : ''}"><span class="lbl">${esc(l)}</span><span class="val">${r.counts[k]}</span></div>`).join('')}</div>
   <div class="filters"><div class="field"><label for="sv">الخطورة</label><select id="sv">${opts(Object.entries(L.sev).map(([k, v]) => [k, v[0]]), query.severity, 'الكل')}</select></div>${query.type ? `<button class="btn sm" data-act="t" data-v="">إزالة فلتر النوع ✕</button>` : ''}<span class="muted small" style="margin-inline-start:auto">${r.total} بند</span></div>
   ${r.items.length ? `<div class="stack" style="gap:10px">${r.items.map(i => `<div class="attn sev-${i.severity}"><div style="flex:1;min-width:0"><div class="row" style="gap:8px">${lp(L.sev, i.severity)}<span class="tag">${esc(r.types[i.type])}</span></div><a href="${LINK(i.source)}" class="b" style="display:block;margin-top:6px;color:var(--ink);font-size:15.5px">${rich(i.title)}</a><div class="small" style="color:var(--ink-2)">${rich(i.detail)}</div>
     <div class="meta"><span>المسؤول: <b>${esc(i.owner_name || '—')}</b></span><span>العمر: <bdi class="num">${i.age_days}</bdi> يوم</span><span>الأثر: ${esc(i.impact)}</span><span>المصدر: <a href="${LINK(i.source)}">${esc(i.source.label)}</a></span></div>
     <div class="small" style="margin-top:8px"><b>الإجراء المقترح:</b> ${esc(i.recommended)}${i.follow_up?.meeting ? ` — مُدرج في <a href="#/meetings/${i.follow_up.meeting.id}">${esc(i.follow_up.meeting.code)}</a>` : ''}${i.follow_up?.task ? ` · مهمة <a href="#/tasks/${i.follow_up.task.id}">${esc(i.follow_up.task.code)}</a>` : ''}</div></div>
     <div class="row" style="flex-direction:column;align-items:stretch">${i.action === 'create_meeting' && i.kpi_id ? `<button class="btn sm primary" data-act="meet" data-k="${i.kpi_id}">${icon('cal')} جدولته في اجتماع</button>` : ''}<a class="btn sm" href="${LINK(i.source)}">فتح المصدر</a></div></div>`).join('')}</div>` : `<div class="card">${state('empty', 'لا توجد استثناءات', 'كل المؤشرات والمهام والقرارات ضمن المسار.')}</div>`}`;
  $('#sv', el).onchange = e => go({ severity: e.target.value });
  wire(el, { t: b => go({ type: b.dataset.v }), meet: async b => { location.hash = `#/kpis/${b.dataset.k}`; setTimeout(() => document.querySelector('[data-act="meet"]')?.click(), 600); } });
}
