// أدوات مشتركة: API، تنسيق، مكوّنات UI، رسوم SVG
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ApiError extends Error { constructor(status, message, details, code) { super(message); this.status = status; this.details = details; this.code = code; } }
export async function api(path, { method = 'GET', body, raw } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, { method, headers: { 'X-Requested-With': 'acc', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { throw new ApiError(0, 'تعذر الاتصال بالخادم. تحقق من الاتصال بالإنترنت وحاول مرة أخرى.'); }
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) { window.dispatchEvent(new Event('session-expired')); }
    throw new ApiError(res.status, data?.error?.message || 'تعذر إكمال العملية. حاول مرة أخرى.', data?.error?.details, data?.error?.code);
  }
  return data;
}
export const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== '' && v !== null && v !== undefined) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };

// ---------- تنسيق ----------
const D = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' });
const DS = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short' });
const DW = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long' });
const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
export const num = n => `<bdi class="num">${n === null || n === undefined ? '—' : NF.format(n)}</bdi>`;
export const ltr = s => `<bdi class="num">${esc(s)}</bdi>`;
export const pd = s => new Date(s + 'T00:00:00');
export const fdate = s => s ? D.format(pd(s.slice(0, 10))) : '—';
export const fshort = s => s ? DS.format(pd(s.slice(0, 10))) : '—';
export const fweek = s => s ? DW.format(pd(s.slice(0, 10))) : '';
export const ftime = t => t ? `<bdi class="num">${esc(t)}</bdi>` : '';
export const fdatetime = iso => { if (!iso) return '—'; const d = new Date(iso); return `${D.format(d)} <bdi class="num">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</bdi>`; };
export const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 1) return 'الآن'; if (m < 60) return `قبل ${m} دقيقة`; const h = Math.round(m / 60); if (h < 24) return `قبل ${h} ساعة`; return `قبل ${Math.round(h / 24)} يوم`; };
export const money = (n, cur = 'EGP') => n === null || n === undefined ? '—' : `<bdi class="num">${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)}</bdi> <span class="tiny muted">${esc(cur)}</span>`;
export const compact = n => { if (n === null || n === undefined) return '—'; const a = Math.abs(n); const f = (v, s) => `<bdi class="num">${NF.format(v)}</bdi>${s}`; return a >= 1e6 ? f(n / 1e6, ' مليون') : a >= 1e3 ? f(n / 1e3, ' ألف') : f(n, ''); };
const SF = v => { const a = Math.abs(v); return a >= 1e6 ? NF.format(v / 1e6) + 'M' : a >= 1e4 ? NF.format(v / 1e3) + 'K' : NF.format(v); };
// نص عربي يحتوي رموزًا/تواريخ: نعزل الرموز حتى لا ينعكس ترتيبها
export const rich = s => esc(s).replace(/([A-Z][A-Z0-9_]*-[0-9][0-9-]*|\d{4}-\d{2}(?:-\d{2})?|\d{4}-Q\d|[A-Z][A-Z0-9]*_[A-Z0-9_]+)/g, '<bdi class="num">$1</bdi>');
export const pct = n => n === null || n === undefined ? '—' : `<bdi class="num">${NF.format(n)}%</bdi>`;
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- تسميات ----------
export const L = {
  meetingStatus: { draft: ['مسودة', 'gray'], preparation: ['قيد التحضير', 'blue'], preparation_published: ['تم نشر التحضير', 'blue'], ready: ['جاهز', 'green'], live: ['جارٍ الآن', 'red'], minutes_draft: ['مسودة المحضر', 'amber'], under_review: ['قيد المراجعة', 'amber'], approved: ['معتمد', 'green'], closed: ['مغلق', 'gray'], cancelled: ['ملغى', 'gray'] },
  meetingType: { department: 'اجتماع قسم', business_unit: 'اجتماع وحدة نشاط', management: 'اجتماع إدارة', cross_functional: 'متعدد الأقسام', committee: 'لجنة', board: 'مجلس الإدارة' },
  mode: { in_person: 'حضوري', online: 'Online', hybrid: 'Hybrid' },
  prep: { not_ready: ['غير جاهزة', 'gray'], draft: ['مسودة', 'amber'], published: ['منشورة', 'green'], late: ['متأخرة', 'red'] },
  taskStatus: { not_started: ['لم تبدأ', 'gray'], in_progress: ['قيد التنفيذ', 'blue'], pending_review: ['بانتظار المراجعة', 'purple'], completed: ['مكتملة', 'green'], blocked: ['معطّلة', 'red'], cancelled: ['ملغاة', 'gray'] },
  priority: { low: ['منخفضة', 'gray'], medium: ['متوسطة', 'blue'], high: ['عالية', 'amber'], critical: ['حرجة', 'red'] },
  source: { meeting: 'اجتماع', management: 'الإدارة', kpi: 'KPI', initiative: 'مبادرة', operational: 'تشغيلية', project: 'مشروع', recurring: 'متكررة', corrective_action: 'إجراء تصحيحي' },
  kpiStatus: { green: ['أخضر', 'green'], amber: ['أصفر', 'amber'], red: ['أحمر', 'red'], missing: ['لا توجد بيانات', 'gray'] },
  quality: { missing: ['ناقصة', 'gray'], draft: ['Draft', 'amber'], submitted: ['مرسلة', 'blue'], verified: ['موثّقة', 'purple'], approved: ['معتمدة', 'green'] },
  decision: { open: ['مفتوح', 'gray'], in_progress: ['قيد التنفيذ', 'blue'], implemented: ['منفّذ', 'green'], closed: ['مغلق', 'gray'], cancelled: ['ملغى', 'gray'] },
  agenda: { pending: ['بانتظار', 'gray'], discussing: ['قيد النقاش', 'blue'], completed: ['مكتمل', 'green'], deferred: ['مؤجل', 'amber'] },
  agendaType: { information: 'معلومة', discussion: 'نقاش', decision_required: 'قرار مطلوب', follow_up: 'متابعة' },
  invitation: { invited: ['مدعو', 'gray'], accepted: ['قَبِل', 'green'], declined: ['اعتذر', 'red'] },
  attendance: { attended: ['حضر', 'green'], absent: ['غائب', 'red'], excused: ['معتذر', 'amber'] },
  initiative: { planned: ['مخططة', 'gray'], active: ['نشطة', 'blue'], at_risk: ['معرضة للخطر', 'red'], completed: ['مكتملة', 'green'], cancelled: ['ملغاة', 'gray'] },
  period: { open: ['مفتوحة', 'blue'], under_review: ['قيد المراجعة', 'amber'], approved: ['معتمدة', 'purple'], locked: ['مقفلة', 'gray'] },
  stage: { manager_review: 'مراجعة المدير', department_review: 'مراجعة القسم', management_calibration: 'معايرة الإدارة', final_approved: 'معتمد نهائيًا' },
  category: { financial: 'مالي', operational: 'تشغيلي', strategic: 'استراتيجي' },
  kpiType: { higher_better: 'الأعلى أفضل', lower_better: 'الأقل أفضل', target_range: 'نطاق مستهدف', exact_target: 'قيمة محددة', milestone: 'معالم', boolean: 'نعم/لا', formula: 'معادلة' },
  freq: { weekly: 'أسبوعي', monthly: 'شهري', quarterly: 'ربع سنوي', annual: 'سنوي', custom: 'مخصص' },
  level: { group: 'المجموعة', company: 'الشركة', business_unit: 'وحدة النشاط', department: 'القسم', team: 'الفريق', employee: 'موظف' },
  role: { employee: 'موظف', team_leader: 'قائد فريق', department_manager: 'مدير قسم', business_unit_manager: 'مدير وحدة نشاط', executive: 'الإدارة التنفيذية', hr_admin: 'HR / إدارة الأداء', system_admin: 'مدير النظام' },
  source_ds: { manual: 'يدوي', odoo: 'Odoo', spreadsheet: 'جدول بيانات', api: 'API', calculated: 'محسوب', other: 'أخرى' },
  sev: { critical: ['حرجة', 'red'], high: ['عالية', 'amber'], medium: ['متوسطة', 'gray'] },
  integ: { real: ['فعلي', 'green'], mock: ['Mock (تجريبي)', 'purple'], ready: ['جاهز غير مربوط', 'blue'], planned: ['مخطط', 'gray'] },
};
export const pill = (text, color = 'gray', nodot) => `<span class="pill ${color}${nodot ? ' nodot' : ''}">${esc(text)}</span>`;
export const lp = (map, key) => { const v = map[key]; return v ? pill(v[0], v[1]) : pill(key || '—'); };
export const dot = s => `<span class="dotc ${s}" title="${esc(L.kpiStatus[s]?.[0] || s)}"></span>`;

// ---------- أيقونات ----------
const P = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>', cal: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>', tasks: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>',
  kpi: '<path d="M12 21a9 9 0 110-18 9 9 0 010 18z"/><path d="M12 17a5 5 0 110-10 5 5 0 010 10z"/><circle cx="12" cy="12" r="1.2"/>', money: '<path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/>', flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  perf: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', report: '<path d="M6 3h9l5 5v13H6z"/><path d="M14 3v6h6M9 14h8M9 18h6"/>', bell: '<path d="M6 17V11a6 6 0 1112 0v6l2 2H4z"/><path d="M10 21h4"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.2-1.6l2-1.5-2-3.4-2.3 1a7 7 0 00-2.8-1.6L13.3 2h-2.6l-.4 2.9a7 7 0 00-2.8 1.6l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .5 0 1.1.2 1.6l-2 1.5 2 3.4 2.3-1a7 7 0 002.8 1.6l.4 2.9h2.6l.4-2.9a7 7 0 002.8-1.6l2.3 1 2-3.4-2-1.5c.2-.5.2-1.1.2-1.6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0114 0M16 4.5a3.5 3.5 0 010 7M22 20a6 6 0 00-5-5.9"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="3"/><path d="M16 10l6-3v10l-6-3"/>', alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', logout: '<path d="M10 4H5v16h5M15 8l5 4-5 4M20 12H9"/>', more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', check: '<path d="M5 13l4 4L19 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>', file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>', play: '<path d="M7 4l13 8-13 8z"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>', inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 118 0v3"/>', refresh: '<path d="M20 11A8 8 0 006 6L4 8M4 4v4h4M4 13a8 8 0 0014 5l2-2M20 20v-4h-4"/>', chevL: '<path d="M15 5l-7 7 7 7"/>', chevR: '<path d="M9 5l7 7-7 7"/>', moon: '<path d="M20 14A8 8 0 1110 4a7 7 0 0010 10z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
};
export const icon = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

// ---------- مكونات ----------
export const stat = (label, value, o = {}) => `<div class="card stat${o.href ? ' clickable' : ''}" ${o.href ? `data-href="${esc(o.href)}" role="link" tabindex="0"` : ''}><span class="lbl">${esc(label)}</span><span class="val ${o.cls || ''}">${value}</span>${o.sub ? `<span class="delta">${o.sub}</span>` : ''}</div>`;
export const bar = (v, cls = '') => `<div class="bar ${cls}" role="progressbar" aria-valuenow="${Math.round(v || 0)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(0, Math.min(100, v || 0))}%"></i></div>`;
export const scoreCls = s => s === null || s === undefined ? '' : s >= 85 ? 'green' : s >= 70 ? 'amber' : 'red';
export const ring = (v, label) => `<div class="ring" style="--p:${Math.max(0, Math.min(100, v || 0))};--c:var(--${scoreCls(v) === 'green' ? 'green' : scoreCls(v) === 'amber' ? 'amber' : v === null || v === undefined ? 'ink-3' : 'red'})"><div>${v === null || v === undefined ? '—' : Math.round(v)}</div></div>`;
export const delta = (cur, prev) => { if (cur === null || cur === undefined || prev === null || prev === undefined) return '<span class="muted">لا توجد فترة سابقة للمقارنة</span>'; const d = Math.round((cur - prev) * 10) / 10; return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} <bdi class="num">${Math.abs(d)}</bdi></span> <span class="muted">عن الفترة السابقة</span>`; };
export function state(kind, title, text, action) {
  const ic = { empty: 'inbox', error: 'alert', lock: 'lock' }[kind] || 'inbox';
  return `<div class="state">${icon(ic)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action || ''}</div>`;
}
export const loading = () => `<div class="stack" aria-busy="true"><div class="skel" style="width:40%;height:28px"></div><div class="grid g3"><div class="skel" style="height:110px"></div><div class="skel" style="height:110px"></div><div class="skel" style="height:110px"></div></div><div class="skel" style="height:220px"></div></div>`;
export const errorState = (e, retry = true) => state('error', e.status === 403 ? 'لا تملك صلاحية لعرض هذه الصفحة' : e.status === 404 ? 'السجل غير موجود' : 'تعذر تحميل البيانات', e.message, retry && e.status !== 403 && e.status !== 404 ? '<button class="btn" data-act="retry">إعادة المحاولة</button>' : '');

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.setAttribute('role', kind === 'err' ? 'alert' : 'status'); el.innerHTML = `${icon(kind === 'err' ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}
export function modal({ title, body, footer, wide, onClose }) {
  const back = document.createElement('div'); back.className = 'modal-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', title);
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}"><header><h3>${esc(title)}</h3><button class="btn ghost sm x" data-close aria-label="إغلاق">${icon('x')}</button></header><div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
  document.body.appendChild(back);
  const prev = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', key); prev?.focus?.(); onClose?.(); };
  const key = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  setTimeout(() => (back.querySelector('input,select,textarea,button.primary') || back.querySelector('button'))?.focus(), 30);
  return { el: back, close, $: s => back.querySelector(s) };
}
export function confirmBox(title, text, okLabel = 'تأكيد', danger = false) {
  return new Promise(res => {
    const m = modal({ title, body: `<p style="margin:0">${esc(text)}</p>`, footer: `<button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button><button class="btn" data-close>إلغاء</button>`, onClose: () => res(false) });
    m.el.querySelector('[data-ok]').onclick = () => { res(true); m.el.remove(); };
  });
}
export function promptBox(title, label, { required = true, okLabel = 'تأكيد', multiline = true } = {}) {
  return new Promise(res => {
    const m = modal({ title, body: `<div class="field"><label for="pb">${esc(label)}</label>${multiline ? '<textarea id="pb"></textarea>' : '<input id="pb">'}<div class="err" id="pberr"></div></div>`, footer: `<button class="btn primary" data-ok>${esc(okLabel)}</button><button class="btn" data-close>إلغاء</button>`, onClose: () => res(null) });
    m.el.querySelector('[data-ok]').onclick = () => { const v = m.$('#pb').value.trim(); if (required && !v) { m.$('#pberr').textContent = 'هذا الحقل مطلوب'; return; } res(v); m.el.remove(); };
  });
}
// قراءة قيم النموذج
export function readForm(root) {
  const o = {};
  $$('[name]', root).forEach(el => {
    if (el.type === 'checkbox') o[el.name] = el.checked; else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else o[el.name] = el.value === '' ? null : el.value;
  });
  return o;
}
export function showErrors(root, e) {
  $$('.field.bad', root).forEach(f => { f.classList.remove('bad'); f.querySelector('.err')?.remove(); });
  const d = e.details || {};
  let first = null;
  for (const [k, msg] of Object.entries(d)) {
    const el = root.querySelector(`[name="${k}"]`); const f = el?.closest('.field'); if (!f) continue;
    f.classList.add('bad'); const s = document.createElement('div'); s.className = 'err'; s.textContent = msg; f.appendChild(s); first ||= el;
  }
  first?.focus();
  const box = root.querySelector('.form-error'); if (box) { box.textContent = e.message; box.hidden = false; } else toast(e.message, 'err');
}
export const field = (label, input, { hint, full, req } = {}) => `<div class="field${full ? ' full' : ''}"><label>${esc(label)}${req ? ' <span class="muted">*</span>' : ''}</label>${input}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
export const opts = (items, sel, empty) => (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + items.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');

// ---------- رسوم SVG ----------
export function spark(vals, { w = 120, h = 32, color = 'var(--brand-2)' } = {}) {
  const v = vals.filter(x => x !== null && x !== undefined); if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), rg = mx - mn || 1; const pts = vals.map((x, i) => x === null ? null : [i / (vals.length - 1) * (w - 4) + 2, h - 4 - (x - mn) / rg * (h - 8)]).filter(Boolean);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="direction:ltr" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${pts.map(p => p.join(',')).join(' ')}"/><circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="3" fill="${color}"/></svg>`;
}
export function lineChart(series, { labels, target, w = 640, h = 220, fmtY = SF } = {}) {
  const all = series.flatMap(s => s.data).filter(v => v !== null && v !== undefined).concat(target !== undefined && target !== null ? [target] : []);
  if (!all.length) return '<div class="muted small">لا توجد بيانات للرسم</div>';
  let mn = Math.min(...all), mx = Math.max(...all); const pad = (mx - mn) * 0.15 || mx * 0.1 || 1; mn -= pad; mx += pad;
  const L_ = 62, R = 30, T = 14, B = 30; const n = labels.length;
  const X = i => L_ + (n === 1 ? (w - L_ - R) / 2 : i / (n - 1) * (w - L_ - R)); const Y = v => T + (1 - (v - mn) / (mx - mn)) * (h - T - B);
  let g = ''; for (let i = 0; i < 4; i++) { const v = mn + (mx - mn) * i / 3; g += `<line x1="${L_}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${L_ - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--ink-3)">${fmtY(v)}</text>`; }
  const xl = labels.map((l, i) => `<text x="${X(i)}" y="${h - 8}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${esc(l)}</text>`).join('');
  const tl = target !== undefined && target !== null ? `<line x1="${L_}" x2="${w - R}" y1="${Y(target)}" y2="${Y(target)}" stroke="var(--green)" stroke-width="1.6" stroke-dasharray="6 4"/><text x="${w - R}" y="${Y(target) - 5}" text-anchor="end" font-size="11" fill="var(--green)">المستهدف</text>` : '';
  const lines = series.map(s => { const pts = s.data.map((v, i) => v === null || v === undefined ? null : [X(i), Y(v)]); const seg = pts.filter(Boolean); return `<polyline fill="none" stroke="${s.color || 'var(--brand-2)'}" stroke-width="2.4" stroke-linejoin="round" points="${seg.map(p => p.join(',')).join(' ')}"/>` + pts.map((p, i) => p ? `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${(s.dotColors && s.dotColors[i]) || s.color || 'var(--brand-2)'}" stroke="var(--surface)" stroke-width="1.5"><title>${esc(labels[i])}: ${fmtY(s.data[i])}</title></circle>` : '').join(''); }).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" style="direction:ltr;width:100%;height:auto" role="img" aria-label="رسم بياني خطي">${g}${tl}${lines}${xl}</svg></div>`;
}
export function hbars(rows, { max = 120, w = 100 } = {}) {
  return `<div class="stack" style="gap:10px">${rows.map(r => `<div><div class="row spread small"><span>${esc(r.label)}</span><b>${r.value === null || r.value === undefined ? '—' : `<bdi class="num">${NF.format(r.value)}</bdi>`}</b></div><div class="bar ${scoreCls(r.value)}"><i style="width:${Math.min(100, (r.value || 0) / max * 100)}%"></i></div></div>`).join('')}</div>`;
}

// ---------- مساعد الأحداث ----------
export function wire(root, handlers) {
  root.addEventListener('click', async e => {
    const href = e.target.closest('[data-href]'); const a = e.target.closest('[data-act]');
    if (a && root.contains(a)) {
      const fn = handlers[a.dataset.act]; if (fn) { e.preventDefault(); if (a.disabled) return; try { await fn(a, e); } catch (err) { if (err instanceof ApiError) toast(err.message, 'err'); else { console.error(err); toast('حدث خطأ غير متوقع. حاول مرة أخرى.', 'err'); } } } return;
    }
    if (href && !e.target.closest('a,button,input,select')) { location.hash = href.dataset.href; }
  });
  root.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-href]')) { e.preventDefault(); location.hash = e.target.dataset.href; } });
}
export async function busy(btn, fn) { const t = btn.innerHTML; btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = t; } }
export const csvDownload = (path) => { location.href = '/api' + path; };
