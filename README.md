# منصة الإدارة والأداء — Meetings · Decisions · Tasks · KPIs · Performance

Web App مستقل، عربي RTL أولًا، يربط دورة الإدارة كاملة:

**KPI / Target ← انحراف ← Management Attention ← اجتماع ← قرار ← مهمة (مسؤول + موعد) ← تنفيذ ← دليل ومراجعة ← تحديث KPI ← مراجعة الأداء**

> البيانات الحالية تجريبية لشركة وهمية «فاست تريد». التقرير الكامل للحالة والاختبارات والفجوات: [`docs/IMPLEMENTATION_REPORT.md`](docs/IMPLEMENTATION_REPORT.md).

## التشغيل السريع

المتطلبات: Node.js 22.5 أو أحدث. لا توجد حزم npm خارجية.

```bash
cd app
npm run seed                      # إنشاء قاعدة البيانات وبيانات Demo
DEMO_MODE=1 npm start             # http://localhost:3000
```

## الحسابات التجريبية (Demo Mode فقط)

كلمة المرور الموحدة: `Demo@2026!` — وتظهر أزرار دخول سريع في صفحة الدخول عند `DEMO_MODE=1`.

| الدور | البريد |
|---|---|
| Employee | mahmoud@fasttrade.demo |
| Team Leader | ahmed@fasttrade.demo |
| Department Manager (المبيعات) | sami@fasttrade.demo |
| Business Unit Manager | tarek@fasttrade.demo |
| Executive (الرئيس التنفيذي + عضو مجلس) | omar@fasttrade.demo |
| Board Member (رئيسة المجلس) | layla@fasttrade.demo |
| Board Secretary | hana@fasttrade.demo |
| HR / Performance Admin | rana@fasttrade.demo |
| System Admin | admin@fasttrade.demo |

## الاختبارات

```bash
cd app
npm test             # 17 اختبار API: الأمان، سلامة البيانات، سير العمل
npm run test:e2e     # 19 خطوة End-to-End في المتصفح (Playwright + Chromium)
node tests/load.js   # اختبار حمل: 600 موظف و30,000 مهمة
```

## البنية

| الطبقة | التقنية الحالية | الانتقال المخطط |
|---|---|---|
| Frontend | SPA بـES Modules بدون Build، خط IBM Plex Sans Arabic مستضاف ذاتيًا، PWA (manifest + Service Worker) | — |
| Backend/API | Node.js `http` + Router داخلي، Domains منفصلة في `app/src/domain` | — |
| Database | SQLite (`node:sqlite`) مع Migrations بـSQL قريب من ANSI | PostgreSQL |
| Files | مجلد محلي مع تحكم بالصلاحيات عند التنزيل | Object Storage (S3-compatible) |
| Integrations | `app/src/integrations` — Teams/Meet/Email/Push = Mock معلن؛ Odoo/Calendars = Planned | Adapters حقيقية |

الوحدة السابقة `acc_meeting/` (Odoo module) محفوظة كما هي للمرجعية، ولا يعتمد عليها التطبيق.
