SET search_path TO tr;
DROP TABLE IF EXISTS platform_meta;
DROP INDEX IF EXISTS users_type_idx;
ALTER TABLE users DROP COLUMN IF EXISTS account_type;
