from odoo import fields, models


class AccMeetingDecision(models.Model):
    _name = 'acc.meeting.decision'
    _description = 'Meeting Decision'
    _order = 'sequence, id'

    meeting_id = fields.Many2one('acc.meeting', required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(default=10)
    name = fields.Char(string='Decision', required=True)
    outcome = fields.Selection(
        [
            ('approved', 'Approved'),
            ('rejected', 'Rejected'),
            ('deferred', 'Deferred'),
            ('noted', 'Noted'),
        ],
        default='approved',
        required=True,
    )
    details = fields.Text(string='Details / Rationale')
    task_ids = fields.One2many('acc.meeting.task', 'decision_id', string='Resulting Action Items')
