SET search_path TO tr;
DROP TABLE IF EXISTS message_outbox, campaigns;
DROP TRIGGER IF EXISTS consent_log_append_only ON consent_log;
DROP TABLE IF EXISTS consent_log, marketing_consents;
