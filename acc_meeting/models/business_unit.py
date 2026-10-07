from odoo import fields, models


class AccBusinessUnit(models.Model):
    _name = 'acc.business.unit'
    _description = 'Business Unit'
    _order = 'name'

    name = fields.Char(required=True, translate=True)
    manager_id = fields.Many2one('res.users', string='Head of Unit', domain=[('share', '=', False)])
    active = fields.Boolean(default=True)
