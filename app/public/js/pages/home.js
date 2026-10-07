import { $, rich, ltr, esc, api, icon, L, lp, pill, num, pct, bar, ring, delta, stat, state, errorState, wire, fdate, ftime, money, compact, dot, scoreCls, toast, hbars, ApiError } from '../core.js';
import { meetingCard, taskItem, kpiRow, empty, pageHead } from '../ui.js';

const greet = () => { const h = new Date().getHours(); return h < 12 ? 'صباح الخير' : h < 18 ? 'مساء الخير' : 'مساء النور'; };

export async function render({ el, me }) {
  const d = await api('/home');
  if (d.admin) return renderAdmin(el, me, d);
  const parts = [];
  parts.push(pageHead(`${greet()}، ${me.name.replace(/^د\.\s*/, 'د. ').split(' ').slice(0, me.name.startsWith('د.') ? 2 : 1).join(' ')}`, `${esc(L.role[me.system_role])} · ${esc(me.dept || me.org_unit || '')} — ${fdate(d.date)}`));
  if (d.executive) parts.push(execBlock(d));
  if (d.manager) parts.push(managerBlock(d, me));
  parts.push(personal(d, me, !!(d.executive || d.manager)));
  el.innerHTML = `<div class="stack" style="gap:20px">${parts.join('')}</div>`;
  wire(el, { markall: async () => { await api('/notifications/read', { method: 'POST', body: { all: true } }); toast('تم تعليم الإشعارات كمقروءة'); await render({ el, me }); } });
}

function hero(d) {
  const m = d.next_meeting;
  if (!m) return `<div class="card">${state('empty', 'لا توجد اجتماعات قادمة', 'عند دعوتك لاجتماع سيظهر هنا مع حزمة التحضير ورابط الانضمام.', '<a class="btn" href="#/meetings">استعراض الاجتماعات</a>')}</div>`;
  const today = m.meeting_date === d.date;
  return `<div class="card hero"><div style="flex:1;min-width:240px"><div class="row"><span class="pill nodot" style="background:rgba(255,255,255,.18);color:#fff">${today ? 'اجتماعك القادم اليوم' : 'اجتماعك القادم'}</span>${m.status === 'live' ? '<span class="pill red">جارٍ الآن</span>' : ''}</div>
    <h2 style="margin:8px 0 4px">${esc(m.title)}</h2>
    <div class="meta">${fdate(m.meeting_date)} · ${ftime(m.start_time)} · ${m.duration_min} دقيقة · ${esc(L.mode[m.mode])}${m.location ? ' · ' + esc(m.location) : ''}</div>
    <div class="meta" style="margin-top:4px">القائد: ${esc(m.leader_name)} · حزمة التحضير: ${esc(L.prep[m.prep_state]?.[0] || '')}</div></div>
    <div class="row">${m.can_join ? `<a class="btn big" href="#/meetings/${m.id}?join=1" data-join="${m.id}">${icon('video')} انضمام للاجتماع</a>` : ''}${m.status === 'live' && (m.is_leader || m.is_secretary) ? `<a class="btn big" href="#/meetings/${m.id}/live">${icon('play')} فتح الجلسة الحية</a>` : ''}<a class="btn line big" href="#/meetings/${m.id}">${icon('file')} ${m.prep_released ? 'قراءة التحضير' : 'تفاصيل الاجتماع'}</a></div></div>`;
}

function personal(d, me, secondary) {
  const open = d.tasks.open_count, over = d.tasks.overdue_count;
  const stats = `<div class="grid g4 keep2">${stat('اجتماعات اليوم', num(d.meetings_today.length), { sub: d.meetings_today.length ? 'يوجد اجتماع اليوم' : 'لا اجتماعات اليوم' })}${stat('مهامي المفتوحة', num(open), { href: '#/tasks', sub: 'اضغط للاستعراض' })}${stat('مهام متأخرة', `<span class="${over ? 'down' : ''}">${num(over)}</span>`, { href: '#/tasks?overdue=1', sub: over ? 'تحتاج إجراءً' : 'لا يوجد تأخير' })}${stat('تحديث KPI مطلوب', num(d.kpi_updates_required.length), { href: d.kpi_updates_required[0] ? `#/kpis/${d.kpi_updates_required[0].id}` : '#/kpis', sub: d.kpi_updates_required.length ? 'بيانات الفترة ناقصة أو Draft' : 'كل بياناتك محدّثة' })}</div>`;
  const left = `<div class="stack">
    ${d.meetings.length ? `<div class="card"><header><h3>اجتماعاتي القادمة</h3><a class="more" href="#/meetings">عرض الكل</a></header><div class="list">${d.meetings.slice(0, 4).map(m => meetingCard(m)).join('')}</div></div>` : ''}
    ${d.prep_to_review.length ? `<div class="card"><header><h3>تحضير يحتاج مراجعتك</h3></header><div class="list">${d.prep_to_review.map(m => `<a class="item" href="#/meetings/${m.id}"><div class="grow"><span class="t">${esc(m.title)}</span><span class="small muted">${fdate(m.meeting_date)} · ${ftime(m.start_time)}</span></div>${pill('اقرأ الحزمة', 'blue')}</a>`).join('')}</div></div>` : ''}
    <div class="card"><header><h3>مهامي</h3><a class="more" href="#/tasks">عرض الكل</a></header>${d.tasks.open.length ? `<div class="list">${d.tasks.open.map(t => taskItem({ ...t })).join('')}</div>` : state('empty', 'لا توجد مهام مفتوحة', 'عندما تُسند إليك مهمة ستظهر هنا.')}</div>
    ${d.tasks.to_review.length ? `<div class="card"><header><h3>بانتظار مراجعتي</h3></header><div class="list">${d.tasks.to_review.map(t => `<a class="item" href="#/tasks/${t.id}"><div class="grow"><span class="t">${esc(t.title)}</span><span class="small muted">${esc(t.owner_name)}</span></div>${pill('راجع', 'purple')}</a>`).join('')}</div></div>` : ''}
  </div>`;
  const p = d.performance;
  const right = `<div class="stack">
    <div class="card"><header><h3>أدائي — الفترة ${ltr(p.period_key)}</h3><a class="more" href="#/performance">التفاصيل</a></header>
      <div class="row" style="gap:16px">${ring(p.calculated_score)}<div><div class="b">الدرجة المحسوبة</div><div class="small">${delta(p.calculated_score, p.previous)}</div><div class="tiny muted" style="margin-top:6px">لا تشمل تقييم المدير قبل الاعتماد.</div></div></div>
      <div style="margin-top:14px">${p.components.filter(c => c.score !== null).map(c => `<div class="row spread small" style="margin:6px 0 2px"><span>${esc(c.label)}</span><b>${num(c.score)}</b></div>${bar(c.score, scoreCls(c.score))}`).join('') || empty('لا توجد بيانات كافية لاحتساب الأداء بعد.')}</div></div>
    <div class="card"><header><h3>مؤشراتي</h3><a class="more" href="#/kpis">الكل</a></header>${d.my_kpis.length ? `<div class="list">${d.my_kpis.slice(0, 5).map(kpiRow).join('')}</div>` : state('empty', 'لا توجد مؤشرات مسندة إليك', 'يسندها لك مديرك من وحدة المؤشرات.')}</div>
    <div class="card"><header><h3>Check-in الشهري</h3></header>${d.checkin.status === 'none' ? `<p class="small muted" style="margin:0 0 10px">لم تبدأ Check-in هذه الفترة. شارك إنجازاتك وما تحتاجه من دعم.</p><a class="btn primary sm" href="#/performance">ابدأ الآن</a>` : `<p style="margin:0">${lp({ draft: ['مسودة', 'amber'], submitted: ['أُرسل للمدير', 'blue'], reviewed: ['تمت المراجعة', 'green'] }, d.checkin.status)}</p>`}</div>
    <div class="card"><header><h3>الإشعارات ${d.unread ? `<span class="pill red nodot">${d.unread}</span>` : ''}</h3><a class="more" href="#/notifications">الكل</a></header>${d.notifications.length ? `<div class="list">${d.notifications.map(n => `<a class="item" href="${esc(n.link || '#/notifications')}"><div class="grow"><span class="t" style="${n.read_at ? 'font-weight:500' : ''}">${esc(n.title)}</span>${n.body ? `<span class="small muted">${esc(n.body)}</span>` : ''}</div>${n.read_at ? '' : '<span class="dotc red" style="margin-top:8px"></span>'}</a>`).join('')}</div>` : empty('لا توجد إشعارات.')}</div>
  </div>`;
  const sect = secondary ? `<details class="acc" open><summary>${icon('user')} عملي الشخصي</summary><div class="in stack" style="gap:20px">${hero(d)}${stats}<div class="grid g-main">${left}${right}</div></div></details>` : `${hero(d)}${stats}<div class="grid g-main">${left}${right}</div>`;
  return sect;
}

function managerBlock(d, me) {
  const m = d.manager;
  return `<section class="stack"><h2>${icon('users')} فريقي</h2>
  <div class="grid g4 keep2">${stat('أداء الفريق', m.team_score === null ? '—' : num(m.team_score), { href: '#/performance/team', sub: `${m.team_count} موظفين مباشرين` })}${stat('يحتاجون انتباهًا', `<span class="${m.needs_attention.length ? 'down' : ''}">${num(m.needs_attention.length)}</span>`, { sub: 'درجة منخفضة أو تأخر أو KPI أحمر' })}${stat('مراجعات معلّقة', num(m.pending_checkins + d.tasks.to_review.length), { sub: `${m.pending_checkins} Check-in · ${d.tasks.to_review.length} مهام` })}${stat('تقييمات لم تبدأ', num(m.pending_assessments), { href: '#/performance/team', sub: 'للفترة المنتهية' })}</div>
  <div class="grid g3">
    <div class="card"><header><h3>موظفون يحتاجون انتباهًا</h3></header>${m.needs_attention.length ? `<div class="list">${m.needs_attention.map(e => `<a class="item" href="#/performance/employee/${e.id}"><div class="grow"><span class="t">${esc(e.name)}</span><span class="small muted">${esc(e.attention.join(' · '))}</span></div><b>${e.score === null ? '—' : num(e.score)}</b></a>`).join('')}</div>` : empty('لا يوجد موظفون بحاجة لتدخل الآن.')}</div>
    <div class="card"><header><h3>مهام الفريق المتأخرة</h3><a class="more" href="#/tasks?view=team&overdue=1">الكل</a></header>${m.overdue_team_tasks.length ? `<div class="list">${m.overdue_team_tasks.map(t => taskItem({ ...t, status: 'in_progress', overdue: true }, { owner: true })).join('')}</div>` : empty('لا توجد مهام متأخرة لدى الفريق.')}</div>
    <div class="card"><header><h3>مؤشرات حمراء ضمن نطاقي</h3><a class="more" href="#/kpis">الكل</a></header>${m.red_kpis.length ? `<div class="list">${m.red_kpis.map(k => `<a class="item" href="#/kpis/${k.id}"><span style="padding-top:7px">${dot('red')}</span><div class="grow"><span class="t">${esc(k.name)}</span><span class="small muted">${ltr(k.period_key)}</span></div><b>${pct(k.achievement)}</b></a>`).join('')}</div>` : empty('لا توجد مؤشرات حمراء.')}</div>
  </div>
  ${m.team_meetings.length ? `<div class="card"><header><h3>اجتماعات الفريق القادمة</h3></header><div class="list">${m.team_meetings.map(x => meetingCard(x)).join('')}</div></div>` : ''}</section>`;
}

function execBlock(d) {
  const x = d.executive; const k = x.kpi; const tot = k.total || 1; const f = x.financial;
  return `<section class="stack"><h2>${icon('perf')} ${esc(x.scope_name)} — الصورة الإدارية</h2>
  <div class="grid g4 keep2">
    <div class="card stat"><span class="lbl">الأداء العام (${ltr(d.period_key)})</span><div class="row" style="gap:12px;flex-wrap:nowrap">${ring(x.performance.score)}<div class="small">${delta(x.performance.score, x.performance.previous)}</div></div></div>
    ${stat('تحقق الإيرادات', f ? pct(f.achievement) : '—', { href: '#/targets', sub: f ? `${compact(f.revenue_actual)} من ${compact(f.revenue_target)} جنيه · ${f.major} انحرافات كبيرة` : 'غير متاح' })}
    <div class="card stat clickable" data-href="#/kpis"><span class="lbl">تحقق مؤشرات الأداء</span><span class="val">${pct(k.avg_achievement)}</span><div style="display:flex;height:8px;border-radius:99px;overflow:hidden;margin:6px 0"><i style="flex:${k.green};background:var(--green)"></i><i style="flex:${k.amber};background:#d97706"></i><i style="flex:${k.red};background:var(--red)"></i></div><span class="delta">${k.green} أخضر · ${k.amber} أصفر · ${k.red} أحمر</span></div>
    ${stat('إنجاز المهام', pct(x.tasks.completion_pct), { sub: `في الموعد ${pct(x.tasks.on_time_pct)} · متأخرة ${x.tasks.overdue}` })}
  </div>
  <div class="grid g-main">
    <div class="card"><header><h3>Management Attention — ما يحتاج قرارك</h3><a class="more" href="#/attention">كل البنود (${x.attention_total})</a></header>
      ${x.attention_top.length ? `<div class="list">${x.attention_top.map(i => `<a class="item" href="${i.source.type === 'kpi' ? '#/kpis/' + i.source.id : i.source.type === 'task' ? '#/tasks/' + i.source.id : i.source.type === 'decision' ? '#/decisions/' + i.source.id : '#/attention'}"><div class="grow"><span class="t">${esc(i.title)}</span><span class="small muted">${rich(i.detail)}</span></div>${lp(L.sev, i.severity)}</a>`).join('')}</div>` : state('empty', 'لا توجد استثناءات', 'كل المؤشرات والمهام ضمن المسار الطبيعي.')}</div>
    <div class="stack">
      <div class="card"><header><h3>مقارنة وحدات النشاط</h3><a class="more" href="#/performance/org">التفاصيل</a></header>${x.bu.length ? hbars(x.bu.map(b => ({ label: b.name, value: b.score }))) : empty('لا توجد وحدات.')}</div>
      <div class="card"><header><h3>تنفيذ القرارات</h3></header><div class="row spread"><div><span class="val" style="font-size:28px;font-weight:700">${pct(x.decisions.executed_pct)}</span><div class="small muted">${x.decisions.total} قرارات · ${x.decisions.unimplemented} متأخرة التنفيذ</div></div><a class="btn sm" href="#/decisions">القرارات</a></div></div>
      <div class="card"><header><h3>مبادرات معرضة للخطر</h3></header>${x.initiatives_at_risk.length ? `<div class="list">${x.initiatives_at_risk.map(i => `<a class="item" href="#/initiatives/${i.id}"><div class="grow"><span class="t">${esc(i.title)}</span><span class="small muted">التقدم ${i.progress}%</span></div>${pill('At Risk', 'red')}</a>`).join('')}</div>` : empty('لا توجد مبادرات معرضة للخطر.')}</div>
    </div></div></section>`;
}

function renderAdmin(el, me, d) {
  const a = d.admin;
  el.innerHTML = `<div class="stack">${pageHead('لوحة مدير النظام', 'إدارة الحسابات والصلاحيات والتكاملات. لا تتضمن بيانات أداء الموظفين أو محاضر الاجتماعات حسب سياسة الفصل بين المهام.')}
    <div class="grid g3">${stat('مستخدمون يمكنهم الدخول', num(a.users))}${stat('موظفون نشطون', num(a.employees))}${stat('أحداث تدقيق اليوم', num(a.audit_today), { href: '#/admin/audit' })}</div>
    <div class="card"><header><h3>حالة التكاملات</h3></header><div class="tablewrap"><table><thead><tr><th>التكامل</th><th>الحالة</th><th>ملاحظة</th></tr></thead><tbody>${a.integrations.map(i => `<tr><td class="title">${esc(i.name)}</td><td>${lp(L.integ, i.state)}</td><td class="small muted">${esc(i.note)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
}
