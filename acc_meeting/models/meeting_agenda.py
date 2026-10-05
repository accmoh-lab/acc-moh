from odoo import fields, models


class AccMeetingAgenda(models.Model):
    _name = 'acc.meeting.agenda'
    _description = 'Meeting Agenda Item'
    _order = 'sequence, id'

    meeting_id = fields.Many2one('acc.meeting', required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(default=10)
    name = fields.Char(string='Topic', required=True)
    description = fields.Text(string='Details')
    presenter_id = fields.Many2one('res.users', string='Presenter', domain=[('share', '=', False)])
    duration_minutes = fields.Integer(string='Duration (min)', default=10)
    source = fields.Selection(
        [('planned', 'Planned'), ('escalated', 'Escalated')],
        default='planned',
        required=True,
    )
    task_id = fields.Many2one(
        'acc.meeting.task',
        string='Linked Item',
        readonly=True,
        ondelete='set null',
        help='Escalated task or issue that this agenda item is about.',
    )
    discussed = fields.Boolean()
    outcome = fields.Text(string='Outcome / Decision')
