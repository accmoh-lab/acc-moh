from datetime import timedelta

from odoo import Command, fields
from odoo.exceptions import UserError, ValidationError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestMeetingFlow(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.type_management = cls.env.ref('acc_meeting.meeting_type_management')
        cls.type_board = cls.env.ref('acc_meeting.meeting_type_board')
        cls.reason = cls.env.ref('acc_meeting.deviation_reason_resources')
        cls.user_a = cls.env['res.users'].create({'name': 'Meeting User A', 'login': 'meeting_a'})
        cls.user_b = cls.env['res.users'].create({'name': 'Meeting User B', 'login': 'meeting_b'})

    def _new_meeting(self, meeting_type, **kwargs):
        vals = {
            'name': 'Weekly follow-up',
            'meeting_type_id': meeting_type.id,
            'date_start': fields.Datetime.now() + timedelta(days=1),
            'attendee_ids': [
                Command.create({'partner_id': self.user_a.partner_id.id}),
                Command.create({'partner_id': self.user_b.partner_id.id}),
            ],
            'agenda_line_ids': [Command.create({'name': 'Review KPIs', 'duration_minutes': 15})],
        }
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

    def test_confirm_requires_attendees_and_agenda(self):
        meeting = self._new_meeting(self.type_management, attendee_ids=False)
        with self.assertRaises(UserError):
            meeting.action_confirm()
        meeting = self._new_meeting(self.type_management, agenda_line_ids=False)
        with self.assertRaises(UserError):
            meeting.action_confirm()

    def test_full_cycle_with_followup_and_deviation(self):
        meeting = self._new_meeting(self.type_management)
        meeting.action_confirm()
        self.assertEqual(meeting.state, 'scheduled')
        self.assertTrue(meeting.calendar_event_id)
        self.assertEqual(meeting.reference[:4], 'MTG/')

        task_done = self._new_task(meeting, name='Finished item')
        task_late = self._new_task(meeting, name='Late item')
        self.assertEqual(task_late.original_deadline, task_late.date_deadline)
        meeting.action_start()
        meeting.action_done()
        self.assertEqual(meeting.state, 'done')
        self.assertEqual(meeting.task_count, 2)

        task_done.action_done()
        self.assertEqual(task_done.state, 'done')
        self.assertTrue(task_done.date_done)

        # Next meeting lists both items of the previous meeting for review.
        action = meeting.action_schedule_next()
        nxt = self.env['acc.meeting'].browse(action['res_id'])
        self.assertEqual(nxt.previous_meeting_id, meeting)
        self.assertEqual(meeting.next_meeting_id, nxt)
        self.assertEqual(len(nxt.followup_ids), 2)
        done_line = nxt.followup_ids.filtered(lambda f: f.task_id == task_done)
        late_line = nxt.followup_ids.filtered(lambda f: f.task_id == task_late)
        self.assertEqual(done_line.review_state, 'completed')
        self.assertFalse(late_line.review_state)

        nxt.agenda_line_ids = [Command.create({'name': 'Follow-up'})]
        nxt.action_confirm()
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
        meeting = self._new_meeting(self.type_management)
        task = self._new_task(meeting, task_type='issue', name='Supplier dispute')
        board = self._new_meeting(self.type_board, name='Board meeting')

        with self.assertRaises(UserError):
            task.action_escalate_to(self.env.ref('acc_meeting.meeting_type_department'), 'x')

        task.action_escalate_to(self.type_board, 'Needs a Board decision')
        self.assertEqual(task.state, 'escalated')
        self.assertTrue(board.agenda_line_ids.filtered(lambda a: a.task_id == task))

        board.action_confirm()
        self.assertEqual(len(board.agenda_line_ids.filtered(lambda a: a.task_id == task)), 1)

        task.action_resolve_escalation()
        self.assertEqual(task.state, 'in_progress')

    def test_overdue_flag_and_search(self):
        meeting = self._new_meeting(self.type_management)
        late = self._new_task(meeting, date_deadline=fields.Date.today() - timedelta(days=2))
        on_time = self._new_task(meeting)
        self.assertTrue(late.is_overdue)
        self.assertEqual(late.delay_days, 2)
        self.assertFalse(on_time.is_overdue)
        found = self.env['acc.meeting.task'].search([('is_overdue', '=', True)])
        self.assertIn(late, found)
        self.assertNotIn(on_time, found)

    def test_department_from_employee(self):
        department = self.env['hr.department'].create({'name': 'Finance'})
        self.env['hr.employee'].create({
            'name': 'Meeting User A', 'user_id': self.user_a.id, 'department_id': department.id,
        })
        meeting = self._new_meeting(self.type_management)
        task = self._new_task(meeting)
        self.assertEqual(task.department_id, department)
