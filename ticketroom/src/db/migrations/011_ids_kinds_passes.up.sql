-- 011: short event and organiser IDs (EV-7K3M9Q, ORG-4H8T2W), target age
-- groups, ticket kinds with people per ticket, and gate passes for crew,
-- artists, media, vendors and guests.
SET search_path TO tr;
ALTER TABLE organisers ADD COLUMN ref text;
ALTER TABLE events ADD COLUMN ref text;
-- Comma list of age group keys, e.g. "18_24,25_34", or "all".
ALTER TABLE events ADD COLUMN age_groups text;
ALTER TABLE ticket_types ADD COLUMN kind text NOT NULL DEFAULT 'general';
ALTER TABLE ticket_types ADD COLUMN admits int NOT NULL DEFAULT 1 CHECK (admits BETWEEN 1 AND 20);

-- Existing organisers and events get their ID now; new ones get it on create.
-- Same alphabet as ticket codes (no 0/O, 1/I).
DO $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  r record;
  next_ref text;
BEGIN
  FOR r IN SELECT id FROM organisers WHERE ref IS NULL LOOP
    LOOP
      next_ref := 'ORG-' || (SELECT string_agg(substr(alphabet, 1 + floor(random() * 30)::int, 1), '') FROM generate_series(1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM organisers WHERE organisers.ref = next_ref);
    END LOOP;
    UPDATE organisers SET ref = next_ref WHERE id = r.id;
  END LOOP;
  FOR r IN SELECT id FROM events WHERE ref IS NULL LOOP
    LOOP
      next_ref := 'EV-' || (SELECT string_agg(substr(alphabet, 1 + floor(random() * 30)::int, 1), '') FROM generate_series(1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM events WHERE events.ref = next_ref);
    END LOOP;
    UPDATE events SET ref = next_ref WHERE id = r.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX organisers_ref_uq ON organisers (ref);
CREATE UNIQUE INDEX events_ref_uq ON events (ref);

-- Gate passes: people an organiser lets in without a ticket. Each has its own
-- signed QR code (TP1.…) and a private link to show it on a phone (only the
-- link's hash is kept); re-entry passes scan in many times.
CREATE TABLE gate_passes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id),
  code             text NOT NULL UNIQUE,
  qr_version       int NOT NULL DEFAULT 1,
  holder_name      text NOT NULL,
  email            text,
  role             text NOT NULL,
  access_note      text,
  reentry          boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  link_token_hash  text NOT NULL UNIQUE,
  scans            int NOT NULL DEFAULT 0,
  first_scanned_at timestamptz,
  last_scanned_at  timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_passes_event_idx ON gate_passes (event_id, updated_at);
ALTER TABLE admission_log ADD COLUMN pass_id uuid REFERENCES gate_passes(id);
