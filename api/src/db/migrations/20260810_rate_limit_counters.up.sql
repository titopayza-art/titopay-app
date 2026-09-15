-- Shared rate-limit counters, so limits survive running more than one API
-- process. Additive: creates one new table and one index, touches nothing that
-- already exists, and holds no financial or personal data.
--
-- The key column stores a SHA-256 of the rate-limit key, not the key itself,
-- so no email address or phone number is written here.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires
  ON rate_limit_counters (expires_at);
