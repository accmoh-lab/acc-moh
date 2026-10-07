from datetime import timedelta

from odoo import Command, fields
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import TransactionCase, tagged

MINUTES = '<p>Discussion summary</p>'


@tagged('post_install', '-at_install')
class TestMeetingFlow(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.type_department = cls.env.ref('acc_meeting.meeting_type_department')
        cls.type_unit = cls.env.ref('acc_meeting.meeting_type_business_unit')
        cls.type_board = cls.env.ref('acc_meeting.meeting_type_board')
        cls.reason = cls.env.ref('acc_meeting.deviation_reason_resources')
        cls.group_user = cls.env.ref('acc_meeting.group_meeting_user')
        cls.department = cls.env['hr.department'].create({'name': 'Finance'})
        cls.unit = cls.env['acc.business.unit'].create({'name': 'Factory'})
        cls.user_a = cls._make_user('Meeting User A', 'meeting_a')
        cls.user_b = cls._make_user('Meeting User B', 'meeting_b')
        cls.user_c = cls._make_user('Meeting User C', 'meeting_c')

    @classmethod
    def _make_user(cls, name, login):
        user = cls.env['res.users'].create({'name': name, 'login': login})
        field = 'group_ids' if 'group_ids' in user._fields else 'groups_id'
        user.write({field: [Command.link(cls.group_user.id)]})
        return user

    def _new_meeting(self, meeting_type, days=1, **kwargs):
        vals = {
            'name': 'Weekly follow-up',
            'meeting_type_id': meeting_type.id,
            'date_start': fields.Datetime.now() + timedelta(days=days),
            'organizer_id': self.user_a.id,
            'attendee_ids': [
                Command.create({'partner_id': self.user_a.partner_id.id}),
                Command.create({'partner_id': self.user_b.partner_id.id}),
            ],
            'agenda_line_ids': [Command.create({'name': 'Review KPIs', 'duration_minutes': 15})],
        }
        if meeting_type.scope == 'department':
            vals['department_id'] = self.department.id
        elif meeting_type.scope == 'business_unit':
            vals['business_unit_id'] = self.unit.id
        vals.update(kwargs)
        return self.env['acc.meeting'].create(vals)

    def _new_task(self, meeting, **kwargs):
        vals = {
            'name': 'Prepare report',
            'meeting_id': meeting.id,
            'assignee_id': self.user_a.id,
            'date_deadline': fields.Date.today() + timedelta(days=3),
        }
        vals.update(kwargs)
        return self.env['acc.meeting.task'].create(vals)

    def _close(self, meeting):
        meeting.minutes = MINUTES
        meeting.action_done()

    # ------------------------------------------------------------------
    # Scheduling rules
    # ------------------------------------------------------------------
    def test_confirm_requires_attendees_agenda_and_scope(self):
        meeting = self._new_meeting(self.type_department, attendee_ids=False)
        with self.assertRaises(UserError):
            meeting.action_confirm()
        meeting = self._new_meeting(self.type_department, agenda_line_ids=False)
        with self.assertRaises(UserError):
            meeting.action_confirm()
        meeting = self._new_meeting(self.type_department, department_id=False)
        with self.assertRaises(UserError):
            meeting.action_confirm()
        board = self._new_meeting(self.type_board)
        board.action_confirm()  # the board level needs neither department nor unit
        self.assertEqual(board.state, 'scheduled')

    def test_every_meeting_has_one_preparation(self):
        meeting = self._new_meeting(self.type_department)
        self.assertEqual(len(meeting.preparation_ids), 1)
        with self.assertRaises(ValidationError):
            self.env['acc.meeting.preparation'].create({'meeting_id': meeting.id})

    def test_closing_requires_minutes(self):
        meeting = self._new_meeting(self.type_department)
        meeting.action_confirm()
        with self.assertRaises(UserError):
            meeting.action_done()
        self._close(meeting)
        self.assertEqual(meeting.state, 'done')

    # ------------------------------------------------------------------
    # Visibility: each person sees only their meetings
    # ------------------------------------------------------------------
    def test_users_see_only_their_meetings(self):
        meeting = self._new_meeting(self.type_department)
        Meeting = self.env['acc.meeting']
        self.assertIn(meeting, Meeting.with_user(self.user_a).search([]))
        self.assertIn(meeting, Meeting.with_user(self.user_b).search([]))
        self.assertNotIn(meeting, Meeting.with_user(self.user_c).search([]))
        with self.assertRaises(AccessError):
            meeting.with_user(self.user_c).read(['name'])

    def test_assignee_sees_meeting_report_only_after_task(self):
        meeting = self._new_meeting(self.type_department)
        Meeting = self.env['acc.meeting']
        self.assertNotIn(meeting, Meeting.with_user(self.user_c).search([]))
        self._new_task(meeting, assignee_id=self.user_c.id)
        self.assertIn(meeting, Meeting.with_user(self.user_c).search([]))

    def test_only_leaders_edit_meeting(self):
        meeting = self._new_meeting(self.type_department)
        meeting.with_user(self.user_a).write({'location': 'Room 1'})
        with self.assertRaises(AccessError):
            meeting.with_user(self.user_b).write({'location': 'Room 2'})

    # ------------------------------------------------------------------
    # Preparation report released 48 hours before the meeting
    # ------------------------------------------------------------------
    def test_preparation_is_hidden_from_members_until_released(self):
        meeting = self._new_meeting(self.type_department, days=5)
        meeting.action_confirm()
        prep = meeting.preparation_ids
        prep.with_user(self.user_a).write({'summary': '<p>Background and figures</p>'})
        prep.with_user(self.user_a).action_publish()
        self.assertEqual(prep.state, 'published')
        self.assertFalse(prep.released)  # 5 days away: not yet visible

        Prep = self.env['acc.meeting.preparation']
        self.assertIn(prep, Prep.with_user(self.user_a).search([]))  # leader
        self.assertNotIn(prep, Prep.with_user(self.user_b).search([]))  # member, not released

        # the meeting moves inside the 48 hours window; the scheduled action releases it
        meeting.date_start = fields.Datetime.now() + timedelta(hours=30)
        Prep._cron_release_preparations()
        self.assertTrue(prep.released)
        self.assertIn(prep, Prep.with_user(self.user_b).search([]))
        self.assertNotIn(prep, Prep.with_user(self.user_c).search([]))  # not an attendee

    def test_publishing_inside_window_releases_immediately(self):
        meeting = self._new_meeting(self.type_department, days=1)
        meeting.action_confirm()
        prep = meeting.preparation_ids
        prep.summary = '<p>Background</p>'
        prep.action_publish()
        self.assertTrue(prep.released)
        self.assertIn(prep, self.env['acc.meeting.preparation'].with_user(self.user_b).search([]))

    def test_publish_needs_content_and_release_cannot_be_withdrawn(self):
        meeting = self._new_meeting(self.type_department, days=1)
        meeting.action_confirm()
        prep = meeting.preparation_ids
        with self.assertRaises(UserError):
            prep.action_publish()
        prep.summary = '<p>Background</p>'
        prep.action_publish()
        with self.assertRaises(UserError):
            prep.action_unpublish()

    # ------------------------------------------------------------------
    # After the meeting: decisions, tasks, follow-up and deviation
    # ------------------------------------------------------------------
    def test_full_cycle_with_decisions_followup_and_deviation(self):
        meeting = self._new_meeting(self.type_unit)
        meeting.action_confirm()
        self.assertEqual(meeting.state, 'scheduled')
        self.assertTrue(meeting.calendar_event_id)
        self.assertEqual(meeting.reference[:4], 'MTG/')

        decision = self.env['acc.meeting.decision'].create({
            'meeting_id': meeting.id, 'name': 'Approve the new schedule', 'outcome': 'approved',
        })
        task_done = self._new_task(meeting, name='Finished item', decision_id=decision.id)
        task_late = self._new_task(meeting, name='Late item')
        self.assertEqual(task_late.original_deadline, task_late.date_deadline)
        meeting.action_start()
        self._close(meeting)
        self.assertEqual(meeting.state, 'done')
        self.assertEqual(meeting.task_count, 2)
        self.assertEqual(meeting.decision_count, 1)

        task_done.action_done()
        self.assertEqual(task_done.state, 'done')
        self.assertTrue(task_done.date_done)

        # the next meeting lists both items of the previous meeting for review
        action = meeting.action_schedule_next()
        nxt = self.env['acc.meeting'].browse(action['res_id'])
        self.assertEqual(nxt.previous_meeting_id, meeting)
        self.assertEqual(nxt.business_unit_id, self.unit)
        self.assertEqual(meeting.next_meeting_id, nxt)
        self.assertEqual(len(nxt.followup_ids), 2)
        done_line = nxt.followup_ids.filtered(lambda f: f.task_id == task_done)
        late_line = nxt.followup_ids.filtered(lambda f: f.task_id == task_late)
        self.assertEqual(done_line.review_state, 'completed')
        self.assertFalse(late_line.review_state)

        nxt.agenda_line_ids = [Command.create({'name': 'Follow-up'})]
        nxt.action_confirm()
        nxt.minutes = MINUTES
        with self.assertRaises(UserError):
            nxt.action_done()  # the late item is not reviewed yet

        with self.assertRaises(ValidationError):
            late_line.review_state = 'delayed'  # reason and new date are mandatory

        new_due = fields.Date.today() + timedelta(days=10)
        late_line.write({
            'review_state': 'delayed',
            'deviation_reason_id': self.reason.id,
            'new_due_date': new_due,
            'deviation_notes': 'Waiting for the vendor',
        })
        nxt.action_done()
        self.assertEqual(task_late.date_deadline, new_due)
        self.assertEqual(task_late.deviation_reason_id, self.reason)
        self.assertEqual(task_late.postponement_count, 1)
        self.assertEqual(task_late.original_deadline, fields.Date.today() + timedelta(days=3))
        self.assertEqual(nxt.followup_deviation_count, 1)

    def test_escalation_to_board(self):
        meeting = self._new_meeting(self.type_unit)
        task = self._new_task(meeting, task_type='issue', name='Supplier dispute')
        board = self._new_meeting(self.type_board, name='Board meeting')

        with self.assertRaises(UserError):
            task.action_escalate_to(self.type_department, 'x')

        task.action_escalate_to(self.type_board, 'Needs a Board decision')
        self.assertEqual(task.state, 'escalated')
        self.assertTrue(board.agenda_line_ids.filtered(lambda a: a.task_id == task))

        board.action_confirm()
        self.assertEqual(len(board.agenda_line_ids.filtered(lambda a: a.task_id == task)), 1)

        task.action_resolve_escalation()
        self.assertEqual(task.state, 'in_progress')

    def test_overdue_flag_and_search(self):
        meeting = self._new_meeting(self.type_unit)
        late = self._new_task(meeting, date_deadline=fields.Date.today() - timedelta(days=2))
        on_time = self._new_task(meeting)
        self.assertTrue(late.is_overdue)
        self.assertEqual(late.delay_days, 2)
        self.assertFalse(on_time.is_overdue)
        found = self.env['acc.meeting.task'].search([('is_overdue', '=', True)])
        self.assertIn(late, found)
        self.assertNotIn(on_time, found)

    def test_department_from_employee(self):
        self.env['hr.employee'].create({
            'name': 'Meeting User A', 'user_id': self.user_a.id, 'department_id': self.department.id,
        })
        meeting = self._new_meeting(self.type_unit)
        task = self._new_task(meeting)
        self.assertEqual(task.department_id, self.department)
