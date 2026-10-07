import { $, $$, esc, api, qs, icon, L, lp, pill, num, ltr, fdate, fshort, fdatetime, ago, state, wire, toast, modal, confirmBox, promptBox, readForm, showErrors, field, opts, busy, todayStr, bar } from '../core.js';
import { pageHead, tabs, getDir, getOrg, getKpiList, empOpts, empty } from '../ui.js';
import { traceView, uploadModal } from './meetings.js';

export async function render(ctx) { return ctx.name === 'tasks' ? list(ctx) : detail(ctx); }

const VIEWS_BY_ROLE = me => [['my', 'مهامي'], ...(me.is_manager ? [['team', 'مهام الفريق'], ['department', 'متتبع القسم']] : []), ...(me.is_exec || me.is_hr || me.system_role === 'business_unit_manager' ? [['business_unit', 'متتبع وحدة النشاط']] : []), ...(me.is_exec || me.is_hr || ['department_manager', 'business_unit_manager'].includes(me.system_role) ? [['management', 'متتبع الإدارة']] : [])];

async function list(ctx) {
  const { el, me, query } = ctx;
  const views = VIEWS_BY_ROLE(me);
  const f = { view: query.view || 'my', layout: query.layout || 'list', status: query.status || '', priority: query.priority || '', source: query.source || '', overdue: query.overdue || '', owner_id: query.owner_id || '', q: query.q || '', kpi_id: query.kpi_id || '', meeting_id: query.meeting_id || '', initiative_id: query.initiative_id || '', due_from: query.due_from || '', due_to: query.due_to || '' };
  if (!views.some(v => v[0] === f.view)) f.view = 'my';
  const [r, sum, dir] = await Promise.all([api('/tasks' + qs({ ...f, layout: undefined, limit: 300 })), api('/tasks/summary' + qs({ view: f.view })), getDir()]);
  const go = o => { location.hash = '#/tasks' + qs({ ...f, ...o }); };
  const bs = sum.by_status;
  const body = !r.items.length ? `<div class="card">${state('empty', f.overdue ? 'لا توجد مهام متأخرة' : 'لا توجد مهام مطابقة', 'غيّر الفلاتر أو أنشئ مهمة جديدة.', '<button class="btn primary" data-act="new">مهمة جديدة</button>')}</div>`
    : f.layout === 'kanban' ? kanban(r.items) : f.layout === 'calendar' ? cal(r.items, query.month) : f.layout === 'timeline' ? timeline(r.items) : table(r.items, f.view !== 'my');
  el.innerHTML = `${pageHead('المهام', 'متتبع موحّد لكل المهام: من الاجتماعات والقرارات ومؤشرات الأداء والمبادرات والعمل التشغيلي.', `<button class="btn primary" data-act="new">${icon('plus')} مهمة جديدة</button><a class="btn ghost" href="/api/export/tasks">${icon('download')} تصدير CSV</a>`)}
    ${tabs(views.map(([k, l]) => [k, l]), f.view)}
    <div class="grid g4 keep2" style="margin-bottom:16px">
      <div class="card stat clickable" data-act="fs" data-v=""><span class="lbl">الإجمالي</span><span class="val">${num(sum.total)}</span></div>
      <div class="card stat clickable" data-act="fs" data-v="in_progress"><span class="lbl">قيد التنفيذ</span><span class="val">${num(bs.in_progress || 0)}</span><span class="delta">${bs.pending_review || 0} بانتظار المراجعة</span></div>
      <div class="card stat clickable" data-act="fo"><span class="lbl">متأخرة</span><span class="val ${sum.overdue ? 'down' : ''}">${num(sum.overdue)}</span></div>
      <div class="card stat clickable" data-act="fs" data-v="blocked"><span class="lbl">معطّلة</span><span class="val ${bs.blocked ? 'down' : ''}">${num(bs.blocked || 0)}</span><span class="delta">${bs.completed || 0} مكتملة</span></div></div>
    <div class="filters">
      <div class="field"><label for="f1">الحالة</label><select id="f1" data-f="status">${opts(Object.entries(L.taskStatus).map(([k, v]) => [k, v[0]]), f.status, 'كل الحالات')}</select></div>
      <div class="field"><label for="f2">الأولوية</label><select id="f2" data-f="priority">${opts(Object.entries(L.priority).map(([k, v]) => [k, v[0]]), f.priority, 'الكل')}</select></div>
      <div class="field"><label for="f3">المصدر</label><select id="f3" data-f="source">${opts(Object.entries(L.source), f.source, 'كل المصادر')}</select></div>
      ${f.view !== 'my' ? `<div class="field"><label for="f4">المسؤول</label><select id="f4" data-f="owner_id">${empOpts(dir, f.owner_id, 'الكل')}</select></div>` : ''}
      <div class="field"><label for="f5">الاستحقاق من</label><input type="date" id="f5" data-f="due_from" value="${esc(f.due_from)}"></div>
      <div class="field"><label for="f6">إلى</label><input type="date" id="f6" data-f="due_to" value="${esc(f.due_to)}"></div>
      <div class="field" style="flex:1;min-width:160px"><label for="f7">بحث</label><input id="f7" data-f="q" value="${esc(f.q)}" placeholder="العنوان أو الرمز"></div>
      <label class="check"><input type="checkbox" data-f="overdue" ${f.overdue ? 'checked' : ''}> المتأخرة فقط</label>
      ${f.kpi_id || f.meeting_id || f.initiative_id ? `<button class="btn sm" data-act="clearlink">إزالة ربط (KPI/اجتماع/مبادرة) ✕</button>` : ''}
      <div class="seg" style="margin-inline-start:auto">${[['list', 'قائمة'], ['kanban', 'Kanban'], ['calendar', 'تقويم'], ['timeline', 'Timeline']].map(([k, l]) => `<button class="${f.layout === k ? 'on' : ''}" data-act="layout" data-v="${k}">${l}</button>`).join('')}</div></div>
    ${body}${r.total > r.items.length ? `<p class="small muted">يُعرض أول ${r.items.length} من ${r.total}. استخدم الفلاتر لتضييق النتائج.</p>` : ''}`;
  $('.tabs', el).addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) go({ view: b.dataset.tab, owner_id: '' }); });
  $$('[data-f]', el).forEach(i => i.addEventListener('change', () => go({ [i.dataset.f]: i.type === 'checkbox' ? (i.checked ? '1' : '') : i.value })));
  wire(el, { new: () => newTask(me), layout: b => go({ layout: b.dataset.v }), fs: b => go({ status: b.dataset.v, overdue: '' }), fo: () => go({ overdue: '1', status: '' }), clearlink: () => go({ kpi_id: '', meeting_id: '', initiative_id: '' }), month: b => go({ month: b.dataset.v }) });
}
const dueCell = t => t.overdue ? `<b style="color:var(--red)">${fdate(t.due_date)}</b><div class="sub" style="color:var(--red)">متأخرة ${t.days_overdue} يومًا</div>` : fdate(t.due_date);
function table(items, showOwner) {
  return `<div class="tablewrap only-desktop"><table><thead><tr><th>المهمة</th>${showOwner ? '<th>المسؤول</th>' : ''}<th>المصدر</th><th>الأولوية</th><th>الاستحقاق</th><th>الإنجاز</th><th>الحالة</th></tr></thead><tbody>${items.map(t => `<tr class="link" data-href="#/tasks/${t.id}"><td><div class="title">${esc(t.title)}</div><div class="sub">${ltr(t.code)}${t.kpi_code ? ' · KPI ' + ltr(t.kpi_code) : ''}${t.meeting_code ? ' · ' + ltr(t.meeting_code) : ''}${t.blocked_by_count ? ` · <span style="color:var(--red)">تعتمد على ${t.blocked_by_count} مهمة</span>` : ''}${t.recurrence !== 'none' ? ' · متكررة' : ''}</div></td>${showOwner ? `<td>${esc(t.owner_name)}</td>` : ''}<td>${esc(L.source[t.source])}</td><td>${lp(L.priority, t.priority)}</td><td>${dueCell(t)}</td><td style="min-width:110px"><div class="row" style="gap:6px;flex-wrap:nowrap">${bar(t.progress)}<bdi class="num small">${t.progress}%</bdi></div></td><td>${lp(L.taskStatus, t.status)}</td></tr>`).join('')}</tbody></table></div>
  <div class="card only-mobile"><div class="list">${items.map(t => `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><div class="small muted">${showOwner ? esc(t.owner_name) + ' · ' : ''}${t.overdue ? `<b style="color:var(--red)">متأخرة ${t.days_overdue} يومًا</b>` : 'الاستحقاق ' + fdate(t.due_date)}</div><div class="row" style="gap:6px;margin-top:6px">${lp(L.taskStatus, t.status)}${lp(L.priority, t.priority)}</div></div></a>`).join('')}</div></div>`;
}
function kanban(items) {
  const cols = ['not_started', 'in_progress', 'blocked', 'pending_review', 'completed'];
  return `<div class="kanban">${cols.map(c => { const it = items.filter(t => t.status === c); return `<div class="kcol"><h4>${lp(L.taskStatus, c)}<span class="cnt">${it.length}</span></h4>${it.map(t => `<a class="kcard" href="#/tasks/${t.id}"><div class="t">${esc(t.title)}</div><div class="small muted">${esc(t.owner_name)}</div><div class="row spread small" style="margin-top:6px">${lp(L.priority, t.priority)}<span class="${t.overdue ? 'down b' : 'muted'}">${fshort(t.due_date)}</span></div>${c === 'in_progress' ? `<div style="margin-top:8px">${bar(t.progress)}</div>` : ''}</a>`).join('') || '<div class="muted small" style="padding:8px">لا توجد مهام</div>'}</div>`; }).join('')}</div>`;
}
function cal(items, monthKey) {
  const t = new Date(); const [y, mo] = (monthKey || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`).split('-').map(Number);
  const first = new Date(y, mo - 1, 1); const start = new Date(first); start.setDate(1 - ((first.getDay() + 1) % 7));
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; const mk = d => key(d).slice(0, 7);
  const by = {}; items.forEach(x => (by[x.due_date] ||= []).push(x)); const today = key(new Date()); let cells = '';
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const k = key(d); cells += `<div class="d${d.getMonth() !== mo - 1 ? ' out' : ''}${k === today ? ' today' : ''}"><b><bdi class="num">${d.getDate()}</bdi></b>${(by[k] || []).map(x => `<a class="ev ${x.status === 'completed' ? 'green' : x.overdue ? 'red' : x.status === 'blocked' ? 'amber' : ''}" href="#/tasks/${x.id}" title="${esc(x.title)}">${esc(x.title)}</a>`).join('')}</div>`; }
  return `<div class="row spread" style="margin-bottom:10px"><button class="btn sm" data-act="month" data-v="${mk(new Date(y, mo - 2, 1))}">${icon('chevR')} السابق</button><h3>${new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' }).format(first)}</h3><button class="btn sm" data-act="month" data-v="${mk(new Date(y, mo, 1))}">التالي ${icon('chevL')}</button></div><div class="cal">${['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'].map(n => `<div class="h">${n}</div>`).join('')}${cells}</div><p class="small muted">تُعرض المهام حسب تاريخ الاستحقاق.</p>`;
}
function timeline(items) {
  const rows = items.filter(t => t.status !== 'cancelled').slice(0, 60);
  const ds = rows.flatMap(t => [t.start_date || t.due_date, t.due_date]).sort();
  const min = new Date(ds[0] + 'T00:00'), max = new Date(ds.at(-1) + 'T00:00'); const today = new Date(); today.setHours(0, 0, 0, 0);
  const lo = new Date(Math.min(min, today)); lo.setDate(lo.getDate() - 2); const hi = new Date(Math.max(max, today)); hi.setDate(hi.getDate() + 3);
  const span = (hi - lo) || 1; const pos = d => ((new Date(d + 'T00:00') - lo) / span * 100);
  const marks = []; const step = Math.max(7, Math.ceil(span / 864e5 / 8)); for (let d = new Date(lo); d <= hi; d.setDate(d.getDate() + step)) marks.push(new Date(d));
  // في RTL يبدأ الزمن من اليمين
  return `<div class="tl"><div class="tl-head"><div style="padding:6px 12px">المهمة</div><div class="scale">${marks.map(d => `<span style="right:${(d - lo) / span * 100}%">${esc(fshort(d.toISOString()))}</span>`).join('')}</div></div>
   ${rows.map(t => { const s = pos(t.start_date || t.due_date), e = pos(t.due_date); return `<div class="tl-row"><a class="nm" href="#/tasks/${t.id}" title="${esc(t.title)}">${esc(t.title)}</a><div class="tl-track"><span class="tl-today" style="right:${(today - lo) / span * 100}%"></span><a class="tl-bar ${t.status === 'completed' ? 'green' : t.overdue ? 'red' : t.status === 'blocked' ? 'amber' : t.status === 'not_started' ? 'gray' : ''}" href="#/tasks/${t.id}" title="${esc(t.title)} — ${t.progress}%" style="right:${s}%;width:${Math.max(1.2, e - s)}%"></a></div></div>`; }).join('')}</div>
   <div class="legend" style="margin-top:8px"><span><span class="dotc" style="background:var(--brand-2)"></span> قيد التنفيذ</span><span><span class="dotc red"></span> متأخرة</span><span><span class="dotc green"></span> مكتملة</span><span><span class="dotc amber"></span> معطّلة</span><span>الخط الأحمر = اليوم</span></div>`;
}

export async function newTask(me, preset = {}, done) {
  const [dir, kpis] = await Promise.all([getDir(), getKpiList().catch(() => [])]);
  const due = new Date(); due.setDate(due.getDate() + 7);
  const mm = modal({ title: 'مهمة جديدة', wide: true, body: `<form id="nt"><div class="alert err form-error" hidden></div><div class="form-grid">
    ${field('العنوان', `<input name="title" value="${esc(preset.title || '')}">`, { full: true, req: true })}
    ${field('المسؤول', `<select name="owner_id">${empOpts(me.can.assign_others ? dir : dir.filter(d => d.id === me.id), preset.owner_id || me.id)}</select>`, { req: true, hint: me.can.assign_others ? 'يمكنك الإسناد لموظفي نطاقك' : 'يمكنك إنشاء مهام لنفسك فقط' })}
    ${field('المصدر', `<select name="source">${opts(Object.entries(L.source).filter(([k]) => k !== 'meeting'), preset.source || 'operational')}</select>`)}
    ${field('تاريخ البدء', `<input type="date" name="start_date" value="${todayStr()}">`)}${field('تاريخ الاستحقاق', `<input type="date" name="due_date" value="${due.toISOString().slice(0, 10)}">`, { req: true })}
    ${field('الأولوية', `<select name="priority">${opts(Object.entries(L.priority).map(([k, v]) => [k, v[0]]), 'medium')}</select>`)}${field('الوزن (1-10)', '<input type="number" name="weight" min="1" max="10" value="1">', { hint: 'يؤثر على احتساب أداء المهام' })}
    ${field('مؤشر مرتبط (KPI)', `<select name="kpi_id">${opts(kpis.map(k => [k.id, `${k.code} — ${k.name}`]), preset.kpi_id, 'بدون')}</select>`)}
    ${field('المراجع', `<select name="reviewer_id">${empOpts(dir, '', 'المدير المباشر عند الحاجة')}</select>`)}
    ${field('التكرار', `<select name="recurrence">${opts([['none', 'لا تتكرر'], ['daily', 'يومي'], ['weekly', 'أسبوعي'], ['monthly', 'شهري'], ['quarterly', 'ربع سنوي'], ['custom', 'مخصص (بالأيام)']], 'none')}</select>`)}${field('أيام التكرار المخصص', '<input type="number" name="recurrence_interval_days" min="1">')}
    <div class="field"><label>الاعتماد</label><label class="check"><input type="checkbox" name="requires_approval"> تتطلب اعتماد الإنجاز من المراجع</label><label class="check"><input type="checkbox" name="evidence_required"> تتطلب دليل إنجاز</label></div>
    ${field('الوصف', '<textarea name="description"></textarea>', { full: true })}</div></form>`, footer: '<button class="btn primary" data-ok>إنشاء</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => {
    const f = mm.$('#nt'); const d = readForm(f);
    for (const k of ['owner_id', 'reviewer_id', 'kpi_id', 'weight', 'recurrence_interval_days']) d[k] = d[k] ? Number(d[k]) : null;
    if (preset.initiative_id) d.initiative_id = preset.initiative_id;
    try { const r = await api('/tasks', { method: 'POST', body: d }); mm.close(); toast(`تم إنشاء المهمة ${r.code}`); if (done) done(r); else location.hash = `#/tasks/${r.id}`; } catch (e) { showErrors(f, e); }
  };
}

// ======================= التفاصيل =======================
const ACT = { in_progress: ['بدء التنفيذ', 'primary'], not_started: ['إرجاع إلى «لم تبدأ»', ''], blocked: ['تسجيل عائق', ''], completed: ['إكمال المهمة', 'primary'], pending_review: ['تسليم الإنجاز للمراجعة', 'primary'], cancelled: ['إلغاء المهمة', 'danger'] };
async function detail(ctx) {
  const { el, me, params } = ctx;
  const t = await api('/tasks/' + params[0]);
  const tr = await api('/trace/task/' + t.id).catch(() => null);
  const p = t.perms; const reopen = t.status === 'completed' && p.allowed.includes('in_progress');
  const acts = p.allowed.filter(a => !(t.status === 'blocked' && a === 'not_started')).map(a => `<button class="btn ${ACT[a][1]}" data-act="st" data-v="${a}">${reopen && a === 'in_progress' ? 'إعادة فتح' : t.status === 'blocked' && a === 'in_progress' ? 'إزالة العائق واستئناف' : ACT[a][0]}</button>`);
  if (p.can_review) acts.unshift('<button class="btn primary" data-act="approve">' + icon('check') + ' اعتماد الإنجاز</button><button class="btn" data-act="return">إرجاع للتعديل</button>');
  const tr0 = t.trace;
  const why = [tr0.kpi && !tr0.kpi.restricted ? `بسبب مؤشر <a href="#/kpis/${tr0.kpi.id}">${esc(tr0.kpi.name)}</a>` : '', tr0.meeting && !tr0.meeting.restricted ? `من اجتماع <a href="#/meetings/${tr0.meeting.id}">${esc(tr0.meeting.title)}</a>` : tr0.meeting?.restricted ? 'من اجتماع لا تملك صلاحية عرضه' : '', tr0.decision && !tr0.decision.restricted ? `تنفيذًا للقرار <a href="#/decisions/${tr0.decision.id}">${ltr(tr0.decision.code)}</a>` : '', tr0.initiative ? `ضمن مبادرة <a href="#/initiatives/${tr0.initiative.id}">${esc(tr0.initiative.title)}</a>` : ''].filter(Boolean);
  el.innerHTML = `${pageHead(t.title, `${ltr(t.code)} · ${esc(L.source[t.source])}${t.recurrence !== 'none' ? ` · متكررة (التكرار ${t.occurrence_no})` : ''}`, acts.join(''), '<a href="#/tasks">المهام</a>')}
   <div class="row" style="margin:-8px 0 16px;gap:8px">${lp(L.taskStatus, t.status)}${lp(L.priority, t.priority)}${t.overdue ? pill(`متأخرة ${t.days_overdue} يومًا`, 'red') : ''}${t.requires_approval ? pill(`الاعتماد: ${{ none: 'لم يُطلب بعد', pending: 'بانتظار المراجع', approved: 'معتمدة', returned: 'أُعيدت' }[t.approval_status]}`, t.approval_status === 'approved' ? 'green' : t.approval_status === 'returned' ? 'amber' : 'gray') : ''}${t.evidence_required ? pill(t.evidence.length ? 'الدليل مرفق' : 'تتطلب دليل إنجاز', t.evidence.length ? 'green' : 'amber') : ''}</div>
   ${t.return_reason && t.approval_status === 'returned' ? `<div class="alert warn">أعادها المراجع للتعديل: ${esc(t.return_reason)}</div>` : ''}
   ${t.status === 'blocked' ? `<div class="alert err"><b>العائق:</b> ${esc(t.blocked_reason || '')}${t.expected_resolution ? ` · الحل المتوقع ${fdate(t.expected_resolution)}` : ''}</div>` : ''}
   ${t.blocked_by.length ? `<div class="alert warn">تعتمد هذه المهمة على مهام غير مكتملة: ${t.blocked_by.map(b => `<a href="#/tasks/${b.id}">${esc(b.title)}</a> (${esc(L.taskStatus[b.status][0])})${b.reason ? ' — ' + esc(b.reason) : ''}`).join('، ')}</div>` : ''}
   <div class="grid g-main"><div class="stack">
     <div class="card"><header><h3>لماذا أُنشئت هذه المهمة؟</h3></header>${why.length ? `<p style="margin:0">${why.join(' · ')}</p>` : '<p class="muted" style="margin:0">مهمة مستقلة (لا ترتبط باجتماع أو مؤشر).</p>'}${tr && tr.nodes.length > 1 ? `<div style="margin-top:14px">${traceView(tr)}</div>` : ''}${t.description ? `<h3 style="margin-top:16px">الوصف</h3><p style="margin:4px 0 0;white-space:pre-wrap">${esc(t.description)}</p>` : ''}</div>
     <div class="card"><header><h3>التقدم</h3></header><div class="row" style="flex-wrap:nowrap">${bar(t.progress, t.overdue ? 'red' : t.status === 'completed' ? 'green' : '')}<b><bdi class="num">${t.progress}%</bdi></b></div>
       ${p.can_manage && ['not_started', 'in_progress', 'blocked'].includes(t.status) ? `<div class="row" style="margin-top:12px"><input type="range" id="prog" min="0" max="100" step="5" value="${t.progress}" style="flex:1" aria-label="نسبة الإنجاز"><output id="progv" class="num b">${t.progress}%</output><button class="btn sm primary" data-act="prog">تحديث</button></div><p class="small muted" style="margin:6px 0 0">${t.requires_approval ? 'الوصول إلى 100% لا يعني اعتماد المهمة. يجب تسليمها للمراجعة.' : ''}</p>` : ''}</div>
     <div class="card"><header><h3>أدلة الإنجاز (Evidence)</h3>${p.can_manage && !['completed', 'cancelled'].includes(t.status) ? `<button class="btn sm primary more" data-act="ev">${icon('upload')} إضافة دليل</button>` : ''}</header>${t.evidence.length ? `<div class="list">${t.evidence.map(e => `<div class="item">${icon('file')}<div class="grow"><span class="t">${esc(e.note)}</span><span class="small muted">${esc(e.submitted_by_name)} · ${fdatetime(e.created_at)}${e.attachment_id ? ` · <a href="/api/attachments/${e.attachment_id}/download">${esc(e.filename)}</a>` : ''}</span></div></div>`).join('')}</div>` : empty(t.evidence_required ? 'هذه المهمة تتطلب دليلًا قبل التسليم.' : 'لا توجد أدلة.')}</div>
     <div class="card"><header><h3>السجل</h3></header><div class="list">${t.events.slice().reverse().map(e => `<div class="item"><div class="grow"><span class="small"><b>${esc(e.actor_name || 'النظام')}</b> — ${esc({ created: 'أنشأ المهمة', status: 'غيّر الحالة', evidence: 'أضاف دليلًا', owner_changed: 'غيّر المسؤول', due_date_changed: 'غيّر تاريخ الاستحقاق' }[e.action] || e.action)}${e.to_status ? ` إلى «${esc(L.taskStatus[e.to_status]?.[0] || e.to_status)}»` : ''}${e.note ? ` — ${esc(e.note)}` : ''}</span><span class="tiny muted">${fdatetime(e.created_at)}</span></div></div>`).join('')}</div></div>
   </div><div class="stack">
     <div class="card"><dl class="kv"><dt>المسؤول</dt><dd>${esc(t.owner_name)}</dd><dt>المراجع</dt><dd>${esc(t.reviewer_name || (t.requires_approval ? 'المدير المباشر' : '—'))}</dd><dt>المساهمون</dt><dd>${t.contributors.map(c => esc(c.name)).join('، ') || '—'}</dd><dt>القسم</dt><dd>${esc(t.dept_name || '—')}</dd><dt>البدء</dt><dd>${fdate(t.start_date)}</dd><dt>الاستحقاق</dt><dd>${fdate(t.due_date)}</dd><dt>الوزن</dt><dd>${t.weight}</dd><dt>أنشأها</dt><dd>${esc(t.created_by_name || '—')} · ${fdate(t.created_at)}</dd>${t.completed_at ? `<dt>اكتملت</dt><dd>${fdate(t.completed_at)}</dd>` : ''}</dl>${p.can_edit_all && !['completed', 'cancelled'].includes(t.status) ? `<button class="btn sm" style="margin-top:12px" data-act="edit">${icon('edit')} تعديل</button>` : ''}</div>
     <div class="card"><header><h3>الاعتمادية (Dependencies)</h3>${p.can_edit_all ? '<button class="btn sm more" data-act="deps">تعديل</button>' : ''}</header>
       <h4 class="small muted">تعتمد على</h4>${t.dependencies_all.length ? `<div class="list">${t.dependencies_all.map(d => `<a class="item" href="#/tasks/${d.id}"><span class="grow small">#${d.id}${d.reason ? ' — ' + esc(d.reason) : ''}${d.expected_resolution ? ' · متوقع ' + fdate(d.expected_resolution) : ''}</span></a>`).join('')}</div>` : empty('لا شيء.')}
       <h4 class="small muted" style="margin-top:10px">مهام تنتظر هذه المهمة</h4>${t.blocking.length ? `<div class="list">${t.blocking.map(b => `<a class="item" href="#/tasks/${b.id}"><span class="grow small">${esc(b.title)}</span>${lp(L.taskStatus, b.status)}</a>`).join('')}</div>` : empty('لا شيء.')}</div>
     ${t.series.length > 1 ? `<div class="card"><header><h3>سجل التكرارات</h3></header><div class="list">${t.series.map(s => `<a class="item" href="#/tasks/${s.id}"><span class="grow small">التكرار ${s.occurrence_no} · ${fdate(s.due_date)}${s.id === t.id ? ' (الحالية)' : ''}</span>${lp(L.taskStatus, s.status)}</a>`).join('')}</div></div>` : ''}
   </div></div>`;
  const pr = $('#prog', el); if (pr) pr.oninput = () => { $('#progv', el).textContent = pr.value + '%'; };
  wire(el, {
    st: async b => {
      const to = b.dataset.v; const body = { to };
      if (to === 'blocked') { body.reason = await promptBox('تسجيل عائق', 'ما الذي يمنع التقدم؟'); if (!body.reason) return; }
      if (to === 'cancelled') { body.reason = await promptBox('إلغاء المهمة', 'سبب الإلغاء'); if (!body.reason) return; }
      if (reopen && to === 'in_progress') { body.reason = await promptBox('إعادة فتح', 'سبب إعادة الفتح'); if (!body.reason) return; }
      await api(`/tasks/${t.id}/status`, { method: 'POST', body }); toast(to === 'pending_review' ? 'تم تسليم الإنجاز للمراجع' : 'تم تحديث المهمة'); ctx.reload();
    },
    approve: async () => { await api(`/tasks/${t.id}/review`, { method: 'POST', body: { decision: 'approve' } }); toast('تم اعتماد الإنجاز'); ctx.reload(); },
    return: async () => { const reason = await promptBox('إرجاع للتعديل', 'ما المطلوب تعديله؟'); if (!reason) return; await api(`/tasks/${t.id}/review`, { method: 'POST', body: { decision: 'return', reason } }); toast('أُعيدت المهمة للمسؤول'); ctx.reload(); },
    prog: async () => { await api(`/tasks/${t.id}`, { method: 'PUT', body: { progress: Number(pr.value) } }); toast('تم تحديث نسبة الإنجاز'); ctx.reload(); },
    ev: () => evidenceModal(t, ctx.reload),
    edit: () => editModal(t, ctx.reload),
    deps: () => depsModal(t, ctx.reload),
  });
}
function evidenceModal(t, reload) {
  const mm = modal({ title: 'إضافة دليل إنجاز', body: `<div class="field"><label for="evn">وصف الدليل</label><textarea id="evn" placeholder="ما الذي أُنجز؟ (رقم، نتيجة، مستند)"></textarea></div><div class="field" style="margin-top:12px"><label for="evf">ملف (اختياري)</label><input type="file" id="evf"></div>`, footer: '<button class="btn primary" data-ok>حفظ الدليل</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => {
    const note = mm.$('#evn').value.trim(); if (!note) return toast('اكتب وصف الدليل', 'err');
    try {
      let attachment_id; const f = mm.$('#evf').files[0];
      if (f) { const { fileToB64 } = await import('../ui.js'); const r = await api('/attachments', { method: 'POST', body: { entity_type: 'task', entity_id: t.id, filename: f.name, mime: f.type || 'text/plain', data_b64: await fileToB64(f) } }); attachment_id = r.id; }
      await api(`/tasks/${t.id}/evidence`, { method: 'POST', body: { note, attachment_id } }); mm.close(); toast('تم حفظ الدليل'); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
}
async function editModal(t, reload) {
  const dir = await getDir();
  const mm = modal({ title: 'تعديل المهمة', wide: true, body: `<form id="ed"><div class="alert err form-error" hidden></div><div class="form-grid">${field('العنوان', `<input name="title" value="${esc(t.title)}">`, { full: true })}${field('المسؤول', `<select name="owner_id">${empOpts(dir, t.owner_id)}</select>`)}${field('المراجع', `<select name="reviewer_id">${empOpts(dir, t.reviewer_id, 'بدون')}</select>`)}${field('تاريخ البدء', `<input type="date" name="start_date" value="${t.start_date || ''}">`)}${field('الاستحقاق', `<input type="date" name="due_date" value="${t.due_date}">`)}${field('الأولوية', `<select name="priority">${opts(Object.entries(L.priority).map(([k, v]) => [k, v[0]]), t.priority)}</select>`)}${field('الوزن', `<input type="number" name="weight" min="1" max="10" value="${t.weight}">`)}${field('سبب التعديل', '<input name="reason" placeholder="يُسجل في سجل التدقيق عند تغيير المسؤول أو الموعد">', { full: true })}${field('الوصف', `<textarea name="description">${esc(t.description || '')}</textarea>`, { full: true })}</div></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const f = mm.$('#ed'); const d = readForm(f); d.owner_id = Number(d.owner_id); d.reviewer_id = d.reviewer_id ? Number(d.reviewer_id) : null; d.weight = Number(d.weight); try { await api(`/tasks/${t.id}`, { method: 'PUT', body: d }); mm.close(); toast('تم الحفظ'); reload(); } catch (e) { showErrors(f, e); } };
}
async function depsModal(t, reload) {
  const r = await api('/tasks' + qs({ status: 'not_started,in_progress,blocked,pending_review,completed', limit: 300 }));
  const cur = new Map(t.dependencies_all.map(d => [d.id, d]));
  const mm = modal({ title: 'تعتمد هذه المهمة على…', wide: true, body: `<p class="small muted" style="margin-top:0">لا يمكن بدء المهمة أو إكمالها قبل اكتمال المهام المحددة. يمنع النظام الاعتماد الدائري.</p><div style="max-height:50vh;overflow:auto">${r.items.filter(x => x.id !== t.id).map(x => `<div class="row" style="border-bottom:1px solid var(--line-2);padding:6px 0;flex-wrap:nowrap"><label class="check" style="flex:1"><input type="checkbox" class="dp" value="${x.id}"${cur.has(x.id) ? ' checked' : ''}> ${esc(x.title)} <span class="tiny muted">${esc(x.owner_name)}</span></label><input class="dr" data-id="${x.id}" placeholder="السبب" value="${esc(cur.get(x.id)?.reason || '')}" style="max-width:200px;min-height:34px"></div>`).join('')}</div>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const deps = $$('.dp:checked', mm.el).map(c => ({ depends_on_id: Number(c.value), reason: mm.$(`.dr[data-id="${c.value}"]`).value || null })); try { await api(`/tasks/${t.id}/dependencies`, { method: 'PUT', body: { dependencies: deps } }); mm.close(); toast('تم حفظ الاعتمادية'); reload(); } catch (e) { toast(e.message, 'err'); } };
}
