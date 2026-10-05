from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import html_escape

OPEN_STATES = ('open', 'in_progress', 'escalated')
ACTIVITY_SUMMARY = 'Meeting action item'
REMINDER_EVERY_DAYS = 3


class AccMeetingTask(models.Model):
    _name = 'acc.meeting.task'
    _description = 'Meeting Action Item'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'date_deadline, priority desc, id'

    name = fields.Char(string='Title', required=True, tracking=True)
    description = fields.Html()
    task_type = fields.Selection(
        [('task', 'Task'), ('decision', 'Decision'), ('issue', 'Issue')],
        string='Type', default='task', required=True,
    )
    meeting_id = fields.Many2one(
        'acc.meeting', string='Raised in Meeting', ondelete='restrict', index=True, tracking=True,
    )
    meeting_type_id = fields.Many2one(related='meeting_id.meeting_type_id', store=True)
    meeting_date = fields.Datetime(related='meeting_id.date_start', store=True)
    agenda_line_ids = fields.One2many('acc.meeting.agenda', 'task_id', string='Agenda Items')

    assignee_id = fields.Many2one(
        'res.users', string='Responsible', required=True, tracking=True,
        domain=[('share', '=', False)],
    )
    priority = fields.Selection(
        [('0', 'Normal'), ('1', 'Important'), ('2', 'Urgent')], default='0', required=True,
    )
    date_deadline = fields.Date(string='Due Date', required=True, tracking=True)
    original_deadline = fields.Date(string='Original Due Date', readonly=True, copy=False)
    date_done = fields.Date(string='Completed On', readonly=True, copy=False)
    state = fields.Selection(
        [
            ('open', 'Open'),
            ('in_progress', 'In Progress'),
            ('escalated', 'Escalated'),
            ('done', 'Done'),
            ('cancelled', 'Cancelled'),
        ],
        default='open', required=True, tracking=True, copy=False,
    )
    is_overdue = fields.Boolean(compute='_compute_is_overdue', search='_search_is_overdue')
    delay_days = fields.Integer(compute='_compute_is_overdue')

    # Deviation
    deviation_reason_id = fields.Many2one(
        'acc.meeting.deviation.reason', string='Last Deviation Reason', tracking=True,
    )
    deviation_notes = fields.Text(string='Deviation Notes')
    postponement_count = fields.Integer(string='Times Postponed', readonly=True, copy=False)
    followup_ids = fields.One2many('acc.meeting.followup', 'task_id', string='Follow-up History')

    # Escalation
    escalated_to_type_id = fields.Many2one(
        'acc.meeting.type', string='Escalated To', copy=False, tracking=True,
    )
    escalation_reason = fields.Text(copy=False)
    escalation_date = fields.Date(copy=False)
    current_level = fields.Integer(compute='_compute_current_level')

    last_reminder_date = fields.Date(copy=False)

    # ------------------------------------------------------------------
    # Computes
    # ------------------------------------------------------------------
    @api.depends('date_deadline', 'state')
    def _compute_is_overdue(self):
        today = fields.Date.context_today(self)
        for task in self:
            overdue = bool(
                task.date_deadline and task.state in OPEN_STATES and task.date_deadline < today
            )
            task.is_overdue = overdue
            task.delay_days = (today - task.date_deadline).days if overdue else 0

    def _search_is_overdue(self, operator, value):
        if operator not in ('=', '!=') or not isinstance(value, bool):
            raise NotImplementedError(_('Unsupported search on overdue.'))
        today = fields.Date.context_today(self)
        overdue = ['&', ('state', 'in', OPEN_STATES), ('date_deadline', '<', today)]
        if (operator == '=') == value:
            return overdue
        return ['!'] + overdue

    @api.depends('meeting_id.meeting_type_id.level', 'escalated_to_type_id.level')
    def _compute_current_level(self):
        for task in self:
            task.current_level = (
                task.escalated_to_type_id.level or task.meeting_id.meeting_type_id.level or 0
            )

    # ------------------------------------------------------------------
    # ORM overrides
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('date_deadline') and not vals.get('original_deadline'):
                vals['original_deadline'] = vals['date_deadline']
        tasks = super().create(vals_list)
        tasks._schedule_activity()
        return tasks

    def write(self, vals):
        if 'state' in vals:
            vals = dict(
                vals,
                date_done=fields.Date.context_today(self) if vals['state'] == 'done' else False,
            )
        res = super().write(vals)
        if {'state', 'assignee_id', 'date_deadline'} & set(vals):
            self._schedule_activity()
        return res

    # ------------------------------------------------------------------
    # Activities (To-Do shown to the responsible person)
    # ------------------------------------------------------------------
    def _clear_activities(self):
        self.activity_ids.filtered(lambda a: a.summary == ACTIVITY_SUMMARY).sudo().unlink()

    def _schedule_activity(self):
        for task in self:
            task._clear_activities()
            if task.state in OPEN_STATES and task.assignee_id and task.date_deadline:
                task.activity_schedule(
                    'mail.mail_activity_data_todo',
                    date_deadline=task.date_deadline,
                    summary=ACTIVITY_SUMMARY,
                    note=html_escape(task.name),
                    user_id=task.assignee_id.id,
                )

    # ------------------------------------------------------------------
    # Status actions
    # ------------------------------------------------------------------
    def action_start(self):
        self.filtered(lambda t: t.state == 'open').write({'state': 'in_progress'})
        return True

    def action_done(self):
        self.filtered(lambda t: t.state in OPEN_STATES).write({'state': 'done'})
        return True

    def action_cancel(self):
        self.filtered(lambda t: t.state in OPEN_STATES).write({'state': 'cancelled'})
        return True

    def action_reopen(self):
        self.filtered(lambda t: t.state in ('done', 'cancelled')).write({'state': 'open'})
        return True

    def action_resolve_escalation(self):
        self.filtered(lambda t: t.state == 'escalated').write({'state': 'in_progress'})
        return True

    # ------------------------------------------------------------------
    # Deviation
    # ------------------------------------------------------------------
    def _register_delay(self, new_due_date, reason, notes, meeting):
        """Postpone the task after a follow-up review and keep the deviation reason."""
        for task in self:
            old_date = task.date_deadline
            task.write({
                'date_deadline': new_due_date,
                'deviation_reason_id': reason.id,
                'deviation_notes': notes,
                'postponement_count': task.postponement_count + 1,
                'state': 'in_progress',
            })
            task.message_post(body=_(
                'Postponed in meeting %(meeting)s from %(old)s to %(new)s. Reason: %(reason)s',
                meeting=meeting.reference, old=old_date, new=new_due_date, reason=reason.name,
            ))

    # ------------------------------------------------------------------
    # Escalation
    # ------------------------------------------------------------------
    def action_open_escalate_wizard(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Escalate to a Higher Meeting'),
            'res_model': 'acc.meeting.task.escalate',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_task_id': self.id},
        }

    def action_escalate_to(self, meeting_type, reason):
        Meeting = self.env['acc.meeting']
        for task in self:
            if task.state not in ('open', 'in_progress'):
                raise UserError(_('Only open items can be escalated.'))
            if meeting_type.level <= task.current_level:
                raise UserError(_('Items can only be escalated to a higher-level meeting.'))
            task.write({
                'state': 'escalated',
                'escalated_to_type_id': meeting_type.id,
                'escalation_reason': reason,
                'escalation_date': fields.Date.context_today(task),
            })
            upcoming = Meeting.search([
                ('meeting_type_id', '=', meeting_type.id),
                ('state', 'in', ('draft', 'scheduled')),
                ('date_start', '>=', fields.Datetime.now()),
            ], order='date_start', limit=1)
            if upcoming:
                upcoming._load_agenda_items()
                where = _('and added to the agenda of %s', upcoming.reference)
            else:
                where = _('and will be added to the next %s meeting', meeting_type.name)
            task.message_post(body=_(
                'Escalated to %(type)s %(where)s. Reason: %(reason)s',
                type=meeting_type.name, where=where, reason=reason,
            ))

    # ------------------------------------------------------------------
    # Cron
    # ------------------------------------------------------------------
    @api.model
    def _cron_overdue_reminders(self):
        today = fields.Date.context_today(self)
        threshold = today - timedelta(days=REMINDER_EVERY_DAYS)
        tasks = self.search([
            ('state', 'in', ('open', 'in_progress')),
            ('date_deadline', '<', today),
        ])
        for task in tasks:
            if task.last_reminder_date and task.last_reminder_date > threshold:
                continue
            task.message_notify(
                partner_ids=task.assignee_id.partner_id.ids,
                subject=_('Overdue action item: %s', task.name),
                body=_(
                    'The action item "%(name)s" was due on %(date)s and is still not completed. '
                    'Please complete it or report the reason for the delay.',
                    name=task.name, date=task.date_deadline,
                ),
            )
            task.last_reminder_date = today
