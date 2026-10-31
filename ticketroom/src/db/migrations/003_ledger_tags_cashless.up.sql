-- 003: double-entry ledger, tag registry, cashless (Mode A), vendor POS,
-- refunds, settlements and reconciliation.
SET search_path TO tr;

-- ---------------------------------------------------------------- ledger
CREATE TABLE ledger_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense')),
  owner_type text NOT NULL CHECK (owner_type IN ('platform','organiser','vendor','attendee','provider')),
  owner_id   text,
  event_id   uuid REFERENCES events(id),
  name       text NOT NULL,
  currency   text NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  reference       text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  memo            text,
  reverses_journal_id uuid REFERENCES journals(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journals_reference_idx ON journals (reference);

-- Positive = debit, negative = credit. Integer minor units (cents).
CREATE TABLE ledger_entries (
  id          bigserial PRIMARY KEY,
  journal_id  uuid NOT NULL REFERENCES journals(id),
  account_id  uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);

-- A journal must balance to zero and have at least two lines. Checked at
-- COMMIT so the lines of one journal can be inserted one by one.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint; n int; jid uuid;
BEGIN
  jid := NEW.journal_id;
  SELECT COALESCE(SUM(amount_cents),0), COUNT(*) INTO s, n FROM tr.ledger_entries WHERE journal_id = jid;
  IF n < 2 OR s <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced (lines=%, sum=%)', jid, n, s USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE FUNCTION assert_journal_has_entries() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint; n int;
BEGIN
  SELECT COALESCE(SUM(amount_cents),0), COUNT(*) INTO s, n FROM tr.ledger_entries WHERE journal_id = NEW.id;
  IF n < 2 OR s <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced (lines=%, sum=%)', NEW.id, n, s USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journals_have_entries AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_has_entries();

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- tags
CREATE TABLE tag_batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_type   text NOT NULL CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  event_id   uuid REFERENCES events(id),
  quantity   int NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  notes      text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_type            text NOT NULL CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  -- HMAC of the normalised chip UID / NDEF token / QR token. The raw value is
  -- never stored, so a database leak does not yield clonable tag values.
  token_hash          text NOT NULL UNIQUE,
  display_code        text NOT NULL UNIQUE,
  activation_code_hash text,
  security_level      text NOT NULL CHECK (security_level IN ('uid_only','random_token','crypto_auth')),
  batch_id            uuid REFERENCES tag_batches(id),
  event_id            uuid REFERENCES events(id),
  user_id             uuid REFERENCES users(id),
  ticket_id           uuid REFERENCES tickets(id),
  status              text NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','active','blocked','lost','revoked','expired','replaced')),
  linked_at           timestamptz,
  activated_at        timestamptz,
  last_used_at        timestamptz,
  status_reason       text,
  replaced_by_tag_id  uuid REFERENCES tags(id),
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR (user_id IS NOT NULL AND event_id IS NOT NULL))
);
-- One active tag per attendee per event.
CREATE UNIQUE INDEX tags_one_active_per_user_event ON tags (event_id, user_id) WHERE status = 'active';
CREATE UNIQUE INDEX tags_one_active_per_ticket ON tags (ticket_id) WHERE status = 'active' AND ticket_id IS NOT NULL;
CREATE INDEX tags_user_idx ON tags (user_id);

CREATE TABLE tag_events (
  id          bigserial PRIMARY KEY,
  tag_id      uuid NOT NULL REFERENCES tags(id),
  action      text NOT NULL,
  actor_id    uuid REFERENCES users(id),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tag_events_tag_idx ON tag_events (tag_id);
CREATE TRIGGER tag_events_append_only BEFORE UPDATE OR DELETE ON tag_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- cashless
CREATE TABLE wallet_topups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,
  user_id         uuid NOT NULL REFERENCES users(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','cancelled')),
  idempotency_key text NOT NULL,
  journal_id      uuid REFERENCES journals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  UNIQUE (user_id, idempotency_key)
);
ALTER TABLE payments ADD CONSTRAINT payments_topup_fk FOREIGN KEY (topup_id) REFERENCES wallet_topups(id);

CREATE TABLE vendors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id),
  organiser_id   uuid NOT NULL REFERENCES organisers(id),
  name           text NOT NULL,
  description    text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  commission_bps int NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 5000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_event_idx ON vendors (event_id);

CREATE TABLE vendor_members (
  vendor_id  uuid NOT NULL REFERENCES vendors(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('manager','cashier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, user_id)
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  name        text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terminals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  event_id      uuid NOT NULL REFERENCES events(id),
  label         text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  registered_by uuid NOT NULL REFERENCES users(id),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pos_sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,
  event_id        uuid NOT NULL REFERENCES events(id),
  vendor_id       uuid NOT NULL REFERENCES vendors(id),
  terminal_id     uuid NOT NULL REFERENCES terminals(id),
  cashier_id      uuid NOT NULL REFERENCES users(id),
  tag_id          uuid REFERENCES tags(id),
  user_id         uuid REFERENCES users(id),
  total_cents     bigint NOT NULL CHECK (total_cents > 0),
  commission_cents bigint NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  status          text NOT NULL CHECK (status IN ('confirmed','declined','reversed')),
  decline_reason  text,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  journal_id      uuid REFERENCES journals(id),
  reversal_journal_id uuid REFERENCES journals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  reversed_at     timestamptz,
  UNIQUE (terminal_id, idempotency_key),
  CHECK (status <> 'confirmed' OR journal_id IS NOT NULL)
);
CREATE INDEX pos_sales_vendor_idx ON pos_sales (vendor_id, created_at);
CREATE INDEX pos_sales_user_idx ON pos_sales (user_id);

CREATE TABLE pos_sale_items (
  sale_id     uuid NOT NULL REFERENCES pos_sales(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  name        text NOT NULL,
  unit_price_cents bigint NOT NULL,
  quantity    int NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (sale_id, product_id)
);

-- ---------------------------------------------------------------- refunds
CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('order','pos_sale','wallet_balance')),
  order_id         uuid REFERENCES orders(id),
  pos_sale_id      uuid REFERENCES pos_sales(id),
  event_id         uuid NOT NULL REFERENCES events(id),
  user_id          uuid REFERENCES users(id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  fee_refund_cents bigint NOT NULL DEFAULT 0 CHECK (fee_refund_cents >= 0),
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','processing','completed','failed')),
  -- NULL = raised by the system (e.g. a payment that arrived after its order expired).
  requested_by     uuid REFERENCES users(id),
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  decision_note    text,
  provider_refund_reference text,
  failure_reason   text,
  journal_id       uuid REFERENCES journals(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Maker-checker: nobody approves their own request.
  CHECK (decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX refunds_status_idx ON refunds (status);
-- At most one open refund per POS sale / order-ticket set is enforced in code;
-- one open wallet refund per user/event is enforced here.
CREATE UNIQUE INDEX refunds_one_open_wallet ON refunds (user_id, event_id)
  WHERE kind = 'wallet_balance' AND status IN ('requested','approved','processing');
CREATE UNIQUE INDEX refunds_one_open_pos ON refunds (pos_sale_id)
  WHERE kind = 'pos_sale' AND status IN ('requested','approved','processing','completed');

CREATE TABLE refund_tickets (
  refund_id uuid NOT NULL REFERENCES refunds(id),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  PRIMARY KEY (refund_id, ticket_id)
);

-- ---------------------------------------------------------------- settlements
CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,
  beneficiary_type text NOT NULL CHECK (beneficiary_type IN ('organiser','vendor')),
  organiser_id    uuid NOT NULL REFERENCES organisers(id),
  vendor_id       uuid REFERENCES vendors(id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','paid','failed')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  paid_by         uuid REFERENCES users(id),
  paid_at         timestamptz,
  bank_reference  text,
  journal_id      uuid REFERENCES journals(id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status <> 'paid' OR (journal_id IS NOT NULL AND bank_reference IS NOT NULL))
);
-- One payout in flight per beneficiary.
CREATE UNIQUE INDEX payouts_one_open ON payouts (organiser_id, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('requested','approved');

-- ---------------------------------------------------------------- reconciliation
CREATE TABLE reconciliation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  source       text NOT NULL,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_items (
  id                 bigserial PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES reconciliation_runs(id),
  provider_reference text,
  payment_id         uuid REFERENCES payments(id),
  provider_amount_cents bigint,
  internal_amount_cents bigint,
  provider_status    text,
  internal_status    text,
  outcome            text NOT NULL CHECK (outcome IN ('matched','missing_internal','missing_provider','amount_mismatch','status_mismatch')),
  resolved           boolean NOT NULL DEFAULT false,
  resolved_by        uuid REFERENCES users(id),
  resolution_note    text
);
CREATE INDEX reconciliation_items_run_idx ON reconciliation_items (run_id, outcome);
