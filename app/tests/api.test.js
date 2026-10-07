'use strict';
// اختبارات API شاملة: الأمان والصلاحيات + سلامة البيانات + سير العمل الكامل
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db'); process.env.FILES_DIR = path.join(tmp, 'files'); process.env.DEMO_MODE = '1'; process.env.NODE_ENV = 'test'; process.env.TZ = 'Africa/Cairo';
const { server } = require('../server');
const db = require('../src/db');
let B; const jar = {};
const PW = 'Demo@2026!';

before(async () => {
  require('../src/seed').seed(); require('../src/automation').runAll();
  await new Promise(r => server.listen(0, r)); B = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function req(who, method, p, body, headers = {}) {
  const h = { 'X-Requested-With': 'acc', ...headers };
  if (who && jar[who]) h.Cookie = jar[who];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { }
  return { s: r.status, j, txt, headers: r.headers };
}
async function login(who) { if (jar[who]) return; const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'acc' }, body: JSON.stringify({ email: `${who}@fasttrade.demo`, password: PW }) }); assert.equal(r.status, 200, `login ${who}`); jar[who] = r.headers.get('set-cookie').split(';')[0]; }
const G = (w, p) => req(w, 'GET', p); const P = (w, p, b) => req(w, 'POST', p, b ?? {}); const U = (w, p, b) => req(w, 'PUT', p, b ?? {});
const emp = no => db.get('SELECT * FROM employees WHERE emp_no = ?', no);
const meetingBy = title => db.get('SELECT * FROM meetings WHERE title LIKE ?', `%${title}%`);
const today = () => require('../src/util').today();
const addDays = (n) => require('../src/util').addDays(today(), n);

// ======================= Authentication =======================
test('auth: protected API requires session; CSRF header required; generic error on bad password; lockout', async () => {
  assert.equal((await G(null, '/home')).s, 401);
  const noCsrf = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const bad = await P(null, '/auth/login', { email: 'salma@fasttrade.demo', password: 'wrong' });
  assert.equal(bad.s, 401); assert.match(bad.j.error.message, /غير صحيحة/);
  const unknown = await P(null, '/auth/login', { email: 'nobody@x.com', password: 'wrong' });
  assert.equal(unknown.j.error.message, bad.j.error.message, 'no user enumeration');
  for (let i = 0; i < 5; i++) await P(null, '/auth/login', { email: 'dina@fasttrade.demo', password: 'wrong' });
  assert.equal((await P(null, '/auth/login', { email: 'dina@fasttrade.demo', password: PW })).s, 423, 'locked after 5 failures');
  assert.equal((await P(null, '/auth/login', { email: 'mohamed.old@fasttrade.demo', password: PW })).s, 401, 'inactive employee cannot log in');
});
test('auth: password reset flow (mock email) and password policy', async () => {
  const f = await P(null, '/auth/forgot', { email: 'fatma@fasttrade.demo' });
  assert.ok(f.j.demo_token);
  assert.equal((await P(null, '/auth/reset', { token: f.j.demo_token, password: 'short' })).s, 400);
  assert.equal((await P(null, '/auth/reset', { token: f.j.demo_token, password: 'NewPassword2026' })).s, 200);
  assert.equal((await P(null, '/auth/reset', { token: f.j.demo_token, password: 'NewPassword2027' })).s, 400, 'token single-use');
  assert.equal((await P(null, '/auth/login', { email: 'fatma@fasttrade.demo', password: 'NewPassword2026' })).s, 200);
  assert.ok(db.get(`SELECT 1 x FROM outbox WHERE channel = 'email' AND mock = 1`), 'email goes to mock outbox');
});

// ======================= Authorization & Scope =======================
test('security: board data is isolated from managers (meeting, decisions, documents, tasks, search)', async () => {
  for (const u of ['sami', 'layla', 'omar', 'tarek', 'admin']) await login(u);
  const bm = meetingBy('الموازنة المبدئية 2027');
  assert.equal((await G('sami', `/meetings/${bm.id}`)).s, 404, 'manager cannot open board meeting');
  assert.equal((await G('tarek', `/meetings/${bm.id}`)).s, 404, 'BU manager cannot open board meeting');
  assert.equal((await G('layla', `/meetings/${bm.id}`)).s, 200);
  assert.equal((await G('omar', `/meetings/${bm.id}`)).s, 200, 'CEO is board member');
  assert.equal((await G('admin', `/meetings/${bm.id}`)).s, 404, 'system admin has no board access');
  const dec = db.get('SELECT id FROM decisions WHERE meeting_id = ?', bm.id);
  assert.equal((await G('sami', `/decisions/${dec.id}`)).s, 404);
  assert.ok(!(await G('sami', '/decisions')).j.some(d => d.id === dec.id));
  const att = db.get(`SELECT id FROM attachments WHERE entity_type = 'meeting' AND entity_id = ?`, bm.id);
  assert.equal((await G('sami', `/attachments/${att.id}/download`)).s, 404, 'board document blocked');
  assert.equal((await G('layla', `/attachments/${att.id}/download`)).s, 200);
  const bt = db.get(`SELECT id FROM tasks WHERE confidentiality = 'board'`);
  assert.equal((await G('sami', `/tasks/${bt.id}`)).s, 404);
  assert.equal((await G('sami', '/meetings?type=board')).j.total, 0);
  const s = (await G('sami', '/search?q=' + encodeURIComponent('مجلس الإدارة'))).j;
  assert.ok(!s.groups.some(g => g.items.some(i => i.link === `#/meetings/${bm.id}`)), 'search respects board isolation');
  assert.equal((await P('sami', '/meetings', { title: 'x', type: 'board', meeting_date: addDays(5), start_time: '10:00', mode: 'in_person' })).s, 403, 'manager cannot create board meeting');
});
test('security: performance privacy (self, chain of command, cross-department, meeting peers, admin)', async () => {
  for (const u of ['mahmoud', 'salma', 'sami', 'yasser', 'rana', 'admin', 'ahmed']) await login(u);
  const mahmoud = emp('E040'), salma = emp('E041');
  assert.equal((await G('mahmoud', `/performance/employee/${salma.id}`)).s, 404, 'peer cannot see peer');
  assert.equal((await G('salma', `/performance/employee/${mahmoud.id}`)).s, 404, 'meeting co-participant cannot see review');
  assert.equal((await G('sami', `/performance/employee/${mahmoud.id}`)).s, 200, 'dept manager in scope');
  assert.equal((await G('ahmed', `/performance/employee/${mahmoud.id}`)).s, 200, 'team leader of employee');
  assert.equal((await G('yasser', `/performance/employee/${mahmoud.id}`)).s, 404, 'other department manager blocked');
  assert.equal((await G('rana', `/performance/employee/${mahmoud.id}`)).s, 200, 'HR sees all');
  assert.equal((await G('admin', '/performance/me')).s, 403, 'system admin has no performance data');
  assert.equal((await G('admin', `/performance/employee/${mahmoud.id}`)).s, 404);
  // الموظف لا يرى تعليق المدير قبل الاعتماد النهائي
  const me = (await G('mahmoud', '/performance/me?period=' + db.get(`SELECT key FROM performance_periods WHERE status = 'under_review'`).key)).j;
  assert.ok(me.assessment && me.assessment.pending && me.assessment.manager_comment === undefined);
  assert.equal(me.scorecard.manager_score, null);
  const asm = await G('mahmoud', `/assessments/${db.get(`SELECT key FROM performance_periods WHERE status = 'under_review'`).key}/${salma.id}`);
  assert.equal(asm.s, 404);
});
test('security: direct object access, role escalation, scope-limited lists, cross-department tasks', async () => {
  for (const u of ['mahmoud', 'sami', 'yasser', 'admin', 'maha']) await login(u);
  const mgmt = meetingBy('مراجعة الأداء');
  assert.equal((await G('mahmoud', `/meetings/${mgmt.id}`)).s, 404, 'not participant, not in scope');
  assert.equal((await G('sami', `/meetings/${mgmt.id}`)).s, 200);
  const credit = db.get(`SELECT id FROM tasks WHERE title LIKE '%سياسة الائتمان%'`);
  assert.equal((await G('mahmoud', `/tasks/${credit.id}`)).s, 404, 'other department task');
  assert.equal((await G('maha', `/tasks/${credit.id}`)).s, 404, 'ops manager cannot open finance task');
  assert.equal((await G('yasser', `/tasks/${credit.id}`)).s, 200);
  assert.equal((await U('mahmoud', `/employees/${emp('E040').id}/access`, { system_role: 'executive' })).s, 403, 'role escalation blocked');
  assert.equal((await U('admin', `/employees/${emp('E090').id}/access`, { system_role: 'employee' })).s, 403, 'admin cannot change own role');
  assert.equal((await G('mahmoud', '/attention')).s, 403);
  assert.equal((await G('mahmoud', '/targets?period=2026-09')).s, 403);
  assert.equal((await G('mahmoud', '/tasks?view=team')).s, 403);
  const sales = meetingBy('متابعة الخطة التصحيحية');
  assert.equal((await P('mahmoud', `/meetings/${sales.id}/transition`, { to: 'live' })).s, 403, 'participant cannot run meeting');
  assert.equal((await P('mahmoud', '/tasks', { title: 'x', owner_id: emp('E041').id, due_date: addDays(3) })).s, 403, 'employee cannot assign to others');
  // لا يرى المدير مهام قسم آخر في القائمة
  const list = (await G('sami', '/tasks?limit=500')).j.items;
  assert.ok(list.every(t => t.dept_id === emp('E020').dept_id || t.owner_id === emp('E020').id || t.created_by === emp('E020').id || t.reviewer_id === emp('E020').id), 'sami list limited to scope');
  const allEmp = (await G('sami', '/employees')).j;
  assert.ok(!allEmp.some(e => e.emp_no === 'E044'), 'manager cannot list finance employees');
});
test('security: KPI data entry restricted to data owner/scope; admin cannot read employee KPIs', async () => {
  for (const u of ['mahmoud', 'salma', 'admin']) await login(u);
  const k40 = db.get(`SELECT id FROM kpis WHERE code = 'NEW_ACC_40'`), k41 = db.get(`SELECT id FROM kpis WHERE code = 'NEW_ACC_41'`);
  assert.equal((await G('mahmoud', `/kpis/${k41.id}`)).s, 404);
  assert.equal((await U('mahmoud', `/kpis/${k41.id}/results/2026-10`, { actual: 9 })).s, 404);
  const rev = db.get(`SELECT id FROM kpis WHERE code = 'COLL_PCT'`);
  const r = await U('mahmoud', `/kpis/${rev.id}/results/2026-10`, { actual: 99 });
  assert.ok([403, 404].includes(r.s));
  assert.equal((await G('admin', `/kpis/${k40.id}`)).s, 404);
});

// ======================= Data integrity =======================
test('integrity: duplicates, weights, dates, transitions, owners, formulas', async () => {
  for (const u of ['rana', 'omar', 'sami']) await login(u);
  const team = db.get(`SELECT id FROM org_units WHERE code = 'T-KA'`).id;
  assert.equal((await P('rana', '/employees', { emp_no: 'E900', name: 'تجربة', job_title: 'x', email: 'salma@fasttrade.demo', org_unit_id: team })).s, 409, 'duplicate email');
  assert.equal((await P('rana', '/employees', { emp_no: 'E041', name: 'تجربة', job_title: 'x', email: 'new@x.com', org_unit_id: team })).s, 409, 'duplicate employee no');
  const w = await U('rana', '/scorecards', { org_unit_id: null, weights: { kpi_financial: 50, kpi_operational: 30, kpi_strategic: 10, tasks: 5, meeting_actions: 0, initiatives: 0, manager_assessment: 0 } });
  assert.equal(w.s, 400); assert.match(w.j.error.message, /100%/);
  assert.equal((await P('sami', '/tasks', { title: 'x', owner_id: emp('E040').id, start_date: addDays(5), due_date: addDays(1) })).s, 400, 'due before start');
  const draft = meetingBy('لجنة الائتمان');
  await login('yasser');
  const bad = await P('yasser', `/meetings/${draft.id}/transition`, { to: 'live' });
  assert.equal(bad.s, 409); assert.equal(bad.j.error.code, 'BAD_TRANSITION');
  assert.equal((await P('yasser', `/meetings/${draft.id}/transition`, { to: 'preparation' })).s, 200);
  assert.equal((await P('yasser', `/meetings/${draft.id}/transition`, { to: 'preparation_published' })).s, 400, 'publishing without agenda');
  const org = db.get(`SELECT id FROM org_units WHERE code = 'DEPT-SALES'`).id;
  assert.equal((await P('omar', '/kpis', { code: 'NO_OWNER', name: 'x', category: 'operational', level: 'department', org_unit_id: org, frequency: 'monthly', kpi_type: 'higher_better', target: 1 })).s, 400, 'KPI without owner');
  assert.equal((await P('omar', '/kpis', { code: 'BAD_F', name: 'x', category: 'operational', level: 'department', org_unit_id: org, owner_id: emp('E020').id, frequency: 'monthly', kpi_type: 'formula', formula: 'REV_M+require(1)' })).s, 400, 'unsafe formula');
  assert.equal((await P('omar', '/kpis', { code: 'BAD_F2', name: 'x', category: 'operational', level: 'department', org_unit_id: org, owner_id: emp('E020').id, frequency: 'monthly', kpi_type: 'formula', formula: 'UNKNOWN_X*2' })).s, 400, 'unknown code in formula');
  assert.equal((await P('omar', '/kpis', { code: 'BAD_R', name: 'x', category: 'operational', level: 'department', org_unit_id: org, owner_id: emp('E020').id, frequency: 'monthly', kpi_type: 'target_range', range_min: 5, range_max: 2 })).s, 400, 'invalid range');
  assert.equal((await P('omar', '/kpis', { code: 'BAD_W', name: 'x', category: 'operational', level: 'department', org_unit_id: org, owner_id: emp('E020').id, frequency: 'monthly', kpi_type: 'higher_better', target: 1, weight: -1 })).s, 400, 'negative weight');
});
test('integrity: locked period blocks silent edits; reopen keeps old snapshot; target change does not alter history', async () => {
  for (const u of ['omar', 'amr', 'rana']) await login(u);
  const locked = db.get(`SELECT * FROM performance_periods WHERE status = 'locked' ORDER BY start_date DESC LIMIT 1`);
  const rev = db.get(`SELECT * FROM kpis WHERE code = 'REV_KA'`);
  const r = await U('omar', `/kpis/${rev.id}/results/${locked.key}`, { actual: 1, reason: 'test' });
  assert.equal(r.s, 409); assert.equal(r.j.error.code, 'PERIOD_LOCKED');
  const salma = emp('E041');
  const before = (await G('rana', `/performance/employee/${salma.id}?period=${locked.key}`)).j.scorecard;
  assert.equal(before.source, 'snapshot');
  // تغيير المستهدف المستقبلي لا يغير التاريخ
  const k = db.get(`SELECT * FROM kpis WHERE code = 'NEW_ACC_41'`);
  assert.equal((await U('omar', `/kpis/${k.id}`, { target: 40, reason: 'test' })).s, 200);
  const after1 = (await G('rana', `/performance/employee/${salma.id}?period=${locked.key}`)).j.scorecard;
  assert.deepEqual(after1.components.map(c => c.score), before.components.map(c => c.score), 'snapshot unchanged');
  assert.ok(db.get(`SELECT 1 x FROM audit_log WHERE entity = 'kpi' AND entity_id = ? AND field = 'target'`, k.id), 'target change audited');
  // إعادة الفتح تتطلب سببًا، والإصدار القديم يبقى
  assert.equal((await P('rana', `/periods/${locked.id}/reopen`, {})).s, 400);
  assert.equal((await P('rana', `/periods/${locked.id}/reopen`, { reason: 'تصحيح خطأ إدخال' })).s, 200);
  assert.equal((await P('rana', `/periods/${locked.id}/transition`, { to: 'approved', acknowledge_gaps: true })).s, 200);
  assert.equal((await P('rana', `/periods/${locked.id}/transition`, { to: 'locked' })).s, 200);
  const versions = db.all('SELECT DISTINCT version FROM period_snapshots WHERE period_id = ? ORDER BY version', locked.id).map(x => x.version);
  assert.deepEqual(versions, [1, 2], 'both snapshot versions preserved');
  assert.ok(db.get(`SELECT 1 x FROM audit_log WHERE entity = 'period' AND entity_id = ? AND action = 'reopen'`, locked.id));
  const sales = db.get(`SELECT * FROM kpis WHERE code = 'NEW_ACC_41'`); assert.equal(sales.target, 40);
  await U('omar', `/kpis/${k.id}`, { target: 4, reason: 'restore' });
});
test('integrity: disabled employee with open tasks is blocked; missing actual excluded from score', async () => {
  await login('rana');
  const r = await U('rana', `/employees/${emp('E040').id}`, { active: false });
  assert.equal(r.s, 409); assert.equal(r.j.error.code, 'HAS_OPEN_WORK');
  const sc = require('../src/domain/perf').computeLive({ type: 'department', id: db.get(`SELECT id FROM org_units WHERE code = 'DEPT-HR'`).id }, { key: '2026-09', start: '2026-09-01', end: '2026-09-30' });
  const turnover = sc.components.flatMap(c => c.detail?.kpis || []).find(k => k.code === 'TURNOVER');
  assert.equal(turnover.counted, false, 'missing data not counted');
  const close = require('../src/domain/perf').computeLive({ type: 'department', id: db.get(`SELECT id FROM org_units WHERE code = 'DEPT-FIN'`).id }, { key: '2026-09', start: '2026-09-01', end: '2026-09-30' });
  assert.equal(close.components.flatMap(c => c.detail?.kpis || []).find(k => k.code === 'CLOSE_DAYS').counted, false, 'draft data not counted');
});
test('integrity: recurring task history kept; dependency cycle rejected; blocked by dependency', async () => {
  for (const u of ['amr', 'yasser', 'sami']) await login(u);
  const cur = db.get(`SELECT * FROM tasks WHERE series_id = 'close-m' AND status = 'in_progress'`);
  await P('amr', `/tasks/${cur.id}/evidence`, { note: 'تم الإقفال' });
  assert.equal((await P('amr', `/tasks/${cur.id}/status`, { to: 'pending_review' })).s, 200);
  assert.equal((await P('yasser', `/tasks/${cur.id}/review`, { decision: 'approve' })).s, 200);
  const series = db.all(`SELECT * FROM tasks WHERE series_id = 'close-m' ORDER BY occurrence_no`);
  assert.equal(series.length, 5, 'new occurrence created'); assert.equal(series[3].status, 'completed'); assert.equal(series[4].status, 'not_started');
  assert.ok(series.slice(0, 3).every(t => t.status === 'completed'), 'history preserved');
  const launch = db.get(`SELECT * FROM tasks WHERE title LIKE 'إطلاق حوافز%'`), incent = db.get(`SELECT * FROM tasks WHERE title LIKE 'اعتماد ميزانية الحوافز%'`);
  const blocked = await P('sami', `/tasks/${launch.id}/status`, { to: 'in_progress' });
  assert.equal(blocked.s, 409); assert.equal(blocked.j.error.code, 'BLOCKED_BY_DEPENDENCY');
  await login('nadia');
  const cyc = await U('nadia', `/tasks/${incent.id}/dependencies`, { dependencies: [{ depends_on_id: launch.id }] });
  assert.equal(cyc.s, 400, 'cycle rejected');
});

// ======================= Workflows =======================
test('workflow: full meeting cycle — KPI → agenda → pack → live → attendance → decision → task → MoM → close', async () => {
  for (const u of ['sami', 'mahmoud', 'ahmed']) await login(u);
  const kpi = db.get(`SELECT id FROM kpis WHERE code = 'REV_KA'`).id;
  const c = await P('sami', '/meetings', { title: 'اجتماع اختبار الدورة', type: 'department', meeting_date: today(), start_time: '00:05', duration_min: 45, mode: 'hybrid', provider: 'teams', objective: 'معالجة انحراف الإيرادات', participant_ids: [emp('E040').id, emp('E030').id] });
  assert.equal(c.s, 200); const id = c.j.id;
  const fk = await P('sami', '/meetings/from-kpi', { kpi_id: kpi, meeting_id: id }); assert.equal(fk.s, 200);
  assert.equal((await P('sami', `/meetings/${id}/online-link`)).j.mock, true);
  // قبل نشر الحزمة: المشارك لا يرى تفاصيل البند
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'preparation' })).s, 200);
  assert.ok(db.get(`SELECT 1 x FROM notifications WHERE employee_id = ? AND event = 'meeting_invitation' AND link = ?`, emp('E040').id, `#/meetings/${id}`), 'invitation sent');
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'preparation_published' })).s, 200);
  const md = (await G('mahmoud', `/meetings/${id}`)).j;
  assert.ok(md.prep_pack && md.prep_pack.agenda.length === 1, 'pack released inside 48h window');
  assert.equal((await U('mahmoud', `/meetings/${id}/rsvp`, { invitation: 'accepted' })).s, 200);
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'ready' })).s, 200);
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'live' })).s, 200);
  assert.ok((await G('mahmoud', `/meetings/${id}/join`)).j.url, 'join available for participant while live');
  const ag = md.agenda[0].id;
  assert.equal((await U('sami', `/agenda/${ag}/live`, { status: 'discussing', discussion_notes: 'نقاش' })).s, 200);
  const d = await P('sami', `/meetings/${id}/decisions`, { text: 'خطة استرداد كبار العملاء', owner_id: emp('E030').id, agenda_item_id: ag, effective_date: addDays(10) });
  assert.match(d.j.code, /^DEC-\d{4}-\d{4}$/);
  const t = await P('sami', '/tasks', { title: 'زيارة 5 عملاء متعثرين', owner_id: emp('E040').id, reviewer_id: emp('E030').id, due_date: addDays(5), meeting_id: id, decision_id: d.j.id, agenda_item_id: ag, kpi_id: kpi, source: 'corrective_action', requires_approval: true, evidence_required: true, priority: 'high' });
  assert.equal(t.s, 200);
  const ended = await P('sami', `/meetings/${id}/transition`, { to: 'minutes_draft' });
  assert.equal(ended.s, 400, 'cannot end while item discussing / attendance missing');
  await U('sami', `/agenda/${ag}/live`, { status: 'completed' });
  for (const [e, a] of [['E020', 'attended'], ['E040', 'attended'], ['E030', 'excused']]) assert.equal((await U('sami', `/meetings/${id}/attendance/${emp(e).id}`, { attendance: a, attendance_mode: e === 'E040' ? 'online' : undefined })).s, 200);
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'minutes_draft' })).s, 200);
  assert.equal((await P('sami', `/meetings/${id}/transition`, { to: 'under_review' })).s, 400, 'empty minutes rejected');
  assert.equal((await U('sami', `/meetings/${id}/minutes`, { summary: 'تمت مناقشة الانحراف واعتماد خطة', next_meeting_note: 'متابعة الأسبوع القادم' })).s, 200);
  for (const to of ['under_review', 'approved', 'closed']) assert.equal((await P('sami', `/meetings/${id}/transition`, { to })).s, 200, to);
  const closed = (await G('mahmoud', `/meetings/${id}`)).j;
  assert.equal(closed.minutes.attendance_snapshot.find(p => p.employee_id === emp('E040').id).attendance_mode, 'online', 'actual attendance saved in MoM');
  // المهمة في المتتبع، مع التتبع الكامل
  const my = (await G('mahmoud', '/tasks?view=my')).j.items; assert.ok(my.some(x => x.id === t.j.id));
  const tr = (await G('mahmoud', `/trace/task/${t.j.id}`)).j; const types = new Set(tr.nodes.map(n => n.type));
  for (const ty of ['kpi', 'meeting', 'decision', 'task']) assert.ok(types.has(ty), 'trace has ' + ty);
  // التنفيذ: 100% لا يعني مكتملة؛ يلزم دليل ثم اعتماد
  assert.equal((await U('mahmoud', `/tasks/${t.j.id}`, { progress: 100 })).s, 200);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t.j.id).status, 'in_progress');
  assert.equal((await P('mahmoud', `/tasks/${t.j.id}/status`, { to: 'completed' })).s, 409);
  assert.equal((await P('mahmoud', `/tasks/${t.j.id}/status`, { to: 'pending_review' })).s, 400, 'evidence required');
  await P('mahmoud', `/tasks/${t.j.id}/evidence`, { note: 'تقرير الزيارات' });
  assert.equal((await P('mahmoud', `/tasks/${t.j.id}/status`, { to: 'pending_review' })).s, 200);
  assert.equal((await P('mahmoud', `/tasks/${t.j.id}/review`, { decision: 'approve' })).s, 403, 'cannot self-approve');
  assert.equal((await P('ahmed', `/tasks/${t.j.id}/review`, { decision: 'return' })).s, 400, 'return needs reason');
  assert.equal((await P('ahmed', `/tasks/${t.j.id}/review`, { decision: 'return', reason: 'أضف أرقام المبيعات' })).s, 200);
  assert.equal((await P('mahmoud', `/tasks/${t.j.id}/status`, { to: 'pending_review' })).s, 200);
  assert.equal((await P('ahmed', `/tasks/${t.j.id}/review`, { decision: 'approve' })).s, 200);
  const done = db.get('SELECT * FROM tasks WHERE id = ?', t.j.id);
  assert.equal(done.status, 'completed'); assert.equal(done.approval_status, 'approved');
});
test('workflow: preparation pack hidden from participants until T-48h; leader sees it', async () => {
  for (const u of ['sami', 'tarek']) await login(u);
  const bu = meetingBy('وحدة الأعمال التجارية');
  const asP = (await G('sami', `/meetings/${bu.id}`)).j;
  assert.equal(asP.prep_pack, null); assert.equal(asP.prep_hidden, true);
  assert.ok((await G('tarek', `/meetings/${bu.id}`)).j.prep_pack);
  // الأتمتة تُتيحها عند دخول نافذة 48 ساعة
  db.run('UPDATE meetings SET meeting_date = ? WHERE id = ?', addDays(1), bu.id);
  require('../src/automation').runAll();
  assert.ok((await G('sami', `/meetings/${bu.id}`)).j.prep_pack, 'released by automation');
});
test('workflow: KPI data quality Draft → Submitted → Verified → Approved with separation of duties; rollup recalculated', async () => {
  for (const u of ['mahmoud', 'sami', 'ahmed', 'omar']) await login(u);
  const ka = db.get(`SELECT * FROM kpis WHERE code = 'REV_KA'`);
  const key = '2026-10';
  assert.equal((await U('mahmoud', `/kpis/${ka.id}/results/${key}`, { actual: 6900000 })).s, 200);
  assert.equal(db.get('SELECT data_quality FROM kpi_results WHERE kpi_id = ? AND period_key = ?', ka.id, key).data_quality, 'draft');
  assert.equal((await P('mahmoud', `/kpis/${ka.id}/results/${key}/submit`)).s, 200);
  assert.equal((await P('mahmoud', `/kpis/${ka.id}/results/${key}/verify`)).s, 403);
  assert.equal((await P('sami', `/kpis/${ka.id}/results/${key}/verify`)).s, 200);
  assert.equal((await P('ahmed', `/kpis/${ka.id}/results/${key}/approve`)).s, 200);
  assert.equal(db.get('SELECT data_quality FROM kpi_results WHERE kpi_id = ? AND period_key = ?', ka.id, key).data_quality, 'approved');
  const parent = db.get(`SELECT r.* FROM kpi_results r JOIN kpis k ON k.id = r.kpi_id WHERE k.code = 'REV_M' AND r.period_key = ?`, key);
  assert.equal(parent.actual, null, 'parent waits for all children (no partial double counting)');
  await login('ibrahim');
  const fs_ = db.get(`SELECT * FROM kpis WHERE code = 'REV_FS'`);
  assert.equal((await U('ibrahim', `/kpis/${fs_.id}/results/${key}`, { actual: 4100000 })).s, 200);
  assert.equal(db.get(`SELECT r.actual FROM kpi_results r JOIN kpis k ON k.id = r.kpi_id WHERE k.code = 'REV_M' AND r.period_key = ?`, key).actual, 11000000, 'rollup sum');
  const gm = db.get(`SELECT r.* FROM kpi_results r JOIN kpis k ON k.id = r.kpi_id WHERE k.code = 'GM_PCT' AND r.period_key = '2026-09'`);
  assert.ok(Math.abs(gm.actual - 23.96) < 0.01, 'formula KPI computed');
});
test('workflow: assessment calibration stages with audit trail; final rating separate from calculated score', async () => {
  for (const u of ['ahmed', 'sami', 'omar', 'mahmoud']) await login(u);
  const key = db.get(`SELECT key FROM performance_periods WHERE status = 'under_review'`).key; const m = emp('E040');
  assert.equal((await U('ahmed', `/assessments/${key}/${m.id}`, { manager_score: 120 })).s, 400);
  assert.equal((await U('ahmed', `/assessments/${key}/${m.id}`, { manager_score: 64, feedback_for_employee: 'ركز على الحسابات الجديدة' })).s, 200);
  assert.equal((await P('ahmed', `/assessments/${key}/${m.id}/advance`, {})).s, 200);
  assert.equal((await P('ahmed', `/assessments/${key}/${m.id}/advance`, {})).s, 403, 'team leader cannot do department review');
  assert.equal((await P('sami', `/assessments/${key}/${m.id}/advance`, {})).s, 200);
  assert.equal((await P('omar', `/assessments/${key}/${m.id}/advance`, { final_rating: 'رقم غير موجود' })).s, 400);
  assert.equal((await P('omar', `/assessments/${key}/${m.id}/advance`, { final_rating: 'يحتاج إلى تحسين' })).s, 200);
  const me = (await G('mahmoud', '/performance/me?period=' + key)).j;
  assert.equal(me.assessment.final_rating, 'يحتاج إلى تحسين'); assert.equal(me.assessment.feedback_for_employee, 'ركز على الحسابات الجديدة');
  assert.equal(me.assessment.manager_comment, undefined, 'internal comment stays private');
  assert.notEqual(me.scorecard.calculated_score, null);
  assert.ok(db.all(`SELECT * FROM assessment_stages s JOIN assessments a ON a.id = s.assessment_id WHERE a.employee_id = ?`, m.id).length >= 3);
});
test('import: template, preview with validation/duplicates, commit; export respects permissions', async () => {
  for (const u of ['rana', 'mahmoud']) await login(u);
  assert.equal((await G('rana', '/import/employees/template')).s, 200);
  const csv = 'emp_no,name,job_title,email,phone,org_code,manager_emp_no,active\nE500,موظف جديد,محاسب,new500@fasttrade.demo,,DEPT-FIN,E021,1\nE041,مكرر,x,dup@x.com,,DEPT-FIN,,1\nE501,خطأ,x,bad-email,,NOPE,,1\nE500,مكرر داخل الملف,x,z@x.com,,DEPT-FIN,,1';
  const pv = (await P('rana', '/import/employees/preview', { csv })).j;
  assert.equal(pv.valid, 1); assert.equal(pv.duplicates, 2); assert.equal(pv.errors, 1);
  assert.equal((await P('rana', '/import/employees/commit', { csv })).s, 400, 'errors block commit');
  const cm = (await P('rana', '/import/employees/commit', { csv, skip_errors: true })).j;
  assert.equal(cm.created, 1); assert.ok(emp('E500'));
  assert.equal((await G('mahmoud', '/export/employees')).s, 403);
  assert.equal((await P('mahmoud', '/import/employees/preview', { csv })).s, 403);
  const ex = await G('mahmoud', '/export/tasks'); assert.equal(ex.s, 200); assert.ok(!ex.txt.includes('سياسة الائتمان'), 'export limited to visible tasks');
});
test('management attention lists exceptions with severity, owner, age, source and action', async () => {
  await login('omar');
  const a = (await G('omar', '/attention')).j;
  for (const t of ['red_kpi', 'financial_variance', 'overdue_task', 'blocked_task', 'decision_not_implemented', 'initiative_at_risk', 'missing_kpi_data', 'pending_approval', 'late_prep_pack']) assert.ok(a.counts[t] > 0, 'has ' + t);
  for (const i of a.items) for (const f of ['severity', 'title', 'age_days', 'impact', 'source', 'recommended']) assert.ok(i[f] !== undefined, f);
  const home = (await G('omar', '/home')).j;
  assert.ok(home.executive && home.executive.bu.length === 2 && home.executive.financial.achievement > 0);
});
test('API errors never expose technical details', async () => {
  await login('omar');
  const r = await G('omar', '/meetings/abc');
  assert.ok([404].includes(r.s)); assert.ok(!/SQLITE|stack|at /.test(r.txt));
});
