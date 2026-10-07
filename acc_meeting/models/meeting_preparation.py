from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import is_html_empty

DEFAULT_RELEASE_HOURS = 48


class AccMeetingPreparation(models.Model):
    """Preparation report written by the meeting leader.

    Members can read it only once it is *released*: published by the leader and the
    meeting is at most N hours away (48 by default, system parameter
    ``acc_meeting.prep_release_hours``). The release flag is stored and set by
    ``_release_if_due`` (on publish / confirm) and by the scheduled action, so that the
    record rules can enforce visibility without time-dependent domains.
    """
    _name = 'acc.meeting.preparation'
    _description = 'Meeting Preparation'
    _inherit = ['mail.thread']
    _order = 'id desc'

    meeting_id = fields.Many2one('acc.meeting', required=True, ondelete='cascade', index=True)
    meeting_date = fields.Datetime(related='meeting_id.date_start', string='Meeting Date')
    meeting_type_id = fields.Many2one(related='meeting_id.meeting_type_id')
    meeting_state = fields.Selection(related='meeting_id.state')
    is_leader = fields.Boolean(related='meeting_id.is_leader')
    state = fields.Selection(
        [('draft', 'Draft'), ('published', 'Published')],
        default='draft', required=True, tracking=True, copy=False,
    )
    released = fields.Boolean(
        string='Visible to Attendees', readonly=True, copy=False, tracking=True,
        help='Set automatically when the report is published and the meeting is within the release window.',
    )
    released_on = fields.Datetime(readonly=True, copy=False)
    release_hours = fields.Integer(string='Released (hours before meeting)', compute='_compute_release_hours')
    summary = fields.Html(string='Preparation Report')
    expected_decisions = fields.Html(string='Decisions Expected from the Meeting')
    required_from_members = fields.Html(string='Required from Members Before the Meeting')

    @api.depends_context('uid')
    def _compute_release_hours(self):
        hours = self._get_release_hours()
        for rec in self:
            rec.release_hours = hours

    @api.depends('meeting_id.name')
    def _compute_display_name(self):
        for rec in self:
            rec.display_name = _('Preparation: %s', rec.meeting_id.name or '')

    @api.constrains('meeting_id')
    def _check_unique_meeting(self):
        for rec in self:
            if self.search_count([('meeting_id', '=', rec.meeting_id.id), ('id', '!=', rec.id)]):
                raise ValidationError(_('A meeting can have only one preparation report.'))

    # ------------------------------------------------------------------
    # Release logic
    # ------------------------------------------------------------------
    @api.model
    def _get_release_hours(self):
        value = self.env['ir.config_parameter'].sudo().get_param('acc_meeting.prep_release_hours')
        try:
            return int(value)
        except (TypeError, ValueError):
            return DEFAULT_RELEASE_HOURS

    def _is_due(self):
        self.ensure_one()
        meeting = self.meeting_id
        if not meeting.date_start or meeting.state not in ('scheduled', 'in_progress', 'done'):
            return False
        return fields.Datetime.now() >= meeting.date_start - timedelta(hours=self._get_release_hours())

    def _release_if_due(self):
        for rec in self.filtered(lambda p: p.state == 'published' and not p.released):
            if rec._is_due():
                rec._release()

    def _release(self):
        self.ensure_one()
        self.write({'released': True, 'released_on': fields.Datetime.now()})
        meeting = self.meeting_id
        partners = meeting.attendee_ids.partner_id
        meeting.message_post(
            body=_('The preparation report for "%s" is now available to the attendees.', meeting.name),
            partner_ids=partners.ids,
            subtype_xmlid='mail.mt_comment',
        )

    def action_publish(self):
        for rec in self:
            if rec.meeting_id.state in ('done', 'cancelled'):
                raise UserError(_('The meeting is already closed or cancelled.'))
            if is_html_empty(rec.summary):
                raise UserError(_('Write the preparation report before publishing it.'))
            rec.state = 'published'
            rec._release_if_due()
        return True

    def action_unpublish(self):
        for rec in self:
            if rec.released:
                raise UserError(_('The report is already visible to the attendees and cannot be withdrawn.'))
            rec.state = 'draft'
        return True

    @api.model
    def _cron_release_preparations(self):
        """Release due reports and remind leaders whose report is still unpublished."""
        limit = fields.Datetime.now() + timedelta(hours=self._get_release_hours())
        due = self.search([
            ('state', '=', 'published'),
            ('released', '=', False),
            ('meeting_id.state', 'in', ('scheduled', 'in_progress')),
            ('meeting_id.date_start', '<=', limit),
        ])
        due._release_if_due()

        Meeting = self.env['acc.meeting']
        late = Meeting.search([
            ('state', '=', 'scheduled'),
            ('date_start', '<=', limit),
            ('date_start', '>', fields.Datetime.now()),
            ('prep_reminder_sent', '=', False),
            ('preparation_ids.state', '=', 'draft'),
        ])
        for meeting in late:
            for user in (meeting.organizer_id | meeting.chairperson_id):
                meeting.activity_schedule(
                    'mail.mail_activity_data_todo',
                    date_deadline=fields.Date.context_today(meeting),
                    summary=_('Publish the preparation report'),
                    note=_('The meeting "%s" is within %s hours and its preparation report is not published.',
                           meeting.name, self._get_release_hours()),
                    user_id=user.id,
                )
            meeting.prep_reminder_sent = True
