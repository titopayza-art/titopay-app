-- 002 ticketing: events, inventory, promo codes, orders, payments, tickets.
SET search_path TO tr;

CREATE TABLE uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  organiser_id uuid REFERENCES organisers(id),
  mime_type   text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes  int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id   uuid NOT NULL REFERENCES organisers(id),
  slug           text NOT NULL UNIQUE,
  title          text NOT NULL,
  summary        text,
  description    text,
  category       text NOT NULL DEFAULT 'other' CHECK (category IN ('music','festival','comedy','sport','arts','food','business','family','nightlife','other')),
  venue_name     text NOT NULL,
  address        text,
  city           text NOT NULL,
  province       text,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  doors_open_at  timestamptz,
  image_upload_id uuid REFERENCES uploads(id),
  capacity       int NOT NULL CHECK (capacity > 0),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','published','suspended','cancelled','completed')),
  sales_start_at timestamptz,
  sales_end_at   timestamptz,
  refund_policy  text NOT NULL DEFAULT 'Tickets are non-refundable unless the event is cancelled or materially changed.',
  accessibility_info text,
  age_restriction text,
  transfers_enabled boolean NOT NULL DEFAULT true,
  cashless_enabled  boolean NOT NULL DEFAULT false,
  featured       boolean NOT NULL DEFAULT false,
  status_reason  text,
  cancellation_requested_at timestamptz,
  cancellation_reason text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_status_start_idx ON events (status, starts_at);
CREATE INDEX events_org_idx ON events (organiser_id);

CREATE TABLE ticket_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id),
  name           text NOT NULL,
  description    text,
  price_cents    bigint NOT NULL CHECK (price_cents >= 0),
  quantity_total int NOT NULL CHECK (quantity_total >= 0),
  quantity_sold  int NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  quantity_held  int NOT NULL DEFAULT 0 CHECK (quantity_held >= 0),
  per_order_limit int NOT NULL DEFAULT 10 CHECK (per_order_limit BETWEEN 1 AND 50),
  sales_start_at timestamptz,
  sales_end_at   timestamptz,
  status         text NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale','paused','hidden')),
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The oversell guard: held + sold can never exceed what exists.
  CONSTRAINT ticket_types_no_oversell CHECK (quantity_sold + quantity_held <= quantity_total)
);
CREATE INDEX ticket_types_event_idx ON ticket_types (event_id);

CREATE TABLE promo_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id),
  code        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('percent','fixed')),
  value       bigint NOT NULL CHECK (value > 0),
  max_uses    int CHECK (max_uses IS NULL OR max_uses > 0),
  used_count  int NOT NULL DEFAULT 0,
  valid_from  timestamptz,
  valid_to    timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (max_uses IS NULL OR used_count <= max_uses)
);
CREATE UNIQUE INDEX promo_codes_event_code_uq ON promo_codes (event_id, upper(code));

-- Marketing attribution links (e.g. ?ref=IG-STORY).
CREATE TABLE tracking_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id),
  code        text NOT NULL,
  label       text NOT NULL,
  clicks      int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,
  event_id        uuid NOT NULL REFERENCES events(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL CHECK (status IN ('pending_payment','paid','expired','cancelled','failed','refunded','partially_refunded','paid_unfulfilled')),
  buyer_name      text NOT NULL,
  buyer_email     text NOT NULL,
  buyer_phone     text,
  subtotal_cents  bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  fee_cents       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  refunded_cents  bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  currency        text NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  promo_code_id   uuid REFERENCES promo_codes(id),
  tracking_link_id uuid REFERENCES tracking_links(id),
  idempotency_key text NOT NULL,
  expires_at      timestamptz NOT NULL,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (total_cents = subtotal_cents - discount_cents + fee_cents),
  CHECK (refunded_cents <= total_cents)
);
CREATE INDEX orders_event_status_idx ON orders (event_id, status);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending_payment';

CREATE TABLE order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id),
  ticket_type_id uuid NOT NULL REFERENCES ticket_types(id),
  quantity       int NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  unit_fee_cents bigint NOT NULL DEFAULT 0 CHECK (unit_fee_cents >= 0),
  UNIQUE (order_id, ticket_type_id)
);

-- One row per attempt to collect money through a provider.
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose            text NOT NULL CHECK (purpose IN ('order','topup')),
  order_id           uuid REFERENCES orders(id),
  topup_id           uuid,
  user_id            uuid NOT NULL REFERENCES users(id),
  provider           text NOT NULL,
  provider_reference text,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  refunded_cents     bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  currency           text NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  status             text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','refunded','partially_refunded')),
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  CHECK ((purpose = 'order' AND order_id IS NOT NULL) OR (purpose = 'topup' AND topup_id IS NOT NULL)),
  CHECK (refunded_cents <= amount_cents)
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  provider_event_id text NOT NULL,
  signature_valid  boolean NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed','rejected')),
  error            text,
  attempts         int NOT NULL DEFAULT 1,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Public random code printed on the ticket; never the database id.
  code           text NOT NULL UNIQUE,
  qr_version     int NOT NULL DEFAULT 1,
  order_id       uuid NOT NULL REFERENCES orders(id),
  order_item_id  uuid NOT NULL REFERENCES order_items(id),
  event_id       uuid NOT NULL REFERENCES events(id),
  ticket_type_id uuid NOT NULL REFERENCES ticket_types(id),
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  holder_name    text,
  price_cents    bigint NOT NULL,
  fee_cents      bigint NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','revoked','refunded')),
  admitted_at    timestamptz,
  admitted_by    uuid REFERENCES users(id),
  revoked_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'used' OR admitted_at IS NOT NULL)
);
CREATE INDEX tickets_owner_idx ON tickets (owner_user_id);
CREATE INDEX tickets_event_idx ON tickets (event_id, status);
CREATE INDEX tickets_order_idx ON tickets (order_id);

CREATE TABLE ticket_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES tickets(id),
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_email      text NOT NULL,
  to_user_id    uuid REFERENCES users(id),
  claim_token_hash text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz
);
-- Only one transfer in flight per ticket.
CREATE UNIQUE INDEX ticket_transfers_one_pending ON ticket_transfers (ticket_id) WHERE status = 'pending';

CREATE TABLE admission_log (
  id          bigserial PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES events(id),
  ticket_id   uuid REFERENCES tickets(id),
  scanned_by  uuid NOT NULL REFERENCES users(id),
  outcome     text NOT NULL CHECK (outcome IN ('admitted','already_used','invalid','wrong_event','revoked','refunded','event_not_live')),
  gate        text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admission_event_idx ON admission_log (event_id, occurred_at);
CREATE TRIGGER admission_log_append_only BEFORE UPDATE OR DELETE ON admission_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE event_staff (
  event_id   uuid NOT NULL REFERENCES events(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  can_scan   boolean NOT NULL DEFAULT true,
  can_manage_tags boolean NOT NULL DEFAULT false,
  added_by   uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
