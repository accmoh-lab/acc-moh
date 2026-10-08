'use strict';
// اختبارات End-to-End عبر المتصفح (Playwright): السيناريوهات A–D + Mobile.
// تشغيل: node tests/e2e.js  (يشغّل خادمًا مستقلًا بقاعدة بيانات مؤقتة)
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-'));
const PORT = 3200 + Math.floor(Math.random() * 500);
const B = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || path.join(tmp, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, DB_PATH: path.join(tmp, 'e2e.db'), FILES_DIR: path.join(tmp, 'files'), DEMO_MODE: '1', PORT: String(PORT), LOG_LEVEL: 'error' };
const results = []; let failed = 0; let current = null;
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`  ✔ ${name} (${Date.now() - t}ms)`); }
  catch (e) { failed++; results.push(['FAIL', name, e.message]); if (current) await current.screenshot({ path: path.join(SHOTS, 'FAIL_' + name.slice(0, 2) + '.png') }).catch(() => { }); console.log(`  ✘ ${name}\n      ${e.message.split('\n')[0]}`); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

async function main() {
  execFileSync(process.execPath, ['--no-warnings', 'src/seed.js', '--reset'], { cwd: ROOT, env, stdio: 'ignore' });
  const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  async function as(user, mobile = false) {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage(); current = page;
    page.on('pageerror', e => errors.push(`${user}: ${e.message}`));
    await page.goto(B + '/#/login');
    await page.fill('#em', `${user}@fasttrade.demo`); await page.fill('#pw', 'Demo@2026!'); await page.click('button[type=submit]');
    await page.waitForSelector('#view h1');
    return { page, ctx, go: async h => { await page.goto(B + '/' + h); await page.waitForSelector('#view h1, #view .state h3'); await page.waitForTimeout(150); }, shot: n => page.screenshot({ path: path.join(SHOTS, n + '.png') }) };
  }
  const text = async (page, sel = '#view') => page.$eval(sel, e => e.innerText);
  const clickText = async (page, t, sel = 'button,a') => { await page.locator(sel, { hasText: t }).first().click(); };
  const modalOk = async page => { await page.locator('.modal [data-ok]').click(); };

  console.log('Scenario A — Employee');
  const A = await as('mahmoud');
  await step('A1 dashboard shows next meeting, join, tasks and KPIs', async () => {
    const t = await text(A.page); expect(t.includes('اجتماعك القادم'), 'next meeting hero'); expect(t.includes('مهامي'), 'tasks'); expect(t.includes('مؤشراتي'), 'kpis'); await A.shot('A1_home');
  });
  await step('A2 read preparation pack', async () => {
    await A.page.locator('.hero a', { hasText: 'قراءة التحضير' }).click(); await A.page.waitForSelector('.tabs');
    await A.page.locator('.tabs button[data-tab="pack"]').click(); const t = await text(A.page);
    expect(t.includes('جدول الأعمال') && t.includes('حالة الخطة التصحيحية'), 'pack agenda visible'); await A.shot('A2_pack');
  });
  await step('A3 join meeting (mock clearly labelled)', async () => {
    await A.page.locator('[data-act="join"]').first().click(); await A.page.waitForSelector('.modal');
    const t = await A.page.$eval('.modal', e => e.innerText); expect(/Jitsi|تجريبي/.test(t), 'provider notice shown'); await A.page.locator('.modal [data-close]').first().click();
  });
  await step('A4 my tasks → update progress → evidence → complete', async () => {
    await A.go('#/tasks'); await A.page.locator('tr.link', { hasText: 'زيارة 10 عملاء' }).click(); await A.page.waitForSelector('#prog');
    await A.page.$eval('#prog', e => { e.value = 80; e.dispatchEvent(new Event('input')); }); await A.page.locator('[data-act="prog"]').click(); await A.page.waitForTimeout(400);
    expect((await text(A.page)).includes('80%'), 'progress saved');
    await A.page.locator('[data-act="ev"]').click(); await A.page.fill('#evn', 'تقرير الزيارات العشر مع النتائج'); await modalOk(A.page); await A.page.waitForTimeout(400);
    expect((await text(A.page)).includes('تقرير الزيارات العشر'), 'evidence listed');
    const sub = A.page.locator('[data-act="st"][data-v="pending_review"], [data-act="st"][data-v="completed"]').first(); await sub.click(); await A.page.waitForTimeout(500);
    const t = await text(A.page); expect(t.includes('مكتملة') || t.includes('بانتظار المراجعة'), 'status moved'); await A.shot('A4_task');
  });
  await step('A5 my KPIs → enter actual (Draft)', async () => {
    await A.go('#/kpis?mine=1'); await A.page.locator('tr.link', { hasText: 'حسابات كبار العملاء الجديدة' }).click(); await A.page.waitForSelector('[data-act="enter"]');
    await A.page.locator('[data-act="enter"]').click(); await A.page.waitForSelector('.modal [name=actual]'); await A.page.waitForTimeout(150); await A.page.fill('.modal [name=period]', '2026-10'); await A.page.fill('.modal [name=actual]', '3'); await modalOk(A.page); await A.page.waitForTimeout(500);
    expect(!(await A.page.$('.modal')), 'modal closed');
  });
  await step('A6 my performance shows breakdown, hides manager comment', async () => {
    await A.go('#/performance'); const t = await text(A.page); expect(t.includes('الدرجة المحسوبة') && t.includes('تفصيل الدرجة'), 'breakdown'); expect(!t.includes('تراجع واضح في استقطاب'), 'internal manager comment hidden'); await A.shot('A6_perf');
  });
  await A.ctx.close();

  console.log('Scenario B — Manager');
  const S = await as('sami');
  let meetingId, taskTitle = 'زيارة العملاء المتعثرين — اختبار E2E';
  await step('B1 my team & red KPI', async () => { await S.go('#/performance/team'); expect((await text(S.page)).includes('أحمد زيدان'), 'direct report row'); await S.go('#/performance/team?all=1'); expect((await text(S.page)).includes('محمود عادل'), 'scope row'); await S.go('#/home'); expect((await text(S.page)).includes('مؤشرات حمراء ضمن نطاقي'), 'red KPIs'); });
  await step('B2 red KPI → create management meeting with agenda item', async () => {
    await S.go('#/kpis'); await S.page.locator('tr.link', { hasText: 'إيرادات كبار العملاء' }).first().click(); await S.page.waitForSelector('[data-act="meet"]');
    await S.page.locator('[data-act="meet"]').click(); await S.page.locator('.modal [data-x="new"]').click(); await S.page.waitForURL(/meetings\/\d+/);
    meetingId = Number(S.page.url().match(/meetings\/(\d+)/)[1]); await S.page.waitForSelector('.agenda');
    expect((await text(S.page)).includes('انحراف KPI'), 'agenda item from KPI'); await S.shot('B2_agenda');
  });
  await step('B3 add participant, prepare and publish pack, ready, start', async () => {
    await S.go(`#/meetings/${meetingId}?tab=attendance`); await S.page.locator('[data-act="participants"]').click();
    await S.page.fill('.modal .pk-q', 'محمود'); await S.page.locator('.modal .pk-row:not([hidden]) .pk-c').first().check(); await modalOk(S.page); await S.page.waitForTimeout(400);
    for (const to of ['preparation', 'preparation_published', 'ready']) { await S.page.locator(`[data-act="move"][data-to="${to}"]`).click(); await S.page.waitForTimeout(500); }
    expect((await text(S.page)).includes('جاهز'), 'ready'); await S.page.locator('[data-act="move"][data-to="live"]').click(); await S.page.waitForSelector('.live-head');
  });
  await step('B4 live: attendance, decision, action item assigned to employee', async () => {
    const attSel = '[data-act="att"][data-v="attended"][data-mode="in_person"]'; const nAtt = await S.page.locator(attSel).count();
    for (let i = 0; i < nAtt; i++) { await S.page.locator(attSel).nth(i).click(); await S.page.waitForTimeout(300); }
    await S.page.locator('[data-act="st"][data-v="discussing"]').click().catch(() => { }); await S.page.waitForTimeout(300);
    await S.page.fill('#notes', 'الإيرادات أقل بـ17%؛ نحتاج زيارات مركزة'); await S.page.locator('#notes').blur();
    await S.page.locator('[data-act="dec"]').click(); await S.page.fill('.modal [name=text]', 'تنفيذ خطة استرداد خمسة عملاء متعثرين خلال أسبوعين');
    await S.page.selectOption('.modal [name=owner_id]', { label: /سامي القاضي/ }).catch(async () => { const v = await S.page.$eval('.modal [name=owner_id] option:nth-child(2)', o => o.value); await S.page.selectOption('.modal [name=owner_id]', v); });
    await modalOk(S.page); await S.page.waitForTimeout(500);
    await S.page.locator('[data-act="task"]').click(); await S.page.fill('.modal [name=title]', taskTitle);
    const opt = await S.page.$$eval('.modal [name=owner_id] option', os => os.find(o => o.textContent.includes('محمود عادل')).value); await S.page.selectOption('.modal [name=owner_id]', opt);
    await modalOk(S.page); await S.page.waitForTimeout(500);
    const t = await text(S.page); expect(t.includes('تنفيذ خطة استرداد') && t.includes(taskTitle), 'decision and task in live workspace'); await S.shot('B4_live');
  });
  await step('B5 complete item, end meeting, write & approve MoM, close', async () => {
    await S.page.locator('[data-act="st"][data-v="completed"]').click(); await S.page.waitForTimeout(400);
    await S.page.locator('[data-act="end"]').click(); await S.page.locator('.modal [data-ok]').click(); await S.page.waitForSelector('#mn-sum');
    await S.page.fill('#mn-sum', 'تمت مناقشة انحراف إيرادات كبار العملاء واعتماد خطة استرداد.'); await S.page.locator('[data-act="saveMinutes"]').click(); await S.page.waitForTimeout(300);
    await S.page.locator('[data-act="move"][data-to="under_review"]').click(); await S.page.waitForTimeout(400);
    await S.page.locator('[data-act="move"][data-to="approved"]').click(); await S.page.locator('.modal [data-ok]').click(); await S.page.waitForTimeout(400);
    await S.page.locator('[data-act="move"][data-to="closed"]').click(); await S.page.waitForTimeout(500);
    const t = await text(S.page); expect(t.includes('مغلق') && t.includes('Published'), 'closed with published MoM'); await S.shot('B5_mom');
  });
  const M = await as('mahmoud');
  await step('B6 employee sees the action item in tracker and submits completion', async () => {
    await M.go('#/tasks'); await M.page.locator('tr.link', { hasText: taskTitle }).click(); await M.page.waitForSelector('text=لماذا أُنشئت');
    const t = await text(M.page); expect(t.includes('لماذا أُنشئت') && t.includes('بسبب مؤشر'), 'trace shown');
    await M.page.locator('[data-act="st"][data-v="in_progress"]').click(); await M.page.waitForTimeout(400);
    await M.page.locator('[data-act="st"][data-v="pending_review"]').click(); await M.page.waitForTimeout(500);
    expect((await text(M.page)).includes('بانتظار المراجعة'), 'pending review');
  });
  await step('B7 manager reviews and approves completion', async () => {
    await S.go('#/home'); await S.page.locator('a', { hasText: taskTitle }).first().click(); await S.page.waitForSelector('[data-act="approve"]');
    await S.page.locator('[data-act="approve"]').click(); await S.page.waitForTimeout(500); const t = await text(S.page); expect(t.includes('مكتملة') && t.includes('معتمدة'), 'approved'); await S.shot('B7_approved');
  });
  await M.ctx.close();

  console.log('Scenario C — Executive');
  const O = await as('omar');
  await step('C1 executive dashboard with BU comparison and attention', async () => { const t = await text(O.page); expect(t.includes('مقارنة وحدات النشاط') && t.includes('Management Attention'), 'exec blocks'); await O.shot('C1_exec'); });
  await step('C2 drill-down company → BU → department → employee', async () => {
    await O.go('#/performance/org'); await O.page.locator('tr.link', { hasText: 'وحدة الأعمال التجارية' }).click(); await O.page.waitForTimeout(500);
    await O.page.locator('tr.link', { hasText: 'المبيعات' }).click(); await O.page.waitForTimeout(500);
    const t = await text(O.page); expect(t.includes('أداء: المبيعات'), 'department level'); await O.shot('C2_drill');
    await O.page.locator('tr.link', { hasText: 'فريق كبار العملاء' }).click(); await O.page.waitForTimeout(500); expect((await text(O.page)).includes('محمود عادل'), 'team employees');
  });
  await step('C3 management attention → financial variance → related KPI → meeting → decision', async () => {
    await O.go('#/attention?type=financial_variance'); expect((await text(O.page)).includes('انحراف مالي'), 'variance listed');
    await O.go('#/targets'); expect((await text(O.page)).includes('مجمل الربح'), 'targets');
    await O.page.locator('#view tr', { hasText: 'إيرادات المبيعات' }).locator('a[href^="#/kpis/"]').first().click(); await O.page.waitForSelector('text=الاجتماعات التي ناقشته');
    await O.page.locator('.card a.item[href^="#/meetings/"]', { hasText: 'مراجعة الأداء' }).first().click(); await O.page.waitForSelector('.tabs');
    await O.page.locator('.tabs button[data-tab="outcomes"]').click(); await O.page.locator('a.item[href^="#/decisions/"]').first().click(); await O.page.waitForSelector('text=المهام التنفيذية');
    const t = await text(O.page); expect(t.includes('المهام التنفيذية') && t.includes('المسار الإداري'), 'decision follow-up'); await O.shot('C3_decision');
  });
  await O.ctx.close();

  console.log('Scenario D — Board security');
  const L = await as('layla'); let boardUrl, docUrl;
  await step('D1 board member opens board meeting, documents and decisions', async () => {
    await L.go('#/board'); const t = await text(L.page); expect(t.includes('قرارات المجلس') && t.includes('مستندات المجلس'), 'board space');
    docUrl = await L.page.$eval('a[href^="/api/attachments/"]', a => a.getAttribute('href'));
    boardUrl = await L.page.$eval('a.item[href^="#/meetings/"]', a => a.getAttribute('href')); await L.go(boardUrl); expect((await text(L.page)).includes('مجلس الإدارة'), 'board meeting opens'); await L.shot('D1_board');
    const r = await L.page.evaluate(u => fetch(u).then(x => x.status), docUrl); expect(r === 200, 'board doc download 200');
  });
  await L.ctx.close();
  const S2 = await as('sami');
  await step('D2 manager is denied board meeting, board page and board document (server-side)', async () => {
    await S2.go(boardUrl); expect((await text(S2.page)).includes('غير موجود'), 'meeting 404 for manager');
    await S2.go('#/board'); expect((await text(S2.page)).includes('مقيدة'), 'board page locked');
    const r = await S2.page.evaluate(u => fetch(u).then(x => x.status), docUrl); expect(r === 404, 'doc 404, got ' + r);
    const id = boardUrl.match(/\d+/)[0]; const api = await S2.page.evaluate(i => fetch('/api/meetings/' + i).then(x => x.status), id); expect(api === 404, 'API 404'); await S2.shot('D2_denied');
  });
  await S2.ctx.close();

  console.log('Scenario E — Administration, KPI lifecycle, online meeting');
  const R = await as('rana');
  await step('E1 archive member with work reassignment, then restore', async () => {
    await R.go('#/admin/employees'); await R.page.locator('tr', { hasText: 'نورا عاطف' }).locator('[data-act="archive"]').click();
    await R.page.waitForSelector('.modal [name=reassign_to]'); const v = await R.page.$$eval('.modal [name=reassign_to] option', os => os.find(o => o.textContent.includes('مها رضوان')).value);
    await R.page.selectOption('.modal [name=reassign_to]', v); await R.page.fill('.modal [name=reason]', 'اختبار الأرشفة'); await modalOk(R.page); await R.page.waitForTimeout(600);
    await R.go('#/admin/employees?status=archived'); expect((await text(R.page)).includes('نورا عاطف'), 'in archive'); await R.shot('E1_archive');
    await R.page.locator('tr', { hasText: 'نورا عاطف' }).locator('[data-act="restore"]').click(); await R.page.locator('.modal [data-ok]').click(); await R.page.waitForTimeout(600);
    await R.go('#/admin/employees'); expect((await text(R.page)).includes('نورا عاطف'), 'restored');
  });
  await step('E2 add a member, rename it, then delete it', async () => {
    await R.page.locator('[data-act="new"]').click(); await R.page.waitForSelector('.modal [name=name]');
    await R.page.fill('.modal [name=name]', 'عضو تجريبي'); await R.page.fill('.modal [name=emp_no]', 'E888'); await R.page.fill('.modal [name=job_title]', 'محلل'); await R.page.fill('.modal [name=email]', 'e888@fasttrade.demo');
    const org = await R.page.$eval('.modal [name=org_unit_id] option:nth-child(3)', o => o.value); await R.page.selectOption('.modal [name=org_unit_id]', org); await modalOk(R.page); await R.page.waitForTimeout(600);
    await R.page.locator('tr', { hasText: 'عضو تجريبي' }).locator('[data-act="edit"]').click(); await R.page.waitForSelector('.modal [name=name]'); await R.page.fill('.modal [name=name]', 'عضو تجريبي معدّل'); await modalOk(R.page); await R.page.waitForTimeout(600);
    expect((await text(R.page)).includes('عضو تجريبي معدّل'), 'renamed');
    await R.page.locator('tr', { hasText: 'عضو تجريبي معدّل' }).locator('[data-act="del"]').click(); await R.page.locator('.modal [data-ok]').click(); await R.page.waitForTimeout(600);
    expect(!(await text(R.page)).includes('عضو تجريبي معدّل'), 'deleted');
  });
  await R.ctx.close();
  const O2 = await as('omar');
  await step('E3 archive a KPI and restore it', async () => {
    await O2.go('#/kpis'); await O2.page.locator('tr.link', { hasText: 'معدل تحويل العروض' }).click(); await O2.page.waitForSelector('[data-act="archive"]');
    await O2.page.locator('[data-act="archive"]').click(); await O2.page.locator('.modal [data-ok]').click(); await O2.page.waitForSelector('text=هذا المؤشر مؤرشف'); await O2.shot('E3_kpi_archived');
    await O2.page.locator('[data-act="restore"]').click(); await O2.page.waitForSelector('[data-act="archive"]');
  });
  await O2.ctx.close();
  const S3 = await as('sami');
  await step('E4 create online meeting with a real Jitsi link', async () => {
    await S3.go('#/meetings/new'); await S3.page.fill('[name=title]', 'اختبار اجتماع أونلاين'); await S3.page.selectOption('[name=mode]', 'online'); await S3.page.selectOption('[name=provider]', 'jitsi');
    await S3.page.fill('[name=objective]', 'اختبار الصوت والصورة'); await S3.page.click('button[type=submit]'); await S3.page.waitForURL(/meetings\/\d+/); await S3.page.waitForSelector('.tabs');
    await S3.page.locator('.tabs button[data-tab="overview"]').click(); await S3.page.waitForSelector('text=رابط فعلي');
    const href = await S3.page.$eval('a[href^="https://meet.jit.si/"]', a => a.href); expect(/meet\.jit\.si\/FastTrade-/.test(href), 'jitsi link'); await S3.shot('E4_jitsi');
  });
  await S3.ctx.close();

  console.log('Mobile');
  const MB = await as('mahmoud', true);
  await step('M1 mobile tab bar → tasks → task detail; join from home', async () => {
    const t = await text(MB.page); expect(t.includes('انضمام للاجتماع'), 'join on mobile home');
    await MB.page.locator('.tabbar a', { hasText: 'المهام' }).click(); await MB.page.waitForSelector('.only-mobile .item');
    await MB.page.locator('.only-mobile a.item').first().click(); await MB.page.waitForSelector('text=لماذا أُنشئت'); await MB.shot('M1_task');
    const overflow = await MB.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); expect(!overflow, 'no horizontal overflow');
    await MB.page.locator('.tabbar #more').click(); await MB.page.waitForSelector('.sidebar.open');
  });
  await MB.ctx.close();

  await browser.close(); srv.kill();
  if (errors.length) { failed++; console.log('Page errors:\n  ' + errors.join('\n  ')); }
  console.log(`\n${results.filter(r => r[0] === 'PASS').length} passed, ${failed} failed. Screenshots: ${SHOTS}`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
