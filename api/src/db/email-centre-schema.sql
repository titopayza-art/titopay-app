-- Additive Email Centre schema. Existing TitoPay tables and routes are unchanged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES email_templates(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS email_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  sender_name TEXT NOT NULL DEFAULT 'TitoPay',
  sender_email TEXT NOT NULL DEFAULT 'no-reply@notify.titopay.co.za',
  reply_to_email TEXT NOT NULL DEFAULT 'support@titopay.co.za',
  company_name TEXT NOT NULL DEFAULT 'TitoPay',
  tagline TEXT NOT NULL DEFAULT 'Smart Payments, Simplified.',
  support_email TEXT NOT NULL DEFAULT 'support@titopay.co.za',
  support_url TEXT NOT NULL DEFAULT 'https://titopay.co.za/support',
  website_url TEXT NOT NULL DEFAULT 'https://titopay.co.za',
  verification_token_expiry_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (verification_token_expiry_minutes BETWEEN 5 AND 10080),
  password_reset_token_expiry_minutes INTEGER NOT NULL DEFAULT 30 CHECK (password_reset_token_expiry_minutes BETWEEN 5 AND 1440),
  verification_resend_cooldown_seconds INTEGER NOT NULL DEFAULT 60 CHECK (verification_resend_cooldown_seconds BETWEEN 15 AND 3600),
  verification_resend_window_minutes INTEGER NOT NULL DEFAULT 60 CHECK (verification_resend_window_minutes BETWEEN 5 AND 1440),
  verification_max_resends INTEGER NOT NULL DEFAULT 5 CHECK (verification_max_resends BETWEEN 1 AND 50),
  maximum_retry_count INTEGER NOT NULL DEFAULT 5 CHECK (maximum_retry_count BETWEEN 1 AND 20),
  daily_sending_limit INTEGER NOT NULL DEFAULT 100000 CHECK (daily_sending_limit BETWEEN 1 AND 10000000),
  worker_concurrency INTEGER NOT NULL DEFAULT 5 CHECK (worker_concurrency BETWEEN 1 AND 50),
  default_provider TEXT NOT NULL DEFAULT 'smtp',
  sending_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_otp_events JSONB NOT NULL DEFAULT '{"login":false,"new_device":false,"new_browser":false,"change_password":false,"change_email":false,"wallet_unlock":true,"withdrawal":false,"high_value_payment":false,"business_approval":false,"merchant_payout":false,"api_key_generation":false,"recovery":false,"optional_mfa":false}'::JSONB,
  wallet_unlock_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  authentication_preference_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  email_otp_length INTEGER NOT NULL DEFAULT 6 CHECK (email_otp_length BETWEEN 6 AND 8),
  email_otp_expiry_minutes INTEGER NOT NULL DEFAULT 5 CHECK (email_otp_expiry_minutes BETWEEN 1 AND 30),
  email_otp_maximum_attempts INTEGER NOT NULL DEFAULT 5 CHECK (email_otp_maximum_attempts BETWEEN 1 AND 10),
  email_otp_maximum_resends INTEGER NOT NULL DEFAULT 3 CHECK (email_otp_maximum_resends BETWEEN 0 AND 10),
  email_otp_resend_cooldown_seconds INTEGER NOT NULL DEFAULT 60 CHECK (email_otp_resend_cooldown_seconds BETWEEN 15 AND 600),
  provider_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO email_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_events JSONB NOT NULL DEFAULT '{"login":false,"new_device":false,"new_browser":false,"change_password":false,"change_email":false,"wallet_unlock":true,"withdrawal":false,"high_value_payment":false,"business_approval":false,"merchant_payout":false,"api_key_generation":false,"recovery":false,"optional_mfa":false}'::JSONB;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS wallet_unlock_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE email_settings
SET email_otp_enabled = TRUE,
    email_otp_events = JSONB_SET(COALESCE(email_otp_events, '{}'::JSONB), '{wallet_unlock}', 'true'::JSONB, TRUE),
    wallet_unlock_email_otp_initialized = TRUE,
    updated_at = NOW()
WHERE id = TRUE
  AND wallet_unlock_email_otp_initialized = FALSE;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS authentication_preference_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE email_settings
SET email_otp_enabled = TRUE,
    email_otp_events = JSONB_SET(COALESCE(email_otp_events, '{}'::JSONB), '{optional_mfa}', 'true'::JSONB, TRUE),
    authentication_preference_email_otp_initialized = TRUE,
    updated_at = NOW()
WHERE id = TRUE
  AND authentication_preference_email_otp_initialized = FALSE;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_length INTEGER NOT NULL DEFAULT 6;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_expiry_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_maximum_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_maximum_resends INTEGER NOT NULL DEFAULT 3;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS email_otp_resend_cooldown_seconds INTEGER NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS email_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}'::JSONB,
  encrypted_content TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sent','delivered','failed','cancelled','dead_lettered')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  maximum_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_error TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS email_delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES email_queue(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  provider_response JSONB NOT NULL DEFAULT '{}'::JSONB,
  safe_variables JSONB NOT NULL DEFAULT '{}'::JSONB,
  html_preview TEXT,
  text_preview TEXT,
  error_code TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (queue_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS email_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type TEXT NOT NULL CHECK (user_type IN ('customer','admin')),
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repair partial/older Email Centre deployments before dashboard and worker queries run.
-- These migrations are additive and preserve existing rows and table names.
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS provider_response JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS safe_variables JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS html_preview TEXT;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS text_preview TEXT;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE email_delivery_logs ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_email_queue_claim ON email_queue (status, scheduled_at, created_at);
CREATE INDEX IF NOT EXISTS idx_email_queue_recipient ON email_queue (LOWER(recipient), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_queue_template ON email_queue (template_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_queue_provider_message ON email_queue (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_created ON email_delivery_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_recipient ON email_delivery_logs (LOWER(recipient), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_provider_message ON email_delivery_logs (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message ON email_delivery_events (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_received ON email_delivery_events (received_at DESC, event_type);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_verification_expiry ON email_verification_tokens (expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_password_reset_lookup ON password_reset_tokens (user_type, user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON password_reset_tokens (expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_otp_lookup ON otp_codes (purpose, user_type, user_id, created_at DESC) WHERE purpose LIKE 'email_otp:%';
