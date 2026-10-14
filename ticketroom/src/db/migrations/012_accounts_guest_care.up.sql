-- 012: one account per person (email key), guest checkout, confirmed emails
-- before sign-in, customer questions passed to organisers, and refunds a
-- lone finance person may approve.
SET search_path TO tr;

-- "Jane.Doe+tickets@gmail.com" and "janedoe@gmail.com" are the same inbox, so
-- they share this key: the part after a "+" is dropped for every domain, and
-- for Gmail the dots too. Same rules as email_key() in the PHP edition and
-- emailKey() in src/lib/accounts.js.
CREATE OR REPLACE FUNCTION tr.email_key(addr text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  e text := lower(btrim(coalesce(addr, '')));
  at int;
  loc text;
  dom text;
BEGIN
  IF strpos(e, '@') = 0 THEN RETURN e; END IF;
  at := length(e) - strpos(reverse(e), '@') + 1;
  loc := split_part(substr(e, 1, at - 1), '+', 1);
  dom := substr(e, at + 1);
  IF dom IN ('gmail.com', 'googlemail.com') THEN
    loc := replace(loc, '.', '');
    dom := 'gmail.com';
  END IF;
  RETURN loc || '@' || dom;
END $$;

ALTER TABLE users ADD COLUMN email_key text;
-- A guest bought without signing up: no usable password, tickets kept here
-- until the inbox's owner sets one.
ALTER TABLE users ADD COLUMN guest boolean NOT NULL DEFAULT false;
UPDATE users SET email_key = tr.email_key(email);

-- Every way an account is made (sign-up, guest checkout, staff invites,
-- seeds) gets its key without having to remember to set it.
CREATE OR REPLACE FUNCTION tr.users_email_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.email_key := tr.email_key(NEW.email);
  RETURN NEW;
END $$;
CREATE TRIGGER users_email_key_trg BEFORE INSERT OR UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION tr.users_email_key();
CREATE INDEX users_email_key_idx ON users (email_key);
CREATE INDEX users_phone_idx ON users (phone);

-- Customer questions passed to the organiser they belong to.
ALTER TABLE support_cases ADD COLUMN organiser_id uuid REFERENCES organisers(id);
ALTER TABLE support_cases ADD COLUMN event_id uuid REFERENCES events(id);
ALTER TABLE support_cases ADD COLUMN handled_by text NOT NULL DEFAULT 'ticketroom' CHECK (handled_by IN ('ticketroom','organiser'));
ALTER TABLE support_cases ADD COLUMN transferred_at timestamptz;
CREATE INDEX support_cases_organiser_idx ON support_cases (organiser_id);

CREATE TABLE support_messages (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES support_cases(id),
  author_id   uuid REFERENCES users(id),
  author_kind text NOT NULL CHECK (author_kind IN ('customer','ticketroom','organiser','system')),
  body        text NOT NULL,
  emailed     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_case_idx ON support_messages (case_id, id);

-- Refunds: whoever asked can't also approve, unless they are the only active
-- finance person. That rule needs the team's size, so it lives in code
-- (modules/finance/refunds.js) instead of a CHECK.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'tr.refunds'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%decided_by <> requested_by%'
  LOOP
    EXECUTE format('ALTER TABLE tr.refunds DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
