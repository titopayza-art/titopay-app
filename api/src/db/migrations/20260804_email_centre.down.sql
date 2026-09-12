-- Roll back only after the Email Centre worker is stopped and a database backup exists.
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS email_verification_tokens;
DROP TABLE IF EXISTS email_delivery_events;
DROP TABLE IF EXISTS email_delivery_logs;
DROP TABLE IF EXISTS email_queue;
DROP TABLE IF EXISTS email_template_versions;
DROP TABLE IF EXISTS email_templates;
DROP TABLE IF EXISTS email_settings;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE otp_codes DROP COLUMN IF EXISTS revoked_at;
