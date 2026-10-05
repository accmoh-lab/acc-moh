from odoo import fields, models


class AccMeetingTaskEscalate(models.TransientModel):
    _name = 'acc.meeting.task.escalate'
    _description = 'Escalate Action Item'

    task_id = fields.Many2one('acc.meeting.task', required=True, readonly=True)
    min_level = fields.Integer(related='task_id.current_level')
    meeting_type_id = fields.Many2one('acc.meeting.type', string='Escalate To', required=True)
    reason = fields.Text(string='Reason for Escalation', required=True)

    def action_confirm(self):
        self.ensure_one()
        self.task_id.action_escalate_to(self.meeting_type_id, self.reason)
        return {'type': 'ir.actions.act_window_close'}
