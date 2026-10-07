'use strict';
// مركز الإشعارات: تفضيلات لكل حدث + منع التكرار (dedupe) لتجنب Notification Spam.
// الإرسال عبر البريد وPush هنا Mock: يُسجَّل في outbox فقط ولا يُرسل فعليًا.
const db = require('./db');
const { nowIso } = require('./util');

const EVENTS = {
  meeting_invitation: 'دعوة اجتماع', prep_published: 'نشر حزمة التحضير', meeting_approaching: 'اقتراب موعد اجتماع',
  task_assigned: 'إسناد مهمة', task_due_soon: 'مهمة تستحق قريبًا', task_overdue: 'مهمة متأخرة', task_returned: 'مهمة معادة للتعديل',
  kpi_update_required: 'مطلوب تحديث KPI', kpi_red: 'KPI أحمر', review_required: 'مطلوب مراجعة', period_closing: 'قرب إغلاق فترة',
  performance_review_pending: 'تقييم أداء بانتظار الإجراء', initiative_at_risk: 'مبادرة معرضة للخطر', mom_published: 'نشر محضر الاجتماع',
  prep_late: 'تأخر حزمة التحضير',
};
// الأحداث التي تُرسل دائمًا في التطبيق ولا يمكن إيقافها
const CRITICAL = new Set(['task_assigned', 'meeting_invitation', 'review_required']);

function prefs(employeeId, event) {
  const p = db.get('SELECT * FROM notification_prefs WHERE employee_id = ? AND event = ?', employeeId, event);
  return p || { in_app: 1, email: 0, push: 0 };
}
function send(employeeId, event, title, body, link, dedupeKey) {
  if (!employeeId) return null;
  const p = prefs(employeeId, event);
  if (!p.in_app && !CRITICAL.has(event)) return null;
  try {
    const id = db.insert('notifications', { employee_id: employeeId, event, title, body, link, dedupe_key: dedupeKey || null, created_at: nowIso() });
    if (p.email) db.insert('outbox', { channel: 'email', employee_id: employeeId, subject: title, body, mock: 1, created_at: nowIso() });
    if (p.push) db.insert('outbox', { channel: 'push', employee_id: employeeId, subject: title, body, mock: 1, created_at: nowIso() });
    return id;
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return null;             // نفس الإشعار أُرسل سابقًا
    throw e;
  }
}
const many = (ids, ...a) => [...new Set(ids.filter(Boolean))].forEach(id => send(id, ...a));

module.exports = { EVENTS, send, many, CRITICAL };
