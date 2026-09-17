ALTER TABLE users DROP CONSTRAINT IF EXISTS users_preferred_authentication_method_check;
ALTER TABLE users DROP COLUMN IF EXISTS last_failed_authentication_at;
ALTER TABLE users DROP COLUMN IF EXISTS last_successful_authentication_at;
ALTER TABLE users DROP COLUMN IF EXISTS authentication_method_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS preferred_authentication_method;
