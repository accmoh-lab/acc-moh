{
    'name': 'ACC Meetings & Action Follow-up',
    'version': '19.0.1.0.0',
    'category': 'Productivity',
    'summary': 'Schedule meetings, record agenda and minutes, assign action items, '
               'follow up deviations and escalate to higher-level meetings.',
    'description': """
Meetings & Action Follow-up
===========================
* Schedule meetings (with calendar invitations) by meeting level:
  Department / Management / Executive / Board.
* Prepare the agenda before the meeting.
* Record minutes and assign action items to individuals.
* The next meeting automatically lists the previous action items for review
  (completed / in progress / delayed / cancelled) with the reason of every deviation.
* Escalate issues or tasks to a higher-level meeting; they appear in its agenda.
* Deviation analysis report.
""",
    'author': 'ACC',
    'license': 'LGPL-3',
    'depends': ['base', 'mail', 'calendar', 'hr'],
    'data': [
        'security/security.xml',
        'security/ir.model.access.csv',
        'security/ir_rules.xml',
        'data/ir_sequence_data.xml',
        'data/meeting_type_data.xml',
        'data/deviation_reason_data.xml',
        'data/ir_cron_data.xml',
        'views/meeting_views.xml',
        'views/meeting_task_views.xml',
        'views/meeting_followup_views.xml',
        'views/config_views.xml',
        'views/dashboard_views.xml',
        'report/meeting_report.xml',
        'wizard/task_escalate_views.xml',
        'views/menus.xml',
    ],
    'application': True,
    'installable': True,
}
