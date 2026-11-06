-- 008: one row per automated message already sent (event reminders,
-- abandoned-checkout nudges), so each is sent at most once.
SET search_path TO tr;
CREATE TABLE notification_log (
  key        text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
