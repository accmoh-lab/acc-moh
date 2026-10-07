import { $, $$, esc, api, qs, icon, L, lp, pill, num, pct, ltr, fdate, fdatetime, state, wire, toast, modal, promptBox, confirmBox, readForm, showErrors, field, opts, bar, ring, delta, scoreCls, lineChart, hbars, dot } from '../core.js';
import { pageHead, tabs, getOrg, empty } from '../ui.js';

export async function render(ctx) {
  const n = ctx.name;
  if (n === 'perf_me') return employee(ctx, ctx.me.id, true);
  if (n === 'perf_employee') return employee(ctx, Number(ctx.params[0]), false);
  if (n === 'perf_team') return team(ctx);
  if (n === 'perf_org') return org(ctx);
  if (n === 'perf_periods') return periodsPage(ctx);
  if (n === 'perf_scorecards') return scorecards(ctx);
}
const periodSel = (list, cur) => `<div class="field"><label for="pp">الفترة</label><select id="pp">${opts(list.filter(p => p.kind === 'monthly').map(p => [p.key, `${p.label} — ${L.period[p.status][0]}`]), cur)}</select></div>`;
const bindPeriod = (el, base) => { const s = $('#pp', el); if (s) s.onchange = () => { location.hash = base + qs({ period: s.value }); }; };

function breakdown(sc, hideMgr) {
  return `<div class="tablewrap breakdown"><table><thead><tr><th>المكوّن</th><th>الوزن</th><th>الدرجة</th><th style="width:34%"></th><th>التفاصيل</th></tr></thead><tbody>${sc.components.map(c => {
    const d = c.detail || {}; const det = c.key.startsWith('kpi_') ? `${d.counted ?? 0}/${d.total ?? 0} مؤشرات بيانات معتمدة` : c.key === 'tasks' || c.key === 'meeting_actions' ? `${d.total || 0} مهمة · ${d.on_time || 0} في الموعد · ${d.late || 0} متأخرة الإنجاز · ${d.overdue || 0} متأخرة مفتوحة` : c.key === 'initiatives' ? `${d.count || 0} مبادرة` : c.key === 'manager_assessment' ? (hideMgr ? 'يظهر بعد الاعتماد النهائي' : (d.stage ? L.stage[d.stage] : 'لم يُقيَّم بعد')) : '';
    return `<tr${c.weight === 0 ? ' style="opacity:.5"' : ''}><td class="b">${esc(c.label)}</td><td><bdi class="num">${c.weight}%</bdi></td><td>${c.score === null ? '<span class="muted">غير متاح</span>' : `<b>${num(c.score)}</b>`}</td><td>${c.score === null ? '' : bar(Math.min(100, c.score), scoreCls(c.score))}</td><td class="small muted">${esc(det)}</td></tr>`; }).join('')}</tbody></table></div>
    <p class="small muted">المكونات غير المتاحة تُستبعد ويُعاد توزيع وزنها نسبيًا. الأوزان مصدرها: ${esc(sc.weights_source || '')}. ${sc.source === 'snapshot' ? `<b>هذه نتيجة محفوظة (Snapshot v${sc.snapshot_version}) وقت الإقفال ولا تتغير بتغيّر الإعدادات.</b>` : 'نتيجة محسوبة حيًا من البيانات الحالية.'}</p>`;
}
function kpiTable(sc) {
  const rows = sc.components.filter(c => c.key.startsWith('kpi_')).flatMap(c => (c.detail?.kpis || []));
  if (!rows.length) return empty('لا توجد مؤشرات مسندة.');
  return `<div class="tablewrap"><table><thead><tr><th>المؤشر</th><th>المستهدف</th><th>الفعلي</th><th>الإنجاز</th><th>الوزن</th><th>البيانات</th></tr></thead><tbody>${rows.map(k => `<tr class="link" data-href="#/kpis/${k.id}"><td><span class="row" style="gap:8px;flex-wrap:nowrap">${dot(k.status)}<span class="title">${esc(k.name)}</span></span></td><td>${num(k.target)} <span class="tiny muted">${esc(k.unit || '')}</span></td><td>${num(k.actual)}</td><td>${pct(k.achievement)}</td><td>${num(k.weight)}</td><td>${k.counted ? lp(L.quality, k.quality) : `<span class="small muted">${esc(k.excluded_reason)}</span>`}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- أدائي / أداء موظف ----------
async function employee(ctx, id, self) {
  const { el, me, query } = ctx;
  if (me.is_admin) { el.innerHTML = state('lock', 'لا توجد بيانات أداء لحساب مدير النظام', 'بيانات الأداء منفصلة عن صلاحيات إدارة النظام.'); return; }
  const [d, pers] = await Promise.all([api(`/performance/${self ? 'me' : 'employee/' + id}` + qs({ period: query.period })), api('/periods')]);
  const sc = d.scorecard; const a = d.assessment; const own = d.employee.id === me.id;
  const hideMgr = own && !d.can_review && !(a && a.stage === 'final_approved');
  const checkins = own ? await api('/checkins') : d.can_review ? await api('/checkins' + qs({ employee_id: id })) : [];
  const curCi = checkins.find(c => c.period_key === sc.period.key);
  el.innerHTML = `${pageHead(own ? 'أدائي' : `أداء: ${d.employee.name}`, `${esc(d.employee.job_title)} · ${esc(d.employee.org_name || '')}`, '', own ? '' : '<a href="#/performance/team">فريقي</a>')}
   <div class="filters">${periodSel(pers, sc.period.key)}${sc.period.status ? lp(L.period, sc.period.status) : ''}</div>
   <div class="grid g3" style="margin-bottom:16px">
     <div class="card stat"><span class="lbl">الدرجة المحسوبة (Calculated)</span><div class="row" style="flex-wrap:nowrap">${ring(sc.calculated_score)}<div class="small">${delta(sc.calculated_score, d.previous.calculated_score)}<div class="tiny muted">من المؤشرات والمهام والمبادرات فقط</div></div></div></div>
     <div class="card stat"><span class="lbl">تقييم المدير (Manager Assessment)</span><span class="val">${hideMgr ? '<span class="muted" style="font-size:16px">يظهر بعد الاعتماد</span>' : sc.manager_score === null ? '—' : num(sc.manager_score)}</span><span class="delta">${a ? esc(L.stage[a.stage] || '') : 'لم يبدأ التقييم'}</span></div>
     <div class="card stat"><span class="lbl">التقييم النهائي المعتمد (Final Rating)</span><span class="val" style="font-size:20px">${a && a.final_rating && a.stage === 'final_approved' ? esc(a.final_rating) : '<span class="muted">لم يُعتمد بعد</span>'}</span><span class="delta">${!hideMgr && sc.suggested_rating ? `مقترح النظام: ${esc(sc.suggested_rating)}` : 'منفصل عن الدرجة المحسوبة'}</span></div></div>
   <div class="grid g-main"><div class="stack">
     <div class="card"><header><h3>تفصيل الدرجة (Breakdown)</h3></header>${breakdown(sc, hideMgr)}</div>
     <div class="card"><header><h3>المؤشرات</h3></header>${kpiTable(sc)}</div>
     ${d.history.length ? `<div class="card"><header><h3>الاتجاه عبر الفترات المقفلة</h3></header>${lineChart([{ data: d.history.map(h => h.calculated_score) }], { labels: d.history.map(h => h.key) })}</div>` : ''}
   </div><div class="stack">
     ${d.can_review ? assessmentCard(d, sc) : ''}
     ${own && a && a.stage === 'final_approved' ? `<div class="card"><header><h3>ملاحظات المدير المعتمدة</h3></header><p style="margin:0">${esc(a.feedback_for_employee || '—')}</p>${a.development_actions ? `<h3 style="margin-top:12px">إجراءات التطوير</h3><p style="margin:4px 0 0">${esc(a.development_actions)}</p>` : ''}</div>` : own && a ? `<div class="card"><header><h3>تقييم الفترة</h3></header><p class="small muted" style="margin:0">التقييم في مرحلة «${esc(L.stage[a.stage])}». تظهر الملاحظات بعد الاعتماد النهائي.</p></div>` : ''}
     ${own && d.development?.length ? `<div class="card"><header><h3>خطة التطوير</h3></header><div class="list">${d.development.map(x => `<div><b class="small">${esc(x.label)}</b><div class="small">${esc(x.development_actions)}</div></div>`).join('')}</div></div>` : ''}
     <div class="card"><header><h3>Check-in — ${ltr(sc.period.key)}</h3></header>${own ? checkinForm(curCi, sc.period.key) : curCi ? checkinView(curCi, d.can_review) : empty('لم يُرسل الموظف Check-in لهذه الفترة.')}</div>
     ${checkins.length > (curCi ? 1 : 0) ? `<div class="card"><header><h3>Check-ins سابقة</h3></header><div class="list">${checkins.filter(c => c !== curCi).map(c => `<div><div class="row spread"><b class="small">${ltr(c.period_key)}</b>${lp({ draft: ['مسودة', 'amber'], submitted: ['مرسل', 'blue'], reviewed: ['تمت المراجعة', 'green'] }, c.status)}</div><div class="small muted">${esc(c.achievements || '')}</div>${c.manager_comment ? `<div class="small">المدير: ${esc(c.manager_comment)}</div>` : ''}</div>`).join('')}</div></div>` : ''}
     <p class="tiny muted">لا يُعرض ترتيب الموظفين (Ranking). بيانات الأداء سرية ولا يراها المشاركون في الاجتماعات.</p>
   </div></div>`;
  bindPeriod(el, self ? '#/performance' : `#/performance/employee/${id}`);
  wire(el, {
    ci: async b => { const f = $('#cif', el); const body = { ...readForm(f), submit: b.dataset.v === 'submit' }; try { await api(`/checkins/me/${sc.period.key}`, { method: 'PUT', body }); toast(body.submit ? 'أُرسل الـCheck-in لمديرك' : 'تم حفظ المسودة'); ctx.reload(); } catch (e) { showErrors(f, e); } },
    cireview: async () => { const c = curCi; const mc = $('#mc', el).value, aa = $('#aa', el).value; await api(`/checkins/${c.id}/review`, { method: 'PUT', body: { manager_comment: mc, agreed_actions: aa } }); toast('تمت مراجعة الـCheck-in'); ctx.reload(); },
    asave: async () => { const f = $('#asf', el); const d2 = readForm(f); try { await api(`/assessments/${sc.period.key}/${d.employee.id}`, { method: 'PUT', body: { ...d2, manager_score: d2.manager_score === null ? null : Number(d2.manager_score) } }); toast('تم حفظ التقييم'); ctx.reload(); } catch (e) { showErrors(f, e); } },
    aadv: async () => { let final_rating; const sel = $('#frs', el); if (sel) final_rating = sel.value; const comment = await promptBox('نقل للمرحلة التالية', 'تعليق (اختياري)', { required: false }); if (comment === null) return; try { await api(`/assessments/${sc.period.key}/${d.employee.id}/advance`, { method: 'POST', body: { comment, final_rating } }); toast('تم نقل التقييم للمرحلة التالية'); ctx.reload(); } catch (e) { toast(e.message, 'err'); } },
    aret: async () => { const comment = await promptBox('إرجاع التقييم', 'سبب الإرجاع'); if (!comment) return; await api(`/assessments/${sc.period.key}/${d.employee.id}/return`, { method: 'POST', body: { comment } }); toast('أُعيد التقييم للمرحلة السابقة'); ctx.reload(); },
  });
}
function assessmentCard(d, sc) {
  const a = d.assessment || {}; const locked = ['approved', 'locked'].includes(sc.period.status); const final = a.stage === 'final_approved';
  const next = { manager_review: 'إرسال لمراجعة القسم', department_review: 'إرسال لمعايرة الإدارة', management_calibration: 'اعتماد نهائي' }[a.stage] || 'بدء';
  return `<div class="card"><header><h3>تقييم المدير — سرّي</h3>${a.stage ? pill(L.stage[a.stage], final ? 'green' : 'blue') : ''}</header>
   ${locked ? '<div class="alert info small">الفترة معتمدة/مقفلة؛ التعديل يتطلب إعادة فتحها.</div>' : ''}
   <form id="asf"><div class="stack" style="gap:10px">
    ${field('درجة المدير (0-100)', `<input name="manager_score" type="number" min="0" max="100" value="${a.manager_score ?? ''}" ${final || locked ? 'disabled' : ''}>`, { hint: `الدرجة المحسوبة للمرجعية: ${sc.calculated_score ?? '—'}` })}
    ${field('التقييم المقترح', `<select name="proposed_rating" ${final || locked ? 'disabled' : ''}>${opts((a.bands || ['يتجاوز التوقعات بشكل كبير', 'يتجاوز التوقعات', 'يحقق التوقعات', 'يحتاج إلى تحسين', 'دون التوقعات']).map(b => [b, b]), a.proposed_rating, 'اختر')}</select>`, { hint: 'التسميات قيم تجريبية تحتاج اعتماد سياسة التقييم' })}
    ${field('تعليق المدير الداخلي (لا يراه الموظف)', `<textarea name="manager_comment" ${final || locked ? 'disabled' : ''}>${esc(a.manager_comment || '')}</textarea>`)}
    ${field('ملاحظات للموظف (تظهر بعد الاعتماد)', `<textarea name="feedback_for_employee" ${final || locked ? 'disabled' : ''}>${esc(a.feedback_for_employee || '')}</textarea>`)}
    ${field('إجراءات التطوير', `<input name="development_actions" value="${esc(a.development_actions || '')}" ${final || locked ? 'disabled' : ''}>`)}
   </div></form>
   ${!final && !locked ? `<div class="row" style="margin-top:12px"><button class="btn" data-act="asave">حفظ</button>${a.stage ? `<button class="btn primary" data-act="aadv">${next}</button>` : ''}${a.stage && a.stage !== 'manager_review' ? '<button class="btn ghost" data-act="aret">إرجاع</button>' : ''}</div>${a.stage === 'management_calibration' ? `<div class="field" style="margin-top:10px"><label for="frs">التقييم النهائي المعتمد</label><select id="frs">${opts((a.bands || []).map(b => [b, b]), a.proposed_rating)}</select></div>` : ''}` : ''}
   ${a.trail?.length ? `<details class="acc" style="margin-top:12px"><summary>سجل المعايرة (Audit Trail)</summary><div class="in list">${a.trail.map(t => `<div class="small"><b>${esc(L.stage[t.stage] || t.stage)}</b> — ${esc(t.actor_name || '')} · ${fdatetime(t.created_at)}${t.comment ? `<div class="muted">${esc(t.comment)}</div>` : ''}</div>`).join('')}</div></details>` : ''}</div>`;
}
const checkinForm = (c, key) => c && c.status === 'reviewed' ? checkinView(c) : `<form id="cif"><div class="stack" style="gap:10px">${[['achievements', 'الإنجازات'], ['challenges', 'التحديات'], ['blockers', 'العوائق'], ['support_required', 'الدعم المطلوب'], ['employee_comment', 'تعليقي']].map(([k, l]) => field(l, `<textarea name="${k}" rows="2">${esc(c?.[k] || '')}</textarea>`)).join('')}</div></form><div class="row" style="margin-top:10px">${c?.status === 'submitted' ? '<span class="pill blue">أُرسل للمدير — يمكنك التحديث</span>' : ''}<button class="btn" data-act="ci" data-v="draft">حفظ مسودة</button><button class="btn primary" data-act="ci" data-v="submit">إرسال للمدير</button></div>`;
function checkinView(c, canReview) {
  return `<dl class="kv">${[['achievements', 'الإنجازات'], ['challenges', 'التحديات'], ['blockers', 'العوائق'], ['support_required', 'الدعم المطلوب'], ['employee_comment', 'تعليق الموظف'], ['manager_comment', 'تعليق المدير'], ['agreed_actions', 'الإجراءات المتفق عليها']].filter(([k]) => c[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(c[k])}</dd>`).join('')}</dl>
   ${canReview && c.status === 'submitted' ? `<div class="stack" style="gap:8px;margin-top:12px">${field('تعليق المدير', '<textarea id="mc" rows="2"></textarea>')}${field('الإجراءات المتفق عليها', '<input id="aa">')}<button class="btn primary" data-act="cireview">تمت المراجعة</button></div>` : ''}`;
}

// ---------- فريقي ----------
async function team(ctx) {
  const { el, query, me } = ctx;
  const [d, pers] = await Promise.all([api('/performance/team' + qs({ period: query.period, all: query.all })), api('/periods')]);
  const due = await api('/checkins-due').catch(() => []);
  el.innerHTML = `${pageHead('فريقي', `${d.count} موظف${query.all ? ' ضمن نطاق مراجعتك' : ' مباشر'}. لا يُعرض ترتيب تنافسي؛ الهدف تحديد من يحتاج دعمًا.`, `<a class="btn" href="#/tasks?view=team">مهام الفريق</a>${me.is_manager && me.system_role !== 'team_leader' ? `<a class="btn" href="#/performance/team${qs({ all: query.all ? '' : '1', period: query.period })}">${query.all ? 'المباشرون فقط' : 'كل نطاقي'}</a>` : ''}`)}
   <div class="filters">${periodSel(pers, d.period_key)}</div>
   <div class="grid g4 keep2" style="margin-bottom:16px">
     <div class="card stat"><span class="lbl">متوسط درجة الفريق</span><div class="row" style="flex-wrap:nowrap">${ring(d.team_score)}</div></div>
     <div class="card stat"><span class="lbl">يحتاجون انتباهًا</span><span class="val ${d.rows.some(r => r.attention.length) ? 'down' : ''}">${num(d.rows.filter(r => r.attention.length).length)}</span></div>
     <div class="card stat"><span class="lbl">مهام متأخرة لدى الفريق</span><span class="val">${num(d.rows.reduce((a, r) => a + r.overdue_tasks, 0))}</span></div>
     <div class="card stat"><span class="lbl">Check-ins بانتظار مراجعتي</span><span class="val">${num(due.length)}</span></div></div>
   ${d.rows.length ? `<div class="tablewrap"><table><thead><tr><th>الموظف</th><th>الدرجة المحسوبة</th><th>مهام متأخرة</th><th>KPI أحمر</th><th>Check-in</th><th>مرحلة التقييم</th><th>يحتاج انتباهًا</th></tr></thead><tbody>${d.rows.map(r => `<tr class="link" data-href="#/performance/employee/${r.id}${qs({ period: d.period_key })}"><td><div class="title">${esc(r.name)}</div><div class="sub">${esc(r.job_title)}</div></td><td>${r.calculated_score === null ? '—' : `<div class="row" style="gap:6px;flex-wrap:nowrap">${bar(r.calculated_score, scoreCls(r.calculated_score))}<b><bdi class="num">${r.calculated_score}</bdi></b></div>`}</td><td>${r.overdue_tasks ? `<b class="down">${r.overdue_tasks}</b>` : '0'}</td><td>${r.red_kpis ? `<b class="down">${r.red_kpis}</b>` : '0'}</td><td>${lp({ none: ['لا يوجد', 'gray'], draft: ['مسودة', 'amber'], submitted: ['بانتظارك', 'blue'], reviewed: ['تمت', 'green'] }, r.checkin_status)}</td><td class="small">${r.assessment_stage ? esc(L.stage[r.assessment_stage]) : '<span class="muted">لم يبدأ</span>'}</td><td class="small">${r.attention.length ? `<span class="down">${esc(r.attention.join(' · '))}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card">${state('empty', 'لا يوجد موظفون مباشرون', 'يظهر هنا الموظفون الذين تديرهم مباشرة.')}</div>`}`;
  bindPeriod(el, '#/performance/team');
}

// ---------- أداء الوحدات (Drill-down) ----------
async function org(ctx) {
  const { el, params, query } = ctx;
  const [d, pers] = await Promise.all([api('/performance/' + (params[0] ? 'org/' + params[0] : 'drilldown') + qs({ period: query.period })), api('/periods')]);
  const sc = d.scorecard; const s = sc.performance_score ?? sc.calculated_score;
  el.innerHTML = `${pageHead(`أداء: ${d.unit.name}`, `${esc(L.level[d.unit.kind])} — تتبع من المجموعة حتى الموظف`, `<a class="btn" href="#/tasks?view=${d.unit.kind === 'business_unit' ? 'business_unit&bu_id=' + d.unit.id : 'department&dept_id=' + d.unit.id}">مهام الوحدة</a><a class="btn" href="#/kpis?org_id=${d.unit.id}">مؤشرات الوحدة</a>`, d.path.map(p => p.id === d.unit.id ? esc(p.name) : `<a href="#/performance/org/${p.id}${qs({ period: query.period })}">${esc(p.name)}</a>`).join(' / '))}
   <div class="filters">${periodSel(pers, sc.period.key)}${sc.source === 'snapshot' ? pill(`Snapshot v${sc.snapshot_version}`, 'gray') : pill('حيّ', 'blue')}</div>
   <div class="grid g-main"><div class="stack">
     <div class="card"><header><h3>الأداء العام</h3></header><div class="row" style="gap:18px">${ring(s)}<div>${delta(s, d.previous.performance_score ?? d.previous.calculated_score)}${d.children.length ? `<div class="small" style="margin-top:6px">متوسط الوحدات التابعة: <b>${num(avgChildren(d.children))}</b></div><div class="tiny muted">درجة الوحدة تحتسب مؤشراتها المباشرة ومهام موظفيها، ولا تكرر مؤشرات الوحدات التابعة (تجنب Double Counting).</div>` : ''}</div></div></div>
     ${d.children.length ? `<div class="card"><header><h3>الوحدات التابعة</h3><span class="muted small more">اضغط للتعمق</span></header><div class="tablewrap"><table><thead><tr><th>الوحدة</th><th>الإجمالي</th><th>مالي</th><th>تشغيلي</th><th>المهام</th><th>إجراءات الاجتماعات</th></tr></thead><tbody>${d.children.map(c => { const g = k => c.components.find(x => x.key === k)?.score; return `<tr class="link" data-href="#/performance/org/${c.id}${qs({ period: query.period })}"><td class="title">${esc(c.name)} <span class="sub">${esc(L.level[c.kind])}</span></td><td>${c.performance_score === null ? '—' : `<div class="row" style="gap:6px;flex-wrap:nowrap">${bar(c.performance_score, scoreCls(c.performance_score))}<b><bdi class="num">${c.performance_score}</bdi></b></div>`}</td><td>${num(g('kpi_financial'))}</td><td>${num(g('kpi_operational'))}</td><td>${num(g('tasks'))}</td><td>${num(g('meeting_actions'))}</td></tr>`; }).join('')}</tbody></table></div></div>` : ''}
     ${d.employees.length ? `<div class="card"><header><h3>الموظفون</h3></header><div class="list">${d.employees.map(e => `<a class="item" href="#/performance/employee/${e.id}${qs({ period: query.period })}"><div class="grow"><span class="t">${esc(e.name)}</span><span class="small muted">${esc(e.job_title)}</span></div><b>${num(e.calculated_score)}</b></a>`).join('')}</div></div>` : ''}
     <div class="card"><header><h3>تفصيل الدرجة</h3></header>${breakdown(sc)}</div>
   </div><div class="stack"><div class="card"><header><h3>مؤشرات الوحدة</h3></header>${kpiTable(sc)}</div></div></div>`;
  bindPeriod(el, `#/performance/org/${d.unit.id}`);
}

const avgChildren = c => { const v = c.map(x => x.performance_score).filter(x => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };

// ---------- فترات الأداء ----------
async function periodsPage(ctx) {
  const { el, me, query } = ctx;
  const list = await api('/periods');
  const sel = query.id ? Number(query.id) : (list.find(p => p.status === 'under_review') || list[0])?.id;
  const p = sel ? await api('/periods/' + sel) : null;
  const can = me.can.manage_periods;
  const nextBtn = p && { open: ['under_review', 'بدء المراجعة'], under_review: ['approved', 'اعتماد الفترة'], approved: ['locked', 'إقفال وحفظ Snapshot'] }[p.status];
  el.innerHTML = `${pageHead('فترات الأداء', 'Open ← Under Review ← Approved ← Locked. بعد الإقفال تُحفظ النتائج كـSnapshot ولا تُعدل بصمت.', can ? `<button class="btn" data-act="new">${icon('plus')} فترة جديدة</button><a class="btn" href="#/performance/scorecards">أوزان Scorecard</a>` : '')}
   <div class="grid g-main"><div class="card"><div class="tablewrap"><table><thead><tr><th>الفترة</th><th>النوع</th><th>من — إلى</th><th>الحالة</th><th>الإصدار</th></tr></thead><tbody>${list.map(x => `<tr class="link" data-href="#/performance/periods?id=${x.id}" style="${x.id === sel ? 'background:var(--brand-soft)' : ''}"><td class="title">${esc(x.label)} <span class="sub">${ltr(x.key)}</span></td><td>${esc(L.freq[x.kind])}</td><td class="small">${fdate(x.start_date)} — ${fdate(x.end_date)}</td><td>${lp(L.period, x.status)}</td><td>v${x.version}${x.reopen_count ? ` · أُعيد فتحها ${x.reopen_count}` : ''}</td></tr>`).join('')}</tbody></table></div></div>
   ${p ? `<div class="stack"><div class="card"><header><h3>${esc(p.label)}</h3>${lp(L.period, p.status)}</header>
     <h4 class="small muted">فحوص الجاهزية</h4><dl class="kv"><dt>مؤشرات بلا بيانات</dt><dd>${p.checks.kpi_missing}</dd><dt>بيانات غير نهائية</dt><dd>${p.checks.data_not_final}</dd><dt>مهام بانتظار المراجعة</dt><dd>${p.checks.tasks_pending_review}</dd><dt>تقييمات غير معتمدة</dt><dd>${p.checks.assessments_not_final}</dd></dl>
     ${can ? `<div class="row" style="margin-top:12px">${nextBtn ? `<button class="btn primary" data-act="move" data-to="${nextBtn[0]}">${nextBtn[1]}</button>` : ''}${['approved', 'locked'].includes(p.status) ? '<button class="btn" data-act="reopen">إعادة فتح (بسبب)</button><button class="btn" data-act="adj">سجل تسوية</button>' : ''}</div>` : ''}</div>
     <div class="card"><header><h3>Snapshots</h3></header>${p.snapshots.length ? `<div class="list">${p.snapshots.map(s => `<div class="small">الإصدار v${s.version} · ${s.subjects} سجل · ${fdatetime(s.created_at)}</div>`).join('')}</div>` : empty('لا توجد بعد. تُنشأ عند الإقفال.')}</div>
     ${p.adjustments.length ? `<div class="card"><header><h3>التسويات</h3></header><div class="list">${p.adjustments.map(a => `<div class="small"><b>${esc(a.entity)} ${esc(a.field || '')}</b>: ${esc(a.old_value || '')} ← ${esc(a.new_value || '')} — ${esc(a.reason)} <span class="muted">(${esc(a.by_name)})</span></div>`).join('')}</div></div>` : ''}
     <div class="card"><header><h3>سجل التدقيق</h3></header>${p.audit.length ? `<div class="list">${p.audit.map(a => `<div class="small"><b>${esc(a.user_name || '')}</b> — ${esc(a.action)} ${a.old_value ? `${esc(a.old_value)} ← ${esc(a.new_value)}` : ''}${a.reason ? `<div class="muted">${esc(a.reason)}</div>` : ''}<div class="tiny muted">${fdatetime(a.ts)}</div></div>`).join('')}</div>` : empty('لا يوجد.')}</div></div>` : ''}</div>`;
  wire(el, {
    move: async b => { const to = b.dataset.to; try { await api(`/periods/${p.id}/transition`, { method: 'POST', body: { to } }); toast('تم تحديث حالة الفترة'); ctx.reload(); } catch (e) { if (e.code === 'HAS_GAPS' && await confirmBox('توجد فجوات في البيانات', `${e.message}\nهل تريد الاعتماد مع الإقرار بالفجوات؟`, 'اعتماد مع الإقرار')) { await api(`/periods/${p.id}/transition`, { method: 'POST', body: { to, acknowledge_gaps: true } }); toast('اعتُمدت الفترة'); ctx.reload(); } else if (e.code !== 'HAS_GAPS') toast(e.message, 'err'); } },
    reopen: async () => { const reason = await promptBox('إعادة فتح الفترة', 'السبب (يُسجل في التدقيق، وتُحفظ Snapshots السابقة)'); if (!reason) return; await api(`/periods/${p.id}/reopen`, { method: 'POST', body: { reason } }); toast('أُعيد فتح الفترة'); ctx.reload(); },
    adj: async () => { const mm = modal({ title: 'سجل تسوية (Adjustment)', body: `<form id="af"><div class="form-grid">${field('الكيان', '<input name="entity" placeholder="kpi_result">')}${field('الحقل', '<input name="field" placeholder="actual">')}${field('القيمة السابقة', '<input name="old_value">')}${field('القيمة المصححة', '<input name="new_value">')}${field('السبب', '<textarea name="reason"></textarea>', { full: true, req: true })}</div><p class="small muted">التسوية تُسجل ولا تغيّر الـSnapshot المعتمد.</p></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' }); mm.$('[data-ok]').onclick = async () => { try { await api(`/periods/${p.id}/adjustments`, { method: 'POST', body: readForm(mm.$('#af')) }); mm.close(); toast('تم تسجيل التسوية'); ctx.reload(); } catch (e) { showErrors(mm.$('#af'), e); } }; },
    new: async () => { const mm = modal({ title: 'فترة أداء جديدة', body: `<form id="nf">${field('مفتاح الفترة', '<input name="key" dir="ltr" placeholder="2026-11 أو 2026-Q4 أو 2026">', { hint: 'للفترة المخصصة حدد التاريخين' })}<div class="form-grid" style="margin-top:10px">${field('من', '<input type="date" name="start_date">')}${field('إلى', '<input type="date" name="end_date">')}${field('الاسم', '<input name="label">', { full: true })}</div></form>`, footer: '<button class="btn primary" data-ok>إنشاء</button><button class="btn" data-close>إلغاء</button>' }); mm.$('[data-ok]').onclick = async () => { try { await api('/periods', { method: 'POST', body: readForm(mm.$('#nf')) }); mm.close(); toast('أُنشئت الفترة'); ctx.reload(); } catch (e) { toast(e.message, 'err'); } }; },
  });
}

// ---------- أوزان Scorecard ----------
async function scorecards(ctx) {
  const { el } = ctx;
  const [d, org] = await Promise.all([api('/scorecards'), getOrg()]);
  const keys = Object.keys(d.components);
  const row = (c, name) => `<tr data-org="${c.org_unit_id || ''}"><td class="title">${esc(name)}</td>${keys.map(k => `<td><input type="number" min="0" max="100" class="w" data-k="${k}" value="${c.weights[k] ?? 0}" style="width:72px;min-height:36px" aria-label="${esc(d.components[k])}"></td>`).join('')}<td class="sum b"></td><td><button class="btn sm primary" data-act="save">حفظ</button></td></tr>`;
  el.innerHTML = `${pageHead('أوزان Scorecard', 'لكل قسم أوزانه. المجموع يجب أن يساوي 100%. التغيير يؤثر على الفترات المفتوحة فقط؛ الفترات المقفلة محفوظة كـSnapshots.', '', '<a href="#/performance/periods">فترات الأداء</a>')}
   <div class="alert warn small">${esc(d.bands_note)} شرائح التقييم الحالية: ${d.bands.map(b => `${esc(b[1])} (≥${b[0]})`).join(' · ')}</div>
   <div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>النطاق</th>${keys.map(k => `<th>${esc(d.components[k])}</th>`).join('')}<th>المجموع</th><th></th></tr></thead><tbody>${d.configs.map(c => row(c, c.org_name || 'الافتراضي (كل الوحدات)')).join('')}</tbody></table></div>
   <div class="row" style="margin-top:14px"><select id="neworg" style="max-width:320px">${opts(org.filter(o => ['department', 'business_unit', 'company'].includes(o.kind) && !d.configs.some(c => c.org_unit_id === o.id)).map(o => [o.id, o.name]), '', 'إضافة أوزان خاصة لوحدة…')}</select><button class="btn" data-act="add">إضافة</button></div>`;
  const sums = () => $$('tbody tr', el).forEach(tr => { const s = $$('.w', tr).reduce((a, i) => a + Number(i.value || 0), 0); const c = $('.sum', tr); c.innerHTML = `<bdi class="num">${s}%</bdi>`; c.style.color = s === 100 ? 'var(--green)' : 'var(--red)'; });
  el.addEventListener('input', sums); sums();
  wire(el, {
    save: async b => { const tr = b.closest('tr'); const weights = Object.fromEntries($$('.w', tr).map(i => [i.dataset.k, Number(i.value || 0)])); const reason = await promptBox('سبب تعديل الأوزان', 'يُسجل في سجل التدقيق', { required: false }); if (reason === null) return; try { await api('/scorecards', { method: 'PUT', body: { org_unit_id: tr.dataset.org ? Number(tr.dataset.org) : null, weights, reason } }); toast('تم حفظ الأوزان'); } catch (e) { toast(e.message, 'err'); } },
    add: () => { const s = $('#neworg', el); if (!s.value) return; const o = org.find(x => x.id === Number(s.value)); $('tbody', el).insertAdjacentHTML('beforeend', row({ org_unit_id: o.id, weights: d.default }, o.name)); sums(); },
  });
}
