import { $, $$, esc, api, qs, icon, L, lp, pill, num, ltr, fdatetime, state, wire, toast, modal, readForm, showErrors, field, opts, promptBox } from '../core.js';
import { pageHead, tabs, getOrg, getDir, empOpts, invalidate } from '../ui.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  const T = [];
  if (me.is_admin || me.is_hr) T.push(['employees', 'الموظفون والصلاحيات']);
  if (me.can.import) T.push(['import', 'الاستيراد والتصدير']);
  if (me.is_admin || me.is_hr) T.push(['audit', 'سجل التدقيق']);
  if (me.is_admin || me.is_exec || me.is_hr) T.push(['settings', 'الإعدادات']);
  T.push(['integrations', 'التكاملات']);
  const tab = T.some(t => t[0] === params[0]) ? params[0] : T[0][0];
  el.innerHTML = `${pageHead('الإدارة', 'إدارة الحسابات والصلاحيات والبيانات المرجعية. كل تغيير مهم يُسجل في سجل التدقيق.')}${tabs(T, tab)}<div id="tc"></div>`;
  $('.tabs', el).addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/admin/' + b.dataset.tab; });
  const tc = $('#tc', el);
  await ({ employees, import: imports, audit, settings, integrations })[tab](tc, ctx);
}

async function employees(tc, ctx) {
  const { me, query } = ctx;
  const [rows, org] = await Promise.all([api('/employees' + qs({ q: query.q })), getOrg()]);
  tc.innerHTML = `<div class="filters"><div class="field" style="flex:1"><label for="eq">بحث</label><input id="eq" value="${esc(query.q || '')}" placeholder="الاسم أو الرقم أو البريد"></div><button class="btn primary" data-act="new">${icon('plus')} موظف جديد</button><a class="btn ghost" href="/api/export/employees">${icon('download')} تصدير</a></div>
   <div class="tablewrap"><table><thead><tr><th>الموظف</th><th>الوحدة</th><th>المدير</th><th>الدور</th><th>الدخول</th><th>الحالة</th><th></th></tr></thead><tbody>${rows.map(e => `<tr><td><div class="title">${esc(e.name)}</div><div class="sub">${ltr(e.emp_no)} · <span dir="ltr">${esc(e.email)}</span></div></td><td class="small">${esc(e.org_name)}</td><td class="small">${esc(e.manager_name || '—')}</td><td>${esc(L.role[e.system_role])}</td><td>${e.can_login ? pill('مفعّل', 'green') : pill('لا', 'gray')}</td><td>${e.active ? pill('نشط', 'green') : pill('موقوف', 'red')}</td><td class="row" style="gap:4px"><button class="btn sm" data-act="edit" data-id="${e.id}">تعديل</button>${me.is_admin ? `<button class="btn sm" data-act="access" data-id="${e.id}">الصلاحيات</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
   <p class="small muted">لا يُشترط أن يكون الموظف مستخدم Odoo. تمكين الدخول والأدوار والنطاق من «الصلاحيات» (مدير النظام فقط).</p>`;
  $('#eq', tc).onchange = e => { location.hash = '#/admin/employees' + qs({ q: e.target.value }); };
  const dir = await getDir();
  const form = async e => {
    const v = e || { active: 1 };
    const mm = modal({ title: e ? `تعديل: ${e.name}` : 'موظف جديد', wide: true, body: `<form id="ef"><div class="alert err form-error" hidden></div><div class="form-grid">${field('رقم الموظف', `<input name="emp_no" dir="ltr" value="${esc(v.emp_no || '')}">`, { req: true })}${field('الاسم', `<input name="name" value="${esc(v.name || '')}">`, { req: true })}${field('المسمى الوظيفي', `<input name="job_title" value="${esc(v.job_title || '')}">`, { req: true })}${field('البريد', `<input name="email" type="email" value="${esc(v.email || '')}">`, { req: true })}${field('الهاتف', `<input name="phone" dir="ltr" value="${esc(v.phone || '')}">`)}${field('الوحدة التنظيمية (فريق/قسم)', `<select name="org_unit_id">${opts(org.map(o => [o.id, `${L.level[o.kind]}: ${o.name}`]), v.org_unit_id, 'اختر')}</select>`, { req: true })}${field('المدير المباشر', `<select name="manager_id">${empOpts(dir, v.manager_id, 'بدون')}</select>`)}${field('المدير الوظيفي (اختياري)', `<select name="functional_manager_id">${empOpts(dir, v.functional_manager_id, 'بدون')}</select>`)}<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> نشط</label></div><p class="small muted">إيقاف موظف لديه مهام مفتوحة أو مؤشرات مسندة يتطلب إعادة إسنادها أولًا.</p></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
    mm.$('[data-ok]').onclick = async () => { const f = mm.$('#ef'); const d = readForm(f); for (const k of ['org_unit_id', 'manager_id', 'functional_manager_id']) d[k] = d[k] ? Number(d[k]) : null; try { if (e) await api(`/employees/${e.id}`, { method: 'PUT', body: d }); else await api('/employees', { method: 'POST', body: d }); mm.close(); invalidate('dir'); toast('تم الحفظ'); ctx.reload(); } catch (x) { showErrors(f, x); } };
  };
  wire(tc, {
    new: () => form(null), edit: b => form(rows.find(r => r.id === Number(b.dataset.id))),
    access: async b => {
      const e = await api('/employees/' + b.dataset.id); const g = new Set((e.grants || []).filter(x => x.role !== 'extra_scope').map(x => x.role));
      const extra = (e.grants || []).filter(x => x.role === 'extra_scope').map(x => x.org_unit_id);
      const roles = ['board_member', 'board_secretary', 'kpi_owner', 'data_owner', 'performance_reviewer', 'meeting_leader', 'meeting_secretary'];
      const RA = { board_member: 'عضو مجلس إدارة', board_secretary: 'أمين سر المجلس', kpi_owner: 'مالك KPI', data_owner: 'مالك بيانات', performance_reviewer: 'مراجع أداء', meeting_leader: 'قائد اجتماعات', meeting_secretary: 'سكرتير اجتماعات' };
      const mm = modal({ title: `الصلاحيات: ${e.name}`, wide: true, body: `<form id="af"><div class="form-grid">${field('الدور الأساسي', `<select name="system_role">${opts(Object.entries(L.role), e.system_role)}</select>`)}${field('نطاق الوصول', `<select name="scope_org_id">${opts(org.map(o => [o.id, `${L.level[o.kind]}: ${o.name}`]), e.scope_org_id, 'تلقائي حسب الدور والوحدة')}</select>`, { hint: 'مدير القسم يرى قسمه فقط ما لم يُمنح نطاقًا إضافيًا' })}<div class="field full"><label>أدوار وظيفية إضافية</label><div class="row">${roles.map(r => `<label class="check"><input type="checkbox" class="gr" value="${r}" ${g.has(r) ? 'checked' : ''}> ${RA[r]}</label>`).join('')}</div></div>${field('نطاق إضافي', `<select id="xs" multiple size="4">${org.map(o => `<option value="${o.id}"${extra.includes(o.id) ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`)}<div class="field"><label>الدخول</label><label class="check"><input type="checkbox" name="can_login" ${e.can_login ? 'checked' : ''}> تمكين الدخول</label>${field('تعيين كلمة مرور جديدة', '<input type="password" name="new_password" autocomplete="new-password">')}</div>${field('سبب التغيير', '<input name="reason">', { full: true, req: true })}</div><div class="alert warn small">تغيير الدور ينهي جلسات المستخدم الحالية فورًا، ويُسجل في التدقيق.</div></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
      mm.$('[data-ok]').onclick = async () => { const f = mm.$('#af'); const d = readForm(f); if (!d.reason) return toast('اذكر سبب التغيير', 'err'); const grants = [...$$('.gr:checked', mm.el)].map(c => ({ role: c.value })).concat([...mm.$('#xs').selectedOptions].map(o => ({ role: 'extra_scope', org_unit_id: Number(o.value) })));
        try { await api(`/employees/${e.id}/access`, { method: 'PUT', body: { system_role: d.system_role, scope_org_id: d.scope_org_id ? Number(d.scope_org_id) : null, can_login: d.can_login, new_password: d.new_password || undefined, grants, reason: d.reason } }); mm.close(); toast('تم تحديث الصلاحيات'); ctx.reload(); } catch (x) { showErrors(f, x); } };
    },
  });
}

async function imports(tc, ctx) {
  const defs = await api('/import');
  tc.innerHTML = `<div class="grid g-main"><div class="card"><header><h3>استيراد CSV</h3></header>
    <ol class="small" style="margin:0 0 12px;padding-inline-start:18px"><li>نزّل القالب واملأه.</li><li>ارفع الملف لمعاينة التحقق وكشف التكرار.</li><li>نفّذ الاستيراد للصفوف السليمة فقط.</li></ol>
    <div class="form-grid">${field('نوع البيانات', `<select id="ie">${opts(defs.map(d => [d.key, d.label]), defs[0]?.key)}</select>`)}<div class="field"><label>&nbsp;</label><a class="btn" id="tpl" href="#">${icon('download')} تنزيل القالب</a></div>${field('ملف CSV (UTF-8)', '<input type="file" id="if" accept=".csv,text/csv">', { full: true })}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="preview">معاينة</button></div><div id="pv" style="margin-top:16px"></div></div>
    <div class="card"><header><h3>التصدير</h3></header><div class="list"><a class="item" href="/api/export/tasks">${icon('download')}<span class="grow">المهام (حسب صلاحياتك)</span></a><a class="item" href="/api/export/kpis">${icon('download')}<span class="grow">مؤشرات الأداء</span></a>${ctx.me.is_hr || ctx.me.is_admin ? `<a class="item" href="/api/export/employees">${icon('download')}<span class="grow">الموظفون</span></a>` : ''}</div><p class="small muted">التقارير أيضًا قابلة للتصدير من مركز التقارير. كل تصدير يُسجل في التدقيق.</p></div></div>`;
  const ie = $('#ie', tc); const tpl = $('#tpl', tc); const setTpl = () => { tpl.href = `/api/import/${ie.value}/template`; }; ie.onchange = setTpl; setTpl();
  let csv = '';
  const read = async () => { const f = $('#if', tc).files[0]; if (!f) throw new Error('اختر ملف CSV'); csv = await f.text(); };
  const show = r => { $('#pv', tc).innerHTML = `<div class="grid g4 keep2"><div class="card stat"><span class="lbl">الصفوف</span><span class="val">${r.total}</span></div><div class="card stat"><span class="lbl">صالحة</span><span class="val up">${r.valid}</span></div><div class="card stat"><span class="lbl">مكررة</span><span class="val">${r.duplicates}</span></div><div class="card stat"><span class="lbl">أخطاء</span><span class="val ${r.errors ? 'down' : ''}">${r.errors}</span></div></div>
     <div class="tablewrap" style="margin-top:12px;max-height:340px"><table><thead><tr><th>السطر</th><th>الإجراء</th><th>البيانات</th><th>الأخطاء</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${x.line}</td><td>${x.action === 'create' ? pill('جديد', 'green') : x.action === 'duplicate' ? pill('مكرر', 'amber') : pill('خطأ', 'red')}</td><td class="small" dir="ltr" style="text-align:right">${esc(Object.values(x.data).slice(0, 4).join(' | '))}</td><td class="small" style="color:var(--red)">${esc(x.errors.join('؛ '))}</td></tr>`).join('')}</tbody></table></div>
     <div class="row" style="margin-top:12px"><label class="check"><input type="checkbox" id="se"> تجاهل الصفوف الخاطئة</label><label class="check"><input type="checkbox" id="ue"> تحديث المكرر (الموظفون/القيم الفعلية)</label><button class="btn primary" data-act="commit" ${!r.valid && !r.duplicates ? 'disabled' : ''}>تنفيذ الاستيراد</button></div>`; };
  wire(tc, {
    preview: async () => { try { await read(); show(await api(`/import/${ie.value}/preview`, { method: 'POST', body: { csv } })); } catch (e) { toast(e.message, 'err'); } },
    commit: async () => { try { const r = await api(`/import/${ie.value}/commit`, { method: 'POST', body: { csv, skip_errors: $('#se', tc).checked, update_existing: $('#ue', tc).checked } }); toast(`تم: ${r.created} جديد، ${r.updated} محدّث، ${r.skipped} متجاهل`); $('#pv', tc).innerHTML = `<div class="alert ok">اكتمل الاستيراد: ${r.created} جديد · ${r.updated} محدّث · ${r.skipped} متجاهل</div>`; invalidate('dir'); invalidate('kpis'); } catch (e) { toast(e.message, 'err'); } },
  });
}

async function audit(tc, ctx) {
  const q = ctx.query;
  const r = await api('/audit' + qs({ entity: q.entity, limit: 200 }));
  const ents = ['task', 'kpi', 'kpi_result', 'financial_target', 'meeting', 'decision', 'period', 'assessment', 'scorecard', 'employee', 'employee_access', 'setting', 'export', 'import', 'session', 'attachment'];
  tc.innerHTML = `<div class="filters"><div class="field"><label for="ae">الكيان</label><select id="ae">${opts(ents.map(e => [e, e]), q.entity, 'الكل')}</select></div><span class="small muted">${r.total} حدث</span></div>
   <div class="tablewrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الكيان</th><th>الإجراء</th><th>الحقل</th><th>القيمة السابقة</th><th>القيمة الجديدة</th><th>السبب</th></tr></thead><tbody>${r.items.map(a => `<tr><td class="small">${fdatetime(a.ts)}</td><td>${esc(a.user_name || '—')}</td><td><span class="tag">${esc(a.entity)}</span> <bdi class="num small">#${a.entity_id ?? ''}</bdi></td><td>${esc(a.action)}</td><td class="small">${esc(a.field || '')}</td><td class="small" style="max-width:180px;overflow-wrap:anywhere">${esc(a.old_value || '')}</td><td class="small" style="max-width:180px;overflow-wrap:anywhere">${esc(a.new_value || '')}</td><td class="small">${esc(a.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
  $('#ae', tc).onchange = e => { location.hash = '#/admin/audit' + qs({ entity: e.target.value }); };
}
async function settings(tc, ctx) {
  const s = await api('/settings');
  const LBL = { prep_release_hours: 'إتاحة حزمة التحضير قبل الاجتماع (ساعات)', kpi_grace_days: 'مهلة إدخال بيانات KPI بعد نهاية الفترة (أيام)', fin_variance_threshold_pct: 'حد الانحراف المالي الكبير (%)', score_cap: 'سقف الإنجاز المحتسب في الدرجة (%)', calibration_enabled: 'تفعيل مراحل المعايرة', attention_score_below: 'درجة تستدعي الانتباه (أقل من)', final_rating_approvers: 'من يعتمد التقييم النهائي', base_currency: 'العملة الأساسية' };
  tc.innerHTML = `<div class="alert warn small">القيم الحالية افتراضية لأغراض التجربة (Demo defaults). القرارات الجوهرية مثل حدود الانحراف المالي وصلاحية اعتماد التقييم النهائي تحتاج اعتماد الإدارة.</div><div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>الإعداد</th><th>القيمة</th><th></th></tr></thead><tbody>${s.map(x => `<tr><td>${esc(LBL[x.key] || x.key)}<div class="sub" dir="ltr" style="text-align:right">${esc(x.key)}</div></td><td><input data-k="${x.key}" value="${esc(JSON.stringify(x.value))}" dir="ltr" style="max-width:300px" ${x.key === 'base_currency' ? 'disabled' : ''}></td><td>${x.key === 'base_currency' ? '<span class="small muted">ثابت</span>' : `<button class="btn sm" data-act="save" data-k="${x.key}">حفظ</button>`}</td></tr>`).join('')}</tbody></table></div>
   ${ctx.me.is_admin || ctx.me.is_exec || ctx.me.is_hr ? `<div class="card" style="margin-top:16px"><header><h3>الأتمتة</h3></header><p class="small" style="margin:0 0 10px">تعمل كل دقيقة داخل الخادم (Simulation): إتاحة حزم التحضير T-48h، تنبيهات المهام والمؤشرات. يمكن تشغيلها يدويًا للتجربة.</p><button class="btn" data-act="auto">تشغيل الأتمتة الآن</button><pre id="ar" class="small" dir="ltr" style="white-space:pre-wrap"></pre></div>` : ''}`;
  wire(tc, { save: async b => { const k = b.dataset.k; let v; try { v = JSON.parse($(`[data-k="${k}"]`, tc).value); } catch { return toast('صيغة القيمة غير صحيحة (JSON)', 'err'); } const reason = await promptBox('سبب التعديل', 'يُسجل في التدقيق', { required: false }); if (reason === null) return; await api(`/settings/${k}`, { method: 'PUT', body: { value: v, reason } }); toast('تم الحفظ'); },
    auto: async () => { const r = await api('/admin/run-automation', { method: 'POST' }); $('#ar', tc).textContent = JSON.stringify(r, null, 2); toast('اكتمل تشغيل الأتمتة'); } });
}
async function integrations(tc) {
  const list = await api('/integrations');
  tc.innerHTML = `<div class="alert info small">لا توجد تكاملات إنتاجية مفعّلة. كل ما يحمل وسم Mock تجريبي ومعلن، ولا يتصل بأي خدمة خارجية.</div><div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>التكامل</th><th>الحالة</th><th>التفاصيل</th></tr></thead><tbody>${list.map(i => `<tr><td class="title">${esc(i.name)}</td><td>${lp(L.integ, i.state)}</td><td class="small">${esc(i.note)}</td></tr>`).join('')}</tbody></table></div>`;
}
