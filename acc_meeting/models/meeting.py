from datetime import timedelta

from odoo import Command, _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import is_html_empty, plaintext2html

CALENDAR_SYNC_FIELDS = {
    'name', 'date_start', 'duration', 'location', 'online_link',
    'objective', 'organizer_id', 'attendee_ids',
}


class AccMeeting(models.Model):
    _name = 'acc.meeting'
    _description = 'Meeting'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'date_start desc, id desc'

    name = fields.Char(string='Subject', required=True, tracking=True)
    reference = fields.Char(copy=False, readonly=True, default='New')
    meeting_type_id = fields.Many2one(
        'acc.meeting.type', string='Meeting Type', required=True, tracking=True,
    )
    scope = fields.Selection(related='meeting_type_id.scope', store=True)
    department_id = fields.Many2one('hr.department', string='Department', tracking=True)
    business_unit_id = fields.Many2one('acc.business.unit', string='Business Unit', tracking=True)
    state = fields.Selection(
        [
            ('draft', 'Draft'),
            ('scheduled', 'Scheduled'),
            ('in_progress', 'In Progress'),
            ('done', 'Done'),
            ('cancelled', 'Cancelled'),
        ],
        default='draft', required=True, tracking=True, copy=False,
    )
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    # Scheduling
    date_start = fields.Datetime(
        string='Start', required=True, tracking=True,
        default=lambda self: fields.Datetime.now().replace(minute=0, second=0, microsecond=0)
        + timedelta(days=1),
    )
    duration = fields.Float(string='Duration (hours)', default=1.0, required=True)
    date_stop = fields.Datetime(string='End', compute='_compute_date_stop', store=True)
    location = fields.Char()
    online_link = fields.Char(string='Online Meeting Link')

    # People
    organizer_id = fields.Many2one(
        'res.users', string='Organizer', default=lambda self: self.env.user, tracking=True,
    )
    chairperson_id = fields.Many2one('res.users', string='Chairperson')
    secretary_id = fields.Many2one('res.users', string='Minute Taker')
    attendee_ids = fields.One2many('acc.meeting.attendee', 'meeting_id', string='Attendees', copy=True)
    leader_user_ids = fields.Many2many(
        'res.users', 'acc_meeting_leader_user_rel', 'meeting_id', 'user_id',
        compute='_compute_leader_user_ids', store=True,
        help='Organizer, chairperson and minute taker (used by record rules).',
    )
    member_user_ids = fields.Many2many(
        'res.users', 'acc_meeting_member_user_rel', 'meeting_id', 'user_id',
        compute='_compute_member_user_ids', store=True,
        help='Users who are listed as attendees (used by record rules).',
    )
    allowed_user_ids = fields.Many2many(
        'res.users', 'acc_meeting_allowed_user_rel', 'meeting_id', 'user_id',
        compute='_compute_allowed_user_ids', store=True,
        help='Leaders, attendees and users with an action item from this meeting '
             '(used by record rules).',
    )
    is_leader = fields.Boolean(compute='_compute_is_leader')
    calendar_event_id = fields.Many2one(
        'calendar.event', string='Calendar Event', copy=False, readonly=True, ondelete='set null',
    )

    # Preparation (visible to members only when released)
    preparation_ids = fields.One2many('acc.meeting.preparation', 'meeting_id', string='Preparation')
    preparation_id = fields.Many2one('acc.meeting.preparation', compute='_compute_preparation_id')
    prep_state = fields.Selection(related='preparation_id.state')
    prep_released = fields.Boolean(related='preparation_id.released')
    prep_reminder_sent = fields.Boolean(copy=False)
    objective = fields.Text(string='Objective')
    agenda_line_ids = fields.One2many('acc.meeting.agenda', 'meeting_id', string='Agenda')
    agenda_duration = fields.Integer(string='Agenda Total (min)', compute='_compute_agenda_duration')

    # Outcome
    minutes = fields.Html(string='Minutes / Discussion Summary')
    decision_ids = fields.One2many('acc.meeting.decision', 'meeting_id', string='Decisions')
    task_ids = fields.One2many('acc.meeting.task', 'meeting_id', string='Action Items')

    # Follow-up of previous meeting
    previous_meeting_id = fields.Many2one(
        'acc.meeting', string='Previous Meeting', copy=False, index=True, ondelete='set null',
        tracking=True,
    )
    next_meeting_id = fields.Many2one(
        'acc.meeting', string='Next Meeting', compute='_compute_next_meeting_id',
    )
    followup_ids = fields.One2many(
        'acc.meeting.followup', 'meeting_id', string='Previous Action Items Review',
    )

    # Statistics
    task_count = fields.Integer(compute='_compute_stats')
    task_done_count = fields.Integer(compute='_compute_stats')
    task_open_count = fields.Integer(compute='_compute_stats')
    decision_count = fields.Integer(compute='_compute_stats')
    completion_rate = fields.Float(string='Completion Rate (%)', compute='_compute_stats')
    followup_count = fields.Integer(compute='_compute_stats')
    followup_completed_count = fields.Integer(compute='_compute_stats')
    followup_deviation_count = fields.Integer(compute='_compute_stats')

    # ------------------------------------------------------------------
    # Computes / constraints
    # ------------------------------------------------------------------
    @api.depends('date_start', 'duration')
    def _compute_date_stop(self):
        for rec in self:
            rec.date_stop = rec.date_start + timedelta(hours=rec.duration) if rec.date_start else False

    @api.depends('organizer_id', 'chairperson_id', 'secretary_id')
    def _compute_leader_user_ids(self):
        for rec in self:
            rec.leader_user_ids = rec.organizer_id | rec.chairperson_id | rec.secretary_id

    @api.depends('attendee_ids.partner_id')
    def _compute_member_user_ids(self):
        for rec in self:
            rec.member_user_ids = rec.attendee_ids.partner_id.sudo().user_ids

    @api.depends('leader_user_ids', 'member_user_ids', 'task_ids.assignee_id', 'create_uid')
    def _compute_allowed_user_ids(self):
        for rec in self:
            users = rec.leader_user_ids | rec.member_user_ids | rec.create_uid
            users |= rec.sudo().task_ids.assignee_id
            rec.allowed_user_ids = users

    @api.depends_context('uid')
    @api.depends('leader_user_ids')
    def _compute_is_leader(self):
        is_manager = self.env.user.has_group('acc_meeting.group_meeting_manager')
        for rec in self:
            rec.is_leader = bool(
                is_manager or not rec._origin or self.env.user in rec.leader_user_ids
            )

    @api.depends('preparation_ids')
    def _compute_preparation_id(self):
        for rec in self:
            rec.preparation_id = rec.preparation_ids[:1]

    @api.depends('agenda_line_ids.duration_minutes')
    def _compute_agenda_duration(self):
        for rec in self:
            rec.agenda_duration = sum(rec.agenda_line_ids.mapped('duration_minutes'))

    def _compute_next_meeting_id(self):
        for rec in self:
            rec.next_meeting_id = self.search([('previous_meeting_id', '=', rec.id)], limit=1)

    @api.depends('task_ids.state', 'decision_ids', 'followup_ids.review_state')
    def _compute_stats(self):
        for rec in self:
            tasks = rec.task_ids.filtered(lambda t: t.state != 'cancelled')
            done = len(tasks.filtered(lambda t: t.state == 'done'))
            rec.task_count = len(tasks)
            rec.task_done_count = done
            rec.task_open_count = len(tasks) - done
            rec.decision_count = len(rec.decision_ids)
            rec.completion_rate = 100.0 * done / len(tasks) if tasks else 0.0
            reviews = rec.followup_ids
            rec.followup_count = len(reviews)
            rec.followup_completed_count = len(reviews.filtered(lambda f: f.review_state == 'completed'))
            rec.followup_deviation_count = len(
                reviews.filtered(lambda f: f.review_state in ('delayed', 'cancelled'))
            )

    @api.constrains('duration')
    def _check_duration(self):
        for rec in self:
            if rec.duration <= 0:
                raise ValidationError(_('The meeting duration must be greater than zero.'))

    @api.constrains('previous_meeting_id')
    def _check_previous_meeting(self):
        if not self._check_recursion(parent='previous_meeting_id'):
            raise ValidationError(_('A meeting cannot be its own predecessor.'))

    @api.onchange('meeting_type_id')
    def _onchange_meeting_type_id(self):
        if self.meeting_type_id:
            self.duration = self.meeting_type_id.default_duration or 1.0

    # ------------------------------------------------------------------
    # ORM overrides
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if not vals.get('reference') or vals['reference'] == 'New':
                vals['reference'] = self.env['ir.sequence'].next_by_code('acc.meeting') or 'New'
        meetings = super().create(vals_list)
        # every meeting has exactly one preparation report, created empty
        self.env['acc.meeting.preparation'].sudo().create([{'meeting_id': m.id} for m in meetings])
        return meetings

    def write(self, vals):
        res = super().write(vals)
        if CALENDAR_SYNC_FIELDS & set(vals):
            self.filtered(lambda m: m.state in ('scheduled', 'in_progress'))._sync_calendar_event()
        if 'date_start' in vals:
            self.sudo().preparation_ids._release_if_due()
        return res

    def unlink(self):
        if any(m.state not in ('draft', 'cancelled') for m in self):
            raise UserError(_('Only draft or cancelled meetings can be deleted.'))
        return super().unlink()

    # ------------------------------------------------------------------
    # Calendar integration
    # ------------------------------------------------------------------
    def _prepare_calendar_vals(self):
        self.ensure_one()
        partners = self.attendee_ids.partner_id | self.organizer_id.partner_id
        description = self.objective or ''
        if self.online_link:
            description += '\n%s: %s' % (_('Online link'), self.online_link)
        return {
            'name': self.name,
            'start': self.date_start,
            'stop': self.date_stop,
            'allday': False,
            'location': self.location,
            'description': plaintext2html(description) if description else False,
            'user_id': self.organizer_id.id or self.env.user.id,
            'partner_ids': [Command.set(partners.ids)],
        }

    def _sync_calendar_event(self):
        for rec in self:
            vals = rec._prepare_calendar_vals()
            if rec.calendar_event_id:
                rec.calendar_event_id.write(vals)
            else:
                rec.calendar_event_id = self.env['calendar.event'].create(vals)

    # ------------------------------------------------------------------
    # Agenda preparation
    # ------------------------------------------------------------------
    def _get_previous_tasks(self):
        """Action items to review in this meeting.

        * every non-cancelled item of the previous meeting (done ones show as completed);
        * items still open from older meetings of the same chain.
        Items already escalated to a higher meeting are excluded.

        Runs with sudo: the leader of this meeting may not be a member of the older ones.
        """
        self.ensure_one()
        Task = self.env['acc.meeting.task'].sudo()
        previous = self.previous_meeting_id.sudo()
        if not previous:
            return Task
        tasks = previous.task_ids.filtered(lambda t: t.state not in ('cancelled', 'escalated'))
        older = self.env['acc.meeting'].sudo()
        cursor = previous.previous_meeting_id
        seen = previous
        while cursor and cursor not in seen:
            seen |= cursor
            older |= cursor
            cursor = cursor.previous_meeting_id
        if older:
            tasks |= Task.search([
                ('meeting_id', 'in', older.ids),
                ('state', 'in', ('open', 'in_progress')),
            ])
        return tasks

    def _get_escalated_tasks(self):
        self.ensure_one()
        return self.env['acc.meeting.task'].sudo().search([
            ('state', '=', 'escalated'),
            ('escalated_to_type_id', '=', self.meeting_type_id.id),
        ])

    def _load_agenda_items(self):
        """Add (idempotently) the follow-up lines of the previous meeting and the
        agenda items for tasks escalated to this meeting level."""
        Followup = self.env['acc.meeting.followup']
        Agenda = self.env['acc.meeting.agenda']
        for rec in self:
            reviewed = set(rec.followup_ids.task_id.ids)
            for task in rec._get_previous_tasks():
                if task.id not in reviewed:
                    Followup.create({'meeting_id': rec.id, 'task_id': task.id})
            listed = set(rec.agenda_line_ids.task_id.ids)
            sequence = max(rec.agenda_line_ids.mapped('sequence') or [0])
            for task in rec._get_escalated_tasks():
                if task.id in listed:
                    continue
                sequence += 10
                Agenda.create({
                    'meeting_id': rec.id,
                    'sequence': sequence,
                    'name': task.name,
                    'description': task.escalation_reason,
                    'presenter_id': task.assignee_id.id,
                    'source': 'escalated',
                    'task_id': task.id,
                })

    def action_load_items(self):
        self._load_agenda_items()
        return True

    # ------------------------------------------------------------------
    # Workflow
    # ------------------------------------------------------------------
    def _check_scope_fields(self):
        for rec in self:
            if rec.scope == 'department' and not rec.department_id:
                raise UserError(_('Select the department of this department-level meeting.'))
            if rec.scope == 'business_unit' and not rec.business_unit_id:
                raise UserError(_('Select the business unit of this business-unit-level meeting.'))

    def action_confirm(self):
        for rec in self:
            if rec.state != 'draft':
                continue
            rec._check_scope_fields()
            if not rec.attendee_ids:
                raise UserError(_('Add at least one attendee before confirming the meeting.'))
            rec._load_agenda_items()
            if not rec.agenda_line_ids:
                raise UserError(_('Prepare the agenda before confirming the meeting.'))
            rec.state = 'scheduled'
            rec._sync_calendar_event()
            rec.preparation_ids._release_if_due()
            rec.message_post(body=_('Meeting scheduled. Invitations were sent to the attendees.'))
        return True

    def action_start(self):
        self.filtered(lambda m: m.state == 'scheduled').write({'state': 'in_progress'})
        return True

    def _check_followup_reviewed(self):
        for rec in self:
            pending = rec.followup_ids.filtered(lambda f: not f.review_state)
            if pending:
                raise UserError(_(
                    'Review the status of all previous action items before closing the '
                    'meeting (%s still pending).', len(pending),
                ))

    def action_done(self):
        for rec in self:
            if rec.state not in ('scheduled', 'in_progress'):
                raise UserError(_('Only a scheduled or running meeting can be closed.'))
            if is_html_empty(rec.minutes):
                raise UserError(_('Write the meeting minutes before closing the meeting.'))
            rec._check_followup_reviewed()
            rec.followup_ids._apply_review()
            rec.state = 'done'
            rec.message_post(body=_(
                'Meeting closed: %(decisions)s decisions, %(tasks)s new action items, '
                '%(deviations)s deviations from previous actions.',
                decisions=rec.decision_count, tasks=rec.task_count,
                deviations=rec.followup_deviation_count,
            ))
        return True

    def action_cancel(self):
        for rec in self:
            if rec.state == 'done':
                raise UserError(_('A closed meeting cannot be cancelled.'))
            rec.calendar_event_id.unlink()
            rec.state = 'cancelled'
        return True

    def action_draft(self):
        meetings = self.filtered(lambda m: m.state in ('cancelled', 'scheduled'))
        meetings.calendar_event_id.unlink()
        meetings.write({'state': 'draft'})
        return True

    def action_schedule_next(self):
        self.ensure_one()
        if self.next_meeting_id:
            return self.action_view_next()
        nxt = self.create({
            'name': self.name,
            'meeting_type_id': self.meeting_type_id.id,
            'department_id': self.department_id.id,
            'business_unit_id': self.business_unit_id.id,
            'date_start': self.date_start + timedelta(days=7),
            'duration': self.duration,
            'location': self.location,
            'online_link': self.online_link,
            'organizer_id': self.organizer_id.id,
            'chairperson_id': self.chairperson_id.id,
            'secretary_id': self.secretary_id.id,
            'previous_meeting_id': self.id,
            'attendee_ids': [
                Command.create({'partner_id': a.partner_id.id}) for a in self.attendee_ids
            ],
        })
        nxt._load_agenda_items()
        return nxt._get_form_action()

    # ------------------------------------------------------------------
    # Navigation
    # ------------------------------------------------------------------
    def _get_form_action(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.name,
            'res_model': 'acc.meeting',
            'res_id': self.id,
            'view_mode': 'form',
        }

    def action_view_next(self):
        self.ensure_one()
        return self.next_meeting_id._get_form_action()

    def action_view_previous(self):
        self.ensure_one()
        return self.previous_meeting_id._get_form_action()

    def action_open_preparation(self):
        self.ensure_one()
        if not self.preparation_id:
            raise UserError(_('The preparation report is not available yet.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Preparation Report'),
            'res_model': 'acc.meeting.preparation',
            'res_id': self.preparation_id.id,
            'view_mode': 'form',
        }

    def action_view_tasks(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Action Items'),
            'res_model': 'acc.meeting.task',
            'view_mode': 'list,kanban,form',
            'domain': [('meeting_id', '=', self.id)],
            'context': {'default_meeting_id': self.id},
        }
