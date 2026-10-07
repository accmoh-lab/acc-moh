'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const H = require('../http');
const rbac = require('../rbac');
const audit = require('../audit');
const notify = require('../notify');
const integ = require('../integrations');
const { need, bad, forbidden, notFound, conflict, nowIso, today, addDays, meetingStart, nowDate, code, setting, pick } = require('../util');

const TRANSITIONS = {
  draft: ['preparation', 'cancelled'],
  preparation: ['preparation_published', 'draft', 'cancelled'],
  preparation_published: ['ready', 'preparation', 'cancelled'],
  ready: ['live', 'preparation_published', 'cancelled'],
  live: ['minutes_draft'],
  minutes_draft: ['under_review'],
  under_review: ['approved', 'minutes_draft'],
  approved: ['closed'],
  closed: [], cancelled: [],
};
const EDITABLE = new Set(['draft', 'preparation', 'preparation_published', 'ready']);
const STATUS_AR = { draft: 'مسودة', preparation: 'قيد التحضير', preparation_published: 'تم نشر التحضير', ready: 'جاهز', live: 'جارٍ الآن', minutes_draft: 'مسودة المحضر', under_review: 'قيد المراجعة', approved: 'معتمد', closed: 'مغلق', cancelled: 'ملغى' };

// ---------- helpers ----------
const orgName = id => (id ? rbac.orgs().get(id)?.name : null);
const empName = id => (id ? db.get('SELECT name FROM employees WHERE id = ?', id)?.name : null);

function loadMeeting(user, id, { edit = false } = {}) {
  const m = db.get('SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL', id);
  if (!m) throw notFound('الاجتماع غير موجود.');
  const parts = rbac.participantSet(m.id);
  if (!rbac.canSeeMeeting(user, m, parts)) throw notFound('الاجتماع غير موجود.');      // لا نكشف وجوده
  if (edit && !rbac.canEditMeeting(user, m)) throw forbidden('إدارة الاجتماع متاحة لقائده وسكرتيره فقط.');
  return m;
}
function prepState(m) {
  if (m.prep_published_at) return 'published';
  const agenda = db.get('SELECT COUNT(*) n FROM agenda_items WHERE meeting_id = ?', m.id).n;
  if (!agenda && !m.objective) return 'not_ready';
  const deadline = new Date(meetingStart(m).getTime() - setting('prep_release_hours', 48) * 3600000);
  if (['draft', 'preparation'].includes(m.status) && nowDate() > deadline) return 'late';
  return 'draft';
}
function canJoin(user, m, parts) {
  if (!['online', 'hybrid'].includes(m.mode) || !m.url) return false;
  if (!['preparation_published', 'ready', 'live'].includes(m.status)) return false;
  if (!(parts.has(user.id) || m.leader_id === user.id || m.secretary_id === user.id)) return false;
  const start = meetingStart(m); const now = nowDate();
  return m.status === 'live' || (now >= new Date(start - 30 * 60000) && now <= new Date(start.getTime() + (m.duration_min + 60) * 60000));
}
function listRow(user, m, parts) {
  const mine = db.get('SELECT invitation, attendance FROM meeting_participants WHERE meeting_id = ? AND employee_id = ?', m.id, user.id);
  return {
    id: m.id, code: m.code, title: m.title, type: m.type, status: m.status, status_ar: STATUS_AR[m.status], mode: m.mode, provider: m.provider,
    meeting_date: m.meeting_date, start_time: m.start_time, duration_min: m.duration_min, location: m.location,
    leader_id: m.leader_id, leader_name: empName(m.leader_id), confidentiality: m.confidentiality,
    org_name: orgName(m.dept_id || m.bu_id || m.company_id), prep_state: prepState(m), prep_released: !!m.prep_released_at,
    recurrence: m.recurrence, series_id: m.series_id, participants_count: db.get('SELECT COUNT(*) n FROM meeting_participants WHERE meeting_id = ?', m.id).n,
    agenda_count: db.get('SELECT COUNT(*) n FROM agenda_items WHERE meeting_id = ?', m.id).n,
    my_invitation: mine?.invitation || null, is_leader: m.leader_id === user.id, is_secretary: m.secretary_id === user.id,
    can_join: canJoin(user, m, parts || rbac.participantSet(m.id)),
  };
}

// ---------- القائمة ----------
H.get('/api/meetings', ({ user, query }) => {
  const where = [rbac.meetingVisibilitySql(user)]; const p = [];
  const t = today();
  if (query.when === 'upcoming') { where.push(`m.meeting_date >= ? AND m.status NOT IN ('closed','cancelled','approved')`); p.push(t); }
  else if (query.when === 'past') { where.push(`(m.meeting_date < ? OR m.status IN ('closed','approved','minutes_draft','under_review'))`); p.push(t); }
  else if (query.when === 'today') { where.push('m.meeting_date = ?'); p.push(t); }
  if (query.type) { where.push('m.type = ?'); p.push(query.type); }
  if (query.status) { where.push('m.status = ?'); p.push(query.status); }
  if (query.mine === '1') { where.push(`(m.leader_id = ? OR m.secretary_id = ? OR EXISTS (SELECT 1 FROM meeting_participants x WHERE x.meeting_id = m.id AND x.employee_id = ?))`); p.push(user.id, user.id, user.id); }
  if (query.q) { where.push('(m.title LIKE ? OR m.code LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
  const order = query.when === 'past' ? 'm.meeting_date DESC, m.start_time DESC' : 'm.meeting_date ASC, m.start_time ASC';
  const limit = Math.min(Number(query.limit) || 100, 200), offset = Number(query.offset) || 0;
  const total = db.get(`SELECT COUNT(*) n FROM meetings m WHERE ${where.join(' AND ')}`, ...p).n;
  const rows = db.all(`SELECT m.* FROM meetings m WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  return { total, items: rows.map(m => listRow(user, m)) };
});

// ---------- الإنشاء والتعديل ----------
const SPEC = {
  title: 'str:req', type: 'enum:req:department|business_unit|management|cross_functional|committee|board',
  company_id: 'int', bu_id: 'int', dept_id: 'int', leader_id: 'int', secretary_id: 'int',
  meeting_date: 'date:req', start_time: 'time:req', duration_min: 'int', location: 'str', mode: 'enum:req:in_person|online|hybrid',
  provider: 'enum:opt:none|teams|google_meet', url: 'str', objective: 'str', required_preparation: 'str',
  confidentiality: 'enum:opt:normal|confidential|board', recurrence: 'enum:opt:none|weekly|monthly',
};
function validateMeeting(user, d, existing) {
  if (!(d.duration_min > 0)) throw bad('مدة الاجتماع يجب أن تكون أكبر من صفر.', { duration_min: 'مدة غير صحيحة' });
  if (['online', 'hybrid'].includes(d.mode) && d.provider === 'none' && !d.url) throw bad('الاجتماع Online/Hybrid يحتاج مزوّد اجتماعات أو رابطًا.', { provider: 'اختر المزوّد' });
  if (d.url && !/^https:\/\/[^\s]+$/.test(d.url)) throw bad('رابط الاجتماع يجب أن يبدأ بـ https://', { url: 'رابط غير صحيح' });
  if (d.type === 'board') {
    if (!user.isBoard) throw forbidden('إنشاء اجتماعات مجلس الإدارة متاح لأمين المجلس وأعضائه فقط.');
    d.confidentiality = 'board';
  } else if (d.confidentiality === 'board') throw bad('السرية Board مخصصة لاجتماعات مجلس الإدارة.');
  const leader = db.get('SELECT * FROM employees WHERE id = ? AND active = 1', d.leader_id);
  if (!leader) throw bad('قائد الاجتماع غير موجود أو غير نشط.', { leader_id: 'اختر قائدًا' });
  if (d.type === 'board' && !db.get(`SELECT 1 x FROM employee_grants WHERE employee_id = ? AND role IN ('board_member','board_secretary')`, d.leader_id)) throw bad('قائد اجتماع Board يجب أن يكون عضو مجلس أو أمين سر المجلس.');
  if (d.secretary_id && !db.get('SELECT 1 x FROM employees WHERE id = ? AND active = 1', d.secretary_id)) throw bad('سكرتير الاجتماع غير موجود.', { secretary_id: 'سكرتير غير صحيح' });
  return leader;
}
H.post('/api/meetings', ({ user, body }) => {
  if (!(rbac.isManagerRole(user) || rbac.has(user, 'meeting_leader', 'meeting_secretary', 'board_secretary'))) throw forbidden('إنشاء الاجتماعات متاح لقادة الفرق فأعلى أو لمن مُنح صلاحية قائد/سكرتير اجتماع.');
  const d = need({ leader_id: user.id, duration_min: 60, provider: 'none', confidentiality: 'normal', recurrence: 'none', ...body }, SPEC);
  const leader = validateMeeting(user, d);
  const lin = rbac.lineage(leader.org_unit_id);
  const row = { ...pick(d, Object.keys(SPEC)), company_id: d.company_id || (d.type === 'board' ? null : lin.company_id), bu_id: d.bu_id ?? (['department', 'business_unit'].includes(d.type) ? lin.bu_id : null), dept_id: d.dept_id ?? (d.type === 'department' ? lin.dept_id : null) };
  if (row.dept_id && !row.bu_id) row.bu_id = rbac.lineage(row.dept_id).bu_id;
  const id = db.tx(() => {
    const mid = db.insert('meetings', { ...row, code: code('MTG'), status: 'draft', series_id: row.recurrence !== 'none' ? crypto.randomBytes(4).toString('hex') : null, created_by: user.id, created_at: nowIso(), updated_at: nowIso() });
    const ids = [...new Set([d.leader_id, ...(body.participant_ids || [])])];
    for (const eid of ids) {
      if (!db.get('SELECT 1 x FROM employees WHERE id = ? AND active = 1', eid)) throw bad('أحد المشاركين غير موجود أو غير نشط.');
      db.insert('meeting_participants', { meeting_id: mid, employee_id: eid, optional: (body.optional_ids || []).includes(eid) ? 1 : 0, invitation: eid === d.leader_id ? 'accepted' : 'invited' });
    }
    if (d.type === 'board') assertBoardParticipants(mid);
    if (d.secretary_id) db.run('INSERT OR IGNORE INTO meeting_participants(meeting_id, employee_id, invitation) VALUES (?,?,?)', mid, d.secretary_id, 'invited');
    audit.log(user.id, 'meeting', mid, 'create');
    return mid;
  });
  return { id };
});
function assertBoardParticipants(mid) {
  const bad_ = db.all(`SELECT e.name FROM meeting_participants p JOIN employees e ON e.id = p.employee_id
     WHERE p.meeting_id = ? AND NOT EXISTS (SELECT 1 FROM employee_grants g WHERE g.employee_id = e.id AND g.role IN ('board_member','board_secretary'))`, mid);
  if (bad_.length) throw bad(`مشاركو اجتماع Board يجب أن يكونوا أعضاء مجلس أو أمين السر. غير مؤهلين: ${bad_.map(x => x.name).join('، ')}`);
}
H.put('/api/meetings/:id', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!EDITABLE.has(m.status)) throw conflict('لا يمكن تعديل بيانات الاجتماع بعد بدئه.', 'LOCKED');
  const d = need({ ...m, ...body }, SPEC); validateMeeting(user, d, m);
  const upd = { ...pick(d, Object.keys(SPEC)), updated_at: nowIso() };
  audit.diff(user.id, 'meeting', m.id, m, upd, ['meeting_date', 'start_time', 'leader_id', 'mode', 'confidentiality', 'url']);
  db.update('meetings', m.id, upd);
  if (['preparation_published', 'ready'].includes(m.status) && (m.meeting_date !== d.meeting_date || m.start_time !== d.start_time)) {
    for (const p of db.all('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', m.id))
      notify.send(p.employee_id, 'meeting_approaching', `تغيّر موعد الاجتماع: ${d.title}`, `الموعد الجديد ${d.meeting_date} ${d.start_time}`, `#/meetings/${m.id}`);
  }
  return { ok: true };
});

// ---------- التفاصيل ----------
function agendaRows(mid) {
  return db.all('SELECT a.*, (SELECT name FROM employees WHERE id = a.presenter_id) presenter_name, (SELECT name FROM kpis WHERE id = a.related_kpi_id) kpi_name, (SELECT code FROM kpis WHERE id = a.related_kpi_id) kpi_code FROM agenda_items a WHERE a.meeting_id = ? ORDER BY a.seq', mid);
}
function previousContext(m) {
  const prev = db.all(`SELECT id FROM meetings WHERE id <> ? AND deleted_at IS NULL AND meeting_date < ? AND status IN ('closed','approved','minutes_draft','under_review')
    AND ((? IS NOT NULL AND series_id = ?) OR (type = ? AND IFNULL(dept_id,0) = IFNULL(?,0) AND IFNULL(bu_id,0) = IFNULL(?,0)))
    ORDER BY meeting_date DESC LIMIT 2`, m.id, m.meeting_date, m.series_id, m.series_id, m.type, m.dept_id, m.bu_id).map(r => r.id);
  if (!prev.length) return { decisions: [], actions: [] };
  const ph = db.ph(prev);
  const decisions = db.all(`SELECT d.id, d.code, d.text, d.status, d.decision_date, (SELECT name FROM employees WHERE id = d.owner_id) owner_name FROM decisions d WHERE d.meeting_id IN (${ph}) AND d.status NOT IN ('closed','cancelled') AND d.deleted_at IS NULL ORDER BY d.decision_date DESC`, ...prev);
  const actions = db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.progress, (SELECT name FROM employees WHERE id = t.owner_id) owner_name, (t.due_date < ? AND t.status NOT IN ('completed','cancelled')) overdue
    FROM tasks t WHERE t.meeting_id IN (${ph}) AND t.status NOT IN ('completed','cancelled') AND t.deleted_at IS NULL ORDER BY t.due_date`, today(), ...prev);
  return { decisions, actions };
}
function buildPack(m) {
  const agenda = agendaRows(m.id).map(a => ({ seq: a.seq, topic: a.topic, presenter_name: a.presenter_name, type: a.type, est_min: a.est_min, objective: a.objective, prep_notes: a.prep_notes, required_data: a.required_data, required_decision: a.required_decision, kpi_code: a.kpi_code }));
  const kpis = db.all(`SELECT k.id, k.code, k.name, k.unit, k.kpi_type FROM meeting_kpis mk JOIN kpis k ON k.id = mk.kpi_id WHERE mk.meeting_id = ?`, m.id).map(k => {
    const r = db.get(`SELECT period_key, target, actual, achievement, status, data_quality FROM kpi_results WHERE kpi_id = ? AND actual IS NOT NULL ORDER BY period_start DESC LIMIT 1`, k.id);
    return { ...k, ...(r || {}) };
  });
  const docs = db.all(`SELECT id, filename, size, note FROM attachments WHERE deleted_at IS NULL AND ((entity_type = 'meeting' AND entity_id = ?) OR (entity_type = 'agenda_item' AND entity_id IN (SELECT id FROM agenda_items WHERE meeting_id = ?)))`, m.id, m.id);
  const prev = previousContext(m);
  return {
    published_at: nowIso(),
    details: { code: m.code, title: m.title, type: m.type, date: m.meeting_date, time: m.start_time, duration_min: m.duration_min, location: m.location, mode: m.mode, provider: m.provider, leader: empName(m.leader_id) },
    objective: m.objective, required_preparation: m.required_preparation, agenda, kpis, documents: docs,
    previous_decisions: prev.decisions, previous_actions: prev.actions,
  };
}
H.get('/api/meetings/:id', ({ user, params }) => {
  const m = loadMeeting(user, params.id);
  const parts = rbac.participantSet(m.id);
  const isEditor = rbac.canEditMeeting(user, m);
  const isParticipantOnly = !isEditor && !rbac.isManagerRole(user);
  const board = rbac.isBoardMeeting(m);
  const seesBoard = !board || rbac.canSeeBoardContent(user);
  const participants = db.all(`SELECT p.*, e.name, e.job_title FROM meeting_participants p JOIN employees e ON e.id = p.employee_id WHERE p.meeting_id = ? ORDER BY e.name`, m.id);
  // حزمة التحضير: المحرر والمديرون يرونها دائمًا، والمشاركون بعد إتاحتها (T-48h)
  const prepVisible = isEditor || (rbac.isManagerRole(user) && !parts.has(user.id)) || !!m.prep_released_at;
  const out = {
    ...listRow(user, m, parts),
    company_name: orgName(m.company_id), bu_name: orgName(m.bu_id), dept_name: orgName(m.dept_id), secretary_id: m.secretary_id, secretary_name: empName(m.secretary_id),
    objective: m.objective, required_preparation: m.required_preparation, url: ['online', 'hybrid'].includes(m.mode) && (parts.has(user.id) || isEditor) ? m.url : null,
    prep_published_at: m.prep_published_at, prep_released_at: m.prep_released_at, started_at: m.started_at, ended_at: m.ended_at, cancel_reason: m.cancel_reason, prev_meeting_id: m.prev_meeting_id,
    allowed_transitions: isEditor ? TRANSITIONS[m.status] : [], can_edit: isEditor && EDITABLE.has(m.status), is_editor: isEditor,
    participants: participants.map(p => ({ employee_id: p.employee_id, name: p.name, job_title: p.job_title, optional: p.optional, invitation: p.invitation, attendance: p.attendance, attendance_mode: p.attendance_mode })),
    agenda: (seesBoard ? agendaRows(m.id) : []).map(a => (isParticipantOnly && !m.prep_released_at && ['draft', 'preparation', 'preparation_published'].includes(m.status) ? { id: a.id, seq: a.seq, topic: a.topic, type: a.type, est_min: a.est_min, status: a.status } : a)),
    kpis: db.all(`SELECT k.id, k.code, k.name FROM meeting_kpis mk JOIN kpis k ON k.id = mk.kpi_id WHERE mk.meeting_id = ?`, m.id),
    prep_pack: prepVisible && m.prep_pack ? JSON.parse(m.prep_pack) : null,
    prep_hidden: !prepVisible && !!m.prep_published_at,
    decisions: seesBoard ? db.all(`SELECT d.id, d.code, d.text, d.status, d.decision_date, d.owner_id, d.agenda_item_id, d.effective_date, d.confidentiality, (SELECT name FROM employees WHERE id = d.owner_id) owner_name FROM decisions d WHERE d.meeting_id = ? AND d.deleted_at IS NULL ORDER BY d.id`, m.id) : [],
    tasks: seesBoard ? db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.progress, t.priority, t.owner_id, t.decision_id, t.agenda_item_id, t.confidentiality, (SELECT name FROM employees WHERE id = t.owner_id) owner_name FROM tasks t WHERE t.meeting_id = ? AND ${rbac.taskVisibilitySql(user)} ORDER BY t.id`, m.id) : [],
    attachments: seesBoard && (isEditor || m.prep_released_at || rbac.isManagerRole(user)) ? db.all(`SELECT id, filename, size, note, entity_type, entity_id FROM attachments WHERE deleted_at IS NULL AND ((entity_type = 'meeting' AND entity_id = ?) OR (entity_type = 'agenda_item' AND entity_id IN (SELECT id FROM agenda_items WHERE meeting_id = ?)))`, m.id, m.id) : [],
    minutes: ['minutes_draft', 'under_review', 'approved', 'closed'].includes(m.status) || isEditor ? db.get('SELECT summary, next_meeting_note, attendance_snapshot, approved_at, approved_by FROM minutes WHERE meeting_id = ?', m.id) || null : null,
    previous: isEditor ? previousContext(m) : null,
    join: canJoin(user, m, parts) ? integ.joinInfo(m) : null,
  };
  if (out.minutes && out.minutes.attendance_snapshot) out.minutes.attendance_snapshot = JSON.parse(out.minutes.attendance_snapshot);
  if (m.status !== 'closed' && m.status !== 'approved' && out.minutes && !isEditor) out.minutes = null;   // المحضر غير المعتمد لا يراه إلا المحرر
  return out;
});

// ---------- الانتقال بين الحالات ----------
function transition(user, m, to, reason) {
  if (!(TRANSITIONS[m.status] || []).includes(to)) throw conflict(`لا يمكن الانتقال من «${STATUS_AR[m.status]}» إلى «${STATUS_AR[to]}».`, 'BAD_TRANSITION');
  const agenda = db.all('SELECT * FROM agenda_items WHERE meeting_id = ?', m.id);
  const parts = db.all('SELECT * FROM meeting_participants WHERE meeting_id = ?', m.id);
  const upd = { status: to, updated_at: nowIso() };
  if (to === 'cancelled') { if (!reason) throw bad('سبب الإلغاء مطلوب.', { reason: 'مطلوب' }); upd.cancel_reason = reason; }
  if (to === 'preparation') {
    if (m.status === 'draft') for (const p of parts) if (p.employee_id !== m.leader_id) notify.send(p.employee_id, 'meeting_invitation', `دعوة اجتماع: ${m.title}`, `${m.meeting_date} ${m.start_time}`, `#/meetings/${m.id}`, `inv:${m.id}`);
  }
  if (to === 'preparation_published') {
    if (m.status === 'preparation') {
      if (!agenda.length) throw bad('أضف بندًا واحدًا على الأقل إلى جدول الأعمال قبل نشر حزمة التحضير.');
      if (!m.objective) throw bad('هدف الاجتماع مطلوب قبل نشر حزمة التحضير.');
      Object.assign(upd, publishPack(m));
    }
  }
  if (to === 'ready' && parts.length < 2) throw bad('أضف مشاركًا واحدًا على الأقل غير القائد.');
  if (to === 'live') {
    if (parts.length < 2) throw bad('لا يمكن بدء اجتماع بدون مشاركين.');
    upd.started_at = nowIso();
    if (!m.prep_pack) { if (!agenda.length) throw bad('لا يمكن بدء الاجتماع بدون جدول أعمال.'); }
  }
  if (to === 'minutes_draft' && m.status === 'live') {
    if (agenda.some(a => a.status === 'discussing')) throw bad('أنهِ البند الجاري مناقشته (Completed أو Deferred) قبل إنهاء الاجتماع.');
    const unrecorded = parts.filter(p => !p.attendance && !p.optional);
    if (unrecorded.length) throw bad(`سجّل حضور كل المشاركين الأساسيين قبل إنهاء الاجتماع (متبقٍ ${unrecorded.length}).`);
    db.run(`UPDATE agenda_items SET status = 'deferred' WHERE meeting_id = ? AND status = 'pending'`, m.id);
    db.run(`UPDATE meeting_participants SET attendance = 'absent' WHERE meeting_id = ? AND attendance IS NULL`, m.id);
    upd.ended_at = nowIso();
    if (!db.get('SELECT 1 x FROM minutes WHERE meeting_id = ?', m.id)) db.insert('minutes', { meeting_id: m.id, summary: '', updated_at: nowIso() });
  }
  if (to === 'under_review') {
    const mn = db.get('SELECT * FROM minutes WHERE meeting_id = ?', m.id);
    if (!mn || !String(mn.summary || '').trim()) throw bad('اكتب ملخص المناقشة في المحضر قبل إرساله للمراجعة.');
    notify.send(m.leader_id, 'review_required', `محضر بانتظار الاعتماد: ${m.title}`, null, `#/meetings/${m.id}`);
  }
  if (to === 'approved') {
    if (m.leader_id !== user.id) throw forbidden('اعتماد المحضر لرئيس الاجتماع (القائد) فقط.');
    const snap = db.all(`SELECT p.employee_id, e.name, p.invitation, p.attendance, p.attendance_mode, p.optional FROM meeting_participants p JOIN employees e ON e.id = p.employee_id WHERE p.meeting_id = ?`, m.id);
    db.update('minutes', m.id, { attendance_snapshot: JSON.stringify(snap), approved_by: user.id, approved_at: nowIso(), updated_at: nowIso() }, 'meeting_id');
  }
  if (to === 'closed') {
    for (const p of parts) notify.send(p.employee_id, 'mom_published', `نُشر محضر الاجتماع: ${m.title}`, null, `#/meetings/${m.id}`, `mom:${m.id}`);
  }
  if (to === 'cancelled') for (const p of parts) notify.send(p.employee_id, 'meeting_approaching', `أُلغي الاجتماع: ${m.title}`, reason, `#/meetings/${m.id}`);
  db.update('meetings', m.id, upd);
  audit.log(user.id, 'meeting', m.id, 'transition', 'status', m.status, to, reason || null);
}
function publishPack(m) {
  const pack = buildPack(m);
  const hrs = setting('prep_release_hours', 48);
  const released = nowDate() >= new Date(meetingStart(m).getTime() - hrs * 3600000);
  const upd = { prep_pack: JSON.stringify(pack), prep_published_at: nowIso() };
  if (released) {
    upd.prep_released_at = nowIso();
    for (const p of db.all('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', m.id))
      if (p.employee_id !== m.leader_id) notify.send(p.employee_id, 'prep_published', `حزمة التحضير: ${m.title}`, 'اطّلع على جدول الأعمال والمطلوب قبل الاجتماع.', `#/meetings/${m.id}`, `prep:${m.id}`);
  }
  return upd;
}
H.post('/api/meetings/:id/transition', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  db.tx(() => transition(user, m, body.to, body.reason));
  return { status: body.to };
});
// إعادة نشر الحزمة بعد التعديل (قبل بدء الاجتماع)
H.post('/api/meetings/:id/prep/republish', ({ user, params }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['preparation_published', 'ready'].includes(m.status)) throw conflict('إعادة النشر متاحة بعد نشر الحزمة وقبل بدء الاجتماع فقط.');
  db.update('meetings', m.id, { ...publishPack(m), updated_at: nowIso() });
  audit.log(user.id, 'meeting', m.id, 'prep_republish');
  return { ok: true };
});
// أتمتة T-48h (تُستدعى دوريًا + زر تشغيل يدوي)
function runAutomation(now = nowDate()) {
  const hrs = setting('prep_release_hours', 48);
  const out = { released: 0, late: 0, approaching: 0 };
  for (const m of db.all(`SELECT * FROM meetings WHERE deleted_at IS NULL AND status IN ('draft','preparation','preparation_published','ready')`)) {
    const start = meetingStart(m); const deadline = new Date(start.getTime() - hrs * 3600000);
    if (m.prep_published_at && !m.prep_released_at && now >= deadline) {
      db.update('meetings', m.id, { prep_released_at: nowIso() });
      for (const p of db.all('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', m.id))
        if (p.employee_id !== m.leader_id) notify.send(p.employee_id, 'prep_published', `حزمة التحضير: ${m.title}`, 'أُتيحت قبل الاجتماع بـ48 ساعة.', `#/meetings/${m.id}`, `prep:${m.id}`);
      out.released++;
    }
    if (!m.prep_published_at && now >= deadline && now < start) {
      if (notify.send(m.leader_id, 'prep_late', `تأخر نشر حزمة التحضير: ${m.title}`, 'اقترب الاجتماع ولم تُنشر الحزمة بعد.', `#/meetings/${m.id}`, `late:${m.id}`)) out.late++;
    }
    const mins = (start - now) / 60000;
    if (mins > 0 && mins <= 60 && ['preparation_published', 'ready'].includes(m.status)) {
      for (const p of db.all('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', m.id))
        if (notify.send(p.employee_id, 'meeting_approaching', `يبدأ الاجتماع قريبًا: ${m.title}`, `${m.start_time}`, `#/meetings/${m.id}`, `appr:${m.id}`)) out.approaching++;
    }
  }
  return out;
}

// ---------- المشاركون والحضور ----------
H.put('/api/meetings/:id/participants', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!EDITABLE.has(m.status)) throw conflict('لا يمكن تغيير المشاركين بعد بدء الاجتماع.');
  const list = Array.isArray(body.participants) ? body.participants : [];
  db.tx(() => {
    const keep = new Set([m.leader_id, ...list.map(p => p.employee_id)]);
    for (const p of db.all('SELECT * FROM meeting_participants WHERE meeting_id = ?', m.id)) if (!keep.has(p.employee_id)) db.run('DELETE FROM meeting_participants WHERE id = ?', p.id);
    for (const p of list) {
      if (!db.get('SELECT 1 x FROM employees WHERE id = ? AND active = 1', p.employee_id)) throw bad('أحد المشاركين غير موجود أو غير نشط.');
      const ex = db.get('SELECT id FROM meeting_participants WHERE meeting_id = ? AND employee_id = ?', m.id, p.employee_id);
      if (ex) db.update('meeting_participants', ex.id, { optional: p.optional ? 1 : 0 });
      else {
        db.insert('meeting_participants', { meeting_id: m.id, employee_id: p.employee_id, optional: p.optional ? 1 : 0 });
        if (m.status !== 'draft') notify.send(p.employee_id, 'meeting_invitation', `دعوة اجتماع: ${m.title}`, `${m.meeting_date} ${m.start_time}`, `#/meetings/${m.id}`, `inv:${m.id}`);
      }
    }
    if (m.type === 'board') assertBoardParticipants(m.id);
    audit.log(user.id, 'meeting', m.id, 'update', 'participants', null, list.length);
  });
  return { ok: true };
});
H.put('/api/meetings/:id/rsvp', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id);
  const d = need(body, { invitation: 'enum:req:accepted|declined' });
  const r = db.run('UPDATE meeting_participants SET invitation = ? WHERE meeting_id = ? AND employee_id = ?', d.invitation, m.id, user.id);
  if (!r.changes) throw forbidden('أنت لست مدعوًا لهذا الاجتماع.');
  return { ok: true };
});
H.put('/api/meetings/:id/attendance/:eid', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['ready', 'live', 'preparation_published', 'minutes_draft'].includes(m.status)) throw conflict('تسجيل الحضور متاح عند جاهزية الاجتماع أو أثناءه أو في مسودة المحضر.');
  const d = need(body, { attendance: 'enum:req:attended|absent|excused', attendance_mode: 'enum:opt:in_person|online' });
  if (d.attendance === 'attended' && !d.attendance_mode) d.attendance_mode = m.mode === 'online' ? 'online' : 'in_person';
  if (d.attendance !== 'attended') d.attendance_mode = null;
  const r = db.run('UPDATE meeting_participants SET attendance = ?, attendance_mode = ? WHERE meeting_id = ? AND employee_id = ?', d.attendance, d.attendance_mode, m.id, params.eid);
  if (!r.changes) throw notFound('المشارك غير موجود في هذا الاجتماع.');
  return { ok: true };
});

// ---------- جدول الأعمال ----------
const AG_SPEC = { topic: 'str:req', presenter_id: 'int', objective: 'str', type: 'enum:opt:information|discussion|decision_required|follow_up', est_min: 'int', prep_notes: 'str', required_data: 'str', required_decision: 'str', related_kpi_id: 'int' };
H.post('/api/meetings/:id/agenda', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['draft', 'preparation', 'preparation_published', 'ready', 'live'].includes(m.status)) throw conflict('لا يمكن إضافة بنود في هذه المرحلة.');
  const d = need({ type: 'discussion', est_min: 10, ...body }, AG_SPEC);
  if (d.est_min < 0) throw bad('المدة المقدّرة غير صحيحة.');
  if (d.related_kpi_id && !db.get('SELECT 1 x FROM kpis WHERE id = ?', d.related_kpi_id)) throw bad('KPI غير موجود.');
  const seq = (db.get('SELECT MAX(seq) s FROM agenda_items WHERE meeting_id = ?', m.id).s || 0) + 1;
  const id = db.insert('agenda_items', { ...d, meeting_id: m.id, seq, status: 'pending', created_at: nowIso(), updated_at: nowIso() });
  if (d.related_kpi_id) db.run('INSERT OR IGNORE INTO meeting_kpis(meeting_id, kpi_id) VALUES (?,?)', m.id, d.related_kpi_id);
  return { id };
});
function loadAgenda(user, id, edit = true) {
  const a = db.get('SELECT * FROM agenda_items WHERE id = ?', id); if (!a) throw notFound();
  return { a, m: loadMeeting(user, a.meeting_id, { edit }) };
}
H.put('/api/agenda/:id', ({ user, params, body }) => {
  const { a, m } = loadAgenda(user, params.id);
  if (['minutes_draft', 'under_review', 'approved', 'closed', 'cancelled'].includes(m.status)) throw conflict('الاجتماع انتهى؛ لا يمكن تعديل الأجندة.');
  const d = need({ ...a, ...body }, AG_SPEC);
  db.update('agenda_items', a.id, { ...d, updated_at: nowIso() });
  return { ok: true };
});
H.del('/api/agenda/:id', ({ user, params }) => {
  const { a, m } = loadAgenda(user, params.id);
  if (!EDITABLE.has(m.status)) throw conflict('لا يمكن حذف بنود بعد بدء الاجتماع.');
  if (db.get('SELECT 1 x FROM decisions WHERE agenda_item_id = ? AND deleted_at IS NULL', a.id)) throw conflict('البند مرتبط بقرارات ولا يمكن حذفه.');
  db.run('UPDATE tasks SET agenda_item_id = NULL WHERE agenda_item_id = ?', a.id);
  db.run('DELETE FROM agenda_items WHERE id = ?', a.id);
  db.tx(() => db.all('SELECT id FROM agenda_items WHERE meeting_id = ? ORDER BY seq', m.id).forEach((r, i) => db.run('UPDATE agenda_items SET seq = ? WHERE id = ?', i + 1, r.id)));
  return { ok: true };
});
H.post('/api/meetings/:id/agenda/reorder', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!EDITABLE.has(m.status) && m.status !== 'live') throw conflict('لا يمكن إعادة ترتيب الأجندة الآن.');
  const ids = body.ids || []; const have = db.all('SELECT id FROM agenda_items WHERE meeting_id = ?', m.id).map(r => r.id);
  if (ids.length !== have.length || !ids.every(i => have.includes(i))) throw bad('قائمة البنود غير مطابقة.');
  db.tx(() => ids.forEach((id, i) => db.run('UPDATE agenda_items SET seq = ? WHERE id = ?', i + 1, id)));
  return { ok: true };
});
// حالة البند وملاحظات النقاش أثناء الاجتماع
H.put('/api/agenda/:id/live', ({ user, params, body }) => {
  const { a, m } = loadAgenda(user, params.id);
  if (m.status !== 'live') throw conflict('هذه العملية متاحة أثناء الاجتماع فقط.');
  const d = need(body, { status: 'enum:opt:pending|discussing|completed|deferred', discussion_notes: 'str' });
  db.tx(() => {
    if (d.status === 'discussing') db.run(`UPDATE agenda_items SET status = 'pending' WHERE meeting_id = ? AND status = 'discussing' AND id <> ?`, m.id, a.id);   // بند واحد فقط جارٍ
    db.update('agenda_items', a.id, { ...(d.status ? { status: d.status } : {}), ...(body.discussion_notes !== undefined ? { discussion_notes: d.discussion_notes } : {}), updated_at: nowIso() });
  });
  return { ok: true };
});
H.put('/api/meetings/:id/kpis', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!EDITABLE.has(m.status)) throw conflict('لا يمكن تعديل مؤشرات الاجتماع الآن.');
  db.tx(() => {
    db.run('DELETE FROM meeting_kpis WHERE meeting_id = ?', m.id);
    for (const id of body.kpi_ids || []) { if (!db.get('SELECT 1 x FROM kpis WHERE id = ?', id)) throw bad('KPI غير موجود.'); db.run('INSERT OR IGNORE INTO meeting_kpis(meeting_id, kpi_id) VALUES (?,?)', m.id, id); }
  });
  return { ok: true };
});

// ---------- المحضر ----------
H.put('/api/meetings/:id/minutes', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['live', 'minutes_draft'].includes(m.status)) throw conflict('المحضر قابل للتعديل أثناء الاجتماع أو في مرحلة المسودة فقط.');
  const d = need(body, { summary: 'str', next_meeting_note: 'str' });
  if (db.get('SELECT 1 x FROM minutes WHERE meeting_id = ?', m.id)) db.update('minutes', m.id, { summary: d.summary ?? '', next_meeting_note: d.next_meeting_note, updated_at: nowIso() }, 'meeting_id');
  else db.insert('minutes', { meeting_id: m.id, summary: d.summary ?? '', next_meeting_note: d.next_meeting_note, updated_at: nowIso() });
  return { ok: true };
});

// ---------- الاجتماعات المتكررة ----------
H.post('/api/meetings/:id/next-occurrence', ({ user, params }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (m.recurrence === 'none') throw bad('الاجتماع ليس متكررًا.');
  if (db.get(`SELECT 1 x FROM meetings WHERE series_id = ? AND meeting_date > ? AND deleted_at IS NULL AND status <> 'cancelled'`, m.series_id, m.meeting_date)) throw conflict('يوجد موعد لاحق في السلسلة بالفعل.');
  const nd = m.recurrence === 'weekly' ? addDays(m.meeting_date, 7) : (() => { const d = new Date(m.meeting_date); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); })();
  const id = db.tx(() => {
    const nid = db.insert('meetings', { code: code('MTG'), title: m.title, type: m.type, company_id: m.company_id, bu_id: m.bu_id, dept_id: m.dept_id, leader_id: m.leader_id, secretary_id: m.secretary_id, meeting_date: nd, start_time: m.start_time, duration_min: m.duration_min, location: m.location, mode: m.mode, provider: m.provider, url: m.url, objective: m.objective, required_preparation: m.required_preparation, confidentiality: m.confidentiality, status: 'draft', series_id: m.series_id, recurrence: m.recurrence, prev_meeting_id: m.id, created_by: user.id, created_at: nowIso(), updated_at: nowIso() });
    for (const p of db.all('SELECT * FROM meeting_participants WHERE meeting_id = ?', m.id)) db.insert('meeting_participants', { meeting_id: nid, employee_id: p.employee_id, optional: p.optional, invitation: p.employee_id === m.leader_id ? 'accepted' : 'invited' });
    const nm = db.get('SELECT * FROM meetings WHERE id = ?', nid);
    const prev = previousContext(nm);
    if (prev.decisions.length || prev.actions.length) db.insert('agenda_items', { meeting_id: nid, seq: 1, topic: 'متابعة القرارات والمهام المفتوحة من الاجتماع السابق', type: 'follow_up', est_min: 15, status: 'pending', objective: `${prev.decisions.length} قرار و${prev.actions.length} مهمة مفتوحة`, created_at: nowIso(), updated_at: nowIso() });
    audit.log(user.id, 'meeting', nid, 'create_occurrence', 'prev', m.id, nid);
    return nid;
  });
  return { id };
});

// ---------- الانضمام / ICS ----------
H.get('/api/meetings/:id/join', ({ user, params }) => {
  const m = loadMeeting(user, params.id);
  const j = canJoin(user, m, rbac.participantSet(m.id)) ? integ.joinInfo(m) : null;
  if (!j) throw conflict('الانضمام غير متاح الآن: يفتح قبل الموعد بـ30 دقيقة للمدعوين في الاجتماعات Online/Hybrid.', 'NOT_JOINABLE');
  return j;
});
H.post('/api/meetings/:id/online-link', ({ user, params }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['online', 'hybrid'].includes(m.mode) || m.provider === 'none') throw bad('اختر وضع Online/Hybrid ومزوّد اجتماعات أولًا.');
  const r = integ.createOnlineMeeting(m.provider, m);
  db.update('meetings', m.id, { url: r.url, updated_at: nowIso() });
  audit.log(user.id, 'meeting', m.id, 'mock_link', 'url', m.url, r.url);
  return r;
});
H.get('/api/meetings/:id/ics', ({ user, params }) => {
  const m = loadMeeting(user, params.id);
  return { __raw: true, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${m.code}.ics"` }, body: integ.ics(m) };
});

// ---------- القرارات ----------
const DEC_SPEC = { text: 'str:req', agenda_item_id: 'int', owner_id: 'int:req', responsible_dept_id: 'int', effective_date: 'date', status: 'enum:opt:open|in_progress|implemented|closed|cancelled', evidence: 'str', decision_date: 'date' };
const DEC_FLOW = { open: ['in_progress', 'implemented', 'cancelled'], in_progress: ['implemented', 'open', 'cancelled'], implemented: ['closed', 'in_progress'], closed: [], cancelled: [] };
H.post('/api/meetings/:id/decisions', ({ user, params, body }) => {
  const m = loadMeeting(user, params.id, { edit: true });
  if (!['live', 'minutes_draft', 'under_review'].includes(m.status)) throw conflict('تسجيل القرارات متاح أثناء الاجتماع أو في مرحلة المحضر.');
  const d = need({ decision_date: today(), ...body }, DEC_SPEC);
  if (!db.get('SELECT 1 x FROM employees WHERE id = ? AND active = 1', d.owner_id)) throw bad('مسؤول القرار غير موجود أو غير نشط.');
  if (d.agenda_item_id && !db.get('SELECT 1 x FROM agenda_items WHERE id = ? AND meeting_id = ?', d.agenda_item_id, m.id)) throw bad('بند الأجندة لا يتبع هذا الاجتماع.');
  const owner = db.get('SELECT dept_id FROM employees WHERE id = ?', d.owner_id);
  const id = db.tx(() => {
    const did = db.insert('decisions', { ...d, status: 'open', responsible_dept_id: d.responsible_dept_id || owner.dept_id, code: code('DEC'), meeting_id: m.id, confidentiality: m.confidentiality, created_by: user.id, created_at: nowIso(), updated_at: nowIso() });
    if (d.agenda_item_id) db.run('UPDATE agenda_items SET related_decision_id = ? WHERE id = ?', did, d.agenda_item_id);
    audit.log(user.id, 'decision', did, 'create');
    return did;
  });
  return { id, code: db.get('SELECT code FROM decisions WHERE id = ?', id).code };
});
function loadDecision(user, id) {
  const d = db.get('SELECT * FROM decisions WHERE id = ? AND deleted_at IS NULL', id); if (!d) throw notFound();
  const m = db.get('SELECT * FROM meetings WHERE id = ?', d.meeting_id);
  if (!rbac.canSeeDecision(user, d, m)) throw notFound();
  return { d, m };
}
H.get('/api/decisions', ({ user, query }) => {
  const rows = db.all(`SELECT d.*, m.code meeting_code, m.title meeting_title, m.type meeting_type, m.leader_id, m.dept_id mdept, m.bu_id mbu, m.company_id mco, m.confidentiality mconf,
      (SELECT name FROM employees WHERE id = d.owner_id) owner_name, (SELECT COUNT(*) FROM tasks t WHERE t.decision_id = d.id AND t.deleted_at IS NULL) tasks_total,
      (SELECT COUNT(*) FROM tasks t WHERE t.decision_id = d.id AND t.status = 'completed' AND t.deleted_at IS NULL) tasks_done
      FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.deleted_at IS NULL ${query.status ? 'AND d.status = ?' : ''} ORDER BY d.decision_date DESC, d.id DESC`, ...(query.status ? [query.status] : []));
  return rows.filter(r => rbac.canSeeDecision(user, r, { ...r, id: r.meeting_id, dept_id: r.mdept, bu_id: r.mbu, company_id: r.mco, type: r.meeting_type, confidentiality: r.mconf })).slice(0, 300)
    .map(r => ({ ...pick(r, ['id', 'code', 'text', 'status', 'decision_date', 'effective_date', 'owner_id', 'owner_name', 'meeting_id', 'meeting_code', 'meeting_title', 'tasks_total', 'tasks_done', 'confidentiality']), overdue: r.effective_date && r.effective_date < today() && !['implemented', 'closed', 'cancelled'].includes(r.status) }));
});
H.get('/api/decisions/:id', ({ user, params }) => {
  const { d, m } = loadDecision(user, params.id);
  return { ...d, meeting: { id: m.id, code: m.code, title: m.title, meeting_date: m.meeting_date }, owner_name: empName(d.owner_id), dept_name: orgName(d.responsible_dept_id),
    agenda: d.agenda_item_id ? db.get('SELECT id, topic, seq FROM agenda_items WHERE id = ?', d.agenda_item_id) : null,
    tasks: db.all(`SELECT t.id, t.code, t.title, t.status, t.due_date, t.progress, (SELECT name FROM employees WHERE id = t.owner_id) owner_name FROM tasks t WHERE t.decision_id = ? AND ${rbac.taskVisibilitySql(user)}`, d.id),
    allowed: DEC_FLOW[d.status], can_edit: d.owner_id === user.id || m.leader_id === user.id || m.secretary_id === user.id };
});
H.put('/api/decisions/:id', ({ user, params, body }) => {
  const { d, m } = loadDecision(user, params.id);
  if (!(d.owner_id === user.id || rbac.canEditMeeting(user, m))) throw forbidden();
  const upd = {};
  if (body.status && body.status !== d.status) {
    if (!DEC_FLOW[d.status].includes(body.status)) throw conflict('انتقال حالة القرار غير مسموح.', 'BAD_TRANSITION');
    if (body.status === 'implemented' && !(body.evidence || d.evidence)) throw bad('أرفق دليل التنفيذ (Evidence) عند اعتبار القرار منفّذًا.', { evidence: 'مطلوب' });
    upd.status = body.status;
  }
  if (body.evidence !== undefined) upd.evidence = body.evidence;
  if (rbac.canEditMeeting(user, m)) { if (body.text) upd.text = body.text; if (body.effective_date !== undefined) upd.effective_date = body.effective_date; if (body.owner_id) upd.owner_id = body.owner_id; }
  audit.diff(user.id, 'decision', d.id, d, upd, ['status', 'owner_id', 'text', 'effective_date'], body.reason);
  db.update('decisions', d.id, { ...upd, updated_at: nowIso() });
  return { ok: true };
});

// ---------- المرفقات ----------
const fs = require('node:fs'); const path = require('node:path');
const FILES = process.env.FILES_DIR || path.join(__dirname, '..', '..', 'data', 'files');
const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpeg)|text\/plain|text\/csv|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/msword|application\/vnd\.ms-excel)$/;
function attachmentAccess(user, a, write) {
  const t = a.entity_type;
  if (t === 'meeting' || t === 'agenda_item') {
    const mid = t === 'meeting' ? a.entity_id : db.get('SELECT meeting_id FROM agenda_items WHERE id = ?', a.entity_id)?.meeting_id;
    const m = mid && db.get('SELECT * FROM meetings WHERE id = ?', mid); if (!m) return false;
    const parts = rbac.participantSet(m.id);
    if (!rbac.canSeeMeeting(user, m, parts)) return false;
    if (rbac.isBoardMeeting(m) && !user.isBoard) return false;
    if (write) return rbac.canEditMeeting(user, m);
    return rbac.canEditMeeting(user, m) || rbac.isManagerRole(user) || !!m.prep_released_at || m.status === 'closed';
  }
  if (t === 'task') { const task = db.get('SELECT * FROM tasks WHERE id = ?', a.entity_id); return !!task && rbac.canSeeTask(user, task) && (!write || [task.owner_id, task.reviewer_id].includes(user.id) || rbac.isManagerRole(user)); }
  if (t === 'decision') { try { loadDecision(user, a.entity_id); return true; } catch { return false; } }
  if (t === 'kpi_result') { const k = db.get('SELECT * FROM kpis WHERE id = ?', a.entity_id); return !!k && rbac.canSeeKpi(user, k) && (!write || [k.owner_id, k.data_owner_id].includes(user.id)); }
  return false;
}
H.post('/api/attachments', ({ user, body }) => {
  const d = need(body, { entity_type: 'enum:req:meeting|agenda_item|task|decision|kpi_result', entity_id: 'int:req', filename: 'str:req', mime: 'str', note: 'str' });
  if (!ALLOWED_MIME.test(d.mime || '')) throw bad('نوع الملف غير مسموح. المسموح: PDF وصور PNG/JPEG وملفات Office وCSV/نص.');
  const buf = Buffer.from(String(body.data_b64 || ''), 'base64');
  if (!buf.length) throw bad('الملف فارغ.'); if (buf.length > 8 * 1024 * 1024) throw bad('حجم الملف يتجاوز 8 ميجابايت.');
  if (!attachmentAccess(user, { entity_type: d.entity_type, entity_id: d.entity_id }, true)) throw forbidden('لا تملك صلاحية إرفاق ملفات هنا.');
  fs.mkdirSync(FILES, { recursive: true });
  const key = crypto.randomUUID(); fs.writeFileSync(path.join(FILES, key), buf);
  const id = db.insert('attachments', { ...d, filename: d.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 120), size: buf.length, storage_key: key, uploaded_by: user.id, created_at: nowIso() });
  audit.log(user.id, 'attachment', id, 'upload', 'entity', null, `${d.entity_type}:${d.entity_id}`);
  return { id };
});
H.get('/api/attachments/:id/download', ({ user, params }) => {
  const a = db.get('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', params.id);
  if (!a || !attachmentAccess(user, a, false)) throw notFound('الملف غير موجود.');
  const file = path.join(FILES, a.storage_key);
  if (!fs.existsSync(file)) throw notFound('الملف غير موجود.');
  audit.log(user.id, 'attachment', a.id, 'download');
  return { __raw: true, headers: { 'Content-Type': a.mime || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}` }, body: fs.readFileSync(file) };
});

// ---------- إنشاء اجتماع/بند من KPI (Management Attention) ----------
H.post('/api/meetings/from-kpi', ({ user, body }) => {
  const k = db.get('SELECT * FROM kpis WHERE id = ? AND deleted_at IS NULL', body.kpi_id);
  if (!k || !rbac.canSeeKpi(user, k)) throw notFound('KPI غير موجود.');
  let m;
  if (body.meeting_id) m = loadMeeting(user, body.meeting_id, { edit: true });
  else {
    if (!(rbac.isManagerRole(user))) throw forbidden();
    const lin = rbac.lineage(user.org_unit_id);
    const nd = addDays(today(), 3);
    const mid = db.insert('meetings', { code: code('MTG'), title: `متابعة أداء: ${k.name}`, type: 'management', company_id: lin.company_id, bu_id: null, dept_id: null, leader_id: user.id, meeting_date: nd, start_time: '10:00', duration_min: 45, mode: 'in_person', objective: `مناقشة الانحراف في «${k.name}» والاتفاق على إجراءات تصحيحية.`, status: 'draft', created_by: user.id, created_at: nowIso(), updated_at: nowIso() });
    db.insert('meeting_participants', { meeting_id: mid, employee_id: user.id, invitation: 'accepted' });
    if (k.owner_id && k.owner_id !== user.id) db.insert('meeting_participants', { meeting_id: mid, employee_id: k.owner_id });
    m = db.get('SELECT * FROM meetings WHERE id = ?', mid);
  }
  if (!['draft', 'preparation', 'preparation_published', 'ready', 'live'].includes(m.status)) throw conflict('لا يمكن إضافة بند لاجتماع في هذه الحالة.');
  const r = db.get('SELECT * FROM kpi_results WHERE kpi_id = ? AND actual IS NOT NULL ORDER BY period_start DESC LIMIT 1', k.id);
  const seq = (db.get('SELECT MAX(seq) s FROM agenda_items WHERE meeting_id = ?', m.id).s || 0) + 1;
  const aid = db.insert('agenda_items', { meeting_id: m.id, seq, topic: `انحراف KPI: ${k.name}`, presenter_id: k.owner_id, type: 'decision_required', est_min: 15, objective: r ? `الإنجاز ${r.achievement}% (${r.period_key})` : null, required_decision: 'إجراء تصحيحي ومسؤول وموعد', related_kpi_id: k.id, status: 'pending', created_at: nowIso(), updated_at: nowIso() });
  db.run('INSERT OR IGNORE INTO meeting_kpis(meeting_id, kpi_id) VALUES (?,?)', m.id, k.id);
  if (k.owner_id) db.run('INSERT OR IGNORE INTO meeting_participants(meeting_id, employee_id) VALUES (?,?)', m.id, k.owner_id);
  audit.log(user.id, 'meeting', m.id, 'agenda_from_kpi', 'kpi', null, k.code);
  return { meeting_id: m.id, agenda_item_id: aid };
});

H.post('/api/admin/run-automation', ({ user }) => { rbac.requireRole(user, 'system_admin', 'executive', 'hr_admin'); return require('./automation').runAll(); });

module.exports = { buildPack, TRANSITIONS, STATUS_AR, runAutomation, prepState, listRow, loadMeeting };
