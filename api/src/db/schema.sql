DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'gen_random_uuid'
      AND pg_catalog.pg_function_is_visible(p.oid)
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION gen_random_uuid()
      RETURNS uuid
      LANGUAGE SQL
      VOLATILE
      AS $body$
        SELECT (
          SUBSTR(seed, 1, 8) || '-' ||
          SUBSTR(seed, 9, 4) || '-4' ||
          SUBSTR(seed, 14, 3) || '-' ||
          SUBSTR('89ab', (FLOOR(RANDOM() * 4)::INT + 1), 1) ||
          SUBSTR(seed, 18, 3) || '-' ||
          SUBSTR(seed, 21, 12)
        )::uuid
        FROM (
          SELECT MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT || TXID_CURRENT()::TEXT) AS seed
        ) s
      $body$
    $fn$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_login_ip TEXT,
  last_failed_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backward-compatible repair for production databases created before the
-- Admin session, lockout and timestamp fields were introduced.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (key, value)
VALUES ('admin_authentication', '{"mode":"password_only"}'::JSONB)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('personal', 'business')),
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  profile_locked BOOLEAN NOT NULL DEFAULT FALSE,
  fica_status TEXT NOT NULL DEFAULT 'pending',
  preferred_authentication_method TEXT NOT NULL DEFAULT 'PUSH'
    CHECK (preferred_authentication_method IN ('PUSH', 'EMAIL', 'SMS')),
  authentication_method_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_successful_authentication_at TIMESTAMPTZ,
  last_failed_authentication_at TIMESTAMPTZ,
  login_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  profile_photo_url TEXT,
  business_logo_url TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_login_ip TEXT,
  last_failed_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_logo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_authentication_method TEXT NOT NULL DEFAULT 'PUSH';
ALTER TABLE users ADD COLUMN IF NOT EXISTS authentication_method_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_successful_authentication_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_authentication_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_preferred_authentication_method_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_preferred_authentication_method_check
      CHECK (preferred_authentication_method IN ('PUSH', 'EMAIL', 'SMS'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_lower_username ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_phone_lookup ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY,
  wallet_number TEXT,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'business', 'merchant', 'revenue', 'system')),
  currency TEXT NOT NULL DEFAULT 'ZAR',
  available_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  reserved_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS wallet_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_wallet_number ON wallets (wallet_number) WHERE wallet_number IS NOT NULL;
DO $$
DECLARE
  wallet_record RECORD;
  candidate TEXT;
BEGIN
  FOR wallet_record IN
    SELECT id FROM wallets
    WHERE (wallet_number IS NULL
       OR wallet_number !~ '^[0-9]{1,10}$')
      -- TitoKids child wallets are user-owned kind 'system' and must stay
      -- unnumbered: a wallet number makes them resolvable as a transfer
      -- recipient, and nothing outside TitoKids may reach a child's money.
      AND NOT (kind = 'system' AND user_id IS NOT NULL)
  LOOP
    LOOP
      candidate := (1000000000 + FLOOR(RANDOM() * 9000000000))::BIGINT::TEXT;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM wallets WHERE wallet_number = candidate);
    END LOOP;
    UPDATE wallets SET wallet_number = candidate, updated_at = NOW() WHERE id = wallet_record.id;
  END LOOP;
END $$;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_number_clean;
ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_number_clean
  CHECK (wallet_number IS NULL OR wallet_number ~ '^[0-9]{1,10}$');

-- One wallet per user per kind, EXCEPT kind 'system': every TitoKids child is
-- a system wallet under the parent, so a parent with two children holds two.
-- The old full index made the second child's wallet a duplicate-key 500.
-- Rebuilt partial under a NEW name so this line converges databases that
-- carry the old definition (IF NOT EXISTS on the old name would keep it).
DROP INDEX IF EXISTS idx_wallets_user_kind;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_kind_ex_system
  ON wallets (user_id, kind) WHERE kind <> 'system';
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_platform_kind ON wallets (kind) WHERE user_id IS NULL;
-- And child wallets numbered by the loop above before it learned to skip
-- them go back to unnumbered, which is what keeps them unreachable from
-- transfers. The platform wallet (user_id IS NULL) keeps its number.
UPDATE wallets SET wallet_number = NULL, updated_at = NOW()
 WHERE kind = 'system' AND user_id IS NOT NULL AND wallet_number IS NOT NULL;

-- Saved beneficiaries are convenience relationships only. Payment
-- authorisation and wallet accounting continue to use the existing engines.
CREATE TABLE IF NOT EXISTS beneficiaries (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beneficiary_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  favourite BOOLEAN NOT NULL DEFAULT FALSE,
  relationship_type TEXT NOT NULL DEFAULT 'personal'
    CHECK (relationship_type IN ('personal','customer','supplier','employee','payout_recipient')),
  last_paid_at TIMESTAMPTZ,
  last_payment_amount NUMERIC(18,2),
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  disabled_reason TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (owner_user_id <> beneficiary_user_id),
  UNIQUE (owner_user_id, beneficiary_user_id)
);

CREATE INDEX IF NOT EXISTS idx_beneficiaries_owner_active
  ON beneficiaries (owner_user_id, favourite DESC, last_paid_at DESC, created_at DESC)
  WHERE deleted_at IS NULL AND disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_beneficiaries_recipient
  ON beneficiaries (beneficiary_user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  merchant_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  payment_link_base TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_wallets (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  settlement_wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  settlement_schedule TEXT NOT NULL DEFAULT 'manual' CHECK (settlement_schedule IN ('manual', 'daily', 'weekly', 'monthly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id),
  UNIQUE (wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_wallets_merchant ON merchant_wallets (merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_wallets_wallet ON merchant_wallets (wallet_id);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'additional_information_required', 'approved', 'rejected', 'suspended', 'cancelled', 'completed')),
  slug TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  event_date DATE,
  start_time TEXT,
  end_time TEXT,
  venue_name TEXT,
  full_venue_address TEXT,
  city TEXT,
  province TEXT,
  country TEXT NOT NULL DEFAULT 'South Africa',
  event_mode TEXT NOT NULL DEFAULT 'physical' CHECK (event_mode IN ('physical', 'online', 'hybrid')),
  organiser_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  business_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  contact_email TEXT,
  contact_number TEXT,
  event_banner_url TEXT,
  event_images JSONB NOT NULL DEFAULT '[]'::JSONB,
  age_restriction TEXT,
  capacity INTEGER,
  terms_conditions TEXT NOT NULL DEFAULT '',
  refund_policy JSONB NOT NULL DEFAULT '{}'::JSONB,
  entry_rules TEXT NOT NULL DEFAULT '',
  prohibited_items TEXT NOT NULL DEFAULT '',
  accessibility_information TEXT NOT NULL DEFAULT '',
  parking_information TEXT NOT NULL DEFAULT '',
  additional_instructions TEXT NOT NULL DEFAULT '',
  risk_flags JSONB NOT NULL DEFAULT '[]'::JSONB,
  rejection_reason TEXT,
  suspended_reason TEXT,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_details JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE events ADD COLUMN IF NOT EXISTS business_details JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE events ADD COLUMN IF NOT EXISTS risk_flags JSONB NOT NULL DEFAULT '[]'::JSONB;
CREATE INDEX IF NOT EXISTS idx_events_business_user ON events (business_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_slug ON events (slug);

CREATE TABLE IF NOT EXISTS event_ticket_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(18,2) NOT NULL DEFAULT 0,
  quantity_available INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_sold INTEGER NOT NULL DEFAULT 0,
  min_purchase_quantity INTEGER NOT NULL DEFAULT 1,
  max_purchase_quantity INTEGER NOT NULL DEFAULT 10,
  sales_opening_at TIMESTAMPTZ,
  sales_closing_at TIMESTAMPTZ,
  per_customer_purchase_limit INTEGER,
  attendee_details_required BOOLEAN NOT NULL DEFAULT FALSE,
  transfer_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  refunds_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  refund_deadline TIMESTAMPTZ,
  refund_conditions TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_ticket_types_event ON event_ticket_types (event_id, sort_order);

CREATE TABLE IF NOT EXISTS event_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_name TEXT NOT NULL,
  file_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('requested', 'uploaded', 'accepted', 'rejected')),
  requested_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_documents_event ON event_documents (event_id, status);

CREATE TABLE IF NOT EXISTS event_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT,
  previous_status TEXT,
  new_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_approvals_event ON event_approvals (event_id, created_at DESC);

-- Organiser change requests against an approved event (postpone/cancel/update/
-- other), reviewed and applied by admin. Kept identical to the copy in
-- ticketing-service.ensureTicketingSchema so both provisioning paths agree.
CREATE TABLE IF NOT EXISTS event_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL,
  requested_changes JSONB NOT NULL DEFAULT '{}'::JSONB,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  decision_note TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_change_requests_type_check CHECK (request_type IN ('postpone','cancel','update_details','other')),
  CONSTRAINT event_change_requests_status_check CHECK (status IN ('requested','under_review','approved','rejected','applied'))
);
CREATE INDEX IF NOT EXISTS idx_event_change_requests_event ON event_change_requests (event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_change_requests_status ON event_change_requests (status, created_at DESC);
-- One OPEN request per event, enforced by the database so a concurrent
-- double-submit cannot slip past the application-level check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_change_requests_open
  ON event_change_requests (event_id) WHERE status IN ('requested','under_review');

CREATE TABLE IF NOT EXISTS event_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_audit_logs_event ON event_audit_logs (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'scanner',
  permissions JSONB NOT NULL DEFAULT '["scan"]'::JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_staff_event ON event_staff (event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_staff_user ON event_staff (user_id, status);

CREATE TABLE IF NOT EXISTS ticket_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  ticket_type_id UUID NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  -- The foreign key is added at the end of this file, not here: transactions
  -- is created below, and Postgres has no forward declaration.
  transaction_id UUID,
  order_reference TEXT NOT NULL UNIQUE,
  quantity INTEGER NOT NULL DEFAULT 1,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  buyer_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  business_commission NUMERIC(18,2) NOT NULL DEFAULT 0,
  business_net NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  buyer_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_buyer ON ticket_orders (buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_event ON ticket_orders (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_status ON ticket_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  ticket_type_id UUID NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ticket_code TEXT NOT NULL UNIQUE,
  qr_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  attendee_name TEXT,
  attendee_phone TEXT,
  attendee_email TEXT,
  status TEXT NOT NULL DEFAULT 'valid',
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  scanned_at TIMESTAMPTZ,
  scanned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets (event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets (order_id);

CREATE TABLE IF NOT EXISTS ticket_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  reason TEXT NOT NULL DEFAULT '',
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  transaction_id UUID,   -- foreign key added at the end of this file
  decision_note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_refunds_event ON ticket_refunds (event_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_refunds_order ON ticket_refunds (order_id);

CREATE TABLE IF NOT EXISTS ticket_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  settlement_reference TEXT NOT NULL UNIQUE,
  gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  buyer_fees NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission NUMERIC(18,2) NOT NULL DEFAULT 0,
  refunds NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_settlement NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  processed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_settlements_event ON ticket_settlements (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id UUID PRIMARY KEY,
  service_code TEXT NOT NULL UNIQUE,
  service_name TEXT NOT NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('FREE', 'FIXED', 'PERCENTAGE')),
  fee_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  flat_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  percentage_fee NUMERIC(18,4) NOT NULL DEFAULT 0,
  minimum_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  maximum_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat_percentage NUMERIC(8,4) NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS flat_fee NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS percentage_fee NUMERIC(18,4) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS vat_percentage NUMERIC(8,4) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS effective_date DATE NOT NULL DEFAULT CURRENT_DATE;
UPDATE pricing_rules
SET flat_fee = CASE WHEN fee_type = 'FIXED' THEN fee_value ELSE flat_fee END,
    percentage_fee = CASE WHEN fee_type = 'PERCENTAGE' THEN fee_value ELSE percentage_fee END,
    enabled = COALESCE(enabled, active, TRUE),
    effective_date = COALESCE(effective_date, CURRENT_DATE)
WHERE flat_fee = 0 AND percentage_fee = 0;

-- A QR payment costs a person a flat R1.50. This only fills in a rule that has
-- NO price at all, which is the case a schema repair has to cover: a rule
-- created at zero would make QR payments free without anybody deciding that.
-- It used to force R0.50 onto anything cheaper and raise minimum_fee to match,
-- which meant an operator could set a lower price in the admin console and have
-- a schema repair quietly put it back. A price an operator has set is theirs.
UPDATE pricing_rules
SET fee_type = 'FIXED',
    fee_value = 1.50,
    flat_fee = 1.50,
    enabled = TRUE,
    active = TRUE,
    updated_at = NOW()
WHERE service_code = 'qr_payment'
  AND COALESCE(flat_fee, 0) = 0
  AND COALESCE(percentage_fee, 0) = 0
  AND COALESCE(fee_value, 0) = 0;

CREATE TABLE IF NOT EXISTS service_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_code TEXT NOT NULL UNIQUE,
  service_name TEXT NOT NULL,
  service_icon TEXT NOT NULL DEFAULT 'grid-3x3',
  action TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'coming_soon', 'disabled')),
  personal_visible BOOLEAN NOT NULL DEFAULT TRUE,
  business_visible BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  feature_badge TEXT NOT NULL DEFAULT 'none' CHECK (feature_badge IN ('new', 'soon', 'none')),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_config_status ON service_config (status, sort_order);
CREATE INDEX IF NOT EXISTS idx_service_config_visibility ON service_config (personal_visible, business_visible);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'admin')),
  user_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('customer', 'admin')),
  refresh_token_hash TEXT NOT NULL,
  access_jti TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  user_agent TEXT,
  ip_address TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_type, user_id, scope);
CREATE INDEX IF NOT EXISTS idx_sessions_access_jti ON sessions (access_jti);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions (refresh_token_hash);

CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'admin')),
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  attempts INTEGER NOT NULL DEFAULT 0,
  resend_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_codes_lookup ON otp_codes (user_type, user_id, purpose, expires_at);

CREATE TABLE IF NOT EXISTS qr_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  code_type TEXT NOT NULL CHECK (code_type IN ('static', 'dynamic', 'merchant')),
  label TEXT,
  amount NUMERIC(18,2),
  currency TEXT NOT NULL DEFAULT 'ZAR',
  status TEXT NOT NULL DEFAULT 'active',
  reference TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  image_svg TEXT,
  image_data_url TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_codes_user ON qr_codes (user_id, code_type, status);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  qr_code_id UUID REFERENCES qr_codes(id) ON DELETE SET NULL,
  service_code TEXT NOT NULL REFERENCES pricing_rules(service_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL,
  fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  recipient_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_qr ON transactions (qr_code_id);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_service ON transactions (service_code, created_at DESC);

-- Backstop for duplicate payments.
--
-- What actually prevents a duplicate is the advisory lock the services take on
-- the idempotency key inside their transaction (transaction-service.js and
-- peach-withdrawal-service.js). This index exists so that if a future money path
-- is written without that lock, PostgreSQL refuses the second row instead of
-- charging the customer twice in silence.
--
-- It is created inside a guard for two reasons. A UNIQUE index cannot be built
-- over rows that already violate it, and schema.sql is executed as one script —
-- so an unguarded CREATE would abort every statement after it. If duplicates are
-- present the index is skipped with a notice; resolve them and the next deploy
-- picks it up. On a large production table build it once by hand with
-- CREATE UNIQUE INDEX CONCURRENTLY (same definition) to avoid holding a write
-- lock, and this block will then find it already there and do nothing.
DO $$
DECLARE duplicate_groups INTEGER;
BEGIN
  IF to_regclass('public.idx_transactions_client_idem') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO duplicate_groups FROM (
    SELECT 1
    FROM transactions
    WHERE metadata->>'clientIdempotencyKey' IS NOT NULL
    GROUP BY user_id, metadata->>'clientIdempotencyKey'
    HAVING COUNT(*) > 1
  ) existing_duplicates;
  IF duplicate_groups > 0 THEN
    RAISE NOTICE 'idx_transactions_client_idem not created: % duplicate idempotency-key group(s) already present. Resolve them and redeploy.', duplicate_groups;
  ELSE
    CREATE UNIQUE INDEX idx_transactions_client_idem
      ON transactions (user_id, (metadata->>'clientIdempotencyKey'))
      WHERE metadata->>'clientIdempotencyKey' IS NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'read')),
  provider TEXT,
  provider_message_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
);
-- Chat, chatbot and support delivery receipts use this optional timestamp.
-- Older production databases and the original runtime-created table omitted it.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_admin ON notifications (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_type_status ON notifications (notification_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_transaction_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  email_support_updates BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_notification_preferences_updated
  ON customer_notification_preferences (updated_at DESC);

CREATE TABLE IF NOT EXISTS announcement_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('general', 'marketing', 'service', 'security')),
  audience TEXT NOT NULL CHECK (audience IN ('personal', 'business', 'specific', 'both')),
  target_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'sent', 'rejected', 'escalated')),
  estimated_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  -- Why a decision was taken, and by whom, for a rejection or an escalation.
  decision_reason TEXT,
  decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  escalated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  escalated_at TIMESTAMPTZ,
  escalation_note TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE announcement_campaigns
  DROP CONSTRAINT IF EXISTS announcement_campaigns_audience_check;
ALTER TABLE announcement_campaigns
  ADD CONSTRAINT announcement_campaigns_audience_check
  CHECK (audience IN ('personal', 'business', 'specific', 'both'));

CREATE TABLE IF NOT EXISTS announcement_approvals (
  campaign_id UUID NOT NULL REFERENCES announcement_campaigns(id) ON DELETE CASCADE,
  -- Three approval seats: the CEO, the COO and Senior Marketing. One row per
  -- seat, so the same person cannot approve twice under two hats.
  approval_role TEXT NOT NULL CHECK (approval_role IN ('ceo', 'coo', 'senior_marketing')),
  approved_by UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, approval_role),
  UNIQUE (campaign_id, approved_by)
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  campaign_id UUID NOT NULL REFERENCES announcement_campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_campaigns_status
  ON announcement_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcement_approvals_campaign
  ON announcement_approvals (campaign_id, approved_at);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_user
  ON announcement_reads (user_id, read_at DESC);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT 'Trusted device',
  user_agent TEXT,
  ip_address INET,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  trusted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_user_fingerprint
  ON trusted_devices (user_id, device_fingerprint)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices (user_id, trusted_at DESC);

CREATE TABLE IF NOT EXISTS active_sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  device_label TEXT,
  ip_address INET,
  user_agent TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions (user_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_sessions_admin ON active_sessions (admin_user_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  success BOOLEAN NOT NULL DEFAULT TRUE,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_admin ON security_events (admin_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS duplicate_account_flags (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,
  matched_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_duplicate_account_flags_user ON duplicate_account_flags (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  identifier TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts (identifier, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_logout_events (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_remote_logout_events_user ON remote_logout_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pin_attempts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_user ON pin_attempts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_qr_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qr_code_id UUID NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, qr_code_id)
);

CREATE INDEX IF NOT EXISTS idx_user_qr_codes_user ON user_qr_codes (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS business_qr_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qr_code_id UUID NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, qr_code_id)
);

CREATE INDEX IF NOT EXISTS idx_business_qr_codes_user ON business_qr_codes (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS invite_links (
  id UUID PRIMARY KEY,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  invitee_identifier TEXT NOT NULL,
  channels TEXT[] NOT NULL DEFAULT ARRAY['sms','email','whatsapp'],
  message TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_links_identifier ON invite_links (invitee_identifier, created_at DESC);

CREATE TABLE IF NOT EXISTS invite_events (
  id UUID PRIMARY KEY,
  invite_id UUID NOT NULL REFERENCES invite_links(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_events_invite ON invite_events (invite_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit', 'reserve', 'release')),
  amount NUMERIC(18,2) NOT NULL,
  balance_after NUMERIC(18,2) NOT NULL,
  reference TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet ON wallet_ledger (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS revenue_ledger (
  id UUID PRIMARY KEY,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  service_code TEXT NOT NULL REFERENCES pricing_rules(service_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  fee_collected NUMERIC(18,2) NOT NULL,
  revenue_wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_ledger_created ON revenue_ledger (created_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY,
  ticket_ref TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business product catalogue and stock trail. The runtime also creates these
-- on first use, so existing databases need no manual migration.
CREATE TABLE IF NOT EXISTS business_products (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  price NUMERIC(18,2) NOT NULL DEFAULT 0,
  track_stock BOOLEAN NOT NULL DEFAULT FALSE,
  stock_quantity NUMERIC(18,2) NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC(18,2) NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_products_name
  ON business_products (business_user_id, LOWER(name)) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS business_stock_movements (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES business_products(id) ON DELETE CASCADE,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('opening', 'sale', 'restock', 'adjustment', 'stock_take')),
  quantity_change NUMERIC(18,2) NOT NULL,
  quantity_after NUMERIC(18,2) NOT NULL,
  note TEXT,
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_business_stock_movements_product ON business_stock_movements (product_id, created_at DESC);

-- Stokvel groups, members, chat, meetings and recorded withdrawals. The
-- runtime also creates these on first use, so existing databases need no
-- manual migration. Contributions are NOT stored here: the group balance is
-- read from the transactions the wallet already recorded.
CREATE TABLE IF NOT EXISTS stockvel_groups (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL DEFAULT 'monthly',
  contribution_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  goal_amount NUMERIC(18,2),
  member_limit INTEGER,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS stockvel_members (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('chair','organiser','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS stockvel_withdrawals (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS stockvel_messages (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_decision BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stockvel_messages_group ON stockvel_messages (group_id, created_at);
CREATE TABLE IF NOT EXISTS stockvel_meetings (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
  opened_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  title TEXT NOT NULL DEFAULT 'Stokvel meeting',
  minutes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

-- Business staff register and staff till sales. The runtime also creates
-- these on first use, so existing databases need no manual migration.
CREATE TABLE IF NOT EXISTS business_staff (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Other',
  contact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_staff_member
  ON business_staff (business_user_id, staff_user_id)
  WHERE staff_user_id IS NOT NULL AND status = 'active';
CREATE TABLE IF NOT EXISTS business_staff_sales (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  reference TEXT NOT NULL,
  qr_id UUID,
  items JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_business_staff_sales_business ON business_staff_sales (business_user_id, created_at DESC);

-- Written replies on a support ticket (staff and customer). The runtime also
-- creates this on first use, so existing databases need no manual migration.
CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('admin', 'customer')),
  author_id UUID,
  author_label TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON support_ticket_replies (ticket_id, created_at);

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ticket_ref TEXT;
-- A customer may clear finished requests from their own list; the row stays
-- for the support team's audit trail.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hidden_by_customer BOOLEAN NOT NULL DEFAULT FALSE;
-- Older TitoPay databases predate the timestamp/assignment columns below.
-- They must exist before the ticket-reference backfill and support actions run.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
DO $$
DECLARE
  ticket_record RECORD;
  candidate TEXT;
BEGIN
  FOR ticket_record IN
    SELECT id FROM support_tickets
    WHERE ticket_ref IS NULL
       OR ticket_ref !~ '^[A-Z]{2}[0-9]{6}$'
  LOOP
    LOOP
      candidate := 'TP' || LPAD(FLOOR(RANDOM() * 1000000)::INT::TEXT, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM support_tickets WHERE ticket_ref = candidate);
    END LOOP;
    UPDATE support_tickets SET ticket_ref = candidate, updated_at = NOW() WHERE id = ticket_record.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_ref ON support_tickets (ticket_ref) WHERE ticket_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID UNIQUE REFERENCES support_tickets(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'BOT_ACTIVE' CHECK (
    status IN ('BOT_ACTIVE','ESCALATED','WAITING_FOR_AGENT','AGENT_ACTIVE','RESOLVED','CLOSED','REOPENED')
  ),
  escalation_reason TEXT,
  assigned_agent_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  taken_over_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  reopened_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_conversations_queue
  ON support_conversations (status, assigned_agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_customer
  ON support_conversations (customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE RESTRICT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CUSTOMER','BOT','AGENT','SYSTEM')),
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','system')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','read')),
  client_message_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (sender_type = 'CUSTOMER' AND sender_user_id IS NOT NULL AND sender_admin_id IS NULL)
    OR (sender_type = 'AGENT' AND sender_admin_id IS NOT NULL AND sender_user_id IS NULL)
    OR (sender_type IN ('BOT','SYSTEM') AND sender_user_id IS NULL AND sender_admin_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
  ON support_conversation_messages (conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_idempotency
  ON support_conversation_messages (conversation_id, sender_type, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_conversation_events
  ON support_conversation_events (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS kyc_reviews (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  review_type TEXT NOT NULL CHECK (review_type IN ('FICA', 'KYC', 'AML', 'merchant_verification', 'document_review')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  risk_rating TEXT CHECK (risk_rating IN ('low', 'medium', 'high')),
  notes TEXT,
  document_reference TEXT,
  reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_reviews_user ON kyc_reviews (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_reviews_merchant ON kyc_reviews (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_reviews_status ON kyc_reviews (status, created_at DESC);

CREATE TABLE IF NOT EXISTS profile_change_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
  requested_changes JSONB NOT NULL DEFAULT '{}'::JSONB,
  current_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  support_notes TEXT,
  reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status ON profile_change_requests (status, due_at ASC);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_user ON profile_change_requests (user_id, created_at DESC);

-- A customer's request to close their TitoPay account, reviewed by an admin.
-- Approval sets users.status = 'closed' and revokes sessions; nothing is
-- deleted (FICA record retention). Also runtime-ensured by
-- account-closure-service.js so an un-migrated database self-heals.
CREATE TABLE IF NOT EXISTS account_closure_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  reason TEXT,
  balance_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_closure_requests_status ON account_closure_requests (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_account_closure_requests_user ON account_closure_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_closure_requests_one_pending
  ON account_closure_requests (user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_type, actor_id);

CREATE TABLE IF NOT EXISTS security_logs (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system', 'unknown')),
  actor_id UUID,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  ip_address TEXT,
  user_agent TEXT,
  device_fingerprint TEXT,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  success BOOLEAN,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_logs_created ON security_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_logs_actor ON security_logs (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_security_logs_event ON security_logs (event_type, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_thread_id TEXT,
  participant_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_type TEXT NOT NULL DEFAULT 'direct' CHECK (thread_type IN ('direct', 'business_to_customer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (participant_a <> participant_b),
  UNIQUE (participant_a, participant_b, thread_type)
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_participant_a ON chat_threads (participant_a, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_threads_participant_b ON chat_threads (participant_b, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_threads_status_updated ON chat_threads (status, updated_at DESC);
ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_client_thread_id_key;

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  client_message_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_message_id TEXT;
ALTER TABLE chat_messages ALTER COLUMN status SET DEFAULT 'sent';

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient ON chat_messages (recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_status_created ON chat_messages (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_sender_client_id
  ON chat_messages (sender_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_thread_participant_settings (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  caller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  call_type TEXT NOT NULL DEFAULT 'voice' CHECK (call_type IN ('voice')),
  status TEXT NOT NULL DEFAULT 'initiated',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);
ALTER TABLE chat_call_logs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_chat_call_logs_caller ON chat_call_logs (caller_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_call_logs_thread ON chat_call_logs (thread_id, started_at DESC);

INSERT INTO service_config (
  service_code,
  service_name,
  service_icon,
  action,
  description,
  fee,
  commission,
  status,
  personal_visible,
  business_visible,
  sort_order,
  feature_badge
) VALUES
  ('top-up', 'Top Up', 'upload', 'top-up', 'Fund a TitoPay wallet by card or bank transfer.', 0, 0, 'active', TRUE, TRUE, 10, 'none'),
  ('withdraw', 'Withdraw', 'landmark', 'withdraw', 'Withdraw funds from a TitoPay wallet to a bank account.', 0, 0, 'active', TRUE, TRUE, 20, 'none'),
  ('bill-split', 'Bill Split', 'scissors', 'bill-split', 'Split bills and send payment requests to participants.', 0, 0, 'active', TRUE, TRUE, 30, 'new'),
  ('stockvel', 'Stockvel', 'piggy-bank', 'stockvel', 'Create, join and manage community savings groups.', 0, 0, 'active', TRUE, TRUE, 40, 'new'),
  ('send-gift', 'Send Gift', 'gift', 'send-gift', 'Send a money gift with a personal message.', 0, 0, 'active', TRUE, TRUE, 50, 'new'),
  ('tip', 'Tip', 'hand-coins', 'tip', 'Generate tip QR codes, receive tips and export tip reports.', 0, 0, 'active', TRUE, TRUE, 60, 'new'),
  ('airtime-and-data', 'Airtime & Data', 'smartphone', 'airtime', 'Buy airtime and mobile data bundles.', 0, 0, 'active', TRUE, TRUE, 70, 'none'),
  ('electricity', 'Electricity', 'zap', 'electricity', 'Buy prepaid electricity and receive a meter token.', 0, 0, 'active', TRUE, TRUE, 80, 'none'),
  ('voucher', 'Voucher', 'tag', 'voucher', 'Buy shopping, gaming, entertainment and food vouchers.', 0, 0, 'active', TRUE, TRUE, 90, 'none'),
  ('learn', 'Learn', 'graduation-cap', 'learn', 'Access personal and business financial education.', 0, 0, 'active', TRUE, TRUE, 100, 'none'),
  ('payment-request', 'Payment Request', 'corner-down-left', 'payment-request', 'Request money with shareable links and QR requests.', 0, 0, 'active', TRUE, TRUE, 110, 'new'),
  ('events', 'Events', 'ticket', 'events', 'Event ticketing and access management.', 0, 0, 'disabled', FALSE, FALSE, 200, 'none'),
  ('shop-marketplace', 'Shop Marketplace', 'shopping-bag', 'shop', 'Marketplace for local brands and digital products.', 0, 0, 'disabled', FALSE, FALSE, 210, 'none'),
  ('virtual-doctor', 'Virtual Doctor', 'stethoscope', 'doctor', 'Healthcare consultations and provider payments.', 0, 0, 'disabled', FALSE, FALSE, 220, 'none'),
  ('travel', 'Travel', 'plane', 'travel', 'Travel booking and payment services.', 0, 0, 'disabled', FALSE, FALSE, 230, 'none'),
  ('donate', 'Donate', 'heart-handshake', 'donate', 'Community giving and donation campaigns.', 0, 0, 'disabled', FALSE, FALSE, 240, 'none'),
  ('cross-border', 'Cross Border', 'globe', 'cross-border', 'Regional remittance and SADC expansion services.', 0, 0, 'disabled', FALSE, FALSE, 250, 'none'),
  ('send-money', 'Send Money', 'send', 'send-money', 'Send money using a username, cellphone number or email address.', 0, 0, 'active', TRUE, FALSE, 25, 'none'),
  ('receive-money', 'Receive Money', 'download', 'receive-money', 'Generate a TitoPay QR to receive money.', 0, 0, 'active', TRUE, TRUE, 26, 'none'),
  ('qr-pay', 'QR Pay', 'qr', 'qr-pay', 'Scan and pay TitoPay QR codes. A flat R1.50 QR payment fee applies.', 1.50, 0, 'active', TRUE, TRUE, 27, 'none'),
  ('data', 'Data', 'smartphone', 'data', 'Buy mobile data bundles.', 0, 0, 'active', TRUE, TRUE, 75, 'none'),
  ('transactions', 'Transactions', 'list', 'transactions', 'Search, filter and export wallet transactions.', 0, 0, 'active', TRUE, TRUE, 120, 'none'),
  ('profile-security', 'Profile & Security', 'shield', 'profile-security', 'Manage FICA, wallet lock, devices and profile security.', 0, 0, 'active', TRUE, FALSE, 130, 'none'),
  ('fica', 'FICA', 'shield', 'fica', 'Submit and track verification documents.', 0, 0, 'active', TRUE, FALSE, 140, 'none'),
  ('tickets', 'Tickets', 'ticket', 'tickets', 'Browse approved TitoPay events and buy secure digital tickets.', 0, 0, 'active', TRUE, FALSE, 145, 'new'),
  ('statements', 'Statements', 'list', 'statements', 'Download PDF statements and CSV exports.', 0, 0, 'active', FALSE, TRUE, 150, 'none'),
  ('payouts', 'Payouts', 'withdraw', 'payouts', 'Request business payouts to bank beneficiaries.', 0, 0, 'active', FALSE, TRUE, 160, 'none'),
  ('business-profile', 'Business Profile', 'user', 'business-profile', 'Manage merchant profile and business wallet settings.', 0, 0, 'active', FALSE, TRUE, 170, 'none'),
  ('invoice', 'Invoice', 'list', 'invoice', 'Create business invoices. PDF download is R2.50.', 0, 0, 'active', FALSE, TRUE, 180, 'none'),
  ('quote', 'Quote', 'list', 'quote', 'Create customer quotes. PDF download is R2.50.', 0, 0, 'active', FALSE, TRUE, 190, 'none'),
  ('proforma-invoice', 'Proforma Invoice', 'list', 'proforma-invoice', 'Create proforma invoices. PDF download is R2.50.', 0, 0, 'active', FALSE, TRUE, 195, 'none'),
  ('rewards', 'Rewards', 'sparkles', 'rewards', 'Personal rewards programme.', 0, 0, 'disabled', FALSE, FALSE, 260, 'none'),
  ('business-rewards', 'Business Rewards', 'sparkles', 'business-rewards', 'Business rewards programme.', 0, 0, 'disabled', FALSE, FALSE, 270, 'none'),
  ('get-cash', 'Get Cash', 'withdraw', 'get-cash', 'Personal cash-out services.', 0, 0, 'disabled', FALSE, FALSE, 280, 'none'),
  ('cash-back', 'Cash Back', 'refresh', 'cash-back', 'Business cashback services.', 0, 0, 'disabled', FALSE, FALSE, 290, 'none')
ON CONFLICT (service_code) DO NOTHING;

UPDATE service_config
SET fee = 1.50,
    description = 'Scan and pay TitoPay QR codes. A flat R1.50 QR payment fee applies.',
    updated_at = NOW()
WHERE service_code = 'qr-pay'
  AND COALESCE(fee, 0) < 1.50;

-- Embedded POS / Speedpoint dynamic QR payments. This module is additive and
-- deliberately reuses the existing merchants, wallets, transactions and
-- wallet_ledger tables as the financial source of truth.
INSERT INTO pricing_rules (
  id, service_code, service_name, fee_type, fee_value, flat_fee,
  percentage_fee, minimum_fee, maximum_fee, vat_percentage,
  enabled, effective_date, active
) VALUES
  (gen_random_uuid(), 'pos_qr', 'POS QR Payment', 'FREE', 0, 0, 0, 0, 0, 0, TRUE, CURRENT_DATE, TRUE),
  (gen_random_uuid(), 'pos_qr_refund', 'POS QR Refund', 'FREE', 0, 0, 0, 0, 0, 0, TRUE, CURRENT_DATE, TRUE),
  (gen_random_uuid(), 'pos_qr_reversal', 'POS QR Reversal', 'FREE', 0, 0, 0, 0, 0, 0, TRUE, CURRENT_DATE, TRUE)
ON CONFLICT (service_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS pos_terminals (
  id UUID PRIMARY KEY,
  terminal_id TEXT NOT NULL UNIQUE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('STANDARD_BANK', 'ABSA', 'NEDBANK', 'CAPITEC', 'OTHER')),
  device_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  credential_encrypted TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, device_identifier)
);
CREATE INDEX IF NOT EXISTS idx_pos_terminals_merchant ON pos_terminals (merchant_id, status);

CREATE TABLE IF NOT EXISTS pos_request_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id UUID NOT NULL REFERENCES pos_terminals(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (terminal_id, nonce_hash)
);
CREATE INDEX IF NOT EXISTS idx_pos_request_nonces_expiry ON pos_request_nonces (expires_at);

CREATE TABLE IF NOT EXISTS pos_payment_intents (
  id UUID PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  terminal_id UUID NOT NULL REFERENCES pos_terminals(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  merchant_reference TEXT NOT NULL,
  qr_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','SCANNED','AUTHORIZED','PROCESSING','COMPLETED','FAILED','CANCELLED','EXPIRED','REVERSED','REFUNDED')
  ),
  provider TEXT NOT NULL CHECK (provider IN ('STANDARD_BANK', 'ABSA', 'NEDBANK', 'CAPITEC', 'OTHER')),
  transaction_reference TEXT UNIQUE,
  cancellation_reason TEXT,
  failure_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  qr_consumed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_intents_terminal ON pos_payment_intents (terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_intents_merchant ON pos_payment_intents (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_intents_customer ON pos_payment_intents (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_intents_status_expiry ON pos_payment_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS pos_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES pos_payment_intents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  terminal_id UUID REFERENCES pos_terminals(id) ON DELETE SET NULL,
  provider TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_events_payment ON pos_payment_events (payment_intent_id, created_at);

CREATE TABLE IF NOT EXISTS pos_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_pos_idempotency_created ON pos_idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS pos_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES pos_payment_intents(id) ON DELETE RESTRICT,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('refund', 'reverse')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  reason TEXT,
  processed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_refunds_payment ON pos_refunds (payment_intent_id, created_at);

CREATE TABLE IF NOT EXISTS pos_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_provider_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_provider_nonces_expiry ON pos_provider_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- Payout bank accounts
--
-- `beneficiaries` links two TitoPay users, so it cannot hold a bank account.
-- A withdrawal or business payout needs the details Peach Payouts requires
-- (account holder, bank, account number, branch code), so they live here,
-- owned by the user, soft-deleted rather than removed so a historical payout
-- always keeps the account it was sent to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_bank_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  account_holder TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  branch_code TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'cheque'
    CHECK (account_type IN ('cheque','savings','transmission','business')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  last_paid_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payout_bank_accounts_owner
  ON payout_bank_accounts (user_id, is_default DESC, created_at DESC)
  WHERE deleted_at IS NULL;
-- One live record per account at a bank, per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_bank_accounts_unique
  ON payout_bank_accounts (user_id, bank_name, account_number, branch_code)
  WHERE deleted_at IS NULL;

-- Rate-limit counters, shared by every API process.
--
-- express-rate-limit's default store lives in one process's memory, so running
-- more than one process would silently multiply every limit by the number of
-- processes. Counting here instead keeps "five attempts per fifteen minutes"
-- meaning five however many workers are serving.
--
-- The key is a SHA-256 of the rate-limit key, never the key itself: rate-limit
-- keys contain the email address or phone number someone typed, and this table
-- has no need to hold those. Rows are disposable — the sweeper deletes expired
-- ones, and losing the table entirely costs nothing but a reset window.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires
  ON rate_limit_counters (expires_at);

-- TitoKids: child sub-wallets managed by a parent. The child's money lives in
-- a real wallet (kind 'system', no wallet number) owned by the parent user, so
-- every fund/pay movement is ordinary double-entry ledger — never a tally.
CREATE TABLE IF NOT EXISTS titokids_children (
  id UUID PRIMARY KEY,
  parent_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  full_name TEXT NOT NULL,
  date_of_birth DATE,
  relationship TEXT NOT NULL DEFAULT 'parent' CHECK (relationship IN ('parent','guardian','other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_titokids_child_link
  ON titokids_children (parent_user_id, child_user_id)
  WHERE child_user_id IS NOT NULL AND status = 'active';
CREATE TABLE IF NOT EXISTS titokids_limits (
  child_id UUID PRIMARY KEY REFERENCES titokids_children(id) ON DELETE CASCADE,
  daily_limit NUMERIC(18,2),
  weekly_limit NUMERIC(18,2),
  monthly_limit NUMERIC(18,2),
  approval_threshold NUMERIC(18,2),
  categories JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS titokids_requests (
  id UUID PRIMARY KEY,
  child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A co-parent, guardian or grandparent who helps manage ONE child's wallet.
-- Per child, never per family, and only after the invitation is accepted.
CREATE TABLE IF NOT EXISTS titokids_guardians (
  id UUID PRIMARY KEY,
  child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'co-parent',
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','declined','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_titokids_guardian
  ON titokids_guardians (child_id, user_id)
  WHERE status IN ('invited','active');
CREATE TABLE IF NOT EXISTS titokids_goals (
  id UUID PRIMARY KEY,
  child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_amount NUMERIC(18,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin console Service Builder: configuration documents composed in the
-- console. Nothing executes these; the PWA's service catalogue is separate.
CREATE TABLE IF NOT EXISTS service_builder_definitions (
  id TEXT PRIMARY KEY,
  definition JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cleared means cleared on every device: the notification feed never serves
-- anything from before the user's last clear-all.
CREATE TABLE IF NOT EXISTS notification_clears (
  user_id UUID PRIMARY KEY,
  cleared_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment requests: Request funds and Bill Split. A row is an ASK, not a
-- movement of money. Money moves only when the payer pays, through the same
-- wallet_transfer rails as Send Money, and transaction_id records that
-- settlement. A bill split is one request per participant sharing a
-- split_group_id.
CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  due_date DATE,
  request_type TEXT NOT NULL DEFAULT 'one_time',
  recurring_frequency TEXT,
  recurring_end_date DATE,
  split_group_id UUID,
  split_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decline_note TEXT,
  transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payment_requests_payer_idx
  ON payment_requests (payer_user_id, status, created_at DESC);

-- Progressive KYC/FICA. Tier 1 is a validated identity document: an SA ID
-- number, a passport with its issuing country, or another approved identity
-- document, stored only as a salted hash. Tier 2 is documentary FICA
-- (fica_status). Enhanced due diligence flags are the audit trail of
-- automatic risk triggers. The tier limits themselves live in
-- platform_settings key 'compliance_tier_limits', editable through the
-- admin API, never hard-coded.
ALTER TABLE users ADD COLUMN IF NOT EXISTS basic_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS edd_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_document_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_issuing_country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_nationality TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_date_of_birth DATE;

-- Verification history: one row per completed verification, hash only.
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  issuing_country TEXT,
  document_hash TEXT,
  status TEXT NOT NULL DEFAULT 'verified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyc_verifications_user_idx
  ON kyc_verifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compliance_flags (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS compliance_flags_open_idx
  ON compliance_flags (status, created_at DESC);

-- Risk status is a separate axis from KYC. Screening entries are maintained
-- by compliance administrators; matches raise high-risk signals.
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_status TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cdd_reviewed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS compliance_screening_list (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  name_pattern TEXT,
  id_number_hash TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  added_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- MONEY INTEGRITY. The wallet_ledger is the financial record; these objects
-- prove the projections agree with it and keep every disagreement visible
-- until a person resolves it. Nothing here moves money.

CREATE TABLE IF NOT EXISTS money_integrity_alerts (
  id UUID PRIMARY KEY,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  fingerprint TEXT NOT NULL UNIQUE,
  user_id UUID,
  wallet_id UUID,
  transaction_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by UUID,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS money_integrity_alerts_open_idx
  ON money_integrity_alerts (status, severity, created_at DESC);

-- Every transactions.status transition, recorded by trigger in the same
-- database transaction as the change. 'reversed' is terminal and enforced.
CREATE TABLE IF NOT EXISTS transaction_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'db_trigger'
);

CREATE INDEX IF NOT EXISTS transaction_status_history_tx_idx
  ON transaction_status_history (transaction_id, changed_at);

CREATE OR REPLACE FUNCTION titopay_record_tx_status() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO transaction_status_history (transaction_id, from_status, to_status)
    VALUES (NEW.id, NULL, NEW.status);
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'reversed' THEN
      RAISE EXCEPTION 'transaction % is reversed; reversed is terminal', OLD.id;
    END IF;
    INSERT INTO transaction_status_history (transaction_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'titopay_tx_status_insert') THEN
    CREATE TRIGGER titopay_tx_status_insert AFTER INSERT ON transactions
    FOR EACH ROW EXECUTE PROCEDURE titopay_record_tx_status();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'titopay_tx_status_update') THEN
    CREATE TRIGGER titopay_tx_status_update BEFORE UPDATE OF status ON transactions
    FOR EACH ROW EXECUTE PROCEDURE titopay_record_tx_status();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  checked_count INT NOT NULL DEFAULT 0,
  exception_count INT NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  triggered_by UUID
);

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id UUID PRIMARY KEY,
  run_id UUID REFERENCES reconciliation_runs(id) ON DELETE SET NULL,
  exception_type TEXT NOT NULL,
  transaction_id UUID,
  wallet_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS reconciliation_exceptions_open_idx
  ON reconciliation_exceptions (status, created_at DESC);

-- Regulatory reporting evidence. Which report types apply is a legal
-- determination mapped by compliance; nothing is assumed here.
CREATE TABLE IF NOT EXISTS regulatory_report_events (
  id UUID PRIMARY KEY,
  report_type TEXT NOT NULL,
  trigger_summary TEXT NOT NULL,
  review_note TEXT,
  decision TEXT NOT NULL,
  submission_reference TEXT,
  submitted_at TIMESTAMPTZ,
  responsible_admin UUID NOT NULL,
  related_user UUID,
  related_case UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

-- Case management on the compliance flag queue.
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS assigned_to UUID;
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS case_type TEXT;
ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS decision TEXT;

-- The lookups the payment rails and the integrity sweep actually run.
CREATE INDEX IF NOT EXISTS idx_transactions_open_status
  ON transactions (status, updated_at DESC) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_transactions_checkout_ref
  ON transactions ((metadata->>'checkoutId')) WHERE metadata ? 'checkoutId';
CREATE INDEX IF NOT EXISTS idx_transactions_payout_ref
  ON transactions ((metadata->>'payoutId')) WHERE metadata ? 'payoutId';

-- HELD CREDITS. A payment that fails only on the recipient's receiving
-- capacity is held rather than refused: the sender's debit is real, the
-- recipient is told money is waiting, verifying releases it, and anything
-- unclaimed returns to the sender in full. Nothing is ever credited to a
-- spendable balance before release.
CREATE TABLE IF NOT EXISTS pending_credits (
  id UUID PRIMARY KEY,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  service_code TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'receiving_capacity',
  status TEXT NOT NULL DEFAULT 'awaiting_verification',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS pending_credits_recipient_idx
  ON pending_credits (recipient_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_credits_open_idx
  ON pending_credits (status, expires_at);

-- Configuration history: every limit and risk change is versioned, so a
-- change can be reviewed and reversed rather than only overwritten.
CREATE TABLE IF NOT EXISTS compliance_config_versions (
  id UUID PRIMARY KEY,
  config_key TEXT NOT NULL,
  value JSONB NOT NULL,
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compliance_config_versions_key_idx
  ON compliance_config_versions (config_key, created_at DESC);

-- The suspense wallet. Money held for a recipient who cannot yet receive it
-- has to be somewhere: it credits here on hold and debits here on release
-- or return, so this balance is always exactly the value of the open holds.
-- A system wallet with no owner: it never enters a customer's limits.
INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
SELECT gen_random_uuid(), '9000000001', NULL, 'system', 'ZAR', 0
WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE wallet_number = '9000000001');

-- ---------------------------------------------------------------------------
-- Deferred foreign keys.
--
-- ticket_orders and ticket_refunds both point at transactions, which this file
-- creates after them. The whole schema runs as ONE statement, so a forward
-- reference does not merely fail: it rolls the entire file back and leaves an
-- empty database behind. That is how rebuilding from scratch stopped working,
-- which is only discovered on the day it is needed most.
--
-- The constraints are the same ones the columns used to declare inline, added
-- once every table exists. Both are guarded, so re-running this file on a
-- database that already has them is a no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_orders_transaction_id_fkey') THEN
    ALTER TABLE ticket_orders
      ADD CONSTRAINT ticket_orders_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_refunds_transaction_id_fkey') THEN
    ALTER TABLE ticket_refunds
      ADD CONSTRAINT ticket_refunds_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Banking integration foundation.
--
-- Kept byte for byte identical to
-- src/db/migrations/20260817_banking_integration_foundation.up.sql, which is
-- what an EXISTING database applies. This copy is what a NEW one gets, so that
-- db:init-production stands up a database with the same shape rather than one
-- migration behind.
--
-- Read that file for why each table exists. The short version: none of them
-- holds a balance or can move money. They record where a payment sits inside a
-- BANK's lifecycle, beside the transaction that remains the financial record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_capability_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Free text, deliberately. A provider is a configuration value, not a schema
  -- change: adding a bank must never require a migration. (The older
  -- pos_terminals/pos_payment_intents tables pin their provider with a CHECK
  -- listing four bank names; that is the pattern this one does not repeat.)
  provider TEXT NOT NULL,
  -- TitoPay's own capability vocabulary, so a CHECK here is a check on our
  -- words rather than a supplier's.
  capability TEXT NOT NULL CHECK (capability IN (
    'CUSTOMER_PAYMENT_INITIATION','ACCOUNT_INFORMATION','ACCOUNT_VERIFICATION',
    'TRANSACTION_HISTORY','PAYMENT_STATUS','WITHDRAWAL','PAYOUT','REFUND',
    'RECONCILIATION','SETTLEMENT','CONSENT_MANAGEMENT'
  )),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  -- Who decided, on what evidence. A capability approved with no reference to
  -- anything is an approval nobody can audit later.
  approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  approval_reference TEXT,
  reason TEXT,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, capability, environment)
);
CREATE INDEX IF NOT EXISTS idx_banking_approvals_lookup
  ON banking_capability_approvals (provider, environment, capability)
  WHERE approved AND revoked_at IS NULL;


-- ---------------------------------------------------------------------------
-- 2. The sidecar: a payment's lifecycle inside the bank.
--
-- ONE INTENT PER TRANSACTION, enforced by a unique constraint on
-- transaction_id, and the transaction must already exist. That ordering is
-- taken from the card top-up path, which writes its transaction row BEFORE it
-- calls the provider, so that there is never a provider-side payment with no
-- TitoPay record of it. An intent describes a transaction; it never substitutes
-- for one.
--
-- `canonical_state` is TitoPay's word for where the payment sits. It maps to
-- `transactions.status`, which keeps its own lifecycle and its own triggers.
-- Where the two disagree, the transaction is authoritative for money and this
-- is authoritative for the bank conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Explicit ownership. RESTRICT rather than CASCADE: a transaction with a bank
  -- conversation attached to it is not something to remove quietly.
  transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  capability TEXT NOT NULL CHECK (capability IN (
    'CUSTOMER_PAYMENT_INITIATION','WITHDRAWAL','PAYOUT','REFUND'
  )),
  canonical_state TEXT NOT NULL CHECK (canonical_state IN (
    'CREATED','CONSENT_PENDING','AUTHORISED','PAYMENT_PENDING','SUCCESS',
    'FAILED','REJECTED','EXPIRED','IN_DOUBT','CANCELLED','REFUNDED'
  )),
  -- A copy of what the server authorised, so a provider's answer can be checked
  -- against something immutable. It is evidence, never a balance.
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The provider's side of the conversation, kept in the provider's own words.
  provider_transaction_id TEXT,
  provider_reference TEXT,
  provider_status TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  -- Required, and unique per provider. Idempotency is a precondition of
  -- creating an intent, not something bolted on afterwards.
  idempotency_key TEXT NOT NULL,
  failure_reason TEXT,
  requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A retried request finds the original instead of starting a second payment.
  UNIQUE (provider, idempotency_key),
  -- One provider-side payment can only ever attach to one intent, so a replayed
  -- or duplicated provider identifier cannot quietly spawn a second record.
  UNIQUE (provider, environment, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_banking_intents_state
  ON banking_payment_intents (canonical_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_banking_intents_user
  ON banking_payment_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_banking_intents_provider_ref
  ON banking_payment_intents (provider, provider_reference);
-- The operator's queue: everything unresolved, newest last.
CREATE INDEX IF NOT EXISTS idx_banking_intents_review
  ON banking_payment_intents (created_at)
  WHERE requires_review OR canonical_state = 'IN_DOUBT';


-- ---------------------------------------------------------------------------
-- 3. State history. Append only, and never written by hand.
--
-- The same idea as transaction_status_history, for the bank-side lifecycle:
-- every canonical state change recorded with what caused it, so that "how did
-- this reach SUCCESS?" is answerable months later without a provider's logs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_state_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES banking_payment_intents(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  -- What moved it: a status query, a callback, an operator, a sweep. A state
  -- that changed because of a callback alone is visible here as exactly that.
  source TEXT NOT NULL,
  provider_status TEXT,
  actor_type TEXT,
  actor_id UUID,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_banking_transitions_intent
  ON banking_state_transitions (intent_id, created_at);


-- ---------------------------------------------------------------------------
-- 4. Provider events (callbacks).
--
-- THIS TABLE EXISTS BECAUSE platform_settings WAS BEING USED FOR THIS.
-- Webhook idempotency keys were written as settings rows, which is why the
-- sandbox database holds 234 of them against a fresh database's 4, and why
-- going live carries a written warning never to copy that table. Bank callbacks
-- get a real home with a real unique constraint.
--
-- A ROW HERE IS NOT EVIDENCE THAT MONEY MOVED. It records that something
-- arrived and whether its signature checked out. What actually happened is
-- established by asking the provider directly, and only that answer may settle
-- anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  -- The provider's own identifier for this delivery. The idempotency constraint
  -- below is the reason duplicate delivery cannot produce duplicate effect.
  event_id TEXT NOT NULL,
  event_type TEXT,
  -- Whether the signature verified. Recorded rather than assumed, so a run of
  -- unverifiable deliveries is visible as a security signal instead of silence.
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  intent_id UUID REFERENCES banking_payment_intents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  request_id TEXT,
  source_ip TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_banking_events_unprocessed
  ON banking_provider_events (received_at)
  WHERE status IN ('received','processing','failed');
CREATE INDEX IF NOT EXISTS idx_banking_events_intent
  ON banking_provider_events (intent_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Banking approval attribution and tamper evidence.
--
-- Kept identical to
-- src/db/migrations/20260818_banking_approval_attribution.up.sql, which is what
-- an EXISTING database applies. This copy is what a NEW one gets.
--
-- These columns are what stop a database row from being an approval on its own:
-- attribution, a signature keyed by a secret held in the SERVER environment and
-- never in this database, and for production a second, different approver. No
-- secret is stored here; a signature is a digest of the approval's own facts.
-- ---------------------------------------------------------------------------
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS approval_signature TEXT;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS signature_algorithm TEXT;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersigned_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersigned_at TIMESTAMPTZ;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersignature TEXT;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS audit_event_id UUID;

ALTER TABLE banking_capability_approvals
  DROP CONSTRAINT IF EXISTS banking_approvals_two_person;
ALTER TABLE banking_capability_approvals
  ADD CONSTRAINT banking_approvals_two_person
  CHECK (countersigned_by IS NULL OR approved_by IS NULL OR countersigned_by <> approved_by);

CREATE INDEX IF NOT EXISTS idx_banking_approvals_unsigned
  ON banking_capability_approvals (provider, environment)
  WHERE approved AND revoked_at IS NULL AND approval_signature IS NULL;

-- ---------------------------------------------------------------------------
-- TitoPay Book: the booking foundation.
--
-- Kept byte for byte identical to
-- src/db/migrations/20260819_book_foundation.up.sql, which is what an EXISTING
-- database applies. This copy is what a NEW one gets, so that db:init-production
-- stands up a database with the same shape rather than one migration behind.
--
-- Read that file for why each table exists. The short version: a business
-- publishes a venue, says what it offers and what it offers it with, and
-- customers book a span of time against a resource. NONE of these tables holds
-- a balance or can move money - book_activations.transaction_id and
-- book_bookings.transaction_id POINT AT the financial record rather than
-- duplicating it.
--
-- APPENDED AT THE END OF THE FILE DELIBERATELY. schema.sql runs as ONE query, so
-- a table referencing users, business_profiles or transactions from higher up
-- would be a forward reference and roll the ENTIRE schema back, leaving an empty
-- database. The two columns pointing at business_profiles are declared bare and
-- get their foreign keys from the guarded block at the very end, because
-- business_profiles is not created by this file at all.
-- ---------------------------------------------------------------------------
/* ============================================================ the venue */

-- A business's bookable presence. One business account may run several (a
-- restaurant group with three branches), which is why this is its own table
-- rather than columns on business_profiles.
CREATE TABLE IF NOT EXISTS book_venues (
  id UUID PRIMARY KEY,

  -- The business account that owns and is paid for this venue. CASCADE because
  -- a venue is meaningless without the business it belongs to.
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The verified business ENTITY, when the business has one.
  --
  -- DECLARED BARE, AND THE FOREIGN KEY IS ATTACHED AT THE BOTTOM OF THIS FILE.
  -- business_profiles is NOT created by schema.sql - it is created by the
  -- 20260816 migration and by ensureBusinessSchema() at runtime. An inline
  -- REFERENCES here would therefore fail on a fresh database, and because
  -- schema.sql runs as ONE statement that failure rolls the ENTIRE schema back
  -- and leaves an empty database. The guarded block at the end adds the
  -- constraint wherever the table does exist.
  business_profile_id UUID,

  -- The public web address. This is what gets shared, printed and posted, so it
  -- is unique platform-wide and never reused.
  slug TEXT NOT NULL,

  name TEXT NOT NULL,
  category TEXT NOT NULL,          -- see the note above: no CHECK, by design

  tagline TEXT,
  description TEXT,

  -- Where it is. Free text rather than a normalised address because a spaza in
  -- a township and a hotel in Sandton do not share an address shape.
  address_line TEXT,
  suburb TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),

  contact_phone TEXT,
  contact_email TEXT,
  website_url TEXT,

  -- Opening hours, amenities and category-specific extras (cuisine, price band).
  -- JSONB is the sanctioned extension point and is never nullable here.
  opening_hours JSONB NOT NULL DEFAULT '[]'::JSONB,
  amenities JSONB NOT NULL DEFAULT '[]'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- THE PUBLIC AVAILABILITY COUNTER. A public, unauthenticated, pollable "3
  -- slots left" is marketing for a restaurant and a patient-load signal for a
  -- doctor. Health categories default this to FALSE and show "Accepting
  -- bookings" instead; every business can change it either way.
  shows_availability_count BOOLEAN NOT NULL DEFAULT TRUE,

  -- Whether a booking needs the business to say yes, or is confirmed on the spot.
  auto_confirm BOOLEAN NOT NULL DEFAULT FALSE,

  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,

  CONSTRAINT book_venues_status_check
    CHECK (status IN ('draft','published','paused','archived'))
);

-- The shared link must resolve to exactly one venue, forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_venues_slug ON book_venues (slug);
-- "my venues, newest first" - the default listing shape every owner-scoped
-- table in this schema uses.
CREATE INDEX IF NOT EXISTS idx_book_venues_business ON book_venues (business_user_id, created_at DESC);
-- Discovery reads only published venues, and almost always by category or city.
CREATE INDEX IF NOT EXISTS idx_book_venues_discovery
  ON book_venues (category, city) WHERE status = 'published';

/* ======================================================== the activation */

-- The once-off R250 that unlocks Book for a business.
--
-- ONCE-ONLY IS STRUCTURAL, NOT CHECKED IN CODE. The unique index on
-- business_user_id means a second activation cannot be written even if two
-- taps race past every application guard. Charging a business twice for the
-- same thing is the specific failure this table is shaped to prevent.
CREATE TABLE IF NOT EXISTS book_activations (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The payment that bought it. RESTRICT, not CASCADE: a transaction that
  -- happened must remain attributable, and deleting it must fail loudly.
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,

  -- What was actually charged, read back from pricing at the moment of sale, so
  -- a later price change never rewrites what this business paid.
  amount NUMERIC(18,2) NOT NULL,
  service_code TEXT NOT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_activations_business
  ON book_activations (business_user_id);

/* ========================================================= what is offered */

CREATE TABLE IF NOT EXISTS book_services (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  -- What the customer pays. Zero is legitimate and common: a restaurant
  -- reservation and a doctor's appointment are usually booked without payment.
  price NUMERIC(18,2) NOT NULL DEFAULT 0,

  duration_minutes INTEGER NOT NULL DEFAULT 60,
  -- How many of this service can run at once on ONE resource. A class of 20 is
  -- capacity 20 on one room; a haircut is capacity 1 on one chair.
  capacity INTEGER NOT NULL DEFAULT 1,
  -- Cleaning, turnaround, writing notes. Held after the booking so the next one
  -- cannot start into it.
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  -- How far ahead a customer must book, and how far ahead they may.
  lead_time_minutes INTEGER NOT NULL DEFAULT 0,
  booking_horizon_days INTEGER NOT NULL DEFAULT 90,
  -- How late a customer may cancel without it counting against them.
  cancellation_notice_minutes INTEGER NOT NULL DEFAULT 0,

  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT book_services_status_check CHECK (status IN ('active','inactive')),
  CONSTRAINT book_services_duration_check CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  CONSTRAINT book_services_capacity_check CHECK (capacity > 0),
  CONSTRAINT book_services_price_check CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_book_services_venue ON book_services (venue_id, sort_order, created_at);

/* ======================================================== what it is offered with */

-- A table, a bay, a room, a chair, a trainer, a class. One shape, because they
-- are all "a thing that can hold N bookings at once".
CREATE TABLE IF NOT EXISTS book_resources (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'general',

  -- Covers for a table, seats for a class, one for a treatment chair.
  capacity INTEGER NOT NULL DEFAULT 1,

  -- When a resource IS a person, this is the TitoPay user they are. Optional and
  -- SET NULL because most resources are not people, and because a stylist
  -- leaving must not delete the chair's booking history. The staff RELATIONSHIP
  -- itself lives in business_staff - this is a pointer, not a second staff model.
  staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT book_resources_status_check CHECK (status IN ('active','inactive')),
  CONSTRAINT book_resources_capacity_check CHECK (capacity > 0)
);

CREATE INDEX IF NOT EXISTS idx_book_resources_venue ON book_resources (venue_id, sort_order, created_at);

/* ============================================== which service uses which resource */

-- Many to many, because a wash bay serves three wash packages and a stylist
-- does cuts and colour. Without this, availability cannot tell which resources
-- to look at for a given service.
CREATE TABLE IF NOT EXISTS book_service_resources (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES book_services(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES book_resources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_service_resources
  ON book_service_resources (service_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_book_service_resources_resource
  ON book_service_resources (resource_id);

/* =============================================================== when it is open */

-- A recurring weekly window.
--
-- MINUTES FROM MIDNIGHT, NOT A TIME COLUMN. South Africa has one timezone and no
-- daylight saving today, but "opens at 09:00" is a wall-clock fact about a place
-- and storing it as an integer makes that unambiguous forever, including if
-- TitoPay ever operates anywhere that does observe DST. 0 is midnight, 1440 is
-- the end of the day.
CREATE TABLE IF NOT EXISTS book_availability_rules (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  -- NULL means the whole venue. A value narrows the rule to one resource, which
  -- is how one stylist works Saturdays and the rest do not.
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,

  -- 0 = Sunday, matching JavaScript's Date.getDay(), because the app reads this.
  day_of_week INTEGER NOT NULL,
  opens_minute INTEGER NOT NULL,
  closes_minute INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT book_availability_day_check CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT book_availability_window_check
    CHECK (opens_minute >= 0 AND closes_minute <= 1440 AND closes_minute > opens_minute)
);

CREATE INDEX IF NOT EXISTS idx_book_availability_venue
  ON book_availability_rules (venue_id, day_of_week);

/* ===================================================== a specific day's exception */

-- A public holiday, a wedding that closes the restaurant, a doctor on leave, or
-- extra hours for a festival. Overrides the weekly rule for one date.
CREATE TABLE IF NOT EXISTS book_availability_exceptions (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,

  -- A true calendar date, which is what DATE is for in this schema.
  exception_date DATE NOT NULL,

  -- Closed all day, or open for a different window.
  is_closed BOOLEAN NOT NULL DEFAULT TRUE,
  opens_minute INTEGER,
  closes_minute INTEGER,
  reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT book_exception_window_check CHECK (
    is_closed = TRUE
    OR (opens_minute IS NOT NULL AND closes_minute IS NOT NULL
        AND opens_minute >= 0 AND closes_minute <= 1440 AND closes_minute > opens_minute)
  )
);

CREATE INDEX IF NOT EXISTS idx_book_exceptions_venue
  ON book_availability_exceptions (venue_id, exception_date);

/* ============================================================== the booking */

CREATE TABLE IF NOT EXISTS book_bookings (
  id UUID PRIMARY KEY,

  -- Human-readable, and what a customer reads out over the phone.
  reference TEXT NOT NULL,

  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  service_id UUID REFERENCES book_services(id) ON DELETE SET NULL,
  resource_id UUID REFERENCES book_resources(id) ON DELETE SET NULL,

  -- WHO IS COMING. Nullable because a business may take a booking over the phone
  -- for somebody who has no TitoPay account.
  customer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,

  -- WHO MADE IT. Different from the customer for a business-to-business booking:
  -- a company books a restaurant for eight employees, so booked_by is the
  -- company's user and booked_for_business_id names the company.
  booked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Bare for the same reason as book_venues.business_profile_id above; the
  -- foreign key is attached by the guarded block at the end of this file.
  booked_for_business_id UUID,

  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'pending',

  -- What it cost, captured at booking time so a later price change does not
  -- rewrite history. The MONEY ITSELF lives in transactions; this is the quote.
  quoted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- The payment, when there was one. RESTRICT so a payment cannot be orphaned.
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,

  customer_notes TEXT,
  business_notes TEXT,
  cancellation_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

  confirmed_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT book_bookings_status_check
    CHECK (status IN ('pending','confirmed','checked_in','completed','cancelled','rejected','no_show')),
  CONSTRAINT book_bookings_span_check CHECK (ends_at > starts_at),
  CONSTRAINT book_bookings_party_check CHECK (party_size > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_bookings_reference ON book_bookings (reference);

-- THE AVAILABILITY INDEX. Every overlap check and every calendar view reads
-- exactly this shape: one resource, the bookings that still hold it, by time.
CREATE INDEX IF NOT EXISTS idx_book_bookings_resource_span
  ON book_bookings (resource_id, starts_at, ends_at)
  WHERE status IN ('pending','confirmed','checked_in');

-- The business console's four views: today, upcoming, past, cancelled.
CREATE INDEX IF NOT EXISTS idx_book_bookings_venue_time
  ON book_bookings (venue_id, starts_at DESC);

-- "my bookings" for a customer.
CREATE INDEX IF NOT EXISTS idx_book_bookings_customer
  ON book_bookings (customer_user_id, starts_at DESC)
  WHERE customer_user_id IS NOT NULL;

/* ================================================ deferred foreign keys */

-- business_profiles is created by the 20260816 migration and by
-- ensureBusinessSchema() at runtime, NOT by schema.sql. So the two columns that
-- point at it get their constraint here, guarded, instead of inline.
--
-- WHY GUARDED RATHER THAN UNCONDITIONAL: this same SQL is executed in two very
-- different situations. Applied as a migration to an existing database,
-- business_profiles is already there and the constraint is created. Executed as
-- part of schema.sql on a brand-new database, it is not there yet - and because
-- schema.sql runs as ONE statement, an unguarded ALTER would abort the whole
-- file and leave the database empty. Skipping quietly is correct: the column
-- still exists and still holds the id, and ensureBookSchema() attaches the
-- constraint later once business_profiles has been created.
--
-- This mirrors the deferred-FK block schema.sql already uses for ticket_refunds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'business_profiles') THEN

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'book_venues_business_profile_fkey'
    ) THEN
      ALTER TABLE book_venues
        ADD CONSTRAINT book_venues_business_profile_fkey
        FOREIGN KEY (business_profile_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'book_bookings_booked_for_business_fkey'
    ) THEN
      ALTER TABLE book_bookings
        ADD CONSTRAINT book_bookings_booked_for_business_fkey
        FOREIGN KEY (booked_for_business_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;

  ELSE
    RAISE NOTICE 'business_profiles is not present yet; Book''s foreign keys to it will be attached by ensureBookSchema().';
  END IF;
END $$;

-- Book venue images. Byte for byte identical to
-- src/db/migrations/20260820_book_venue_images.up.sql.
ALTER TABLE book_venues
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE book_venues
  ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::JSONB;
