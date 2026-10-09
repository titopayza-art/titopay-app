SET search_path TO tr;
DROP TABLE IF EXISTS support_cases, idempotency_keys;
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP TABLE IF EXISTS audit_log, organiser_members, organisers, password_resets, sessions, platform_roles, users;
DROP FUNCTION IF EXISTS forbid_mutation();
DROP SCHEMA IF EXISTS tr;
