import { $, $$, esc, api, icon, toast, modal, state, loading, errorState, readForm, showErrors, field, wire, L, ApiError } from './core.js';

export const S = { me: null, nav: [], unread: 0 };
const routes = [
  [/^#\/home$/, 'home'], [/^#\/meetings$/, 'meetings'], [/^#\/meetings\/new$/, 'meeting_new'], [/^#\/meetings\/(\d+)$/, 'meeting_detail'], [/^#\/meetings\/(\d+)\/live$/, 'meeting_live'],
  [/^#\/decisions$/, 'decisions'], [/^#\/decisions\/(\d+)$/, 'decision_detail'],
  [/^#\/tasks$/, 'tasks'], [/^#\/tasks\/(\d+)$/, 'task_detail'],
  [/^#\/kpis$/, 'kpis'], [/^#\/kpis\/(\d+)$/, 'kpi_detail'], [/^#\/targets$/, 'targets'],
  [/^#\/initiatives$/, 'initiatives'], [/^#\/initiatives\/(\d+)$/, 'initiative_detail'],
  [/^#\/performance$/, 'perf_me'], [/^#\/performance\/team$/, 'perf_team'], [/^#\/performance\/org(?:\/(\d+))?$/, 'perf_org'], [/^#\/performance\/employee\/(\d+)$/, 'perf_employee'], [/^#\/performance\/periods$/, 'perf_periods'], [/^#\/performance\/scorecards$/, 'perf_scorecards'],
  [/^#\/attention$/, 'attention'], [/^#\/board$/, 'board'], [/^#\/reports$/, 'reports'], [/^#\/reports\/([a-z_]+)$/, 'report'],
  [/^#\/notifications$/, 'notifications'], [/^#\/admin(?:\/([a-z]+))?$/, 'admin'], [/^#\/profile$/, 'profile'],
];
const PAGES = { home: 'home', meetings: 'meetings', meeting_new: 'meetings', meeting_detail: 'meetings', meeting_live: 'meetings', decisions: 'meetings', decision_detail: 'meetings', tasks: 'tasks', task_detail: 'tasks', kpis: 'kpis', kpi_detail: 'kpis', targets: 'kpis', initiatives: 'initiatives', initiative_detail: 'initiatives', perf_me: 'perf', perf_team: 'perf', perf_org: 'perf', perf_employee: 'perf', perf_periods: 'perf', perf_scorecards: 'perf', attention: 'attention', board: 'board', reports: 'reports', report: 'reports', notifications: 'notifications', admin: 'admin', profile: 'profile' };
const cache = {};
async function loadPage(name) { const f = PAGES[name]; return (cache[f] ||= await import(`./pages/${f}.js`)); }

// ---------- Theme ----------
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
if (store.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

// ---------- تسجيل الدخول ----------
async function renderLogin(msg) {
  document.title = 'تسجيل الدخول — منصة الإدارة والأداء';
  $('#app').innerHTML = `<div class="login">
    <section class="hero-side"><div class="row"><div class="brand"><div class="logo">${icon('perf')}</div><div><b>منصة الإدارة والأداء</b><small>فاست تريد — بيئة تجريبية</small></div></div></div>
      <h1>من انحراف المؤشر إلى القرار والتنفيذ والنتيجة، في مكان واحد</h1>
      <p>تربط المنصة الاجتماعات والقرارات والمهام والمؤشرات والأهداف المالية والأداء في دورة إدارية واحدة قابلة للمتابعة.</p>
      <div class="cycle"><span><i></i>KPI / Target ← انحراف الأداء</span><span><i></i>اجتماع ← قرار ← مهمة ← مسؤول وموعد</span><span><i></i>تنفيذ ← دليل ← مراجعة ← تحديث KPI</span></div></section>
    <section class="form-side"><form class="box" id="lf" novalidate>
      <div><h1>تسجيل الدخول</h1><p class="muted" style="margin:4px 0 0">استخدم بريد العمل وكلمة المرور.</p></div>
      ${msg ? `<div class="alert warn" role="alert">${esc(msg)}</div>` : ''}
      <div class="alert err form-error" role="alert" hidden></div>
      <div class="field"><label for="em">البريد الإلكتروني</label><input id="em" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">كلمة المرور</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <div class="field" id="mfa" hidden><label for="mf">رمز التحقق الثنائي (MFA)</label><input id="mf" name="mfa" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
      <button class="btn primary big" type="submit">دخول</button>
      <button class="btn ghost" type="button" data-act="forgot">نسيت كلمة المرور؟</button>
      <div id="demo"></div>
    </form></section></div>`;
  const form = $('#lf');
  const submit = async (email, password) => {
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try { const r = await api('/auth/login', { method: 'POST', body: { email, password, mfa: $('#mf').value || undefined } }); S.me = r.user; if (location.hash === '#/login' || !location.hash) location.hash = '#/home'; else await route(); if (location.hash === '#/home') await route(); }
    catch (e) { if (e.code === 'MFA_REQUIRED') $('#mfa').hidden = false; const b = $('.form-error', form); b.textContent = e.message; b.hidden = false; }
    finally { btn.disabled = false; }
  };
  form.addEventListener('submit', e => { e.preventDefault(); submit($('#em').value, $('#pw').value); });
  wire(form, {
    forgot: async () => {
      const m = modal({ title: 'استعادة كلمة المرور', body: `<div class="field"><label for="fe">البريد الإلكتروني</label><input id="fe" type="email" dir="ltr"></div><p class="muted small">سيصل رابط إعادة التعيين إذا كان البريد مسجلًا. (البريد في هذه البيئة Mock ولا يُرسل فعليًا.)</p><div id="fres"></div>`, footer: '<button class="btn primary" data-ok>إرسال</button><button class="btn" data-close>إغلاق</button>' });
      m.$('[data-ok]').onclick = async () => { const r = await api('/auth/forgot', { method: 'POST', body: { email: m.$('#fe').value } }).catch(e => ({ message: e.message })); m.$('#fres').innerHTML = `<div class="alert info">${esc(r.message)}</div>` + (r.demo_token ? `<p class="small"><a href="#/reset?token=${esc(r.demo_token)}">رابط التعيين (يظهر في وضع Demo فقط)</a></p>` : ''); };
    },
  });
  try {
    const demos = await api('/auth/demo-accounts');
    if (demos.length) {
      $('#demo').innerHTML = `<div class="alert mockbar small"><b>حسابات تجريبية (Demo Mode)</b> — كلمة المرور الموحدة: <bdi class="ltr">Demo@2026!</bdi></div><div class="demo-list" style="margin-top:10px">${demos.map(d => `<button type="button" data-demo="${esc(d.email)}"><b>${esc(d.name)}</b><small>${esc(L.role[d.system_role] || d.system_role)} · ${esc(d.job_title)}</small></button>`).join('')}</div>`;
      $('#demo').addEventListener('click', e => { const b = e.target.closest('[data-demo]'); if (b) submit(b.dataset.demo, 'Demo@2026!'); });
    }
  } catch { }
  $('#em').focus();
}
async function renderReset() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token');
  $('#app').innerHTML = `<div class="login"><section class="form-side" style="grid-column:1/-1"><form class="box" id="rf"><h1>تعيين كلمة مرور جديدة</h1><div class="alert err form-error" hidden></div><div class="field"><label>كلمة المرور الجديدة</label><input name="password" type="password" autocomplete="new-password"><span class="hint">10 أحرف على الأقل، وتشمل حرفًا كبيرًا وصغيرًا ورقمًا.</span></div><button class="btn primary big">حفظ</button></form></section></div>`;
  $('#rf').onsubmit = async e => { e.preventDefault(); try { await api('/auth/reset', { method: 'POST', body: { token, password: $('#rf [name=password]').value } }); toast('تم تعيين كلمة المرور. سجّل الدخول الآن.'); location.hash = '#/login'; } catch (x) { showErrors($('#rf'), x); } };
}

// ---------- الهيكل ----------
function navFor(me) {
  const adm = me.is_admin; const items = [];
  if (adm) return [['#/home', 'الرئيسية', 'home'], ['#/admin', 'الإدارة', 'gear'], ['#/notifications', 'الإشعارات', 'bell']];
  items.push(['#/home', 'الرئيسية', 'home'], ['#/meetings', 'الاجتماعات', 'cal'], ['#/tasks', 'المهام', 'tasks'], ['#/kpis', 'مؤشرات الأداء', 'kpi']);
  if (me.can.manage_kpis || me.is_exec || me.is_hr || me.system_role === 'department_manager' || me.system_role === 'business_unit_manager') items.push(['#/targets', 'الأهداف المالية', 'money']);
  items.push(['#/initiatives', 'المبادرات', 'flag'], ['#/performance', 'أدائي', 'perf']);
  return items;
}
function renderShell() {
  const me = S.me; const main = navFor(me);
  const mgmt = [];
  if (!me.is_admin) {
    if (me.can.see_team) mgmt.push(['#/performance/team', 'فريقي', 'users']);
    if (me.can.see_attention) mgmt.push(['#/attention', 'Management Attention', 'alert']);
    if (me.can.see_executive) mgmt.push(['#/performance/org', 'أداء الوحدات', 'perf']);
    if (me.is_board) mgmt.push(['#/board', 'مجلس الإدارة', 'shield']);
    mgmt.push(['#/reports', 'التقارير', 'report']);
    if (me.can.manage_periods) mgmt.push(['#/performance/periods', 'فترات الأداء', 'clock']);
    if (me.can.import || me.is_hr) mgmt.push(['#/admin', 'الاستيراد والإعدادات', 'gear']);
  }
  const link = ([h, t, i]) => `<a href="${h}" data-nav="${h}">${icon(i)}<span>${esc(t)}</span>${h === '#/notifications' ? '<span class="badge" id="nbadge" hidden></span>' : ''}${h === '#/attention' ? '<span class="badge" id="abadge" hidden></span>' : ''}</a>`;
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar" id="sb" aria-label="القائمة الرئيسية">
      <div class="brand"><div class="logo">${icon('perf')}</div><div><b>منصة الإدارة والأداء</b><small>فاست تريد</small></div></div>
      <nav class="nav">${main.map(link).join('')}${mgmt.length ? '<div class="nav-group">الإدارة والمتابعة</div>' + mgmt.map(link).join('') : ''}</nav>
      <div class="side-foot"><div class="who">${esc(me.name)}</div><div class="muted" style="color:#8f9bc4">${esc(L.role[me.system_role])} · ${esc(me.dept || me.org_unit || '')}</div>
        <div class="row" style="margin-top:10px"><a href="#/profile" class="btn sm" style="background:#1b2650;color:#fff;border-color:#2b3a72">${icon('user')} ملفي</a><button class="btn sm" id="theme" style="background:#1b2650;color:#fff;border-color:#2b3a72" aria-label="تبديل المظهر">${icon('moon')}</button><button class="btn sm" data-act="logout" style="background:#1b2650;color:#fff;border-color:#2b3a72" aria-label="خروج">${icon('logout')}</button></div></div>
    </aside><div class="scrim only-mobile" id="scrim" hidden></div>
    <div class="main"><header class="topbar">
      <button class="iconbtn only-mobile" id="menu" aria-label="القائمة">${icon('menu')}</button>
      <div class="search" role="search">${icon('search')}<input id="q" type="search" placeholder="ابحث عن اجتماع، قرار، مهمة، مؤشر…" aria-label="بحث شامل" autocomplete="off"><div class="search-pop" id="sp" hidden></div></div>
      <a class="iconbtn" href="#/notifications" aria-label="الإشعارات">${icon('bell')}<span class="dot" id="nbadge2" hidden></span></a>
    </header><main class="content" id="view" tabindex="-1"></main></div>
    <nav class="tabbar" aria-label="تنقل سريع"><a href="#/home" data-nav="#/home">${icon('home')}<span>الرئيسية</span></a><a href="#/meetings" data-nav="#/meetings">${icon('cal')}<span>الاجتماعات</span></a><a href="#/tasks" data-nav="#/tasks">${icon('tasks')}<span>المهام</span></a><a href="#/notifications" data-nav="#/notifications">${icon('bell')}<span>الإشعارات</span><span class="badge" id="nbadge3" hidden></span></a><a href="#" id="more">${icon('more')}<span>المزيد</span></a></nav>
  </div>`;
  const sb = $('#sb'), scrim = $('#scrim');
  const open = v => { sb.classList.toggle('open', v); scrim.hidden = !v; };
  $('#menu').onclick = () => open(true); scrim.onclick = () => open(false); $('#more').onclick = e => { e.preventDefault(); open(true); };
  sb.addEventListener('click', e => { if (e.target.closest('a')) open(false); });
  $('#theme').onclick = () => { const d = document.documentElement.dataset.theme === 'dark'; document.documentElement.dataset.theme = d ? '' : 'dark'; store.set('theme', d ? 'light' : 'dark'); };
  if (!window.__shellWired) { window.__shellWired = true; wire($('#app'), { logout: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => { }); S.me = null; const hadLogin = location.hash === '#/login'; location.hash = '#/login'; if (hadLogin) await route(); } }); }
  // البحث الشامل
  let t; const q = $('#q'), sp = $('#sp');
  q.addEventListener('input', () => { clearTimeout(t); const v = q.value.trim(); if (v.length < 2) { sp.hidden = true; return; } t = setTimeout(async () => {
    try { const r = await api('/search?q=' + encodeURIComponent(v)); sp.hidden = false; sp.innerHTML = r.groups.length ? r.groups.map(g => `<h4>${esc(g.label)}</h4>${g.items.map(i => `<a href="${esc(i.link)}"><span class="b">${esc(i.title)}</span><small>${esc(i.sub)}</small></a>`).join('')}`).join('') : '<div class="state" style="padding:18px">لا توجد نتائج ضمن صلاحياتك</div>'; } catch { } }, 250); });
  sp.addEventListener('click', () => { sp.hidden = true; q.value = ''; });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) sp.hidden = true; });
  q.addEventListener('keydown', e => { if (e.key === 'Escape') { sp.hidden = true; q.blur(); } });
}
async function refreshBadges() {
  if (!S.me) return;
  try {
    const { unread } = await api('/notifications/count'); S.unread = unread;
    for (const id of ['nbadge', 'nbadge2', 'nbadge3']) { const el = $('#' + id); if (el) { el.hidden = !unread; el.textContent = unread > 99 ? '99+' : unread; } }
  } catch { }
}
function markNav() {
  const h = location.hash.split('?')[0];
  $$('[data-nav]').forEach(a => { const t = a.dataset.nav; const on = h === t || (t !== '#/home' && h.startsWith(t + '/') && !(t === '#/performance' && h.startsWith('#/performance/') )) ; a.classList.toggle('on', on); });
}

// ---------- الراوتر ----------
let seq = 0;
async function route() {
  const h = location.hash || '#/home';
  if (h.startsWith('#/reset')) return renderReset();
  if (!S.me) { if (h !== '#/login') { /* أعد توجيه */ } return renderLogin(); }
  if (!$('#view')) renderShell();
  const base = h.split('?')[0];
  const query = Object.fromEntries(new URLSearchParams(h.split('?')[1] || ''));
  const view = $('#view'); const my = ++seq;
  for (const [re, name] of routes) {
    const m = re.exec(base); if (!m) continue;
    markNav(); view.innerHTML = loading(); window.scrollTo(0, 0);
    try {
      const mod = await loadPage(name); if (my !== seq) return;
      const ctx = { el: view, params: m.slice(1), query, me: S.me, S, name, reload: () => route() };
      view.onclick = null; const fresh = view.cloneNode(false); view.replaceWith(fresh); fresh.innerHTML = loading();
      ctx.el = fresh; await mod.render(ctx);
      document.title = (fresh.querySelector('h1')?.textContent || 'المنصة') + ' — منصة الإدارة والأداء';
      refreshBadges();
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e); const v = $('#view'); v.innerHTML = e instanceof ApiError ? errorState(e) : state('error', 'حدث خطأ غير متوقع', 'تعذر عرض الصفحة. حاول مرة أخرى.', '<button class="btn" data-act="retry">إعادة المحاولة</button>');
      wire(v, { retry: () => route() });
    }
    return;
  }
  $('#view').innerHTML = state('empty', 'الصفحة غير موجودة', 'تحقق من الرابط أو عد إلى الصفحة الرئيسية.', '<a class="btn primary" href="#/home">الرئيسية</a>');
}
async function boot(skipRoute) {
  try { S.me = await api('/auth/me'); } catch { S.me = null; }
  await route();
}
window.addEventListener('hashchange', route);
window.addEventListener('session-expired', () => { if (S.me) { S.me = null; renderLogin('انتهت الجلسة. سجّل الدخول من جديد.'); } });
setInterval(refreshBadges, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
boot();
