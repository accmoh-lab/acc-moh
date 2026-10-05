from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class AccMeetingFollowup(models.Model):
    """Review of a previous action item inside a meeting.

    Each delayed / cancelled line is a recorded *deviation* with its reason, which
    feeds the deviation analysis report.
    """
    _name = 'acc.meeting.followup'
    _description = 'Meeting Follow-up Line'
    _order = 'meeting_date desc, id'

    meeting_id = fields.Many2one('acc.meeting', required=True, ondelete='cascade', index=True)
    meeting_type_id = fields.Many2one(related='meeting_id.meeting_type_id', store=True)
    meeting_date = fields.Datetime(related='meeting_id.date_start', store=True)
    task_id = fields.Many2one('acc.meeting.task', string='Action Item', required=True, ondelete='cascade')
    origin_meeting_id = fields.Many2one(related='task_id.meeting_id', string='Raised in', store=True)
    assignee_id = fields.Many2one(related='task_id.assignee_id', string='Responsible', store=True)
    date_deadline = fields.Date(related='task_id.date_deadline', string='Due Date')
    task_state = fields.Selection(related='task_id.state', string='Current Status')

    review_state = fields.Selection(
        [
            ('completed', 'Completed'),
            ('in_progress', 'In Progress (on track)'),
            ('delayed', 'Delayed'),
            ('cancelled', 'Cancelled'),
        ],
        string='Review Result',
        compute='_compute_review_state', store=True, readonly=False,
    )
    deviation_reason_id = fields.Many2one('acc.meeting.deviation.reason', string='Deviation Reason')
    deviation_notes = fields.Text(string='Notes')
    new_due_date = fields.Date()
    applied = fields.Boolean(readonly=True, copy=False)

    @api.depends('task_id.state')
    def _compute_review_state(self):
        for line in self:
            if line.task_id.state == 'done':
                line.review_state = 'completed'
            elif line.review_state == 'completed':
                line.review_state = False
            else:
                line.review_state = line.review_state or False

    @api.depends('meeting_id.reference', 'task_id.name')
    def _compute_display_name(self):
        for line in self:
            line.display_name = '%s - %s' % (line.meeting_id.reference or '', line.task_id.name or '')

    @api.constrains('meeting_id', 'task_id')
    def _check_unique_task(self):
        for line in self:
            if self.search_count([
                ('meeting_id', '=', line.meeting_id.id),
                ('task_id', '=', line.task_id.id),
                ('id', '!=', line.id),
            ]):
                raise ValidationError(_('This action item is already reviewed in this meeting.'))

    @api.constrains('review_state', 'deviation_reason_id', 'new_due_date')
    def _check_deviation(self):
        for line in self:
            if line.review_state in ('delayed', 'cancelled') and not line.deviation_reason_id:
                raise ValidationError(
                    _('A deviation reason is required for delayed or cancelled action items.')
                )
            if line.review_state == 'delayed' and not line.new_due_date:
                raise ValidationError(_('Set a new due date for delayed action items.'))

    def _apply_review(self):
        """Write the review result back on the action items (called when the meeting closes)."""
        for line in self.filtered(lambda l: not l.applied and l.review_state):
            task = line.task_id
            if line.review_state == 'completed':
                task.action_done()
            elif line.review_state == 'in_progress':
                task.action_start()
            elif line.review_state == 'delayed':
                task._register_delay(
                    line.new_due_date, line.deviation_reason_id,
                    line.deviation_notes, line.meeting_id,
                )
            elif line.review_state == 'cancelled':
                task.write({
                    'deviation_reason_id': line.deviation_reason_id.id,
                    'deviation_notes': line.deviation_notes,
                })
                task.action_cancel()
            line.applied = True
