from odoo import fields, models


class AccMeetingDeviationReason(models.Model):
    _name = 'acc.meeting.deviation.reason'
    _description = 'Deviation Reason'
    _order = 'sequence, id'

    name = fields.Char(required=True, translate=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
