from odoo import fields, models


class AccMeetingType(models.Model):
    _name = 'acc.meeting.type'
    _description = 'Meeting Type'
    _order = 'level, id'

    name = fields.Char(required=True, translate=True)
    level = fields.Integer(
        string='Authority Level',
        default=10,
        required=True,
        help='Higher number = higher authority (e.g. Department 10, Management 20, '
             'Executive 30, Board 40). Items can only be escalated to a higher level.',
    )
    default_duration = fields.Float(string='Default Duration (hours)', default=1.0)
    description = fields.Text()
    active = fields.Boolean(default=True)
