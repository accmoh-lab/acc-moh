import { $, esc, api, qs, icon, L, lp, num, ltr, state, wire, opts } from '../core.js';
import { pageHead } from '../ui.js';
const DESC = { meeting_effectiveness: 'الحضور والقرارات والمهام الناتجة لكل اجتماع', attendance: 'نسبة حضور كل موظف', decision_execution: 'حالة تنفيذ القرارات ومهامها', task_performance: 'الإنجاز والالتزام بالمواعيد لكل مسؤول', overdue_tasks: 'كل المهام المتأخرة', kpi_performance: 'المستهدف والفعلي والحالة لكل مؤشر', financial_achievement: 'الأهداف المالية والانحرافات', department_performance: 'درجات الأقسام ومكوّناتها', business_unit_performance: 'درجات وحدات النشاط', employee_performance: 'سرّي: الدرجات والتقييمات', initiative_performance: 'تقدم المبادرات ومهامها', period_comparison: 'تطور الأداء عبر الفترات' };
const CELL = (k, v) => v === null || v === undefined ? '<span class="muted">—</span>' : typeof v === 'number' ? num(v) : k === 'status' && L.taskStatus[v] ? lp(L.taskStatus, v) : k === 'status' && L.kpiStatus[v] ? lp(L.kpiStatus, v) : k === 'status' && L.decision[v] ? lp(L.decision, v) : /^\d{4}-\d{2}(-\d{2}|-Q\d)?$/.test(v) ? ltr(v) : esc(v);
export async function render(ctx) {
  const { el, name, params, query } = ctx;
  if (name === 'reports') {
    const list = await api('/reports');
    el.innerHTML = `${pageHead('مركز التقارير', 'التقارير متاحة حسب دورك ونطاقك. التصدير CSV يحترم الصلاحيات ويُسجل في التدقيق.')}<div class="grid g3">${list.map(r => `<a class="card" href="#/reports/${r.key}" style="color:inherit;text-decoration:none"><h3>${icon('report')} ${esc(r.title)}</h3><p class="small muted" style="margin:6px 0 0">${esc(DESC[r.key] || '')}</p></a>`).join('')}</div>`;
    return;
  }
  const f = { from: query.from || '', to: query.to || '', period: query.period || '' };
  const r = await api(`/reports/${params[0]}` + qs(f));
  el.innerHTML = `${pageHead(r.title, r.note ? esc(r.note) : `${r.total} سجل`, `<a class="btn" href="/api/reports/${params[0]}${qs({ ...f, format: 'csv' })}">${icon('download')} تصدير CSV</a><button class="btn ghost" data-act="print">طباعة</button>`, '<a href="#/reports">التقارير</a>')}
   <div class="filters"><div class="field"><label for="rf">من</label><input type="date" id="rf" value="${esc(f.from)}"></div><div class="field"><label for="rt">إلى</label><input type="date" id="rt" value="${esc(f.to)}"></div><div class="field"><label for="rp">الفترة</label><input id="rp" dir="ltr" placeholder="2026-09" value="${esc(f.period)}"></div><button class="btn" data-act="apply">تطبيق</button></div>
   ${r.rows.length ? `<div class="tablewrap"><table><thead><tr>${r.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(row => `<tr>${r.columns.map(c => `<td>${CELL(c.key, row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${r.total > r.rows.length ? `<p class="small muted">يُعرض ${r.rows.length} من ${r.total}. التصدير يشمل الكل.</p>` : ''}` : `<div class="card">${state('empty', 'لا توجد بيانات', 'غيّر الفلاتر أو الفترة.')}</div>`}`;
  wire(el, { apply: () => { location.hash = `#/reports/${params[0]}` + qs({ from: $('#rf', el).value, to: $('#rt', el).value, period: $('#rp', el).value }); }, print: () => window.print() });
}
