'use strict';
// اختبار حمل خفيف: 600 موظف، 30,000 مهمة، 12 شهرًا من نتائج KPI ثم قياس زمن أهم الواجهات.
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-load-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'load.db'), FILES_DIR: path.join(tmp, 'f'), DEMO_MODE: '1', LOG_LEVEL: 'error', TZ: 'Africa/Cairo' });
const { server } = require('../server'); const db = require('../src/db'); const { nowIso, addDays, today } = require('../src/util');
require('../src/seed').seed();
const depts = db.all(`SELECT id FROM org_units WHERE kind IN ('team','department')`).map(r => r.id);
const pw = db.get(`SELECT password_hash FROM employees WHERE emp_no = 'E040'`).password_hash; const rbac = require('../src/rbac');
db.tx(() => {
  for (let i = 0; i < 600; i++) { const org = depts[i % depts.length]; const l = rbac.lineage(org); db.insert('employees', { emp_no: `L${i}`, name: `موظف ${i}`, job_title: 'موظف', email: `l${i}@load.test`, org_unit_id: org, ...l, manager_id: db.get(`SELECT id FROM employees WHERE dept_id = ? AND system_role = 'department_manager'`, l.dept_id)?.id || null, system_role: 'employee', password_hash: pw, can_login: 0, created_at: nowIso(), updated_at: nowIso() }); }
  const emps = db.all(`SELECT id, company_id, bu_id, dept_id FROM employees WHERE emp_no LIKE 'L%'`); const st = ['not_started', 'in_progress', 'completed', 'completed', 'completed', 'blocked'];
  for (let i = 0; i < 30000; i++) { const e = emps[i % emps.length]; const due = addDays(today(), -(i % 365) + 20); const s = st[i % st.length];
    db.insert('tasks', { code: `LT-${i}`, title: `مهمة تحميل ${i}`, source: 'operational', owner_id: e.id, company_id: e.company_id, bu_id: e.bu_id, dept_id: e.dept_id, priority: ['low', 'medium', 'high', 'critical'][i % 4], due_date: due, start_date: addDays(due, -10), status: s, progress: s === 'completed' ? 100 : 30, completed_at: s === 'completed' ? due + 'T10:00:00Z' : null, created_at: nowIso(), updated_at: nowIso() }); }
});
(async () => {
  await new Promise(r => server.listen(0, r)); const B = `http://127.0.0.1:${server.address().port}/api`;
  const login = async u => (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'acc' }, body: JSON.stringify({ email: u + '@fasttrade.demo', password: 'Demo@2026!' }) })).headers.get('set-cookie').split(';')[0];
  const out = [];
  for (const [u, paths] of [['omar', ['/home', '/attention', '/tasks?view=management', '/tasks?limit=100', '/tasks/summary', '/performance/org/2', '/reports/task_performance', '/search?q=' + encodeURIComponent('مهمة')]], ['sami', ['/home', '/tasks?view=department', '/performance/team?all=1']], ['mahmoud', ['/home', '/tasks?view=my']]]) {
    const c = await login(u);
    for (const p of paths) { const t = []; for (let i = 0; i < 3; i++) { const s = performance.now(); const r = await fetch(B + p, { headers: { Cookie: c } }); await r.text(); if (r.status !== 200) throw new Error(p + ' ' + r.status); t.push(performance.now() - s); } out.push({ user: u, path: p, first_ms: Math.round(t[0]), warm_ms: Math.round(Math.min(...t.slice(1))) }); }
  }
  console.table(out); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
})();
