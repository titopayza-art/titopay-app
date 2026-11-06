-- 006: organiser commission, free events, external payment methods (TitoPay
-- wallet linkage), manual refund completion, and an outbound integration log.
SET search_path TO tr;

-- Organiser commission (TicketRoom's % of ticket sales). NULL = platform default.
ALTER TABLE organisers ADD COLUMN commission_bps int CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000);
ALTER TABLE orders ADD COLUMN organiser_fee_cents bigint NOT NULL DEFAULT 0 CHECK (organiser_fee_cents >= 0);
ALTER TABLE refunds ADD COLUMN organiser_fee_cents bigint NOT NULL DEFAULT 0 CHECK (organiser_fee_cents >= 0);

-- Free events: every ticket type must be R0 (enforced in code and by trigger).
ALTER TABLE events ADD COLUMN is_free boolean NOT NULL DEFAULT false;
CREATE FUNCTION assert_free_event_prices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_cents > 0 AND EXISTS (SELECT 1 FROM tr.events WHERE id = NEW.event_id AND is_free) THEN
    RAISE EXCEPTION 'ticket types of a free event must cost R0' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_types_free_event BEFORE INSERT OR UPDATE ON ticket_types
  FOR EACH ROW EXECUTE FUNCTION assert_free_event_prices();

-- How a payment was made: card via the payment gateway, or the TitoPay wallet.
ALTER TABLE payments ADD COLUMN method text NOT NULL DEFAULT 'card' CHECK (method IN ('card','titopay_wallet'));
ALTER TABLE payments ADD COLUMN checkout_context jsonb;

-- Refunds the provider cannot do by API wait for finance to complete them by hand.
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('requested','approved','rejected','processing','manual_pending','completed','failed'));
DROP INDEX refunds_one_open_wallet;
CREATE UNIQUE INDEX refunds_one_open_wallet ON refunds (user_id, event_id)
  WHERE kind = 'wallet_balance' AND status IN ('requested','approved','processing','manual_pending');

-- Linked external wallets. The partner token is encrypted at rest.
CREATE TABLE wallet_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL CHECK (provider IN ('titopay')),
  external_wallet_id text NOT NULL,
  token_enc       text NOT NULL,
  display_handle  text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);
CREATE UNIQUE INDEX wallet_links_one_active ON wallet_links (user_id, provider) WHERE status = 'active';

CREATE TABLE wallet_link_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL,
  external_request_id text NOT NULL,
  phone_masked    text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Outbound calls to payment, SMS and wallet APIs: metadata only, never bodies.
CREATE TABLE integration_calls (
  id          bigserial PRIMARY KEY,
  integration text NOT NULL,
  environment text NOT NULL,
  operation   text NOT NULL,
  http_status int,
  ok          boolean NOT NULL,
  duration_ms int NOT NULL,
  error       text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_calls_idx ON integration_calls (integration, occurred_at DESC);
