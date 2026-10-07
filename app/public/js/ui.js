// مكوّنات عرض مشتركة بين الصفحات
import { ltr, esc, L, lp, pill, icon, fdate, fshort, fweek, ftime, num, pct, bar, dot, scoreCls } from './core.js';

export const prepPill = s => { const v = L.prep[s]; return v ? `<span class="pill ${v[1]}">حزمة التحضير: ${v[0]}</span>` : ''; };
export function meetingCard(m, { compact } = {}) {
  const live = m.status === 'live';
  return `<a class="item" href="#/meetings/${m.id}"><div class="stack" style="gap:0;align-items:center;min-width:54px;text-align:center"><b style="font-size:22px;line-height:1.1">${m.meeting_date.slice(8)}</b><span class="tiny muted">${esc(fshort(m.meeting_date).split(' ')[1] || '')}</span></div>
    <div class="grow"><span class="t">${esc(m.title)}</span>
    <div class="row small muted" style="gap:4px 10px"><span>${ftime(m.start_time)} · ${m.duration_min} د</span><span>${esc(L.meetingType[m.type])}</span><span>${esc(L.mode[m.mode])}</span></div>
    <div class="row" style="margin-top:6px;gap:6px">${live ? '<span class="pill red">جارٍ الآن</span>' : lp(L.meetingStatus, m.status)}${m.status !== 'closed' && m.status !== 'cancelled' && !compact ? prepPill(m.prep_state) : ''}${m.can_join ? '<span class="pill blue nodot">Join متاح</span>' : ''}</div></div></a>`;
}
export function taskItem(t, { owner } = {}) {
  return `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><div class="row small muted" style="gap:4px 10px">${owner && t.owner_name ? `<span>${esc(t.owner_name)}</span>` : ''}<span>${t.overdue || (t.due_date < new Date().toISOString().slice(0, 10) && !['completed', 'cancelled'].includes(t.status)) ? `<b style="color:var(--red)">متأخرة · ${fdate(t.due_date)}</b>` : `الاستحقاق ${fdate(t.due_date)}`}</span></div>
    <div class="row" style="gap:6px;margin-top:5px">${lp(L.taskStatus, t.status)}${t.priority && t.priority !== 'medium' ? lp(L.priority, t.priority) : ''}</div></div></a>`;
}
export function kpiRow(k) {
  return `<a class="item" href="#/kpis/${k.id}"><span style="padding-top:7px">${dot(k.status)}</span><div class="grow"><span class="t">${esc(k.name)}</span><span class="small muted">${k.actual === null ? 'لا توجد بيانات ' + ltr(k.period_key) : `الفعلي ${num(k.actual)} / المستهدف ${num(k.target)} ${esc(k.unit || '')}`}</span></div><div style="text-align:end"><b>${k.achievement === null ? '—' : pct(k.achievement)}</b><div class="tiny">${k.data_quality && k.data_quality !== 'approved' && k.data_quality !== 'verified' ? lp(L.quality, k.data_quality) : ''}</div></div></a>`;
}
export const empty = (t) => `<div class="muted small" style="padding:6px 0">${esc(t)}</div>`;
export const pageHead = (title, sub, actions = '', crumbs = '') => `<div class="page-head"><div>${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="actions">${actions}</div></div>`;
export const orgOptions = (tree, kinds) => tree.filter(o => !kinds || kinds.includes(o.kind)).map(o => [o.id, o.name]);
export const tabs = (items, cur) => `<div class="tabs" role="tablist">${items.map(([k, l, c]) => `<button role="tab" aria-selected="${k === cur}" class="${k === cur ? 'on' : ''}" data-tab="${k}">${esc(l)}${c !== undefined ? `<span class="cnt">${c}</span>` : ''}</button>`).join('')}</div>`;

// بيانات مرجعية مخزنة مؤقتًا للجلسة
import { api } from './core.js';
const memo = {};
export const getDir = () => (memo.dir ||= api('/directory').catch(e => { memo.dir = null; throw e; }));
export const getOrg = () => (memo.org ||= api('/org/tree').catch(e => { memo.org = null; throw e; }));
export const getKpiList = () => (memo.kpis ||= api('/kpis').then(r => r.items).catch(e => { memo.kpis = null; throw e; }));
export const invalidate = k => { delete memo[k]; };
export const empOpts = (dir, sel, empty = 'اختر…') => `<option value="">${esc(empty)}</option>` + dir.map(e => `<option value="${e.id}"${String(e.id) === String(sel ?? '') ? ' selected' : ''}>${esc(e.name)} — ${esc(e.job_title)}</option>`).join('');
// اختيار المشاركين: بحث + تحديد + اختياري
export function peoplePicker(dir, selected = [], optional = [], exclude = []) {
  const sel = new Set(selected.map(Number)), opt = new Set(optional.map(Number));
  return `<div class="picker"><input type="search" class="pk-q" placeholder="ابحث بالاسم أو المسمى…" aria-label="بحث في الموظفين"><div class="pk-list" style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;margin-top:8px">${dir.filter(e => !exclude.includes(e.id)).map(e => `<div class="row pk-row" data-s="${esc((e.name + ' ' + e.job_title).toLowerCase())}" style="padding:6px 12px;border-bottom:1px solid var(--line-2);flex-wrap:nowrap"><label class="check" style="flex:1"><input type="checkbox" class="pk-c" value="${e.id}"${sel.has(e.id) ? ' checked' : ''}><span>${esc(e.name)} <span class="muted small">— ${esc(e.job_title)}</span></span></label><label class="check small muted"><input type="checkbox" class="pk-o" value="${e.id}"${opt.has(e.id) ? ' checked' : ''}>اختياري</label></div>`).join('')}</div><div class="small muted pk-count" style="margin-top:6px"></div></div>`;
}
export function wirePicker(root) {
  const q = root.querySelector('.pk-q'); const cnt = () => { root.querySelector('.pk-count').textContent = `المحدّدون: ${root.querySelectorAll('.pk-c:checked').length}`; };
  q.addEventListener('input', () => { const v = q.value.trim().toLowerCase(); root.querySelectorAll('.pk-row').forEach(r => { r.hidden = v && !r.dataset.s.includes(v); }); });
  root.addEventListener('change', e => { if (e.target.classList.contains('pk-o') && e.target.checked) { const c = root.querySelector(`.pk-c[value="${e.target.value}"]`); c.checked = true; } cnt(); });
  cnt();
  return () => [...root.querySelectorAll('.pk-c:checked')].map(c => ({ employee_id: Number(c.value), optional: root.querySelector(`.pk-o[value="${c.value}"]`).checked }));
}
export const fileToB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
