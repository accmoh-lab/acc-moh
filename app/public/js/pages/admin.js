import { $, $$, esc, api, qs, icon, L, lp, pill, num, ltr, fdatetime, state, wire, toast, modal, readForm, showErrors, field, opts, promptBox, confirmBox } from '../core.js';
import { pageHead, tabs, getOrg, getDir, empOpts, invalidate } from '../ui.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  const T = [];
  if (me.is_admin || me.is_hr) T.push(['employees', 'الموظفون والصلاحيات'], ['org', 'الهيكل التنظيمي']);
  if (me.can.import) T.push(['import', 'الاستيراد والتصدير']);
  if (me.is_admin || me.is_hr) T.push(['audit', 'سجل التدقيق']);
  if (me.is_admin || me.is_exec || me.is_hr) T.push(['settings', 'الإعدادات']);
  T.push(['integrations', 'التكاملات']);
  const tab = T.some(t => t[0] === params[0]) ? params[0] : T[0][0];
  el.innerHTML = `${pageHead('الإدارة', 'إدارة الحسابات والصلاحيات والبيانات المرجعية. كل تغيير مهم يُسجل في سجل التدقيق.')}${tabs(T, tab)}<div id="tc"></div>`;
  $('.tabs', el).addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/admin/' + b.dataset.tab; });
  const tc = $('#tc', el);
  await ({ employees, org: orgTab, import: imports, audit, settings, integrations })[tab](tc, ctx);
}

async function employees(tc, ctx) {
  const { me, query } = ctx;
  const status = query.status || 'active';
  const [rows, org] = await Promise.all([api('/employees' + qs({ q: query.q, status: status === 'all' ? '' : status })), getOrg()]);
  const go = o => { location.hash = '#/admin/employees' + qs({ q: query.q, status, ...o }); };
  tc.innerHTML = `<div class="filters"><div class="seg" role="group" aria-label="الحالة">${[['active', 'النشطون'], ['archived', 'الأرشيف'], ['all', 'الكل']].map(([k, l]) => `<button class="${status === k ? 'on' : ''}" data-act="st" data-v="${k}">${l}</button>`).join('')}</div>
     <div class="field" style="flex:1;min-width:180px"><label for="eq">بحث</label><input id="eq" value="${esc(query.q || '')}" placeholder="الاسم أو الرقم أو البريد"></div><button class="btn primary" data-act="new">${icon('plus')} إضافة عضو</button><a class="btn ghost" href="/api/export/employees">${icon('download')} تصدير</a></div>
   ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>الموظف</th><th>الوحدة</th><th>المدير</th><th>الدور</th><th>الدخول</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>${rows.map(e => `<tr${e.active ? '' : ' style="opacity:.7"'}><td><div class="title">${esc(e.name)}</div><div class="sub">${ltr(e.emp_no)} · <span dir="ltr">${esc(e.email)}</span></div></td><td class="small">${esc(e.org_name)}</td><td class="small">${esc(e.manager_name || '—')}</td><td>${esc(L.role[e.system_role])}</td><td>${e.can_login ? pill('مفعّل', 'green') : pill('لا', 'gray')}</td><td>${e.active ? pill('نشط', 'green') : pill('مؤرشف', 'gray')}</td>
     <td><div class="row" style="gap:4px;flex-wrap:nowrap">${e.id === me.id ? '<span class="small muted">حسابك</span>' : `<button class="btn sm" data-act="edit" data-id="${e.id}">${icon('edit')} تعديل</button>${me.is_admin ? `<button class="btn sm" data-act="access" data-id="${e.id}">الصلاحيات</button>` : ''}${e.active ? `<button class="btn sm" data-act="archive" data-id="${e.id}">أرشفة</button>` : `<button class="btn sm" data-act="restore" data-id="${e.id}">استعادة</button>`}<button class="btn sm danger" data-act="del" data-id="${e.id}" aria-label="حذف ${esc(e.name)}">حذف</button>`}</div></td></tr>`).join('')}</tbody></table></div>`
     : `<div class="card">${state('empty', status === 'archived' ? 'لا يوجد أعضاء في الأرشيف' : 'لا توجد نتائج', status === 'archived' ? 'عند أرشفة عضو يظهر هنا ويمكن استعادته.' : 'غيّر البحث أو أضف عضوًا جديدًا.')}</div>`}
   <p class="small muted"><b>الأرشفة</b> توقف دخول العضو وتنقل أعماله المفتوحة لبديل، مع الاحتفاظ بكل تاريخه (الاجتماعات، المهام، التقييمات). <b>الحذف النهائي</b> متاح فقط لعضو بلا أي سجل، مثل عضو أُضيف بالخطأ.</p>`;
  $('#eq', tc).onchange = e => go({ q: e.target.value });
  const dir = await getDir();
  const byId = id => rows.find(r => r.id === Number(id));
  const form = async e => {
    const v = e || {};
    const mm = modal({ title: e ? `تعديل: ${e.name}` : 'إضافة عضو جديد', wide: true, body: `<form id="ef"><div class="alert err form-error" hidden></div><div class="form-grid">${field('الاسم', `<input name="name" value="${esc(v.name || '')}">`, { req: true })}${field('رقم الموظف', `<input name="emp_no" dir="ltr" value="${esc(v.emp_no || '')}">`, { req: true })}${field('المسمى الوظيفي', `<input name="job_title" value="${esc(v.job_title || '')}">`, { req: true })}${field('البريد الإلكتروني', `<input name="email" type="email" value="${esc(v.email || '')}">`, { req: true })}${field('الهاتف', `<input name="phone" dir="ltr" value="${esc(v.phone || '')}">`)}${field('الوحدة التنظيمية', `<select name="org_unit_id">${opts(org.map(o => [o.id, `${L.level[o.kind]}: ${o.name}`]), v.org_unit_id, 'اختر')}</select>`, { req: true })}${field('المدير المباشر', `<select name="manager_id">${empOpts(dir.filter(d => d.id !== v.id), v.manager_id, 'بدون')}</select>`)}${field('المدير الوظيفي (اختياري)', `<select name="functional_manager_id">${empOpts(dir.filter(d => d.id !== v.id), v.functional_manager_id, 'بدون')}</select>`)}</div>
      ${e ? '' : `<div class="alert info small" style="margin-top:12px">بعد الإضافة: ${me.is_admin ? 'اضغط «الصلاحيات» لتمكين الدخول وتعيين كلمة المرور والدور.' : 'يمكّن مدير النظام الدخول ويعيّن الدور.'}</div>`}</form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
    mm.$('[data-ok]').onclick = async () => { const f = mm.$('#ef'); const d = readForm(f); for (const k of ['org_unit_id', 'manager_id', 'functional_manager_id']) d[k] = d[k] ? Number(d[k]) : null; try { if (e) await api(`/employees/${e.id}`, { method: 'PUT', body: d }); else await api('/employees', { method: 'POST', body: d }); mm.close(); invalidate('dir'); toast(e ? 'تم حفظ التعديلات' : 'تمت إضافة العضو'); ctx.reload(); } catch (x) { showErrors(f, x); } };
  };
  const archive = async e => {
    const w = await api(`/employees/${e.id}/workload`);
    const L2 = { open_tasks: 'مهام مفتوحة', reviews: 'مهام ينتظر مراجعتها', kpis: 'مؤشرات أداء مسؤول عنها', initiatives: 'مبادرات يملكها', meetings_led: 'اجتماعات قادمة يقودها', reports: 'موظفون يديرهم مباشرة' };
    const items = Object.entries(w).filter(([, n]) => n);
    const mm = modal({ title: `أرشفة: ${e.name}`, body: `<form id="ar"><div class="alert err form-error" hidden></div>
      <p style="margin-top:0">سيتوقف دخول العضو فورًا، ويختفي من قوائم الاختيار، مع بقاء كل سجله التاريخي. يمكن استعادته لاحقًا.</p>
      ${items.length ? `<div class="alert warn small"><b>لديه أعمال مفتوحة ستُنقل للبديل:</b><ul style="margin:6px 0 0;padding-inline-start:18px">${items.map(([k, n]) => `<li>${n} ${L2[k]}</li>`).join('')}</ul></div>
        ${field('نقل الأعمال إلى', `<select name="reassign_to">${empOpts(dir.filter(d => d.id !== e.id), e.manager_id, 'اختر البديل')}</select>`, { req: true })}` : '<div class="alert ok small">لا توجد أعمال مفتوحة.</div>'}
      <div style="margin-top:12px">${field('السبب (يُسجل في التدقيق)', '<input name="reason" placeholder="مثال: انتهاء الخدمة">')}</div></form>`, footer: '<button class="btn danger" data-ok>أرشفة</button><button class="btn" data-close>إلغاء</button>' });
    mm.$('[data-ok]').onclick = async () => { const f = mm.$('#ar'); const d = readForm(f); if (items.length && !d.reassign_to) return showErrors(f, { message: 'اختر الموظف البديل.', details: { reassign_to: 'مطلوب' } });
      try { await api(`/employees/${e.id}/archive`, { method: 'POST', body: { reassign_to: d.reassign_to ? Number(d.reassign_to) : null, reason: d.reason } }); mm.close(); invalidate('dir'); toast(`تمت أرشفة ${e.name}${items.length ? ' ونقل أعماله' : ''}`); ctx.reload(); } catch (x) { showErrors(f, x); } };
  };
  wire(tc, {
    st: b => go({ status: b.dataset.v }), new: () => form(null), edit: b => form(byId(b.dataset.id)),
    archive: b => archive(byId(b.dataset.id)),
    restore: async b => { const e = byId(b.dataset.id); if (!await confirmBox('استعادة العضو', `سيعود ${e.name} نشطًا ويستطيع الدخول بكلمة مروره السابقة.`, 'استعادة')) return; await api(`/employees/${e.id}/restore`, { method: 'POST' }); invalidate('dir'); toast('تمت الاستعادة'); ctx.reload(); },
    del: async b => { const e = byId(b.dataset.id); if (!await confirmBox('حذف نهائي', `حذف ${e.name} نهائيًا لا يمكن التراجع عنه. مسموح فقط إذا لم يكن له أي سجل.`, 'حذف نهائي', true)) return;
      try { await api(`/employees/${e.id}`, { method: 'DELETE' }); invalidate('dir'); toast('تم الحذف'); ctx.reload(); }
      catch (x) { if (x.code === 'HAS_HISTORY' && e.active && await confirmBox('لا يمكن الحذف', `${x.message}\n\nهل تريد أرشفته بدلًا من ذلك؟`, 'أرشفة بدلًا من الحذف')) archive(e); else if (x.code !== 'HAS_HISTORY' || !e.active) toast(x.message, 'err'); } },
    access: async b => {
      const e = await api('/employees/' + b.dataset.id); const g = new Set((e.grants || []).filter(x => x.role !== 'extra_scope').map(x => x.role));
      const extra = (e.grants || []).filter(x => x.role === 'extra_scope').map(x => x.org_unit_id);
      const roles = ['board_member', 'board_secretary', 'kpi_owner', 'data_owner', 'performance_reviewer', 'meeting_leader', 'meeting_secretary'];
      const RA = { board_member: 'عضو مجلس إدارة', board_secretary: 'أمين سر المجلس', kpi_owner: 'مالك KPI', data_owner: 'مالك بيانات', performance_reviewer: 'مراجع أداء', meeting_leader: 'قائد اجتماعات', meeting_secretary: 'سكرتير اجتماعات' };
      const mm = modal({ title: `الصلاحيات: ${e.name}`, wide: true, body: `<form id="af"><div class="alert err form-error" hidden></div><div class="form-grid">${field('الدور الأساسي', `<select name="system_role">${opts(Object.entries(L.role), e.system_role)}</select>`)}${field('نطاق الوصول', `<select name="scope_org_id">${opts(org.map(o => [o.id, `${L.level[o.kind]}: ${o.name}`]), e.scope_org_id, 'تلقائي حسب الدور والوحدة')}</select>`, { hint: 'مدير القسم يرى قسمه فقط ما لم يُمنح نطاقًا إضافيًا' })}<div class="field full"><label>أدوار وظيفية إضافية</label><div class="row">${roles.map(r => `<label class="check"><input type="checkbox" class="gr" value="${r}" ${g.has(r) ? 'checked' : ''}> ${RA[r]}</label>`).join('')}</div></div>${field('نطاق إضافي', `<select id="xs" multiple size="4">${org.map(o => `<option value="${o.id}"${extra.includes(o.id) ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`)}<div class="field"><label>الدخول</label><label class="check"><input type="checkbox" name="can_login" ${e.can_login ? 'checked' : ''}> تمكين الدخول</label>${field('تعيين كلمة مرور جديدة', '<input type="password" name="new_password" autocomplete="new-password">', { hint: '10 أحرف على الأقل مع حرف كبير وصغير ورقم' })}</div>${field('سبب التغيير', '<input name="reason">', { full: true, req: true })}</div><div class="alert warn small">تغيير الدور ينهي جلسات المستخدم الحالية فورًا، ويُسجل في التدقيق.</div></form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' });
      mm.$('[data-ok]').onclick = async () => { const f = mm.$('#af'); const d = readForm(f); if (!d.reason) return toast('اذكر سبب التغيير', 'err'); const grants = [...$$('.gr:checked', mm.el)].map(c => ({ role: c.value })).concat([...mm.$('#xs').selectedOptions].map(o => ({ role: 'extra_scope', org_unit_id: Number(o.value) })));
        try { await api(`/employees/${e.id}/access`, { method: 'PUT', body: { system_role: d.system_role, scope_org_id: d.scope_org_id ? Number(d.scope_org_id) : null, can_login: d.can_login, new_password: d.new_password || undefined, grants, reason: d.reason } }); mm.close(); toast('تم تحديث الصلاحيات'); ctx.reload(); } catch (x) { showErrors(f, x); } };
    },
  });
}

async function orgTab(tc, ctx) {
  const org = await api('/org/tree');
  const kids = id => org.filter(o => o.parent_id === id);
  const rowsOf = (o, depth) => [`<tr><td style="padding-inline-start:${14 + depth * 24}px"><span class="title">${esc(o.name)}</span> <span class="tag">${esc(L.level[o.kind])}</span></td><td>${ltr(o.code)}</td><td><div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn sm" data-act="ren" data-id="${o.id}">${icon('edit')} تعديل الاسم</button>${o.kind !== 'team' ? `<button class="btn sm" data-act="add" data-id="${o.id}">${icon('plus')} وحدة فرعية</button>` : ''}${o.parent_id ? `<button class="btn sm danger" data-act="del" data-id="${o.id}">حذف</button>` : ''}</div></td></tr>`, ...kids(o.id).map(c => rowsOf(c, depth + 1)).flat()];
  tc.innerHTML = `<div class="tablewrap"><table><thead><tr><th>الوحدة</th><th>الرمز</th><th></th></tr></thead><tbody>${org.filter(o => !o.parent_id).map(o => rowsOf(o, 0)).flat().join('')}</tbody></table></div><p class="small muted">حذف الوحدة متاح فقط إذا كانت فارغة (بلا وحدات فرعية أو موظفين أو مؤشرات).</p>`;
  const NEXT = { group: 'company', company: 'business_unit', business_unit: 'department', department: 'team' };
  const done = () => { invalidate('org'); invalidate('dir'); ctx.reload(); };
  wire(tc, {
    ren: async b => { const o = org.find(x => x.id === Number(b.dataset.id)); const mm = modal({ title: 'تعديل اسم الوحدة', body: `<form id="rf"><div class="alert err form-error" hidden></div>${field('الاسم', `<input name="name" value="${esc(o.name)}">`, { req: true })}</form>`, footer: '<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>' }); mm.$('[data-ok]').onclick = async () => { try { await api(`/org/units/${o.id}`, { method: 'PUT', body: readForm(mm.$('#rf')) }); mm.close(); toast('تم تعديل الاسم'); done(); } catch (x) { showErrors(mm.$('#rf'), x); } }; },
    add: async b => { const p = org.find(x => x.id === Number(b.dataset.id)); const kind = NEXT[p.kind]; const mm = modal({ title: `إضافة ${L.level[kind]} تحت ${p.name}`, body: `<form id="nf"><div class="alert err form-error" hidden></div><div class="form-grid">${field('الاسم', '<input name="name">', { req: true })}${field('الرمز', '<input name="code" dir="ltr" placeholder="DEPT-LEGAL">', { req: true })}</div></form>`, footer: '<button class="btn primary" data-ok>إضافة</button><button class="btn" data-close>إلغاء</button>' }); mm.$('[data-ok]').onclick = async () => { try { await api('/org/units', { method: 'POST', body: { ...readForm(mm.$('#nf')), kind, parent_id: p.id } }); mm.close(); toast('تمت الإضافة'); done(); } catch (x) { showErrors(mm.$('#nf'), x); } }; },
    del: async b => { const o = org.find(x => x.id === Number(b.dataset.id)); if (!await confirmBox('حذف الوحدة', `حذف «${o.name}»؟`, 'حذف', true)) return; try { await api(`/org/units/${o.id}`, { method: 'DELETE' }); toast('تم الحذف'); done(); } catch (x) { toast(x.message, 'err'); } },
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
     <div class="tablewrap" style="margin-top:12px;max-height:340px"><table><thead><tr><th>السطر</th><th>الإجراء</th><th>البيانات</th><th>الأخطاء</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${x.line}</td><td>${x.action === 'create' ? pill('جديد', 'green') : x.action === 'duplicate' ? pill('مكرر', 'amber') : pill('خطأ', 'red')}</td><td class="small" dir="ltr" style="text-align:right">${esc(Object.values(x.data).slice(0, 4).join(' | '))}</td><td class="small" style="color:var(--red)">${esc(x.errors.concat(x.warnings || []).join('؛ '))}</td></tr>`).join('')}</tbody></table></div>
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
