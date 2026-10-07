from odoo import fields, models


class AccMeetingType(models.Model):
    _name = 'acc.meeting.type'
    _description = 'Meeting Type'
    _order = 'level, id'

    name = fields.Char(required=True, translate=True)
    scope = fields.Selection(
        [
            ('department', 'Department'),
            ('business_unit', 'Business Unit'),
            ('board', 'Board'),
        ],
        string='Meeting Level',
        required=True,
        default='department',
        help='Department meetings are tied to a company department, business unit meetings '
             'to a business unit, and board meetings to neither.',
    )
    level = fields.Integer(
        string='Authority Level',
        default=10,
        required=True,
        help='Higher number = higher authority (e.g. Department 10, Business Unit 20, '
             'Board 30). Items can only be escalated to a higher level.',
    )
    default_duration = fields.Float(string='Default Duration (hours)', default=1.0)
    description = fields.Text()
    active = fields.Boolean(default=True)
