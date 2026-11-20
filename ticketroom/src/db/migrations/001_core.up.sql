-- 001 core: identity, sessions, roles, organisers, audit.
-- Every TicketRoom object lives in the dedicated "tr" schema so that this
-- database can never collide with TitoPay tables even if a shared server is used.
CREATE SCHEMA IF NOT EXISTS tr;
SET search_path TO tr;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  phone           text,
  full_name       text NOT NULL,
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  email_verified_at timestamptz,
  spending_pin_hash text,
  pin_failed_attempts int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- Platform-wide staff roles. Attendee is implicit for every user.
CREATE TABLE platform_roles (
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('admin','finance','support')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organisers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           text NOT NULL UNIQUE,
  contact_email  text NOT NULL,
  contact_phone  text,
  description    text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
  -- Bank details for settlements. account number is AES-256-GCM encrypted at
  -- the application layer; only the last four digits are stored in clear.
  bank_name          text,
  bank_account_holder text,
  bank_account_enc   text,
  bank_account_last4 text,
  bank_branch_code   text,
  payout_hold_days   int NOT NULL DEFAULT 3 CHECK (payout_hold_days >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  approved_by    uuid REFERENCES users(id)
);

CREATE TABLE organiser_members (
  organiser_id uuid NOT NULL REFERENCES organisers(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner','manager','marketing','finance','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organiser_id, user_id)
);
CREATE INDEX organiser_members_user_idx ON organiser_members (user_id);

-- Tamper-evident audit log: each row carries a hash of the previous row.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  organiser_id uuid,
  ip          text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text NOT NULL,
  row_hash    text NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_org_idx ON audit_log (organiser_id);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  status_code  int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE support_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference   text NOT NULL UNIQUE,
  user_id     uuid REFERENCES users(id),
  email       text NOT NULL,
  category    text NOT NULL CHECK (category IN ('tickets','refund','tag','payment','account','other')),
  subject     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to uuid REFERENCES users(id),
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
