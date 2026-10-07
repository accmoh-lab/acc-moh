'use strict';
// مهام دورية: إتاحة حزمة التحضير T-48h، تنبيهات المهام، تحديثات KPI المطلوبة، إغلاق الفترات.
// تعمل داخل العملية كل دقيقة (Simulation). في الإنتاج تُنقل إلى Scheduler/Worker منفصل.
const db = require('./db');
const notify = require('./notify');
const { today, addDays, nowIso, setting, diffDays } = require('./util');
const meetings = require('./domain/meetings');
const kpis = require('./domain/kpis');
const kpiEngine = require('./kpi_engine');

function taskAlerts() {
  const t0 = today(); let due = 0, over = 0;
  for (const t of db.all(`SELECT * FROM tasks WHERE deleted_at IS NULL AND status IN ('not_started','in_progress','blocked') AND due_date <= ?`, addDays(t0, 2))) {
    if (t.due_date < t0) { if (notify.send(t.owner_id, 'task_overdue', `مهمة متأخرة: ${t.title}`, `متأخرة ${diffDays(t0, t.due_date)} يومًا`, `#/tasks/${t.id}`, `over:${t.id}:${Math.floor(diffDays(t0, t.due_date) / 3)}`)) over++; }
    else if (notify.send(t.owner_id, 'task_due_soon', `تستحق قريبًا: ${t.title}`, t.due_date, `#/tasks/${t.id}`, `soon:${t.id}`)) due++;
  }
  return { due, over };
}
function kpiAlerts() {
  let n = 0;
  for (const k of db.all(`SELECT * FROM kpis WHERE deleted_at IS NULL AND approval_status = 'approved' AND data_source IN ('manual','spreadsheet','api','other') AND kpi_type <> 'formula'`)) {
    const key = kpis.dueKey(k.frequency); const r = kpiEngine.getResult(k.id, key);
    if (!r || r.actual === null) if (notify.send(k.data_owner_id || k.owner_id, 'kpi_update_required', `مطلوب تحديث KPI: ${k.name}`, `الفترة ${key}`, `#/kpis/${k.id}`, `kpiupd:${k.id}:${key}`)) n++;
  }
  return n;
}
function periodAlerts() {
  let n = 0;
  for (const p of db.all(`SELECT * FROM performance_periods WHERE status = 'open' AND end_date <= ?`, addDays(today(), 3)))
    for (const u of db.all(`SELECT id FROM employees WHERE system_role IN ('executive','hr_admin') AND active = 1`)) if (notify.send(u.id, 'period_closing', `اقتراب إغلاق الفترة: ${p.label}`, p.end_date, '#/performance/periods', `pc:${p.id}:${u.id}`)) n++;
  return n;
}
function runAll() {
  const out = { meetings: meetings.runAutomation(), tasks: taskAlerts(), kpi_alerts: kpiAlerts(), period_alerts: periodAlerts(), ran_at: nowIso() };
  db.insert('automation_runs', { job: 'all', ran_at: out.ran_at, summary: JSON.stringify(out) });
  return out;
}
let timer = null;
const start = (ms = 60000) => { if (!timer) { timer = setInterval(() => { try { runAll(); } catch (e) { require('./logger').error('automation', { err: String(e) }); } }, ms); timer.unref(); } };
module.exports = { runAll, start };
