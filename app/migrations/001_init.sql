-- ACC Management Platform — schema v1 (ANSI-leaning; portable to PostgreSQL)
CREATE TABLE org_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('group','company','business_unit','department','team')),
  parent_id INTEGER REFERENCES org_units(id),
  currency TEXT NOT NULL DEFAULT 'EGP',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_org_parent ON org_units(parent_id);

CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  org_unit_id INTEGER NOT NULL REFERENCES org_units(id),
  company_id INTEGER REFERENCES org_units(id),
  bu_id INTEGER REFERENCES org_units(id),
  dept_id INTEGER REFERENCES org_units(id),
  team_id INTEGER REFERENCES org_units(id),
  manager_id INTEGER REFERENCES employees(id),
  functional_manager_id INTEGER REFERENCES employees(id),
  active INTEGER NOT NULL DEFAULT 1,
  system_role TEXT NOT NULL DEFAULT 'employee'
    CHECK (system_role IN ('employee','team_leader','department_manager','business_unit_manager','executive','hr_admin','system_admin')),
  scope_org_id INTEGER REFERENCES org_units(id),
  password_hash TEXT,
  can_login INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_emp_org ON employees(org_unit_id);
CREATE INDEX idx_emp_dept ON employees(dept_id);
CREATE INDEX idx_emp_mgr ON employees(manager_id);

-- Functional roles (board_member, board_secretary, kpi_owner, ...) and extra scopes
CREATE TABLE employee_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role TEXT NOT NULL CHECK (role IN ('board_member','board_secretary','kpi_owner','data_owner','performance_reviewer','meeting_leader','meeting_secretary','extra_scope')),
  org_unit_id INTEGER REFERENCES org_units(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_grant ON employee_grants(employee_id, role, IFNULL(org_unit_id,0));

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT
);
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  expires_at TEXT NOT NULL, used_at TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at TEXT NOT NULL);
CREATE TABLE sequences (name TEXT PRIMARY KEY, last_value INTEGER NOT NULL);
CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, rate_to_base REAL NOT NULL, as_of TEXT NOT NULL);

-- ---------- Meetings ----------
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('department','business_unit','management','cross_functional','committee','board')),
  company_id INTEGER REFERENCES org_units(id),
  bu_id INTEGER REFERENCES org_units(id),
  dept_id INTEGER REFERENCES org_units(id),
  leader_id INTEGER NOT NULL REFERENCES employees(id),
  secretary_id INTEGER REFERENCES employees(id),
  meeting_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60 CHECK (duration_min > 0),
  location TEXT,
  mode TEXT NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person','online','hybrid')),
  provider TEXT NOT NULL DEFAULT 'none' CHECK (provider IN ('none','teams','google_meet')),
  url TEXT,
  objective TEXT,
  required_preparation TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal','confidential','board')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparation','preparation_published','ready','live','minutes_draft','under_review','approved','closed','cancelled')),
  series_id TEXT,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','weekly','monthly')),
  prev_meeting_id INTEGER REFERENCES meetings(id),
  prep_published_at TEXT,
  prep_released_at TEXT,
  prep_pack TEXT,
  started_at TEXT, ended_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_meet_date ON meetings(meeting_date);
CREATE INDEX idx_meet_status ON meetings(status);
CREATE INDEX idx_meet_leader ON meetings(leader_id);
CREATE INDEX idx_meet_series ON meetings(series_id);

CREATE TABLE meeting_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  optional INTEGER NOT NULL DEFAULT 0,
  invitation TEXT NOT NULL DEFAULT 'invited' CHECK (invitation IN ('invited','accepted','declined')),
  attendance TEXT CHECK (attendance IN ('attended','absent','excused')),
  attendance_mode TEXT CHECK (attendance_mode IN ('in_person','online')),
  UNIQUE (meeting_id, employee_id)
);
CREATE INDEX idx_part_emp ON meeting_participants(employee_id);

CREATE TABLE agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  seq INTEGER NOT NULL,
  topic TEXT NOT NULL,
  presenter_id INTEGER REFERENCES employees(id),
  objective TEXT,
  type TEXT NOT NULL DEFAULT 'discussion' CHECK (type IN ('information','discussion','decision_required','follow_up')),
  est_min INTEGER NOT NULL DEFAULT 10 CHECK (est_min >= 0),
  prep_notes TEXT, required_data TEXT, required_decision TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','discussing','completed','deferred')),
  discussion_notes TEXT,
  related_kpi_id INTEGER REFERENCES kpis(id),
  related_task_id INTEGER REFERENCES tasks(id),
  related_decision_id INTEGER REFERENCES decisions(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_agenda_meeting ON agenda_items(meeting_id, seq);
CREATE INDEX idx_agenda_kpi ON agenda_items(related_kpi_id);

CREATE TABLE meeting_kpis (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  kpi_id INTEGER NOT NULL REFERENCES kpis(id),
  PRIMARY KEY (meeting_id, kpi_id)
);

CREATE TABLE minutes (
  meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id),
  summary TEXT, next_meeting_note TEXT,
  attendance_snapshot TEXT,
  approved_by INTEGER REFERENCES employees(id), approved_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('meeting','agenda_item','task','decision','kpi_result','initiative')),
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL, mime TEXT, size INTEGER, storage_key TEXT NOT NULL,
  note TEXT, uploaded_by INTEGER REFERENCES employees(id), created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_att_entity ON attachments(entity_type, entity_id);

-- ---------- Decisions ----------
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  agenda_item_id INTEGER REFERENCES agenda_items(id),
  text TEXT NOT NULL,
  decision_date TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES employees(id),
  responsible_dept_id INTEGER REFERENCES org_units(id),
  effective_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','implemented','closed','cancelled')),
  evidence TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal','confidential','board')),
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_dec_meeting ON decisions(meeting_id);
CREATE INDEX idx_dec_status ON decisions(status);

-- ---------- Initiatives ----------
CREATE TABLE initiatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, objective TEXT,
  owner_id INTEGER NOT NULL REFERENCES employees(id),
  sponsor_id INTEGER REFERENCES employees(id),
  org_unit_id INTEGER REFERENCES org_units(id),
  start_date TEXT, target_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','at_risk','completed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  expected_impact TEXT, actual_impact TEXT, risk_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE initiative_kpis (initiative_id INTEGER NOT NULL REFERENCES initiatives(id), kpi_id INTEGER NOT NULL REFERENCES kpis(id), PRIMARY KEY (initiative_id, kpi_id));
CREATE TABLE initiative_meetings (initiative_id INTEGER NOT NULL REFERENCES initiatives(id), meeting_id INTEGER NOT NULL REFERENCES meetings(id), PRIMARY KEY (initiative_id, meeting_id));
CREATE TABLE initiative_decisions (initiative_id INTEGER NOT NULL REFERENCES initiatives(id), decision_id INTEGER NOT NULL REFERENCES decisions(id), PRIMARY KEY (initiative_id, decision_id));

-- ---------- Tasks ----------
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, description TEXT,
  source TEXT NOT NULL DEFAULT 'operational' CHECK (source IN ('meeting','management','kpi','initiative','operational','project','recurring','corrective_action')),
  meeting_id INTEGER REFERENCES meetings(id),
  decision_id INTEGER REFERENCES decisions(id),
  agenda_item_id INTEGER REFERENCES agenda_items(id),
  kpi_id INTEGER REFERENCES kpis(id),
  initiative_id INTEGER REFERENCES initiatives(id),
  source_ref TEXT,
  owner_id INTEGER NOT NULL REFERENCES employees(id),
  reviewer_id INTEGER REFERENCES employees(id),
  company_id INTEGER REFERENCES org_units(id),
  bu_id INTEGER REFERENCES org_units(id),
  dept_id INTEGER REFERENCES org_units(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  start_date TEXT, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','pending_review','completed','blocked','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  blocked_reason TEXT, expected_resolution TEXT,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_status TEXT NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','returned')),
  return_reason TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal','confidential','board')),
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly','quarterly','custom')),
  recurrence_interval_days INTEGER,
  series_id TEXT, occurrence_no INTEGER,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, deleted_at TEXT,
  CHECK (start_date IS NULL OR start_date <= due_date)
);
CREATE INDEX idx_task_owner ON tasks(owner_id, status);
CREATE INDEX idx_task_due ON tasks(due_date, status);
CREATE INDEX idx_task_dept ON tasks(dept_id, status);
CREATE INDEX idx_task_meeting ON tasks(meeting_id);
CREATE INDEX idx_task_kpi ON tasks(kpi_id);
CREATE INDEX idx_task_series ON tasks(series_id);
CREATE TABLE task_contributors (task_id INTEGER NOT NULL REFERENCES tasks(id), employee_id INTEGER NOT NULL REFERENCES employees(id), PRIMARY KEY (task_id, employee_id));
CREATE TABLE task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id),
  reason TEXT, expected_resolution TEXT,
  PRIMARY KEY (task_id, depends_on_id), CHECK (task_id <> depends_on_id)
);
CREATE TABLE task_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  note TEXT NOT NULL, attachment_id INTEGER REFERENCES attachments(id),
  submitted_by INTEGER NOT NULL REFERENCES employees(id), created_at TEXT NOT NULL
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  actor_id INTEGER REFERENCES employees(id),
  action TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_task_events ON task_events(task_id);

-- ---------- KPIs ----------
CREATE TABLE kpis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL DEFAULT 'operational' CHECK (category IN ('financial','operational','strategic')),
  level TEXT NOT NULL CHECK (level IN ('group','company','business_unit','department','team','employee')),
  org_unit_id INTEGER REFERENCES org_units(id),
  employee_id INTEGER REFERENCES employees(id),
  owner_id INTEGER REFERENCES employees(id),
  data_owner_id INTEGER REFERENCES employees(id),
  reviewer_id INTEGER REFERENCES employees(id),
  unit TEXT NOT NULL DEFAULT '', currency TEXT,
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','monthly','quarterly','annual','custom')),
  kpi_type TEXT NOT NULL DEFAULT 'higher_better' CHECK (kpi_type IN ('higher_better','lower_better','target_range','exact_target','milestone','boolean','formula')),
  baseline REAL, target REAL, range_min REAL, range_max REAL,
  formula TEXT,
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual','odoo','spreadsheet','api','calculated','other')),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  green_min REAL NOT NULL DEFAULT 100, amber_min REAL NOT NULL DEFAULT 85,
  cascade_type TEXT NOT NULL DEFAULT 'independent' CHECK (cascade_type IN ('cascaded','shared','independent')),
  parent_kpi_id INTEGER REFERENCES kpis(id),
  direction TEXT NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher','lower')),
  rollup TEXT CHECK (rollup IN ('sum','avg')),
  effective_from TEXT, effective_to TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('draft','submitted','approved','retired')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_kpi_org ON kpis(org_unit_id);
CREATE INDEX idx_kpi_emp ON kpis(employee_id);
CREATE INDEX idx_kpi_owner ON kpis(owner_id);
CREATE INDEX idx_kpi_parent ON kpis(parent_kpi_id);

CREATE TABLE kpi_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kpi_id INTEGER NOT NULL REFERENCES kpis(id),
  period_key TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  target REAL, actual REAL, achievement REAL, status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('green','amber','red','missing')),
  data_quality TEXT NOT NULL DEFAULT 'missing' CHECK (data_quality IN ('missing','draft','submitted','verified','approved')),
  note TEXT, evidence TEXT,
  updated_by INTEGER REFERENCES employees(id), verified_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (kpi_id, period_key)
);
CREATE INDEX idx_kpires_period ON kpi_results(period_key);
CREATE INDEX idx_kpires_status ON kpi_results(status);

CREATE TABLE financial_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL CHECK (metric IN ('revenue','gross_profit','gross_margin','ebitda','collection','expenses','budget','budget_variance','cash_flow','receivables','inventory','custom')),
  label TEXT NOT NULL,
  org_unit_id INTEGER NOT NULL REFERENCES org_units(id),
  period_key TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EGP',
  target REAL NOT NULL, actual REAL,
  lower_is_better INTEGER NOT NULL DEFAULT 0,
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual','odoo','spreadsheet','api','calculated','other')),
  data_quality TEXT NOT NULL DEFAULT 'draft' CHECK (data_quality IN ('missing','draft','submitted','verified','approved')),
  related_kpi_id INTEGER REFERENCES kpis(id),
  updated_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (metric, label, org_unit_id, period_key)
);
CREATE INDEX idx_fin_period ON financial_targets(period_key, org_unit_id);

-- ---------- Performance ----------
CREATE TABLE performance_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('weekly','monthly','quarterly','annual','custom')),
  label TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','approved','locked')),
  version INTEGER NOT NULL DEFAULT 1, reopen_count INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT, locked_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (start_date <= end_date)
);
CREATE TABLE period_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES performance_periods(id),
  version INTEGER NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('employee','team','department','business_unit','company')),
  subject_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  calculated_score REAL, performance_score REAL, rating TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (period_id, version, subject_type, subject_id)
);
CREATE INDEX idx_snap_subject ON period_snapshots(subject_type, subject_id);
CREATE TABLE period_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES performance_periods(id),
  entity TEXT NOT NULL, entity_id INTEGER, field TEXT, old_value TEXT, new_value TEXT,
  reason TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES employees(id), created_at TEXT NOT NULL
);

CREATE TABLE scorecard_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_unit_id INTEGER REFERENCES org_units(id),   -- NULL = default for all
  name TEXT NOT NULL,
  weights TEXT NOT NULL,                          -- JSON {component: pct}, must total 100
  updated_by INTEGER REFERENCES employees(id), updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_scorecard_org ON scorecard_configs(IFNULL(org_unit_id,0));

CREATE TABLE assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES performance_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  manager_score REAL CHECK (manager_score IS NULL OR manager_score BETWEEN 0 AND 100),
  manager_comment TEXT,
  proposed_rating TEXT,
  final_rating TEXT,
  stage TEXT NOT NULL DEFAULT 'manager_review' CHECK (stage IN ('manager_review','department_review','management_calibration','final_approved')),
  feedback_for_employee TEXT,
  development_actions TEXT,
  assessed_by INTEGER REFERENCES employees(id), approved_by INTEGER REFERENCES employees(id), approved_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (period_id, employee_id)
);
CREATE TABLE assessment_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id),
  stage TEXT NOT NULL, actor_id INTEGER REFERENCES employees(id), comment TEXT, created_at TEXT NOT NULL
);
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  period_key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'monthly' CHECK (kind IN ('weekly','monthly')),
  achievements TEXT, challenges TEXT, blockers TEXT, support_required TEXT,
  employee_comment TEXT, manager_comment TEXT, agreed_actions TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','reviewed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (employee_id, period_key, kind)
);

-- ---------- Notifications / Audit / Integrations ----------
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  event TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  dedupe_key TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_emp ON notifications(employee_id, read_at);
CREATE UNIQUE INDEX uq_notif_dedupe ON notifications(employee_id, dedupe_key);
CREATE TABLE notification_prefs (
  employee_id INTEGER NOT NULL REFERENCES employees(id), event TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1, email INTEGER NOT NULL DEFAULT 0, push INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, event)
);
CREATE TABLE outbox (   -- MOCK delivery log for email / push (no real sending)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, employee_id INTEGER, subject TEXT, body TEXT, mock INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, ts TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, reason TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE TABLE automation_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ran_at TEXT NOT NULL, summary TEXT);
