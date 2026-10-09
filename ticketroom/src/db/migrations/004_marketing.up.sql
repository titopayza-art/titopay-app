-- 004: organiser marketing (email + SMS), consent and the message outbox.
SET search_path TO tr;

-- organiser_id NULL means consent for TicketRoom's own marketing.
CREATE TABLE marketing_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  organiser_id uuid REFERENCES organisers(id),
  channel      text NOT NULL CHECK (channel IN ('email','sms')),
  granted      boolean NOT NULL,
  source       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marketing_consents_uq ON marketing_consents
  (user_id, COALESCE(organiser_id, '00000000-0000-0000-0000-000000000000'::uuid), channel);

CREATE TABLE consent_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  organiser_id uuid REFERENCES organisers(id),
  channel      text NOT NULL,
  granted      boolean NOT NULL,
  source       text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER consent_log_append_only BEFORE UPDATE OR DELETE ON consent_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id   uuid NOT NULL REFERENCES organisers(id),
  channel        text NOT NULL CHECK (channel IN ('email','sms')),
  name           text NOT NULL,
  subject        text,
  body           text NOT NULL,
  audience       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed')),
  scheduled_at   timestamptz,
  sent_at        timestamptz,
  recipients_count int NOT NULL DEFAULT 0,
  delivered_count  int NOT NULL DEFAULT 0,
  failed_count     int NOT NULL DEFAULT 0,
  estimated_cost_cents bigint NOT NULL DEFAULT 0,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (channel <> 'email' OR subject IS NOT NULL)
);
CREATE INDEX campaigns_org_idx ON campaigns (organiser_id);

CREATE TABLE message_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text NOT NULL CHECK (channel IN ('email','sms')),
  kind                text NOT NULL CHECK (kind IN ('transactional','marketing')),
  to_address          text NOT NULL,
  subject             text,
  body                text NOT NULL,
  campaign_id         uuid REFERENCES campaigns(id),
  user_id             uuid REFERENCES users(id),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','suppressed')),
  provider            text,
  provider_message_id text,
  attempts            int NOT NULL DEFAULT 0,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX message_outbox_status_idx ON message_outbox (status, created_at);
-- A campaign can never message the same person twice.
CREATE UNIQUE INDEX message_outbox_campaign_user_uq ON message_outbox (campaign_id, user_id) WHERE campaign_id IS NOT NULL;
