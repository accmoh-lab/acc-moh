from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class AccMeetingAttendee(models.Model):
    _name = 'acc.meeting.attendee'
    _description = 'Meeting Attendee'
    _order = 'id'

    meeting_id = fields.Many2one('acc.meeting', required=True, ondelete='cascade', index=True)
    partner_id = fields.Many2one('res.partner', string='Attendee', required=True)
    email = fields.Char(related='partner_id.email')
    attendance = fields.Selection(
        [
            ('invited', 'Invited'),
            ('present', 'Present'),
            ('absent', 'Absent'),
            ('excused', 'Excused'),
        ],
        default='invited',
        required=True,
    )

    @api.depends('partner_id')
    def _compute_display_name(self):
        for rec in self:
            rec.display_name = rec.partner_id.name or ''

    @api.constrains('meeting_id', 'partner_id')
    def _check_unique_attendee(self):
        for rec in self:
            duplicates = self.search_count([
                ('meeting_id', '=', rec.meeting_id.id),
                ('partner_id', '=', rec.partner_id.id),
                ('id', '!=', rec.id),
            ])
            if duplicates:
                raise ValidationError(
                    _('%s is already listed as an attendee of this meeting.', rec.partner_id.name)
                )
