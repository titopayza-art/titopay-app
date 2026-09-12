-- Additive wallet-unlock authentication preference fields.
-- No OTP values or authentication tokens are persisted here.
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
