import { $, $$, rich, esc, api, qs, icon, L, lp, pill, num, pct, ltr, fdate, fshort, ftime, fdatetime, ago, state, wire, toast, modal, confirmBox, promptBox, readForm, showErrors, field, opts, busy, todayStr, ApiError } from '../core.js';
import { pageHead, meetingCard, prepPill, tabs, getDir, getOrg, getKpiList, empOpts, peoplePicker, wirePicker, fileToB64, empty } from '../ui.js';

export async function render(ctx) {
  const n = ctx.name;
  if (n === 'meetings') return list(ctx);
  if (n === 'meeting_new') return createForm(ctx);
  if (n === 'meeting_detail') return detail(ctx);
  if (n === 'meeting_live') return live(ctx);
  if (n === 'decisions') return decisions(ctx);
  if (n === 'decision_detail') return decisionDetail(ctx);
}

// ======================= القائمة =======================
async function list(ctx) {
  const { el, me, query } = ctx;
  const f = { when: query.when || 'upcoming', type: query.type || '', status: query.status || '', q: query.q || '', view: query.view || 'list' };
  const r = await api('/meetings' + qs({ when: f.when === 'all' ? '' : f.when, type: f.type, status: f.status, q: f.q, limit: 200 }));
  const go = o => { location.hash = '#/meetings' + qs({ ...f, ...o }); };
  const body = !r.items.length ? `<div class="card">${state('empty', f.when === 'upcoming' ? 'لا توجد اجتماعات قادمة' : 'لا توجد اجتماعات مطابقة', 'جرّب تغيير الفلاتر' + (me.can.create_meeting ? ' أو أنشئ اجتماعًا جديدًا.' : '.'), me.can.create_meeting ? '<a class="btn primary" href="#/meetings/new">اجتماع جديد</a>' : '')}</div>`
    : f.view === 'calendar' ? calendar(r.items, query.month)
    : `<div class="tablewrap only-desktop"><table><thead><tr><th>الاجتماع</th><th>الموعد</th><th>النوع</th><th>الوضع</th><th>الحالة</th><th>التحضير</th><th></th></tr></thead><tbody>${r.items.map(m => `<tr class="link" data-href="#/meetings/${m.id}"><td><div class="title">${esc(m.title)}</div><div class="sub">${ltr(m.code)} · ${esc(m.leader_name)}${m.org_name ? ' · ' + esc(m.org_name) : ''}</div></td><td>${fdate(m.meeting_date)}<div class="sub">${ftime(m.start_time)} · ${m.duration_min} د</div></td><td>${esc(L.meetingType[m.type])}${m.confidentiality !== 'normal' ? ` ${pill(m.confidentiality === 'board' ? 'Board' : 'سرّي', 'purple', 1)}` : ''}</td><td>${esc(L.mode[m.mode])}</td><td>${lp(L.meetingStatus, m.status)}</td><td>${['closed', 'cancelled', 'approved'].includes(m.status) ? '<span class="muted">—</span>' : lp(L.prep, m.prep_state)}</td><td>${m.can_join ? `<a class="btn sm primary" href="#/meetings/${m.id}?join=1">${icon('video')} Join</a>` : ''}</td></tr>`).join('')}</tbody></table></div>
       <div class="card only-mobile"><div class="list">${r.items.map(m => meetingCard(m)).join('')}</div></div>`;
  el.innerHTML = `${pageHead('الاجتماعات', `${r.total} اجتماع ضمن صلاحياتك`, `${me.can.create_meeting ? `<a class="btn primary" href="#/meetings/new">${icon('plus')} اجتماع جديد</a>` : ''}<a class="btn" href="#/decisions">القرارات</a>`)}
    <div class="filters"><div class="seg" role="group" aria-label="الفترة">${[['upcoming', 'القادمة'], ['past', 'السابقة'], ['all', 'الكل']].map(([k, l]) => `<button data-act="when" data-v="${k}" class="${f.when === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="field"><label for="ft">النوع</label><select id="ft" data-f="type">${opts(Object.entries(L.meetingType), f.type, 'كل الأنواع')}</select></div>
      <div class="field"><label for="fs">الحالة</label><select id="fs" data-f="status">${opts(Object.entries(L.meetingStatus).map(([k, v]) => [k, v[0]]), f.status, 'كل الحالات')}</select></div>
      <div class="field" style="flex:1;min-width:180px"><label for="fq">بحث</label><input id="fq" data-f="q" value="${esc(f.q)}" placeholder="العنوان أو الرمز"></div>
      <div class="seg" style="margin-inline-start:auto">${[['list', 'قائمة'], ['calendar', 'تقويم']].map(([k, l]) => `<button data-act="view" data-v="${k}" class="${f.view === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    ${body}`;
  el.querySelectorAll('[data-f]').forEach(i => i.addEventListener('change', () => go({ [i.dataset.f]: i.value })));
  wire(el, { when: b => go({ when: b.dataset.v }), view: b => go({ view: b.dataset.v, when: b.dataset.v === 'calendar' ? 'all' : f.when }), month: b => go({ month: b.dataset.v }) });
}
function calendar(items, monthKey) {
  const t = new Date(); const [y, mo] = (monthKey || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`).split('-').map(Number);
  const first = new Date(y, mo - 1, 1); const start = new Date(first); start.setDate(1 - ((first.getDay() + 1) % 7));      // الأسبوع يبدأ السبت
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const by = {}; items.forEach(m => (by[m.meeting_date] ||= []).push(m));
  const prev = new Date(y, mo - 2, 1), next = new Date(y, mo, 1); const mk = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  let cells = ''; const today = key(new Date());
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const k = key(d);
    cells += `<div class="d${d.getMonth() !== mo - 1 ? ' out' : ''}${k === today ? ' today' : ''}"><b><bdi class="num">${d.getDate()}</bdi></b>${(by[k] || []).map(m => `<a class="ev ${m.status === 'live' ? 'red' : ['closed', 'approved'].includes(m.status) ? 'gray' : m.prep_state === 'late' ? 'amber' : ''}" href="#/meetings/${m.id}" title="${esc(m.title)}"><bdi class="num">${esc(m.start_time)}</bdi> ${esc(m.title)}</a>`).join('')}</div>`; }
  const names = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
  return `<div class="row spread" style="margin-bottom:10px"><button class="btn sm" data-act="month" data-v="${mk(prev)}">${icon('chevR')} الشهر السابق</button><h3>${new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' }).format(first)}</h3><button class="btn sm" data-act="month" data-v="${mk(next)}">الشهر التالي ${icon('chevL')}</button></div><div class="cal">${names.map(n => `<div class="h">${n}</div>`).join('')}${cells}</div>`;
}

// ======================= إنشاء اجتماع =======================
async function createForm(ctx) {
  const { el, me, query } = ctx;
  if (!me.can.create_meeting) { el.innerHTML = state('lock', 'إنشاء الاجتماعات غير متاح لدورك', 'تواصل مع مديرك لجدولة الاجتماع.'); return; }
  const [dir, org] = await Promise.all([getDir(), getOrg()]);
  const meDir = dir.find(d => d.id === me.id);
  const types = Object.entries(L.meetingType).filter(([k]) => k !== 'board' || me.is_board);
  el.innerHTML = `${pageHead('اجتماع جديد', 'أنشئ الاجتماع كمسودة، ثم أضف جدول الأعمال وانشر حزمة التحضير.', '', '<a href="#/meetings">الاجتماعات</a> / جديد')}
  <form class="card" id="mf" novalidate><div class="alert err form-error" hidden></div>
   <div class="form-grid">
    ${field('عنوان الاجتماع', '<input name="title" required>', { full: true, req: true })}
    ${field('نوع الاجتماع', `<select name="type">${opts(types, query.type || 'department')}</select>`, { req: true })}
    ${field('الوحدة التنظيمية', `<select name="org">${opts(org.filter(o => ['company', 'business_unit', 'department'].includes(o.kind)).map(o => [o.id, `${L.level[o.kind]}: ${o.name}`]), meDir?.dept_id || '', 'تلقائيًا حسب القائد')}</select>`, { hint: 'لاجتماعات القسم أو وحدة النشاط' })}
    ${field('التاريخ', `<input type="date" name="meeting_date" value="${todayStr()}">`, { req: true })}
    ${field('وقت البدء', '<input type="time" name="start_time" value="10:00">', { req: true })}
    ${field('المدة المتوقعة (دقيقة)', '<input type="number" name="duration_min" value="60" min="5" step="5">')}
    ${field('وضع الاجتماع', `<select name="mode">${opts(Object.entries(L.mode), 'in_person')}</select>`)}
    ${field('مزوّد الاجتماع Online', `<select name="provider">${opts([['none', 'بدون'], ['teams', 'Microsoft Teams'], ['google_meet', 'Google Meet']], 'none')}</select>`, { hint: 'الربط الحالي Mock: يمكن توليد رابط تجريبي بعد الإنشاء أو لصق رابط حقيقي' })}
    ${field('رابط الاجتماع', '<input name="url" dir="ltr" placeholder="https://">')}
    ${field('المكان', '<input name="location" placeholder="مثال: قاعة الاجتماعات الرئيسية">')}
    ${field('القائد / رئيس الاجتماع', `<select name="leader_id">${empOpts(dir, me.id)}</select>`, { req: true })}
    ${field('السكرتير', `<select name="secretary_id">${empOpts(dir, '', 'بدون')}</select>`)}
    ${field('السرية', `<select name="confidentiality">${opts([['normal', 'عادي'], ['confidential', 'سرّي — للمشاركين والإدارة التنفيذية']], 'normal')}</select>`)}
    ${field('التكرار', `<select name="recurrence">${opts([['none', 'لا يتكرر'], ['weekly', 'أسبوعي'], ['monthly', 'شهري']], 'none')}</select>`)}
    ${field('الهدف من الاجتماع', '<textarea name="objective" placeholder="ما القرار أو النتيجة المطلوبة من هذا الاجتماع؟"></textarea>', { full: true })}
    ${field('التحضير المطلوب من المشاركين', '<textarea name="required_preparation"></textarea>', { full: true })}
    <div class="field full"><label>المشاركون</label>${peoplePicker(dir, [], [], [me.id])}</div>
   </div>
   <div class="row" style="margin-top:18px"><button class="btn primary big" type="submit">إنشاء الاجتماع</button><a class="btn big" href="#/meetings">إلغاء</a></div></form>`;
  const form = $('#mf', el); const getParts = wirePicker($('.picker', form));
  form.addEventListener('submit', async e => {
    e.preventDefault(); const d = readForm(form); const parts = getParts();
    const o = org.find(x => String(x.id) === String(d.org));
    const body = { ...d, duration_min: Number(d.duration_min), leader_id: Number(d.leader_id), secretary_id: d.secretary_id ? Number(d.secretary_id) : null, participant_ids: parts.map(p => p.employee_id), optional_ids: parts.filter(p => p.optional).map(p => p.employee_id) };
    delete body.org; if (o) { if (o.kind === 'department') body.dept_id = o.id; if (o.kind === 'business_unit') body.bu_id = o.id; if (o.kind === 'company') body.company_id = o.id; }
    const btn = $('button[type=submit]', form);
    await busy(btn, async () => { try { const r = await api('/meetings', { method: 'POST', body }); toast('تم إنشاء الاجتماع كمسودة'); location.hash = `#/meetings/${r.id}?tab=agenda`; } catch (x) { showErrors(form, x); } });
  });
}

// ======================= التفاصيل =======================
const NEXT = {
  draft: [['preparation', 'بدء التحضير وإرسال الدعوات', 'primary']],
  preparation: [['preparation_published', 'نشر حزمة التحضير', 'primary'], ['draft', 'إرجاع لمسودة', '']],
  preparation_published: [['ready', 'تأكيد الجاهزية', 'primary'], ['preparation', 'إلغاء النشر للتعديل', '']],
  ready: [['live', 'بدء الاجتماع', 'primary'], ['preparation_published', 'عودة للتحضير', '']],
  live: [['minutes_draft', 'إنهاء الاجتماع', 'danger']],
  minutes_draft: [['under_review', 'إرسال المحضر للمراجعة', 'primary']],
  under_review: [['approved', 'اعتماد المحضر', 'primary'], ['minutes_draft', 'إرجاع المحضر', '']],
  approved: [['closed', 'إغلاق ونشر المحضر', 'primary']],
};
async function detail(ctx) {
  const { el, me, params, query } = ctx;
  const m = await api('/meetings/' + params[0]);
  const tab = query.tab || (m.status === 'live' ? 'agenda' : ['minutes_draft', 'under_review', 'approved'].includes(m.status) ? 'minutes' : 'overview');
  const board = m.type === 'board';
  const actions = [];
  if (m.join) actions.push(`<button class="btn primary" data-act="join">${icon('video')} انضمام للاجتماع</button>`);
  if (m.status === 'live' && m.is_editor) actions.push(`<a class="btn primary" href="#/meetings/${m.id}/live">${icon('play')} فتح الجلسة الحية</a>`);
  for (const [to, label, cls] of (NEXT[m.status] || [])) if (m.allowed_transitions.includes(to)) actions.push(`<button class="btn ${cls}" data-act="move" data-to="${to}">${esc(label)}</button>`);
  if (m.is_editor && ['preparation_published', 'ready'].includes(m.status)) actions.push('<button class="btn" data-act="republish">إعادة نشر الحزمة</button>');
  if (m.is_editor && m.recurrence !== 'none' && ['closed', 'approved', 'ready', 'preparation_published'].includes(m.status)) actions.push('<button class="btn" data-act="nextocc">إنشاء الموعد التالي</button>');
  if (m.allowed_transitions.includes('cancelled')) actions.push('<button class="btn danger" data-act="cancel">إلغاء الاجتماع</button>');
  actions.push(`<a class="btn ghost" href="/api/meetings/${m.id}/ics" title="تصدير إلى التقويم">${icon('download')} ICS</a>`);
  const rsvp = m.my_invitation && !m.is_leader && ['preparation', 'preparation_published', 'ready'].includes(m.status)
    ? `<div class="alert info row spread"><span>دعوتك: ${esc(L.invitation[m.my_invitation][0])}. هل ستحضر؟</span><span class="row"><button class="btn sm primary" data-act="rsvp" data-v="accepted">سأحضر</button><button class="btn sm" data-act="rsvp" data-v="declined">أعتذر</button></span></div>` : '';
  const counts = { agenda: m.agenda.length, attendance: m.participants.length, outcomes: m.decisions.length + m.tasks.length };
  const T = [['overview', 'نظرة عامة'], ['agenda', m.is_editor ? 'التحضير وجدول الأعمال' : 'جدول الأعمال', counts.agenda], ['pack', 'حزمة التحضير'], ['attendance', 'المشاركون والحضور', counts.attendance], ['outcomes', 'القرارات والمهام', counts.outcomes], ['minutes', 'المحضر (MoM)']];
  el.innerHTML = `${pageHead(m.title, `${ltr(m.code)} · ${esc(L.meetingType[m.type])} · ${fdate(m.meeting_date)} ${ftime(m.start_time)} · ${m.duration_min} دقيقة · ${esc(L.mode[m.mode])}`, actions.join(''), '<a href="#/meetings">الاجتماعات</a>')}
    <div class="row" style="margin:-8px 0 16px;gap:8px">${lp(L.meetingStatus, m.status)}${!['closed', 'cancelled'].includes(m.status) ? prepPill(m.prep_state) : ''}${board ? pill('Board — سرّي', 'purple') : m.confidentiality === 'confidential' ? pill('سرّي', 'purple') : ''}${m.recurrence !== 'none' ? pill(m.recurrence === 'weekly' ? 'يتكرر أسبوعيًا' : 'يتكرر شهريًا', 'blue', 1) : ''}${m.is_leader ? pill('أنت القائد', 'green', 1) : m.is_secretary ? pill('أنت السكرتير', 'green', 1) : ''}</div>
    ${rsvp}${m.cancel_reason ? `<div class="alert warn">سبب الإلغاء: ${esc(m.cancel_reason)}</div>` : ''}
    ${tabs(T, tab)}<div id="tabc"></div>`;
  const tc = $('#tabc', el);
  const show = t => { $$('.tabs button', el).forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); }); history.replaceState(null, '', `#/meetings/${m.id}?tab=${t}`); renderTab(t); };
  $('.tabs', el).addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  const renderTab = t => {
    if (t === 'overview') tc.innerHTML = overview(m);
    if (t === 'agenda') tc.innerHTML = agendaTab(m);
    if (t === 'pack') tc.innerHTML = packTab(m);
    if (t === 'attendance') tc.innerHTML = attendanceTab(m);
    if (t === 'outcomes') tc.innerHTML = outcomesTab(m);
    if (t === 'minutes') tc.innerHTML = minutesTab(m);
    if (t === 'overview') loadTrace(m);
  };
  renderTab(tab);
  const reload = async t => { const cur = t || $('.tabs .on', el)?.dataset.tab; history.replaceState(null, '', `#/meetings/${m.id}?tab=${cur}`); await ctx.reload(); };
  if (query.join && m.join) doJoin(m);
  wire(el, {
    join: () => doJoin(m),
    move: async b => {
      const to = b.dataset.to; let reason;
      if (to === 'live') { await api(`/meetings/${m.id}/transition`, { method: 'POST', body: { to } }); toast('بدأ الاجتماع'); location.hash = `#/meetings/${m.id}/live`; return; }
      if (to === 'minutes_draft' && m.status === 'under_review') { reason = await promptBox('إرجاع المحضر', 'سبب الإرجاع'); if (!reason) return; }
      if (to === 'minutes_draft' && m.status === 'live') { if (!await confirmBox('إنهاء الاجتماع', 'سيتم تأجيل البنود التي لم تُناقش وتسجيل غير المسجلين كغائبين.', 'إنهاء')) return; }
      if (to === 'approved' && !await confirmBox('اعتماد المحضر', 'بعد الاعتماد يُحفظ سجل الحضور الفعلي ولا يمكن تعديل المحضر.', 'اعتماد')) return;
      await api(`/meetings/${m.id}/transition`, { method: 'POST', body: { to, reason } });
      toast('تم تحديث حالة الاجتماع'); await reload(to === 'preparation_published' ? 'pack' : to === 'minutes_draft' || to === 'under_review' ? 'minutes' : undefined);
    },
    cancel: async () => { const reason = await promptBox('إلغاء الاجتماع', 'سبب الإلغاء (سيصل للمشاركين)'); if (!reason) return; await api(`/meetings/${m.id}/transition`, { method: 'POST', body: { to: 'cancelled', reason } }); toast('تم إلغاء الاجتماع'); await reload('overview'); },
    republish: async () => { await api(`/meetings/${m.id}/prep/republish`, { method: 'POST' }); toast('أُعيد نشر حزمة التحضير'); await reload('pack'); },
    nextocc: async () => { const r = await api(`/meetings/${m.id}/next-occurrence`, { method: 'POST' }); toast('تم إنشاء الموعد التالي في السلسلة'); location.hash = `#/meetings/${r.id}`; },
    rsvp: async b => { await api(`/meetings/${m.id}/rsvp`, { method: 'PUT', body: { invitation: b.dataset.v } }); toast(b.dataset.v === 'accepted' ? 'تم تأكيد حضورك' : 'تم تسجيل اعتذارك'); await reload(); },
    mocklink: async () => { const r = await api(`/meetings/${m.id}/online-link`, { method: 'POST' }); toast(r.notice); await reload('overview'); },
    edit: () => editMeeting(m, reload),
    addAgenda: () => agendaModal(m, null, reload),
    editAgenda: b => agendaModal(m, m.agenda.find(a => a.id === Number(b.dataset.id)), reload),
    delAgenda: async b => { if (!await confirmBox('حذف البند', 'هل تريد حذف هذا البند من جدول الأعمال؟', 'حذف', true)) return; await api(`/agenda/${b.dataset.id}`, { method: 'DELETE' }); toast('تم حذف البند'); await reload('agenda'); },
    moveAgenda: async b => { const ids = m.agenda.map(a => a.id); const i = ids.indexOf(Number(b.dataset.id)); const j = i + Number(b.dataset.d); if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await api(`/meetings/${m.id}/agenda/reorder`, { method: 'POST', body: { ids } }); await reload('agenda'); },
    kpis: () => kpisModal(m, reload),
    upload: () => uploadModal('meeting', m.id, reload),
    participants: () => participantsModal(m, reload),
    att: async b => { await api(`/meetings/${m.id}/attendance/${b.dataset.e}`, { method: 'PUT', body: { attendance: b.dataset.v, attendance_mode: b.dataset.mode || undefined } }); await reload('attendance'); },
    addDecision: () => decisionModal(m, null, () => reload('outcomes')),
    addTask: () => taskModal(m, null, () => reload('outcomes')),
    saveMinutes: async b => { await busy(b, () => api(`/meetings/${m.id}/minutes`, { method: 'PUT', body: { summary: $('#mn-sum', el).value, next_meeting_note: $('#mn-next', el).value } })); toast('تم حفظ المحضر'); },
    print: () => window.print(),
  });
}
async function doJoin(m) {
  try { const j = await api(`/meetings/${m.id}/join`); const mm = modal({ title: 'الانضمام للاجتماع', body: `<p>سيُفتح الاجتماع في ${esc(j.provider === 'teams' ? 'Microsoft Teams' : j.provider === 'google_meet' ? 'Google Meet' : 'المتصفح')}.</p>${j.mock ? `<div class="alert mockbar small">${esc(j.notice)}</div>` : ''}<p class="small" dir="ltr" style="word-break:break-all">${esc(j.url)}</p>`, footer: `<a class="btn primary" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">فتح الرابط</a><button class="btn" data-close>إغلاق</button>` }); }
  catch (e) { toast(e.message, 'err'); }
}
function overview(m) {
  const part = m.participants; const acc = part.filter(p => p.invitation === 'accepted').length;
  return `<div class="grid g-main"><div class="stack">
    <div class="card"><header><h3>الهدف</h3>${m.can_edit ? '<button class="btn sm more" data-act="edit">' + icon('edit') + ' تعديل البيانات</button>' : ''}</header><p style="margin:0">${esc(m.objective) || '<span class="muted">لم يُحدد هدف بعد. الهدف مطلوب قبل نشر حزمة التحضير.</span>'}</p>${m.required_preparation ? `<h3 style="margin-top:14px">المطلوب قبل الاجتماع</h3><p style="margin:4px 0 0">${esc(m.required_preparation)}</p>` : ''}</div>
    <div class="card"><header><h3>مسار الإدارة المرتبط</h3><span class="muted small more">KPI ← اجتماع ← قرار ← مهمة ← دليل</span></header><div id="trace">${empty('جارٍ التحميل…')}</div></div>
    ${m.previous && (m.previous.decisions.length || m.previous.actions.length) ? `<div class="card"><header><h3>متابعة من الاجتماعات السابقة</h3></header>${prevBlock(m.previous)}</div>` : ''}
  </div><div class="stack"><div class="card"><dl class="kv">
    <dt>الرمز</dt><dd>${ltr(m.code)}</dd><dt>الموعد</dt><dd>${fdate(m.meeting_date)} · ${ftime(m.start_time)}</dd><dt>المدة</dt><dd>${m.duration_min} دقيقة</dd>
    <dt>الوضع</dt><dd>${esc(L.mode[m.mode])}${m.provider !== 'none' ? ` · ${m.provider === 'teams' ? 'Microsoft Teams' : 'Google Meet'}` : ''}</dd>
    ${m.url ? `<dt>الرابط</dt><dd><span class="mock">Mock</span> <span dir="ltr" class="small" style="word-break:break-all">${esc(m.url)}</span></dd>` : ''}
    ${m.is_editor && ['online', 'hybrid'].includes(m.mode) && m.provider !== 'none' && m.can_edit ? `<dt></dt><dd><button class="btn sm" data-act="mocklink">توليد رابط (Mock)</button></dd>` : ''}
    <dt>المكان</dt><dd>${esc(m.location) || '—'}</dd><dt>القائد</dt><dd>${esc(m.leader_name)}</dd><dt>السكرتير</dt><dd>${esc(m.secretary_name) || '—'}</dd>
    <dt>الوحدة</dt><dd>${esc(m.dept_name || m.bu_name || m.company_name || (m.type === 'board' ? 'مجلس الإدارة' : '—'))}</dd>
    <dt>الدعوات</dt><dd>${part.length} مشارك · ${acc} قبول</dd>
    ${m.started_at ? `<dt>بدأ</dt><dd>${fdatetime(m.started_at)}</dd>` : ''}${m.ended_at ? `<dt>انتهى</dt><dd>${fdatetime(m.ended_at)}</dd>` : ''}
  </dl></div>
  ${m.attachments.length ? `<div class="card"><header><h3>المستندات</h3></header><div class="list">${m.attachments.map(a => attRow(a)).join('')}</div></div>` : ''}</div></div>`;
}
const attRow = a => `<a class="item" href="/api/attachments/${a.id}/download">${icon('file')}<div class="grow"><span class="t">${esc(a.filename)}</span><span class="small muted"><bdi class="num">${Math.max(1, Math.round(a.size / 1024))} KB</bdi></span></div>${icon('download')}</a>`;
function prevBlock(p) {
  return `${p.decisions.length ? `<h3 class="small muted" style="margin-bottom:6px">قرارات لم تُغلق</h3><div class="list">${p.decisions.map(d => `<a class="item" href="#/decisions/${d.id}"><div class="grow"><span class="t">${esc(d.text)}</span><span class="small muted">${ltr(d.code)} · ${esc(d.owner_name)}</span></div>${lp(L.decision, d.status)}</a>`).join('')}</div>` : ''}
  ${p.actions.length ? `<h3 class="small muted" style="margin:14px 0 6px">مهام مفتوحة</h3><div class="list">${p.actions.map(t => `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><span class="small muted">${esc(t.owner_name)} · ${t.overdue ? '<b style="color:var(--red)">متأخرة</b> · ' : ''}${fdate(t.due_date)} · ${t.progress}%</span></div>${lp(L.taskStatus, t.status)}</a>`).join('')}</div>` : ''}`;
}
async function loadTrace(m) {
  try { const t = await api(`/trace/meeting/${m.id}`); const box = document.getElementById('trace'); if (!box) return; box.innerHTML = traceView(t); } catch { }
}
export function traceView(t) {
  if (!t.nodes.length || t.nodes.length === 1) return empty('لا توجد روابط بعد. القرارات والمهام المرتبطة ستظهر هنا.');
  const order = ['kpi', 'meeting', 'decision', 'task', 'evidence', 'initiative']; const T = { kpi: 'KPI', meeting: 'اجتماع', decision: 'قرار', task: 'مهمة', evidence: 'دليل', initiative: 'مبادرة' };
  const cols = order.map(k => t.nodes.filter(n => n.type === k)).filter(c => c.length);
  const color = s => ({ red: 'red', amber: 'amber', green: 'green', completed: 'green', implemented: 'green', closed: 'gray', at_risk: 'red', blocked: 'red' })[s] || '';
  return `<div class="trace" style="align-items:flex-start">${cols.map((c, i) => `${i ? `<span class="tarrow">${icon('chevL')}</span>` : ''}<div class="stack" style="gap:8px">${c.map(n => `<a class="tnode" href="${esc(n.link)}"><span class="ty">${T[n.type]}</span> ${n.status ? `<span class="dotc ${color(n.status)}" style="margin-inline-start:4px"></span>` : ''}<div class="b small" style="line-height:1.4">${rich(n.label)}</div><small>${rich(n.sub)}</small></a>`).join('')}</div>`).join('')}</div>`;
}
function agendaTab(m) {
  const ed = m.is_editor && ['draft', 'preparation', 'preparation_published', 'ready', 'live'].includes(m.status);
  const canOrder = m.is_editor && ['draft', 'preparation', 'preparation_published', 'ready'].includes(m.status);
  const total = m.agenda.reduce((a, x) => a + (x.est_min || 0), 0);
  const hiddenNote = !m.is_editor && !m.prep_released_at && ['draft', 'preparation', 'preparation_published'].includes(m.status) ? '<div class="alert info small">تظهر تفاصيل البنود والتحضير المطلوب عند إتاحة حزمة التحضير قبل الاجتماع بـ48 ساعة.</div>' : '';
  return `<div class="grid g-main"><div class="stack">${hiddenNote}
    <div class="card"><header><h3>جدول الأعمال</h3><span class="muted small">${m.agenda.length} بنود · <bdi class="num">${total}</bdi> دقيقة${total > m.duration_min ? ` <b style="color:var(--amber)">(أطول من مدة الاجتماع)</b>` : ''}</span>${ed ? `<button class="btn sm primary more" data-act="addAgenda">${icon('plus')} إضافة بند</button>` : ''}</header>
    ${m.agenda.length ? `<div class="agenda">${m.agenda.map((a, i) => `<div class="ag ${a.status === 'completed' ? 'done' : ''}" style="cursor:default"><span class="no"><bdi class="num">${a.seq}</bdi></span><div class="grow" style="flex:1;min-width:0">
      <div class="row spread"><b>${esc(a.topic)}</b><span class="row" style="gap:6px">${pill(L.agendaType[a.type] || a.type, a.type === 'decision_required' ? 'amber' : 'gray', 1)}${a.status && a.status !== 'pending' ? lp(L.agenda, a.status) : ''}</span></div>
      <div class="small muted">${a.presenter_name ? 'المقدم: ' + esc(a.presenter_name) + ' · ' : ''}<bdi class="num">${a.est_min || 0}</bdi> دقيقة${a.kpi_code ? ` · KPI: <a href="#/kpis/${a.related_kpi_id}">${esc(a.kpi_name)}</a>` : ''}</div>
      ${a.objective ? `<div class="small" style="margin-top:4px">الهدف: ${esc(a.objective)}</div>` : ''}${a.required_decision ? `<div class="small">القرار المطلوب: ${esc(a.required_decision)}</div>` : ''}${a.required_data ? `<div class="small">البيانات المطلوبة: ${esc(a.required_data)}</div>` : ''}${a.prep_notes ? `<div class="small">ملاحظات التحضير: ${esc(a.prep_notes)}</div>` : ''}${a.discussion_notes ? `<div class="small" style="margin-top:4px;color:var(--ink-2)">ملخص النقاش: ${esc(a.discussion_notes)}</div>` : ''}
      ${ed ? `<div class="row" style="margin-top:8px;gap:6px">${canOrder ? `<button class="btn sm ghost" data-act="moveAgenda" data-id="${a.id}" data-d="-1" aria-label="تحريك لأعلى" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sm ghost" data-act="moveAgenda" data-id="${a.id}" data-d="1" aria-label="تحريك لأسفل" ${i === m.agenda.length - 1 ? 'disabled' : ''}>▼</button>` : ''}<button class="btn sm" data-act="editAgenda" data-id="${a.id}">${icon('edit')} تعديل</button>${canOrder ? `<button class="btn sm danger" data-act="delAgenda" data-id="${a.id}">حذف</button>` : ''}</div>` : ''}
    </div></div>`).join('')}</div>` : state('empty', 'لا توجد بنود بعد', ed ? 'أضف البنود المطلوب مناقشتها؛ نشر حزمة التحضير يتطلب بندًا واحدًا على الأقل.' : 'لم يُضف القائد بنودًا بعد.', ed ? '<button class="btn primary" data-act="addAgenda">إضافة أول بند</button>' : '')}</div></div>
    <div class="stack">
      <div class="card"><header><h3>المؤشرات المطلوبة</h3>${m.can_edit ? '<button class="btn sm more" data-act="kpis">تعديل</button>' : ''}</header>${m.kpis.length ? `<div class="list">${m.kpis.map(k => `<a class="item" href="#/kpis/${k.id}">${icon('kpi')}<span class="grow t">${esc(k.name)}</span><span class="tag">${ltr(k.code)}</span></a>`).join('')}</div>` : empty('لم تُحدد مؤشرات.')}</div>
      <div class="card"><header><h3>المرفقات</h3>${m.is_editor ? `<button class="btn sm more" data-act="upload">${icon('upload')} رفع</button>` : ''}</header>${m.attachments.length ? `<div class="list">${m.attachments.map(attRow).join('')}</div>` : empty('لا توجد مرفقات.')}</div>
      ${m.previous ? `<div class="card"><header><h3>من الاجتماعات السابقة</h3></header>${m.previous.decisions.length || m.previous.actions.length ? prevBlock(m.previous) : empty('لا توجد قرارات أو مهام مفتوحة.')}</div>` : ''}
    </div></div>`;
}
function packTab(m) {
  const p = m.prep_pack;
  if (!p) {
    if (m.prep_hidden) return `<div class="card">${state('lock', 'حزمة التحضير غير متاحة بعد', 'نُشرت الحزمة وستُتاح للمشاركين تلقائيًا قبل الاجتماع بـ48 ساعة.')}</div>`;
    return `<div class="card">${state('empty', m.prep_state === 'late' ? 'حزمة التحضير متأخرة' : 'لم تُنشر حزمة التحضير بعد', m.is_editor ? 'جهّز الهدف وجدول الأعمال ثم اضغط «نشر حزمة التحضير». تُتاح للمشاركين قبل الاجتماع بـ48 ساعة.' : 'سيُنبهك النظام عند نشرها.')}</div>`;
  }
  return `<div class="stack"><div class="alert ${m.prep_released_at ? 'ok' : 'info'} small">${m.prep_released_at ? `أُتيحت للمشاركين ${fdatetime(m.prep_released_at)}` : `نُشرت ${fdatetime(m.prep_published_at)} وستُتاح للمشاركين قبل الاجتماع بـ48 ساعة (أتمتة). أنت تراها الآن لأنك قائد/مدير.`}</div>
    <div class="grid g-main"><div class="stack">
      <div class="card"><header><h3>${esc(p.details.title)}</h3></header><dl class="kv"><dt>الموعد</dt><dd>${fdate(p.details.date)} · ${ftime(p.details.time)} · ${p.details.duration_min} دقيقة</dd><dt>الوضع</dt><dd>${esc(L.mode[p.details.mode])}${p.details.location ? ' · ' + esc(p.details.location) : ''}</dd><dt>القائد</dt><dd>${esc(p.details.leader)}</dd><dt>الهدف</dt><dd>${esc(p.objective)}</dd>${p.required_preparation ? `<dt>المطلوب منك</dt><dd><b>${esc(p.required_preparation)}</b></dd>` : ''}</dl></div>
      <div class="card"><header><h3>جدول الأعمال</h3></header><div class="agenda">${p.agenda.map(a => `<div class="ag" style="cursor:default"><span class="no"><bdi class="num">${a.seq}</bdi></span><div style="flex:1"><b>${esc(a.topic)}</b> ${pill(L.agendaType[a.type] || '', 'gray', 1)}<div class="small muted">${esc(a.presenter_name || '')} · <bdi class="num">${a.est_min}</bdi> د</div>${a.prep_notes ? `<div class="small">التحضير: ${esc(a.prep_notes)}</div>` : ''}${a.required_data ? `<div class="small">البيانات: ${esc(a.required_data)}</div>` : ''}${a.required_decision ? `<div class="small">القرار المطلوب: ${esc(a.required_decision)}</div>` : ''}</div></div>`).join('')}</div></div>
    </div><div class="stack">
      <div class="card"><header><h3>المؤشرات</h3></header>${p.kpis.length ? `<div class="list">${p.kpis.map(k => `<a class="item" href="#/kpis/${k.id}"><span style="padding-top:7px" class="dotc ${k.status || 'missing'}"></span><div class="grow"><span class="t">${esc(k.name)}</span><span class="small muted">${k.period_key ? `${ltr(k.period_key)} · الفعلي ${num(k.actual)} / ${num(k.target)} ${esc(k.unit || '')}` : 'لا توجد بيانات'}</span></div><b>${pct(k.achievement)}</b></a>`).join('')}</div>` : empty('لا توجد مؤشرات.')}</div>
      <div class="card"><header><h3>المستندات</h3></header>${p.documents.length ? `<div class="list">${p.documents.map(attRow).join('')}</div>` : empty('لا توجد مستندات.')}</div>
      <div class="card"><header><h3>القرارات والمهام المفتوحة سابقًا</h3></header>${p.previous_decisions.length || p.previous_actions.length ? prevBlock({ decisions: p.previous_decisions, actions: p.previous_actions }) : empty('لا توجد بنود متابعة.')}</div>
    </div></div></div>`;
}
function attendanceTab(m) {
  const canAtt = m.is_editor && ['ready', 'live', 'preparation_published', 'minutes_draft'].includes(m.status);
  const snap = m.minutes && m.minutes.attendance_snapshot;
  const rows = snap || m.participants;
  return `<div class="card"><header><h3>المشاركون${snap ? ' — الحضور الفعلي المعتمد في المحضر' : ''}</h3>${m.can_edit ? `<button class="btn sm more" data-act="participants">${icon('users')} تعديل المشاركين</button>` : ''}</header>
   <div class="tablewrap"><table><thead><tr><th>المشارك</th><th>الدعوة</th><th>الحضور</th><th>طريقة الحضور</th>${canAtt ? '<th>تسجيل</th>' : ''}</tr></thead><tbody>${rows.map(p => `<tr><td><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.job_title || '')}${p.optional ? ' · اختياري' : ''}${p.employee_id === m.leader_id ? ' · القائد' : ''}</div></td><td>${lp(L.invitation, p.invitation)}</td><td>${p.attendance ? lp(L.attendance, p.attendance) : '<span class="muted">—</span>'}</td><td>${p.attendance_mode ? (p.attendance_mode === 'online' ? 'Online' : 'حضوري') : '—'}</td>
     ${canAtt ? `<td><div class="row" style="gap:4px">${attButtons(p, m)}</div></td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
}
const attButtons = (p, m) => `<button class="btn sm ${p.attendance === 'attended' && p.attendance_mode !== 'online' ? 'primary' : ''}" data-act="att" data-e="${p.employee_id}" data-v="attended" data-mode="in_person">حضوري</button>${m.mode !== 'in_person' ? `<button class="btn sm ${p.attendance === 'attended' && p.attendance_mode === 'online' ? 'primary' : ''}" data-act="att" data-e="${p.employee_id}" data-v="attended" data-mode="online">Online</button>` : ''}<button class="btn sm ${p.attendance === 'excused' ? 'primary' : ''}" data-act="att" data-e="${p.employee_id}" data-v="excused">معتذر</button><button class="btn sm ${p.attendance === 'absent' ? 'primary' : ''}" data-act="att" data-e="${p.employee_id}" data-v="absent">غائب</button>`;
function outcomesTab(m) {
  const canDec = m.is_editor && ['live', 'minutes_draft', 'under_review'].includes(m.status);
  const canTask = m.is_editor && !['draft', 'cancelled'].includes(m.status);
  return `<div class="grid g2"><div class="card"><header><h3>القرارات</h3>${canDec ? `<button class="btn sm primary more" data-act="addDecision">${icon('plus')} قرار</button>` : ''}</header>${m.decisions.length ? `<div class="list">${m.decisions.map(d => `<a class="item" href="#/decisions/${d.id}"><div class="grow"><span class="t">${esc(d.text)}</span><span class="small muted">${ltr(d.code)} · ${esc(d.owner_name)}${d.effective_date ? ' · السريان ' + fdate(d.effective_date) : ''}</span></div>${lp(L.decision, d.status)}</a>`).join('')}</div>` : state('empty', 'لا توجد قرارات', canDec ? 'سجّل القرارات أثناء الاجتماع أو في مرحلة المحضر.' : 'تُسجل القرارات أثناء الاجتماع.')}</div>
   <div class="card"><header><h3>المهام (Action Items)</h3>${canTask ? `<button class="btn sm primary more" data-act="addTask">${icon('plus')} مهمة</button>` : ''}</header>${m.tasks.length ? `<div class="list">${m.tasks.map(t => `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><span class="small muted">${esc(t.owner_name)} · ${fdate(t.due_date)} · <bdi class="num">${t.progress}%</bdi></span></div>${lp(L.taskStatus, t.status)}</a>`).join('')}</div>` : state('empty', 'لا توجد مهام', 'كل مهمة تُنشأ هنا تظهر تلقائيًا في متتبع المهام.')}</div></div>`;
}
function minutesTab(m) {
  const mn = m.minutes; const ed = m.is_editor && ['live', 'minutes_draft'].includes(m.status);
  if (!mn && !ed) return `<div class="card">${state('empty', 'المحضر غير متاح', ['closed', 'approved'].includes(m.status) ? 'لا يوجد محضر.' : 'يُتاح المحضر بعد اعتماده ونشره.')}</div>`;
  const att = mn?.attendance_snapshot || m.participants;
  const deferred = m.agenda.filter(a => a.status === 'deferred');
  const stMap = { minutes_draft: 'Draft', under_review: 'Review', approved: 'Approved', closed: 'Published' };
  return `<div class="stack">${ed ? `<div class="card"><header><h3>تحرير المحضر</h3><span class="pill amber more">${esc(stMap[m.status] || 'Draft')}</span></header><div class="field"><label for="mn-sum">ملخص النقاش</label><textarea id="mn-sum" rows="6">${esc(mn?.summary || '')}</textarea></div><div class="field" style="margin-top:12px"><label for="mn-next">الاجتماع القادم / ملاحظات المتابعة</label><input id="mn-next" value="${esc(mn?.next_meeting_note || '')}"></div><div class="row" style="margin-top:12px"><button class="btn primary" data-act="saveMinutes">حفظ المحضر</button></div></div>` : ''}
   <article class="card" id="mom"><header><h3>محضر الاجتماع (MoM)</h3><span class="pill ${m.status === 'closed' ? 'green' : 'amber'} more">${esc(stMap[m.status] || '')}</span><button class="btn sm" data-act="print">${icon('download')} طباعة / PDF</button></header>
    <dl class="kv"><dt>الاجتماع</dt><dd>${esc(m.title)} (${ltr(m.code)})</dd><dt>التاريخ</dt><dd>${fdate(m.meeting_date)} · ${ftime(m.start_time)}</dd><dt>القائد</dt><dd>${esc(m.leader_name)}</dd>${mn?.approved_at ? `<dt>الاعتماد</dt><dd>${fdatetime(mn.approved_at)}</dd>` : ''}</dl>
    <h3 style="margin:16px 0 6px">الحضور</h3><div class="small">${att.map(p => `${esc(p.name)} (${p.attendance ? esc(L.attendance[p.attendance][0]) : '—'}${p.attendance_mode === 'online' ? ' · Online' : ''})`).join('، ')}</div>
    <h3 style="margin:16px 0 6px">جدول الأعمال والنقاش</h3><ol style="margin:0;padding-inline-start:20px">${m.agenda.map(a => `<li><b>${esc(a.topic)}</b> — ${esc(L.agenda[a.status]?.[0] || '')}${a.discussion_notes ? `<div class="small">${esc(a.discussion_notes)}</div>` : ''}</li>`).join('')}</ol>
    <h3 style="margin:16px 0 6px">ملخص النقاش</h3><p style="margin:0;white-space:pre-wrap">${esc(mn?.summary) || '<span class="muted">لم يُكتب بعد.</span>'}</p>
    <h3 style="margin:16px 0 6px">القرارات</h3>${m.decisions.length ? `<ol style="margin:0;padding-inline-start:20px">${m.decisions.map(d => `<li>${esc(d.text)} — <span class="small muted">${ltr(d.code)} · ${esc(d.owner_name)}</span></li>`).join('')}</ol>` : empty('لا توجد.')}
    <h3 style="margin:16px 0 6px">المهام</h3>${m.tasks.length ? `<div class="tablewrap"><table><thead><tr><th>المهمة</th><th>المسؤول</th><th>الاستحقاق</th></tr></thead><tbody>${m.tasks.map(t => `<tr><td>${esc(t.title)}</td><td>${esc(t.owner_name)}</td><td>${fdate(t.due_date)}</td></tr>`).join('')}</tbody></table></div>` : empty('لا توجد.')}
    <h3 style="margin:16px 0 6px">البنود المؤجلة</h3>${deferred.length ? `<ul style="margin:0">${deferred.map(a => `<li>${esc(a.topic)}</li>`).join('')}</ul>` : empty('لا توجد.')}
    <h3 style="margin:16px 0 6px">الاجتماع القادم</h3><p style="margin:0">${esc(mn?.next_meeting_note) || '—'}</p></article></div>`;
}

// ---------- نوافذ ----------
async function editMeeting(m, reload) {
  const mm = modal({ title: 'تعديل بيانات الاجتماع', wide: true, body: `<form id="ef"><div class="alert err form-error" hidden></div><div class="form-grid">${field('العنوان', `<input name="title" value="${esc(m.title)}">`, { full: true })}${field('التاريخ', `<input type="date" name="meeting_date" value="${m.meeting_date}">`)}${field('الوقت', `<input type="time" name="start_time" value="${m.start_time}">`)}${field('المدة', `<input type="number" name="duration_min" value="${m.duration_min}">`)}${field('الوضع', `<select name="mode">${opts(Object.entries(L.mode), m.mode)}</select>`)}${field('المزوّد', `<select name="provider">${opts([['none', 'بدون'], ['teams', 'Microsoft Teams'], ['google_meet', 'Google Meet']], m.provider)}</select>`)}${field('الرابط', `<input name="url" dir="ltr" value="${esc(m.url || '')}">`)}${field('المكان', `<input name="location" value="${esc(m.location || '')}">`)}${field('الهدف', `<textarea name="objective">${esc(m.objective || '')}</textarea>`, { full: true })}${field('التحضير المطلوب', `<textarea name="required_preparation">${esc(m.required_preparation || '')}</textarea>`, { full: true })}</div></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const f = mm.$('#ef'); const d = readForm(f); try { await api(`/meetings/${m.id}`, { method: 'PUT', body: { ...d, duration_min: Number(d.duration_min) } }); mm.close(); toast('تم الحفظ'); reload('overview'); } catch (e) { showErrors(f, e); } };
}
async function agendaModal(m, a, reload) {
  const [dir, kpis] = await Promise.all([getDir(), getKpiList().catch(() => [])]);
  const mm = modal({ title: a ? 'تعديل بند' : 'إضافة بند لجدول الأعمال', wide: true, body: `<form id="af"><div class="alert err form-error" hidden></div><div class="form-grid">${field('الموضوع', `<input name="topic" value="${esc(a?.topic || '')}">`, { full: true, req: true })}${field('المقدّم', `<select name="presenter_id">${empOpts(dir, a?.presenter_id, 'بدون')}</select>`)}${field('النوع', `<select name="type">${opts(Object.entries(L.agendaType), a?.type || 'discussion')}</select>`)}${field('المدة المقدرة (دقيقة)', `<input type="number" name="est_min" min="0" value="${a?.est_min ?? 10}">`)}${field('مؤشر مرتبط (KPI)', `<select name="related_kpi_id">${opts(kpis.map(k => [k.id, `${k.code} — ${k.name}`]), a?.related_kpi_id, 'بدون')}</select>`)}${field('الهدف من البند', `<input name="objective" value="${esc(a?.objective || '')}">`, { full: true })}${field('القرار المطلوب', `<input name="required_decision" value="${esc(a?.required_decision || '')}">`, { full: true })}${field('البيانات المطلوبة', `<input name="required_data" value="${esc(a?.required_data || '')}">`)}${field('ملاحظات التحضير', `<input name="prep_notes" value="${esc(a?.prep_notes || '')}">`)}</div></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const f = mm.$('#af'); const d = readForm(f); const body = { ...d, est_min: d.est_min === null ? 0 : Number(d.est_min), presenter_id: d.presenter_id ? Number(d.presenter_id) : null, related_kpi_id: d.related_kpi_id ? Number(d.related_kpi_id) : null };
    try { if (a) await api(`/agenda/${a.id}`, { method: 'PUT', body }); else await api(`/meetings/${m.id}/agenda`, { method: 'POST', body }); mm.close(); toast('تم حفظ البند'); reload('agenda'); } catch (e) { showErrors(f, e); } };
}
async function kpisModal(m, reload) {
  const kpis = await getKpiList(); const sel = new Set(m.kpis.map(k => k.id));
  const mm = modal({ title: 'المؤشرات المطلوبة في حزمة التحضير', body: `<div style="max-height:50vh;overflow:auto">${kpis.map(k => `<label class="check"><input type="checkbox" value="${k.id}"${sel.has(k.id) ? ' checked' : ''}> ${esc(k.name)} <span class="tag">${ltr(k.code)}</span></label>`).join('')}</div>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const ids = $$('input:checked', mm.el).map(i => Number(i.value)); await api(`/meetings/${m.id}/kpis`, { method: 'PUT', body: { kpi_ids: ids } }).then(() => { mm.close(); reload('agenda'); }).catch(e => toast(e.message, 'err')); };
}
export function uploadModal(entity, id, reload, note) {
  const mm = modal({ title: 'رفع مستند', body: `<div class="field"><label for="uf">الملف</label><input type="file" id="uf" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.doc,.docx,.xls,.xlsx,.pptx"><span class="hint">PDF أو صور أو ملفات Office حتى 8 ميجابايت. التخزين الحالي محلي على الخادم (جاهز للانتقال إلى Object Storage).</span></div>${note ? `<div class="field" style="margin-top:10px"><label>وصف</label><input id="un"></div>` : ''}`, footer: '<button class="btn primary" data-ok>رفع</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const f = mm.$('#uf').files[0]; if (!f) return toast('اختر ملفًا', 'err'); try { const mime = f.type || (f.name.endsWith('.txt') ? 'text/plain' : ''); const r = await api('/attachments', { method: 'POST', body: { entity_type: entity, entity_id: id, filename: f.name, mime, note: mm.$('#un')?.value, data_b64: await fileToB64(f) } }); mm.close(); toast('تم رفع الملف'); reload(r.id); } catch (e) { toast(e.message, 'err'); } };
}
async function participantsModal(m, reload) {
  const dir = await getDir();
  const mm = modal({ title: 'المشاركون', wide: true, body: peoplePicker(dir, m.participants.map(p => p.employee_id), m.participants.filter(p => p.optional).map(p => p.employee_id), [m.leader_id]) + (m.type === 'board' ? '<div class="alert info small" style="margin-top:8px">اجتماعات Board تقبل أعضاء المجلس وأمين السر فقط.</div>' : ''), footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
  const get = wirePicker(mm.$('.picker'));
  mm.$('[data-ok]').onclick = async () => { try { await api(`/meetings/${m.id}/participants`, { method: 'PUT', body: { participants: get() } }); mm.close(); toast('تم تحديث المشاركين'); reload('attendance'); } catch (e) { toast(e.message, 'err'); } };
}
export async function decisionModal(m, agendaItem, done) {
  const dir = await getDir();
  const mm = modal({ title: 'تسجيل قرار', body: `<form id="df"><div class="alert err form-error" hidden></div><div class="form-grid">${field('نص القرار', '<textarea name="text"></textarea>', { full: true, req: true })}${field('مسؤول التنفيذ', `<select name="owner_id">${empOpts(dir, agendaItem?.presenter_id)}</select>`, { req: true })}${field('تاريخ السريان / الإنجاز المتوقع', '<input type="date" name="effective_date">')}${field('بند الأجندة', `<select name="agenda_item_id">${opts(m.agenda.map(a => [a.id, `${a.seq}. ${a.topic}`]), agendaItem?.id, 'بدون')}</select>`, { full: true })}</div><p class="small muted">الترقيم تلقائي بصيغة DEC-YYYY-####.</p></form>`, footer: '<button class="btn primary" data-ok>حفظ القرار</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => { const f = mm.$('#df'); const d = readForm(f); try { const r = await api(`/meetings/${m.id}/decisions`, { method: 'POST', body: { ...d, owner_id: d.owner_id ? Number(d.owner_id) : null, agenda_item_id: d.agenda_item_id ? Number(d.agenda_item_id) : null } }); mm.close(); toast(`تم تسجيل القرار ${r.code}`); done(r); } catch (e) { showErrors(f, e); } };
}
export async function taskModal(m, agendaItem, done) {
  const dir = await getDir();
  const due = new Date(); due.setDate(due.getDate() + 7); const dueS = due.toISOString().slice(0, 10);
  const mm = modal({ title: 'إضافة مهمة (Action Item)', wide: true, body: `<form id="tf"><div class="alert err form-error" hidden></div><div class="form-grid">${field('عنوان المهمة', '<input name="title">', { full: true, req: true })}${field('المسؤول', `<select name="owner_id">${empOpts(dir, agendaItem?.presenter_id)}</select>`, { req: true })}${field('تاريخ الاستحقاق', `<input type="date" name="due_date" value="${dueS}">`, { req: true })}${field('الأولوية', `<select name="priority">${opts(Object.entries(L.priority).map(([k, v]) => [k, v[0]]), 'high')}</select>`)}${field('القرار المرتبط', `<select name="decision_id">${opts(m.decisions.map(d => [d.id, `${d.code} — ${d.text.slice(0, 50)}`]), m.decisions.find(d => agendaItem && d.agenda_item_id === agendaItem.id)?.id, 'بدون')}</select>`)}${field('المراجع (للاعتماد)', `<select name="reviewer_id">${empOpts(dir, m.leader_id, 'المدير المباشر للمسؤول')}</select>`)}<div class="field"><label>خيارات</label><label class="check"><input type="checkbox" name="requires_approval" checked> تتطلب اعتماد الإنجاز</label><label class="check"><input type="checkbox" name="evidence_required"> تتطلب دليل إنجاز (Evidence)</label></div>${field('الوصف', '<textarea name="description"></textarea>', { full: true })}</div><p class="small muted">تظهر المهمة تلقائيًا في متتبع المهام مرتبطة بهذا الاجتماع${agendaItem?.related_kpi_id ? ' والمؤشر المرتبط بالبند' : ''}.</p></form>`, footer: '<button class="btn primary" data-ok>إنشاء المهمة</button><button class="btn" data-close>إلغاء</button>' });
  mm.$('[data-ok]').onclick = async () => {
    const f = mm.$('#tf'); const d = readForm(f);
    const body = { ...d, owner_id: d.owner_id ? Number(d.owner_id) : null, reviewer_id: d.reviewer_id ? Number(d.reviewer_id) : null, decision_id: d.decision_id ? Number(d.decision_id) : null, meeting_id: m.id, agenda_item_id: agendaItem?.id || null, kpi_id: agendaItem?.related_kpi_id || null, source: agendaItem?.related_kpi_id ? 'corrective_action' : 'meeting', start_date: todayStr() };
    if (body.reviewer_id && body.reviewer_id === body.owner_id) body.reviewer_id = null;
    try { const r = await api('/tasks', { method: 'POST', body }); mm.close(); toast(`تم إنشاء المهمة ${r.code} وإسنادها`); done(r); } catch (e) { showErrors(f, e); }
  };
}

// ======================= الجلسة الحية =======================
async function live(ctx) {
  const { el, params } = ctx;
  let m = await api('/meetings/' + params[0]);
  if (m.status !== 'live') { el.innerHTML = state('empty', 'الاجتماع ليس جاريًا الآن', `حالة الاجتماع: ${L.meetingStatus[m.status][0]}`, `<a class="btn primary" href="#/meetings/${m.id}">صفحة الاجتماع</a>`); return; }
  if (!m.is_editor) { location.hash = `#/meetings/${m.id}`; return; }
  let curId = (m.agenda.find(a => a.status === 'discussing') || m.agenda.find(a => a.status === 'pending') || m.agenda[0] || {}).id;
  const refresh = async () => { m = await api('/meetings/' + m.id); draw(); };
  const draw = () => {
    const cur = m.agenda.find(a => a.id === curId);
    const done = m.agenda.filter(a => a.status === 'completed').length;
    const attended = m.participants.filter(p => p.attendance === 'attended').length;
    const curDec = cur ? m.decisions.filter(d => d.agenda_item_id === cur.id) : []; const curTasks = cur ? m.tasks.filter(t => t.agenda_item_id === cur.id) : [];
    el.innerHTML = `<div class="live-head"><div style="flex:1;min-width:220px"><div class="row small" style="opacity:.85"><span class="live-dot"></span> جارٍ الآن · ${ltr(m.code)}</div><h2>${esc(m.title)}</h2><div class="small" style="opacity:.8">التقدم: ${done} من ${m.agenda.length} بنود · الحضور ${attended}/${m.participants.length}</div></div>
      <div style="text-align:center"><div class="timer" id="timer">00:00</div><div class="tiny" style="opacity:.75">المدة المخططة <bdi class="num">${m.duration_min}</bdi> د</div></div>
      <div class="row"><a class="btn" style="background:#fff;color:#10193a" href="#/meetings/${m.id}">صفحة الاجتماع</a><button class="btn danger" style="background:#fff" data-act="end">إنهاء الاجتماع</button></div></div>
      <div style="margin-top:12px">${'<div class="bar"><i style="width:' + (m.agenda.length ? done / m.agenda.length * 100 : 0) + '%"></i></div>'}</div>
      <div class="live-grid">
        <section class="card"><header><h3>جدول الأعمال</h3></header><div class="agenda">${m.agenda.map(a => `<div class="ag ${a.id === curId ? 'cur' : ''} ${a.status === 'completed' ? 'done' : ''}" data-act="pick" data-id="${a.id}" role="button" tabindex="0"><span class="no"><bdi class="num">${a.seq}</bdi></span><div style="flex:1;min-width:0"><b class="small">${esc(a.topic)}</b><div class="row" style="gap:4px;margin-top:4px">${lp(L.agenda, a.status)}<span class="tiny muted"><bdi class="num">${a.est_min}</bdi> د</span></div></div></div>`).join('')}</div>
          <button class="btn sm" style="margin-top:10px;width:100%" data-act="addItem">${icon('plus')} بند طارئ</button></section>
        <section class="card">${cur ? `<header><h3>البند ${cur.seq}: ${esc(cur.topic)}</h3>${lp(L.agenda, cur.status)}</header>
          <div class="small muted">${cur.presenter_name ? 'المقدم: ' + esc(cur.presenter_name) + ' · ' : ''}${esc(L.agendaType[cur.type])}${cur.kpi_name ? ` · KPI: <a href="#/kpis/${cur.related_kpi_id}">${esc(cur.kpi_name)}</a>` : ''}</div>
          ${cur.objective ? `<p class="small" style="margin:6px 0 0">الهدف: ${esc(cur.objective)}</p>` : ''}${cur.required_decision ? `<p class="small" style="margin:2px 0 0"><b>القرار المطلوب:</b> ${esc(cur.required_decision)}</p>` : ''}
          <div class="field" style="margin-top:12px"><label for="notes">ملاحظات النقاش</label><textarea id="notes" rows="5" placeholder="تُحفظ تلقائيًا عند الخروج من الحقل">${esc(cur.discussion_notes || '')}</textarea></div>
          <div class="row" style="margin-top:12px">${cur.status !== 'discussing' ? '<button class="btn primary" data-act="st" data-v="discussing">بدء مناقشة البند</button>' : ''}<button class="btn" data-act="st" data-v="completed">${icon('check')} إكمال البند</button><button class="btn" data-act="st" data-v="deferred">تأجيل</button><span style="flex:1"></span><button class="btn primary" data-act="dec">${icon('plus')} قرار</button><button class="btn primary" data-act="task">${icon('plus')} مهمة</button></div>
          <h3 style="margin:18px 0 6px">قرارات هذا البند</h3>${curDec.length ? `<div class="list">${curDec.map(d => `<div class="item"><div class="grow"><span class="t">${esc(d.text)}</span><span class="small muted">${ltr(d.code)} · ${esc(d.owner_name)}</span></div></div>`).join('')}</div>` : empty('لم تُسجل قرارات.')}
          <h3 style="margin:14px 0 6px">مهام هذا البند</h3>${curTasks.length ? `<div class="list">${curTasks.map(t => `<div class="item"><div class="grow"><span class="t">${esc(t.title)}</span><span class="small muted">${esc(t.owner_name)} · ${fdate(t.due_date)}</span></div></div>`).join('')}</div>` : empty('لم تُسجل مهام.')}`
          : state('empty', 'لا توجد بنود', 'أضف بندًا طارئًا للبدء.')}</section>
        <section class="stack"><div class="card"><header><h3>الحضور</h3><span class="muted small more">${attended}/${m.participants.length}</span></header><div class="list">${m.participants.map(p => `<div><div class="row spread"><b class="small">${esc(p.name)}</b>${p.attendance ? lp(L.attendance, p.attendance) : '<span class="tiny muted">لم يُسجل</span>'}</div><div class="row" style="gap:4px;margin-top:6px">${attButtons(p, m)}</div></div>`).join('')}</div></div>
          <div class="card"><header><h3>ملخص الجلسة</h3></header><dl class="kv"><dt>القرارات</dt><dd>${m.decisions.length}</dd><dt>المهام</dt><dd>${m.tasks.length}</dd><dt>المؤجل</dt><dd>${m.agenda.filter(a => a.status === 'deferred').map(a => esc(a.topic)).join('، ') || '—'}</dd></dl></div></section>
      </div>`;
    const start = new Date(m.started_at); const tick = () => { const t = document.getElementById('timer'); if (!t) return clearInterval(iv); const s = Math.max(0, Math.floor((Date.now() - start) / 1000)); t.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; t.style.color = s / 60 > m.duration_min ? '#fca5a5' : ''; };
    clearInterval(window.__liveTimer); const iv = window.__liveTimer = setInterval(tick, 1000); tick();
    const notes = document.getElementById('notes'); if (notes) notes.addEventListener('change', async () => { await api(`/agenda/${curId}/live`, { method: 'PUT', body: { discussion_notes: notes.value } }).then(() => toast('حُفظت الملاحظات')).catch(e => toast(e.message, 'err')); const a = m.agenda.find(x => x.id === curId); if (a) a.discussion_notes = notes.value; });
  };
  draw();
  wire(el, {
    pick: b => { curId = Number(b.dataset.id); draw(); },
    st: async b => { const v = b.dataset.v; const notes = document.getElementById('notes')?.value; await api(`/agenda/${curId}/live`, { method: 'PUT', body: { status: v, discussion_notes: notes } }); if (v !== 'discussing') { const nxt = m.agenda.find(a => a.id !== curId && a.status === 'pending'); await refresh(); if (nxt) { curId = nxt.id; draw(); } toast(v === 'completed' ? 'اكتمل البند' : 'تم تأجيل البند'); } else await refresh(); },
    att: async b => { await api(`/meetings/${m.id}/attendance/${b.dataset.e}`, { method: 'PUT', body: { attendance: b.dataset.v, attendance_mode: b.dataset.mode || undefined } }); await refresh(); },
    dec: () => decisionModal(m, m.agenda.find(a => a.id === curId), refresh),
    task: () => taskModal(m, m.agenda.find(a => a.id === curId), refresh),
    addItem: () => agendaModal(m, null, async () => { await refresh(); }),
    end: async () => {
      if (!await confirmBox('إنهاء الاجتماع', 'البنود التي لم تبدأ ستُسجل كمؤجلة. تأكد من تسجيل حضور المشاركين.', 'إنهاء الاجتماع')) return;
      await api(`/meetings/${m.id}/transition`, { method: 'POST', body: { to: 'minutes_draft' } }); clearInterval(window.__liveTimer); toast('انتهى الاجتماع. أكمل المحضر.'); location.hash = `#/meetings/${m.id}?tab=minutes`;
    },
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.act === 'pick') e.target.click(); });
}

// ======================= القرارات =======================
async function decisions(ctx) {
  const { el, query } = ctx;
  const rows = await api('/decisions' + qs({ status: query.status }));
  el.innerHTML = `${pageHead('القرارات', 'سجل القرارات الصادرة عن الاجتماعات ضمن صلاحياتك، وحالة تنفيذها.', '', '<a href="#/meetings">الاجتماعات</a>')}
   <div class="filters"><div class="seg">${[['', 'الكل'], ['open', 'مفتوح'], ['in_progress', 'قيد التنفيذ'], ['implemented', 'منفّذ'], ['closed', 'مغلق']].map(([k, l]) => `<button class="${(query.status || '') === k ? 'on' : ''}" data-act="st" data-v="${k}">${l}</button>`).join('')}</div></div>
   ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>القرار</th><th>الاجتماع</th><th>المسؤول</th><th>السريان</th><th>المهام</th><th>الحالة</th></tr></thead><tbody>${rows.map(d => `<tr class="link" data-href="#/decisions/${d.id}"><td><div class="title">${esc(d.text)}</div><div class="sub">${ltr(d.code)}</div></td><td class="small">${esc(d.meeting_title)}</td><td>${esc(d.owner_name)}</td><td>${d.effective_date ? fdate(d.effective_date) : '—'}${d.overdue ? '<div class="sub" style="color:var(--red)">متأخر التنفيذ</div>' : ''}</td><td><bdi class="num">${d.tasks_done}/${d.tasks_total}</bdi></td><td>${lp(L.decision, d.status)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card">${state('empty', 'لا توجد قرارات', 'تُسجل القرارات أثناء الاجتماعات.')}</div>`}`;
  wire(el, { st: b => { location.hash = '#/decisions' + qs({ status: b.dataset.v }); } });
}
async function decisionDetail(ctx) {
  const { el, params } = ctx;
  const d = await api('/decisions/' + params[0]); const tr = await api('/trace/decision/' + d.id).catch(() => null);
  const labels = { in_progress: 'بدء التنفيذ', implemented: 'تم التنفيذ', open: 'إعادة فتح', closed: 'إغلاق القرار', cancelled: 'إلغاء' };
  el.innerHTML = `${pageHead(d.code, `قرار صادر عن <a href="#/meetings/${d.meeting.id}">${esc(d.meeting.title)}</a> · ${fdate(d.decision_date)}`, d.can_edit ? d.allowed.map(s => `<button class="btn ${s === 'implemented' ? 'primary' : s === 'cancelled' ? 'danger' : ''}" data-act="st" data-v="${s}">${labels[s]}</button>`).join('') : '', '<a href="#/decisions">القرارات</a>')}
   <div class="grid g-main"><div class="stack"><div class="card"><header><h3>نص القرار</h3>${lp(L.decision, d.status)}</header><p style="font-size:16px;margin:0">${esc(d.text)}</p>${d.evidence ? `<div class="alert ok small" style="margin-top:12px">دليل التنفيذ: ${esc(d.evidence)}</div>` : ''}</div>
     <div class="card"><header><h3>المسار الإداري</h3></header>${tr ? traceView(tr) : ''}</div>
     <div class="card"><header><h3>المهام التنفيذية</h3></header>${d.tasks.length ? `<div class="list">${d.tasks.map(t => `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><span class="small muted">${esc(t.owner_name)} · ${fdate(t.due_date)}</span></div>${lp(L.taskStatus, t.status)}</a>`).join('')}</div>` : empty('لا توجد مهام مرتبطة. أنشئ مهمة من صفحة الاجتماع لربط التنفيذ بالقرار.')}</div></div>
   <div class="card"><dl class="kv"><dt>المسؤول</dt><dd>${esc(d.owner_name)}</dd><dt>الإدارة المسؤولة</dt><dd>${esc(d.dept_name || '—')}</dd><dt>السريان</dt><dd>${d.effective_date ? fdate(d.effective_date) : '—'}</dd><dt>البند</dt><dd>${d.agenda ? esc(d.agenda.topic) : '—'}</dd><dt>السرية</dt><dd>${d.confidentiality === 'board' ? 'Board' : d.confidentiality === 'confidential' ? 'سرّي' : 'عادي'}</dd></dl></div></div>`;
  wire(el, { st: async b => { const v = b.dataset.v; let evidence, reason; if (v === 'implemented') { evidence = await promptBox('دليل التنفيذ', 'صف ما تم تنفيذه والدليل (مستند، رقم، نتيجة)'); if (!evidence) return; } if (v === 'cancelled') { reason = await promptBox('إلغاء القرار', 'السبب'); if (!reason) return; } await api(`/decisions/${d.id}`, { method: 'PUT', body: { status: v, evidence, reason } }); toast('تم تحديث القرار'); ctx.reload(); } });
}
