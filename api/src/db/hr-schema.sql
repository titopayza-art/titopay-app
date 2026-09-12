-- TitoPay HR Management System (Enterprise Edition)
-- Isolated HR schema: does not alter customer/admin auth tables.

CREATE TABLE IF NOT EXISTS hr_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  job_title TEXT,
  department TEXT,
  employment_type TEXT NOT NULL DEFAULT 'Permanent',
  start_date DATE,
  salary NUMERIC(14,2),
  hourly_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
  contract_hours_per_week NUMERIC(6,2) NOT NULL DEFAULT 40,
  work_start_time TIME NOT NULL DEFAULT '08:00',
  work_end_time TIME NOT NULL DEFAULT '17:00',
  lunch_minutes INTEGER NOT NULL DEFAULT 60,
  tax_number TEXT,
  bank_name TEXT,
  bank_account TEXT,
  work_location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','resigned','terminated')),
  emergency_contact JSONB NOT NULL DEFAULT '{}'::JSONB,
  skills TEXT[] NOT NULL DEFAULT '{}',
  medical_info JSONB NOT NULL DEFAULT '{}'::JSONB,
  manager_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('CEO','Super Admin','HR Director','HR Administrator','Finance','Payroll Officer','Compliance Officer','Department Manager','Team Lead','Recruiter','Employee','Auditor','Read Only')),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  access_jti TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  trusted_device BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_login_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  device_name TEXT,
  device_fingerprint TEXT NOT NULL,
  ip_address TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_fingerprint)
);

CREATE TABLE IF NOT EXISTS hr_employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  file_url TEXT NOT NULL,
  mime_type TEXT,
  uploaded_by UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_onboarding_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE CASCADE,
  employee TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','overdue')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  accrued NUMERIC(8,2) NOT NULL DEFAULT 0,
  used NUMERIC(8,2) NOT NULL DEFAULT 0,
  available NUMERIC(8,2) NOT NULL DEFAULT 0,
  period_year INTEGER NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_type, period_year)
);

CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(8,2) NOT NULL DEFAULT 1,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  manager_comment TEXT,
  hr_comment TEXT,
  approved_by UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  lunch_start TIMESTAMPTZ,
  lunch_end TIMESTAMPTZ,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  regular_minutes INTEGER NOT NULL DEFAULT 0,
  work_mode TEXT NOT NULL DEFAULT 'Office',
  status TEXT NOT NULL DEFAULT 'present',
  minutes_late INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  employee_signature TEXT,
  apology_reason TEXT,
  attendance_source TEXT NOT NULL DEFAULT 'hr-portal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_payroll_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  period TEXT NOT NULL,
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  allowances NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonuses NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  uif NUMERIC(14,2) NOT NULL DEFAULT 0,
  pension NUMERIC(14,2) NOT NULL DEFAULT 0,
  medical_aid NUMERIC(14,2) NOT NULL DEFAULT 0,
  reimbursements NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_payslips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_record_id UUID REFERENCES hr_payroll_records(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_by UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_performance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  period TEXT NOT NULL,
  kpis TEXT,
  objectives TEXT,
  self_review TEXT,
  manager_feedback TEXT,
  peer_review TEXT,
  score NUMERIC(5,2),
  improvement_plan TEXT,
  promotion_recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_disciplinary_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT UNIQUE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  type TEXT NOT NULL,
  incident_date DATE,
  description TEXT,
  investigation_notes TEXT,
  hearing_date DATE,
  outcome TEXT,
  evidence_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_company_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT,
  role_permission TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  description TEXT,
  file_url TEXT,
  requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
  required_reading BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at DATE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_recruitment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  department TEXT,
  location TEXT,
  closing_date DATE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  applicants INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_recruitment_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES hr_recruitment_jobs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  job_title TEXT,
  source TEXT NOT NULL DEFAULT 'HR portal',
  phone TEXT,
  qualification TEXT,
  portfolio TEXT,
  website_application_id TEXT,
  stage TEXT NOT NULL DEFAULT 'screening',
  notes TEXT,
  resume_url TEXT,
  rating INTEGER,
  offer_status TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester TEXT NOT NULL,
  requester_id UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  escalation_level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES hr_users(id) ON DELETE CASCADE,
  role TEXT,
  title TEXT NOT NULL,
  body TEXT,
  type TEXT NOT NULL DEFAULT 'info',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  detail TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT,
  format TEXT,
  description TEXT,
  overview TEXT,
  level TEXT,
  department TEXT,
  role_permission TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  due_days INTEGER,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  handbook_content TEXT,
  pass_mark INTEGER NOT NULL DEFAULT 80,
  course_url TEXT,
  video_url TEXT,
  pdf_url TEXT,
  presentation_url TEXT,
  image_url TEXT,
  certificate_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  assessment_required BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES hr_learning_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  lesson_type TEXT NOT NULL DEFAULT 'article',
  content TEXT,
  resource_url TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 10,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pass_mark INTEGER NOT NULL DEFAULT 80,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_quiz_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES hr_learning_quizzes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::JSONB,
  correct_answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE CASCADE,
  department TEXT,
  role_permission TEXT,
  mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  due_date DATE,
  assigned_by UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_enrolments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id UUID REFERENCES hr_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'enrolled',
  progress_percent INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (course_id, user_id)
);

CREATE TABLE IF NOT EXISTS hr_learning_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id UUID NOT NULL REFERENCES hr_learning_enrolments(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES hr_learning_lessons(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress',
  score NUMERIC(5,2),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  user_id UUID REFERENCES hr_users(id) ON DELETE SET NULL,
  certificate_number TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score NUMERIC(5,2),
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'issued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_learning_bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES hr_learning_courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (course_id, user_id)
);

CREATE TABLE IF NOT EXISTS hr_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag TEXT UNIQUE,
  type TEXT NOT NULL,
  serial_number TEXT,
  assigned_to TEXT,
  assigned_at DATE,
  warranty_expiry DATE,
  maintenance_history TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_expense_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee TEXT NOT NULL,
  type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ZAR',
  receipt_url TEXT,
  description TEXT,
  manager_status TEXT NOT NULL DEFAULT 'pending',
  finance_status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  status TEXT NOT NULL DEFAULT 'submitted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  priority TEXT NOT NULL DEFAULT 'normal',
  publish_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  manager TEXT,
  cost_centre TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Additive production repair tables. Existing ticket and announcement records
-- are intentionally left untouched; no automatic data rewrite is performed.
CREATE TABLE IF NOT EXISTS hr_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_name TEXT NOT NULL,
  owner TEXT,
  owner_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  department TEXT,
  start_date DATE,
  due_date DATE,
  progress NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  current_milestone TEXT,
  latest_update TEXT,
  blockers TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  meeting_date TIMESTAMPTZ,
  meeting_time TIME,
  chair TEXT,
  chair_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  department TEXT,
  agenda TEXT,
  attendees TEXT,
  apologies TEXT,
  previous_minutes TEXT,
  outcomes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hr_users_email ON hr_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_hr_sessions_user ON hr_sessions (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_employees_search ON hr_employees (lower(email), status, department);
CREATE INDEX IF NOT EXISTS idx_hr_leave_status ON hr_leave_requests (status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_employee_date ON hr_attendance_records (employee, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_period ON hr_payroll_records (period, status);
CREATE INDEX IF NOT EXISTS idx_hr_audit_created ON hr_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_notifications_user ON hr_notifications (user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_projects_status_due ON hr_projects (status, due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_meetings_date ON hr_meetings (meeting_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_employees_active_created ON hr_employees (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_onboarding_active_due ON hr_onboarding_tasks (due_date, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_leave_active_created ON hr_leave_requests (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_attendance_active_date ON hr_attendance_records (work_date DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_attendance_employee_id_date ON hr_attendance_records (employee_id, work_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_payroll_active_period ON hr_payroll_records (period DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_performance_active_created ON hr_performance_reviews (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_jobs_active_created ON hr_recruitment_jobs (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_candidates_active_created ON hr_recruitment_candidates (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_tickets_active_created ON hr_tickets (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_expenses_active_created ON hr_expense_claims (created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS contract_hours_per_week NUMERIC(6,2) NOT NULL DEFAULT 40;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_start_time TIME NOT NULL DEFAULT '08:00';
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_end_time TIME NOT NULL DEFAULT '17:00';
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS lunch_minutes INTEGER NOT NULL DEFAULT 60;

ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS lunch_start TIMESTAMPTZ;
ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS lunch_end TIMESTAMPTZ;
ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS regular_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS employee_signature TEXT;
ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS apology_reason TEXT;
ALTER TABLE hr_attendance_records ADD COLUMN IF NOT EXISTS attendance_source TEXT NOT NULL DEFAULT 'hr-portal';

ALTER TABLE hr_recruitment_candidates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HR portal';
ALTER TABLE hr_recruitment_candidates ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE hr_recruitment_candidates ADD COLUMN IF NOT EXISTS qualification TEXT;
ALTER TABLE hr_recruitment_candidates ADD COLUMN IF NOT EXISTS portfolio TEXT;
ALTER TABLE hr_recruitment_candidates ADD COLUMN IF NOT EXISTS website_application_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_candidates_website_application ON hr_recruitment_candidates (website_application_id) WHERE website_application_id IS NOT NULL;

ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS role_permission TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS due_days INTEGER;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS handbook_content TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS pass_mark INTEGER NOT NULL DEFAULT 80;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS format TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS overview TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS level TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS presentation_url TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE hr_learning_courses ADD COLUMN IF NOT EXISTS certificate_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hr_expense_claims ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE hr_expense_claims ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hr_expenses_employee_id ON hr_expense_claims (employee_id) WHERE deleted_at IS NULL;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_hr_learning_courses_status_category ON hr_learning_courses (status, category);
CREATE INDEX IF NOT EXISTS idx_hr_learning_enrolments_user ON hr_learning_enrolments (user_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_learning_assignments_employee ON hr_learning_assignments (employee_id, department, role_permission);
ALTER TABLE hr_learning_enrolments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE hr_learning_enrolments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE hr_learning_progress ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE hr_learning_certificates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE hr_learning_certificates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE hr_learning_certificates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE hr_learning_bookmarks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE hr_learning_bookmarks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
