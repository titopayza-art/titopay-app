-- 013: one account, one portal. Every account is a customer, an organiser or
-- TicketRoom staff, and signs in on its own portal only. Existing accounts are
-- sorted by what they already do (same steps as the PHP edition's upgrade 8).
SET search_path TO tr;

ALTER TABLE users ADD COLUMN account_type text NOT NULL DEFAULT 'customer'
  CHECK (account_type IN ('customer','organiser','staff'));
UPDATE users SET account_type = 'staff' WHERE id IN (SELECT user_id FROM platform_roles);
UPDATE users SET account_type = 'organiser' WHERE account_type = 'customer' AND id IN (SELECT user_id FROM organiser_members);
CREATE INDEX users_type_idx ON users (account_type, created_at);

-- Small platform-wide values (the PHP edition's "meta" table).
CREATE TABLE platform_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The platform owner is the first administrator. Nobody else can change
-- their roles, suspend them or reset their password.
INSERT INTO platform_meta (key, value)
SELECT 'owner_user_id', u.id::text FROM users u JOIN platform_roles r ON r.user_id = u.id AND r.role = 'admin'
 ORDER BY u.created_at LIMIT 1;
