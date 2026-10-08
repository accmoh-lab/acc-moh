'use strict';
// طبقة التكامل: كل Adapter يعلن حالته بوضوح (real / mock / ready / planned). لا يوجد تكامل إنتاجي مفعّل حاليًا.
const crypto = require('node:crypto');

const STATUS = {
  odoo: { key: 'odoo', name: 'Odoo Online 19.3', state: 'planned', note: 'مصدر/وجهة بيانات مستقبلية (موظفون، Actuals مالية). لم يُربط. التطبيق لا يعتمد على Odoo للدخول.' },
  teams: { key: 'teams', name: 'Microsoft Teams', state: 'mock', note: 'Mock Integration: يولّد رابطًا تجريبيًا. الربط الحقيقي يحتاج Microsoft Graph (OnlineMeetings.ReadWrite).' },
  google_meet: { key: 'google_meet', name: 'Google Meet', state: 'mock', note: 'Mock Integration: يولّد رابطًا تجريبيًا. الربط الحقيقي يحتاج Google Calendar API (conferenceData).' },
  jitsi: { key: 'jitsi', name: 'Jitsi Meet', state: 'real', note: 'روابط اجتماعات فعلية على meet.jit.si بدون حساب أو مفتاح API. قد يطلب الموقع من أول داخل تسجيل الدخول ليصبح منظِّم الاجتماع.' },
  google_calendar: { key: 'google_calendar', name: 'Google Calendar', state: 'planned', note: 'لم يُنفَّذ. الواجهة جاهزة لتصدير ملف ICS كبديل مؤقت.' },
  ms_calendar: { key: 'ms_calendar', name: 'Microsoft Calendar', state: 'planned', note: 'لم يُنفَّذ.' },
  email: { key: 'email', name: 'Email (SMTP)', state: 'mock', note: 'يُسجَّل في جدول outbox فقط ولا يُرسل بريد فعلي.' },
  push: { key: 'push', name: 'Push Notifications', state: 'mock', note: 'يُسجَّل في outbox فقط. يحتاج Web Push (VAPID) وPWA مثبّت.' },
  sso: { key: 'sso', name: 'SSO (OIDC/SAML)', state: 'ready', note: 'البنية جاهزة (جدول المستخدمين مستقل). لم يُربط مزوّد هوية.' },
  mfa: { key: 'mfa', name: 'MFA (TOTP)', state: 'ready', note: 'التحقق من TOTP منفّذ في الخادم عند وجود mfa_enabled. لا توجد شاشة تسجيل الجهاز بعد.' },
};
const list = () => Object.values(STATUS);

// مزوّد المؤتمرات (Mock): لا يتصل بأي خدمة خارجية
function createOnlineMeeting(provider, meeting) {
  if (!STATUS[provider] || !['teams', 'google_meet'].includes(provider)) throw new Error('provider');
  const id = crypto.randomBytes(5).toString('hex');
  const host = provider === 'teams' ? 'teams.microsoft.example' : 'meet.google.example';
  return { url: `https://${host}/mock/${id}`, mock: true, notice: 'رابط تجريبي (Mock) لم يُنشأ عبر API حقيقي.' };
}
// نوع الرابط يُستنتج من عنوانه: Jitsi فعلي، .example تجريبي، وغير ذلك رابط حقيقي أدخله المستخدم
function linkKind(url) {
  if (!url) return null;
  let host = ''; try { host = new URL(url).hostname; } catch { return 'manual'; }
  if (host === 'meet.jit.si') return 'jitsi';
  if (host.endsWith('.example')) return 'mock';
  return 'manual';
}
const PROVIDER_NAME = { teams: 'Microsoft Teams', google_meet: 'Google Meet', jitsi: 'Jitsi Meet' };
function providerLabel(m) {
  const k = linkKind(m.url);
  if (k === 'jitsi') return 'Jitsi Meet';
  if (k === 'manual') { try { const h = new URL(m.url).hostname; return /teams\.(microsoft|live)\.com/.test(h) ? 'Microsoft Teams' : /meet\.google\.com/.test(h) ? 'Google Meet' : /zoom\.us/.test(h) ? 'Zoom' : h; } catch { return 'رابط'; } }
  return PROVIDER_NAME[m.provider] || null;
}
function createJitsi(meeting) {
  const slug = `FastTrade-${String(meeting.code || 'MTG').replace(/[^A-Za-z0-9]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  return { url: `https://meet.jit.si/${slug}`, mock: false, notice: 'تم إنشاء رابط Jitsi Meet فعلي. افتحه من أي متصفح أو من تطبيق Jitsi على الهاتف.' };
}
function joinInfo(meeting) {
  if (!['online', 'hybrid'].includes(meeting.mode) || !meeting.url) return null;
  const kind = linkKind(meeting.url);
  return { url: meeting.url, provider: meeting.provider, provider_label: providerLabel(meeting), kind, mock: kind === 'mock',
    notice: kind === 'mock' ? 'هذا رابط تجريبي (Mock) لا يفتح اجتماعًا حقيقيًا. استخدم «رابط Jitsi فعلي» للتجربة، أو الصق رابط Teams/Meet/Zoom حقيقي.' : kind === 'manual' ? 'رابط أدخله منظّم الاجتماع.' : null };
}

// ملف ICS لتصدير الدعوة إلى أي Calendar (حل مؤقت حتى تُنفَّذ التكاملات)
function ics(m) {
  const d = m.meeting_date.replace(/-/g, ''); const t = m.start_time.replace(':', '') + '00';
  const end = new Date(`${m.meeting_date}T${m.start_time}:00`); end.setMinutes(end.getMinutes() + m.duration_min);
  const p = n => String(n).padStart(2, '0');
  const e = `${end.getFullYear()}${p(end.getMonth() + 1)}${p(end.getDate())}T${p(end.getHours())}${p(end.getMinutes())}00`;
  const esc = s => String(s || '').replace(/[,;]/g, ' ').replace(/\n/g, ' ');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ACC//Meetings//AR', 'BEGIN:VEVENT', `UID:${m.code}@acc`, `DTSTART:${d}T${t}`, `DTEND:${e}`, `SUMMARY:${esc(m.title)}`, `LOCATION:${esc(m.location || m.url)}`, `DESCRIPTION:${esc(m.objective)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
module.exports = { list, STATUS, createOnlineMeeting, createJitsi, joinInfo, linkKind, providerLabel, ics };
