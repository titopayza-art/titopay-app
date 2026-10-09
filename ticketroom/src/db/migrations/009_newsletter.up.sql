-- 009: TicketRoom updates. People who subscribe on the website (double
-- opt-in: pending until they click the link in the confirmation email),
-- and a record of each update sent.
SET search_path TO tr;
CREATE TABLE newsletter_subscribers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','subscribed','unsubscribed')),
  source          text NOT NULL DEFAULT 'web',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz
);
CREATE UNIQUE INDEX newsletter_email_uq ON newsletter_subscribers (lower(email));
CREATE INDEX newsletter_status_idx ON newsletter_subscribers (status);
CREATE TABLE newsletter_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  body        text NOT NULL,
  recipients  integer NOT NULL,
  sent_by     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
