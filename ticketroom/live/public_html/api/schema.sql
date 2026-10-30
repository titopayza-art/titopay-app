-- TicketRoom (PHP edition) — SQLite schema.
-- Same tables and column names as the Node/PostgreSQL edition where they
-- overlap. Payments, refunds, payouts, the ledger and cashless (wristbands,
-- event wallets, vendors and POS) are at the end.
-- Conventions: ids are UUID text; timestamps are ISO-8601 UTC text
-- ("2026-10-09T12:00:00.000Z"), so text order = time order; booleans are 0/1;
-- JSON values are text.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  phone             TEXT,
  phone_verified_at TEXT,
  full_name         TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  email_verified_at TEXT,
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  email_key         TEXT,
  guest             INTEGER NOT NULL DEFAULT 0,
  account_type      TEXT NOT NULL DEFAULT 'customer' CHECK (account_type IN ('customer','organiser','staff')),
  spending_pin_hash   TEXT,
  pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
  pin_locked_until    TEXT,
  email_otp_enabled   INTEGER NOT NULL DEFAULT 0 CHECK (email_otp_enabled IN (0,1))
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_type_idx ON users (account_type, created_at);
CREATE INDEX users_email_key_idx ON users (email_key);
CREATE INDEX users_phone_idx ON users (phone);

CREATE TABLE platform_roles (
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('admin','finance','support')),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- A short-lived, one-use email OTP used only to sign in to the staff portal.
CREATE TABLE staff_login_codes (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX staff_login_challenge_uq ON staff_login_codes (challenge_hash);

-- Optional second-step email code for customer and organiser sign-ins.
CREATE TABLE user_login_codes (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  portal         TEXT NOT NULL CHECK (portal IN ('site','customer','organiser')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX user_login_challenge_uq ON user_login_codes (challenge_hash);

CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE organisers (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  contact_email       TEXT NOT NULL,
  contact_phone       TEXT,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
  bank_name           TEXT,
  bank_account_holder TEXT,
  bank_account_enc    TEXT,
  bank_account_last4  TEXT,
  bank_branch_code    TEXT,
  payout_hold_days    INTEGER NOT NULL DEFAULT 3,
  commission_bps      INTEGER CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000),
  created_at          TEXT NOT NULL,
  approved_at         TEXT,
  approved_by         TEXT REFERENCES users(id),
  ref                 TEXT,
  logo_upload_id      TEXT,
  -- Upgrade 52: the built-in "TicketRoom Test" organiser of test events.
  is_test             INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX organisers_ref_uq ON organisers (ref);

CREATE TABLE organiser_members (
  organiser_id TEXT NOT NULL REFERENCES organisers(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL CHECK (role IN ('owner','manager','marketing','finance','viewer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (organiser_id, user_id)
);

-- Append-only, hash-chained (see lib/audit.php). Triggers refuse edits.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  actor_id     TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  organiser_id TEXT,
  ip           TEXT,
  details      TEXT NOT NULL DEFAULT '{}',
  prev_hash    TEXT NOT NULL,
  row_hash     TEXT NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE support_cases (
  id             TEXT PRIMARY KEY,
  reference      TEXT NOT NULL UNIQUE,
  user_id        TEXT REFERENCES users(id),
  email          TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('tickets','refund','tag','payment','account','organiser','advertising','callback','other')),
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to    TEXT REFERENCES users(id),
  resolution     TEXT,
  phone          TEXT,
  full_name      TEXT,
  preferred_time TEXT,
  source         TEXT NOT NULL DEFAULT 'web',
  due_at         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  organiser_id   TEXT REFERENCES organisers(id),
  event_id       TEXT REFERENCES events(id),
  handled_by     TEXT NOT NULL DEFAULT 'ticketroom',
  transferred_at TEXT
);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  organiser_id TEXT REFERENCES organisers(id),
  mime_type    TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  sha256       TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE events (
  id                        TEXT PRIMARY KEY,
  organiser_id              TEXT NOT NULL REFERENCES organisers(id),
  slug                      TEXT NOT NULL UNIQUE,
  title                     TEXT NOT NULL,
  summary                   TEXT,
  description               TEXT,
  category                  TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('music','festival','comedy','sport','arts','food','business','family','nightlife','other')),
  venue_name                TEXT NOT NULL,
  address                   TEXT,
  city                      TEXT NOT NULL,
  province                  TEXT,
  starts_at                 TEXT NOT NULL,
  ends_at                   TEXT NOT NULL,
  doors_open_at             TEXT,
  image_upload_id           TEXT REFERENCES uploads(id),
  capacity                  INTEGER NOT NULL CHECK (capacity > 0),
  status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','published','suspended','cancelled','completed')),
  sales_start_at            TEXT,
  sales_end_at              TEXT,
  presale_queue_enabled     INTEGER NOT NULL DEFAULT 0,
  park_ride_info            TEXT,
  park_ride_url             TEXT,
  refund_policy             TEXT NOT NULL DEFAULT 'Tickets are non-refundable unless the event is cancelled or materially changed.',
  accessibility_info        TEXT,
  age_restriction           TEXT,
  transfers_enabled         INTEGER NOT NULL DEFAULT 1,
  cashless_enabled          INTEGER NOT NULL DEFAULT 0,
  featured                  INTEGER NOT NULL DEFAULT 0,
  is_free                   INTEGER NOT NULL DEFAULT 0,
  status_reason             TEXT,
  cancellation_requested_at TEXT,
  cancellation_reason       TEXT,
  created_by                TEXT REFERENCES users(id),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  published_at              TEXT,
  ref                       TEXT,
  age_groups                TEXT,
  lineup                    TEXT,
  resale_enabled            INTEGER NOT NULL DEFAULT 1,
  service_fee_payer         TEXT NOT NULL DEFAULT 'customer' CHECK (service_fee_payer IN ('customer','organiser')),
  prohibited_items          TEXT,
  ticket_groups             TEXT,
  -- Upgrade 52: a test event (Admin portal, Test event). Never listed, left
  -- out of reports, and the only kind of event that can be deleted.
  is_test                   INTEGER NOT NULL DEFAULT 0,
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_test_idx ON events (is_test, ends_at);
CREATE TRIGGER events_delete_only_test BEFORE DELETE ON events WHEN COALESCE(OLD.is_test, 0) <> 1
  BEGIN SELECT RAISE(ABORT, 'only test events can be deleted'); END;

CREATE TABLE presale_queue_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  full_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','admitted','used','expired')),
  joined_at TEXT NOT NULL,
  admitted_until TEXT,
  order_id TEXT REFERENCES orders(id),
  UNIQUE(event_id, email_key)
);
CREATE INDEX presale_queue_fifo_idx ON presale_queue_entries (event_id, status, joined_at, id);
CREATE TABLE recently_viewed_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX recently_viewed_user_idx ON recently_viewed_events (user_id, viewed_at DESC);
CREATE UNIQUE INDEX events_ref_uq ON events (ref);
CREATE INDEX events_status_idx ON events (status, starts_at);
CREATE INDEX events_organiser_idx ON events (organiser_id);

CREATE TABLE event_change_requests (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id),
  organiser_id      TEXT NOT NULL REFERENCES organisers(id),
  requested_by      TEXT NOT NULL REFERENCES users(id),
  request_reason    TEXT NOT NULL,
  changes_json      TEXT NOT NULL,
  before_json       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  review_note       TEXT,
  review_checks_json TEXT,
  reviewed_by       TEXT REFERENCES users(id),
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX event_change_requests_pending_uq ON event_change_requests (event_id) WHERE status = 'pending';
CREATE INDEX event_change_requests_status_idx ON event_change_requests (status, created_at);
CREATE INDEX event_change_requests_organiser_idx ON event_change_requests (organiser_id, created_at);

CREATE TABLE ticket_types (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  name            TEXT NOT NULL,
  description     TEXT,
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  quantity_total  INTEGER NOT NULL CHECK (quantity_total >= 0),
  quantity_sold   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  quantity_held   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_held >= 0),
  per_order_limit INTEGER NOT NULL DEFAULT 10 CHECK (per_order_limit BETWEEN 1 AND 50),
  sales_start_at  TEXT,
  sales_end_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale','paused','hidden')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'general',
  admits          INTEGER NOT NULL DEFAULT 1 CHECK (admits BETWEEN 1 AND 20),
  group_name      TEXT,
  release_after   TEXT,
  CHECK (quantity_sold + quantity_held <= quantity_total)
);
CREATE INDEX ticket_types_event_idx ON ticket_types (event_id);
-- A free event only ever has R0 ticket types (mirrors the PostgreSQL trigger).
CREATE TRIGGER free_event_prices_ins BEFORE INSERT ON ticket_types
  WHEN NEW.price_cents > 0 AND (SELECT is_free FROM events WHERE id = NEW.event_id) = 1
  BEGIN SELECT RAISE(ABORT, 'ticket types of a free event must cost R0'); END;
CREATE TRIGGER free_event_prices_upd BEFORE UPDATE OF price_cents ON ticket_types
  WHEN NEW.price_cents > 0 AND (SELECT is_free FROM events WHERE id = NEW.event_id) = 1
  BEGIN SELECT RAISE(ABORT, 'ticket types of a free event must cost R0'); END;

CREATE TABLE promo_codes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  code       TEXT NOT NULL,
  code_type  TEXT NOT NULL DEFAULT 'promo' CHECK (code_type IN ('promo','voucher')),
  kind       TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value      INTEGER NOT NULL CHECK (value > 0),
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_email INTEGER CHECK (max_uses_per_email IS NULL OR max_uses_per_email > 0),
  minimum_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_subtotal_cents >= 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX promo_codes_event_code_uq ON promo_codes (event_id, upper(code));
CREATE INDEX promo_codes_event_active_idx ON promo_codes (event_id, active, valid_from, valid_to);

CREATE TABLE tracking_links (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  campaign_id TEXT
);
CREATE UNIQUE INDEX tracking_links_event_code_uq ON tracking_links (event_id, code);

CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  event_id            TEXT NOT NULL REFERENCES events(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL CHECK (status IN ('pending_payment','paid','expired','cancelled','failed','refunded','partially_refunded','paid_unfulfilled')),
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT NOT NULL,
  buyer_phone         TEXT,
  subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents      INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  fee_cents           INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),
  refunded_cents      INTEGER NOT NULL DEFAULT 0,
  organiser_fee_cents INTEGER NOT NULL DEFAULT 0,
  organiser_commission_fixed_cents INTEGER NOT NULL DEFAULT 0 CHECK (organiser_commission_fixed_cents >= 0),
  organiser_service_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (organiser_service_fee_cents >= 0),
  currency            TEXT NOT NULL DEFAULT 'ZAR',
  promo_code_id       TEXT REFERENCES promo_codes(id),
  tracking_link_id    TEXT REFERENCES tracking_links(id),
  retail_partner_id   TEXT REFERENCES retail_partners(id),
  retail_commission_share_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_commission_share_cents >= 0),
  retail_service_share_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_service_share_cents >= 0),
  idempotency_key     TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  paid_at             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  test                INTEGER NOT NULL DEFAULT 0,
  resale_listing_id   TEXT,
  -- 0 when booked at a checkout into an account that already existed: the
  -- order's private link then shows its status only, not the tickets.
  link_shows_tickets  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_event_idx ON orders (event_id, status);
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE INDEX orders_retail_partner_idx ON orders (retail_partner_id, created_at);

CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  ticket_type_id   TEXT NOT NULL REFERENCES ticket_types(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  unit_fee_cents   INTEGER NOT NULL DEFAULT 0 CHECK (unit_fee_cents >= 0),
  unit_organiser_service_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_organiser_service_fee_cents >= 0)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX orders_event_created_idx ON orders (event_id, created_at);

CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  qr_version     INTEGER NOT NULL DEFAULT 1,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  order_item_id  TEXT NOT NULL REFERENCES order_items(id),
  event_id       TEXT NOT NULL REFERENCES events(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  owner_user_id  TEXT NOT NULL REFERENCES users(id),
  holder_name    TEXT,
  price_cents    INTEGER NOT NULL,
  fee_cents      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','revoked','refunded')),
  admitted_at    TEXT,
  admitted_by    TEXT REFERENCES users(id),
  revoked_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  test           INTEGER NOT NULL DEFAULT 0,
  CHECK (status <> 'used' OR admitted_at IS NOT NULL)
);
CREATE INDEX tickets_owner_idx ON tickets (owner_user_id);
CREATE INDEX tickets_event_idx ON tickets (event_id, status);
CREATE INDEX tickets_event_updated_idx ON tickets (event_id, updated_at);
CREATE INDEX tickets_order_idx ON tickets (order_id);
-- Old codes of tickets and gate passes that were transferred or reissued.
-- They scan as "replaced" and are never handed out again (upgrade 48).
CREATE TABLE IF NOT EXISTS replaced_codes (
  code        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ticket','pass')),
  ref_id      TEXT NOT NULL,
  event_id    TEXT NOT NULL REFERENCES events(id),
  reason      TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replaced_codes_event_idx ON replaced_codes (event_id, replaced_at);
-- Apple Wallet and Google Wallet passes handed out, and the Apple devices
-- holding each one (upgrade 53). A transfer, resale, reissue or refund voids them.
CREATE TABLE IF NOT EXISTS wallet_passes (
  serial      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('apple','google')),
  ticket_id   TEXT NOT NULL,
  qr_version  INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','void')),
  fingerprint TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_passes_state_idx ON wallet_passes (state, expires_at);
CREATE INDEX IF NOT EXISTS wallet_passes_ticket_idx ON wallet_passes (ticket_id);
CREATE TABLE IF NOT EXISTS wallet_devices (
  device_id  TEXT NOT NULL,
  serial     TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, serial)
);
-- The days a multi-day or season pass was used: once a day (upgrade 48).
CREATE TABLE IF NOT EXISTS ticket_entry_days (
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  day         TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  admitted_by TEXT REFERENCES users(id),
  PRIMARY KEY (ticket_id, day)
);

-- Gate passes: crew, artists, media, vendors and guests that an organiser
-- lets in without a ticket. Each has its own signed QR code (TP1.…) and a
-- private link to show it on a phone; re-entry passes scan in many times.
CREATE TABLE gate_passes (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events(id),
  code             TEXT NOT NULL UNIQUE,
  qr_version       INTEGER NOT NULL DEFAULT 1,
  holder_name      TEXT NOT NULL,
  email            TEXT,
  role             TEXT NOT NULL,
  access_note      TEXT,
  reentry          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  link_token_hash  TEXT NOT NULL UNIQUE,
  scans            INTEGER NOT NULL DEFAULT 0,
  first_scanned_at TEXT,
  last_scanned_at  TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX gate_passes_event_idx ON gate_passes (event_id, updated_at);

CREATE TABLE ticket_transfers (
  id               TEXT PRIMARY KEY,
  ticket_id        TEXT NOT NULL REFERENCES tickets(id),
  from_user_id     TEXT NOT NULL REFERENCES users(id),
  to_email         TEXT NOT NULL,
  to_user_id       TEXT REFERENCES users(id),
  claim_token_hash TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','expired')),
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE UNIQUE INDEX ticket_transfers_one_pending ON ticket_transfers (ticket_id) WHERE status = 'pending';

CREATE TABLE admission_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(id),
  ticket_id   TEXT REFERENCES tickets(id),
  scanned_by  TEXT NOT NULL REFERENCES users(id),
  outcome     TEXT NOT NULL CHECK (outcome IN ('admitted','already_used','invalid','wrong_event','revoked','refunded','event_not_live')),
  gate        TEXT,
  occurred_at TEXT NOT NULL,
  pass_id     TEXT,
  -- What the gate was told (replaced, refund_pending, test_ticket...), where
  -- outcome keeps the broad class. Offline scans keep the scanner who made
  -- them and the phone's time; synced_by and synced_at say who sent them and
  -- when (upgrade 54).
  reason      TEXT,
  offline     INTEGER NOT NULL DEFAULT 0,
  synced_by   TEXT REFERENCES users(id),
  synced_at   TEXT
);
CREATE INDEX admission_event_idx ON admission_log (event_id, occurred_at);
CREATE INDEX admission_scanner_idx ON admission_log (event_id, scanned_by);
CREATE TRIGGER admission_log_no_update BEFORE UPDATE ON admission_log BEGIN SELECT RAISE(ABORT, 'admission_log is append-only'); END;
-- Scans stay append-only, except those of a test event, deleted with it (upgrade 52).
CREATE TRIGGER admission_log_no_delete BEFORE DELETE ON admission_log
  WHEN COALESCE((SELECT is_test FROM events WHERE id = OLD.event_id), 0) <> 1
   AND COALESCE((SELECT e.is_test FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = OLD.ticket_id), 0) <> 1
  BEGIN SELECT RAISE(ABORT, 'admission_log is append-only'); END;

CREATE TABLE event_staff (
  event_id        TEXT NOT NULL REFERENCES events(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  can_scan        INTEGER NOT NULL DEFAULT 1,
  can_manage_tags INTEGER NOT NULL DEFAULT 0,
  can_sell_tickets INTEGER NOT NULL DEFAULT 0,
  added_by        TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

-- Door sales are online-only. Manual tenders are tied to a server-created
-- order hold and an open cashier shift; no client-side/offline sale queue.
CREATE TABLE door_shifts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  retail_partner_id TEXT REFERENCES retail_partners(id),
  cashier_id TEXT NOT NULL REFERENCES users(id),
  opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  counted_cash_cents INTEGER CHECK (counted_cash_cents >= 0),
  counted_card_cents INTEGER CHECK (counted_card_cents >= 0),
  cash_variance_cents INTEGER,
  card_variance_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (id, event_id)
);
CREATE UNIQUE INDEX door_shifts_one_open_cashier ON door_shifts (event_id, cashier_id) WHERE status = 'open';
CREATE INDEX door_shifts_event_idx ON door_shifts (event_id, opened_at);
CREATE TABLE door_order_intents (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  retail_partner_id TEXT REFERENCES retail_partners(id),
  shift_id TEXT NOT NULL REFERENCES door_shifts(id),
  cashier_id TEXT NOT NULL REFERENCES users(id),
  tender_method TEXT NOT NULL CHECK (tender_method IN ('cash','external_card','yoco','snapscan','titopay')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_tender','confirmed','cancelled')),
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE door_tenders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  shift_id TEXT NOT NULL REFERENCES door_shifts(id),
  cashier_id TEXT NOT NULL REFERENCES users(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  method TEXT NOT NULL CHECK (method IN ('cash','external_card','yoco','snapscan','titopay')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  cash_received_cents INTEGER CHECK (cash_received_cents >= amount_cents),
  change_cents INTEGER NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  external_reference TEXT,
  receipt_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (shift_id, method, external_reference)
);
CREATE INDEX door_tenders_shift_idx ON door_tenders (shift_id, created_at);
CREATE INDEX IF NOT EXISTS door_tenders_event_idx ON door_tenders (event_id, cashier_id);

-- Retail distribution partners. Applications are reviewed before any selling
-- or retailer attribution is permitted. Partner cash/card sales use the same
-- reserved orders, payments, tickets and shift records as organiser door sales.
CREATE TABLE IF NOT EXISTS retail_partners (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  business_name TEXT NOT NULL,
  registration_number TEXT,
  contact_phone TEXT NOT NULL,
  store_address TEXT NOT NULL,
  sales_channels TEXT NOT NULL DEFAULT '[]',
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id),
  location_lat_e6 INTEGER CHECK (location_lat_e6 IS NULL OR location_lat_e6 BETWEEN -90000000 AND 90000000),
  location_lng_e6 INTEGER CHECK (location_lng_e6 IS NULL OR location_lng_e6 BETWEEN -180000000 AND 180000000)
);
CREATE INDEX IF NOT EXISTS retail_partners_status_idx ON retail_partners (status, created_at);
CREATE TABLE IF NOT EXISTS retail_partner_members (
  partner_id TEXT NOT NULL REFERENCES retail_partners(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','seller')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (partner_id,user_id)
);
CREATE TABLE IF NOT EXISTS retail_partner_payouts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES retail_partners(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  bank_reference TEXT NOT NULL,
  paid_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, bank_reference)
);

CREATE TABLE marketing_consents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  organiser_id TEXT REFERENCES organisers(id),
  channel      TEXT NOT NULL CHECK (channel IN ('email','sms')),
  granted      INTEGER NOT NULL,
  source       TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX marketing_consents_uq ON marketing_consents (user_id, COALESCE(organiser_id, ''), channel);

CREATE TABLE consent_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  organiser_id TEXT REFERENCES organisers(id),
  channel      TEXT NOT NULL,
  granted      INTEGER NOT NULL,
  source       TEXT NOT NULL,
  occurred_at  TEXT NOT NULL
);

CREATE TABLE campaigns (
  id                   TEXT PRIMARY KEY,
  organiser_id         TEXT NOT NULL REFERENCES organisers(id),
  channel              TEXT NOT NULL CHECK (channel IN ('email','sms')),
  name                 TEXT NOT NULL,
  subject              TEXT,
  body                 TEXT NOT NULL,
  audience             TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed')),
  scheduled_at         TEXT,
  sent_at              TEXT,
  recipients_count     INTEGER NOT NULL DEFAULT 0,
  delivered_count      INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  promotion_id         TEXT
);

CREATE TABLE message_outbox (
  id                  TEXT PRIMARY KEY,
  channel             TEXT NOT NULL CHECK (channel IN ('email','sms')),
  kind                TEXT NOT NULL CHECK (kind IN ('transactional','marketing')),
  to_address          TEXT NOT NULL,
  subject             TEXT,
  body                TEXT NOT NULL,
  campaign_id         TEXT REFERENCES campaigns(id),
  user_id             TEXT REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','suppressed')),
  provider            TEXT,
  provider_message_id TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  sent_at             TEXT,
  -- Upgrade 49: a lease while one worker sends it, and when to try again.
  claimed_until       TEXT,
  next_attempt_at     TEXT,
  -- Upgrade 52: set on messages about a test event, deleted with it.
  event_id            TEXT
);
CREATE INDEX message_outbox_event_idx ON message_outbox (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX message_outbox_status_idx ON message_outbox (status, created_at);
CREATE INDEX message_outbox_due_idx ON message_outbox (status, next_attempt_at);
CREATE UNIQUE INDEX message_outbox_campaign_user_uq ON message_outbox (campaign_id, user_id) WHERE campaign_id IS NOT NULL;

CREATE TABLE site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX support_cases_status_idx ON support_cases (status, due_at);
CREATE INDEX message_outbox_user_idx ON message_outbox (user_id);
CREATE INDEX ticket_transfers_to_idx ON ticket_transfers (to_email, status);

CREATE TABLE ad_posters (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  image_upload_id TEXT REFERENCES uploads(id),
  link_url        TEXT CHECK (link_url IS NULL OR link_url LIKE '/%' OR link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  placement       TEXT NOT NULL DEFAULT 'home' CHECK (placement IN ('home','events')),
  starts_at       TEXT,
  ends_at         TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  clicks          INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
);

CREATE TABLE job_posts (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  department      TEXT NOT NULL,
  location        TEXT NOT NULL,
  employment_type TEXT NOT NULL,
  summary         TEXT NOT NULL,
  description     TEXT NOT NULL,
  application_url TEXT,
  closes_at       TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX job_posts_public_idx ON job_posts (status, closes_at, created_at DESC);

CREATE TABLE kb_articles (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  keywords   TEXT NOT NULL DEFAULT '[]',
  link_url   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation TEXT NOT NULL,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('kb','ai','fallback')),
  article_id   TEXT REFERENCES kb_articles(id) ON DELETE SET NULL,
  helpful      INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at);

-- One row per automated message already sent (reminders, abandoned checkout).
CREATE TABLE notification_log (
  key        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Fixed-window rate limiting (shared by every PHP worker).
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Background job bookkeeping (jobs run after requests or from cron).
CREATE TABLE job_runs (
  name     TEXT PRIMARY KEY,
  last_run INTEGER NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- TicketRoom updates: people who subscribed from the website (double opt-in).
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','subscribed','unsubscribed')),
  source          TEXT NOT NULL DEFAULT 'web',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  confirmed_at    TEXT,
  unsubscribed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_email_uq ON newsletter_subscribers (lower(email));
CREATE INDEX IF NOT EXISTS newsletter_status_idx ON newsletter_subscribers (status);
CREATE TABLE IF NOT EXISTS newsletter_issues (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  recipients  INTEGER NOT NULL,
  sent_by     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- Events people like (saved to their account).
CREATE TABLE IF NOT EXISTS event_likes (
  user_id    TEXT NOT NULL REFERENCES users(id),
  event_id   TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS event_likes_event_idx ON event_likes (event_id);

-- Card payments, provider notifications, refunds, organiser payouts,
-- settings entered in the admin portal, and support conversations.
CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT REFERENCES orders(id),
  provider           TEXT NOT NULL,
  environment        TEXT NOT NULL,
  provider_reference TEXT,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  status             TEXT NOT NULL CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','refunded','partially_refunded')),
  refunded_cents     INTEGER NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  confirmed_at       TEXT,
  checkout_url      TEXT,
  provider_payment_id TEXT,
  purpose            TEXT NOT NULL DEFAULT 'order' CHECK (purpose IN ('order','topup')),
  topup_id           TEXT REFERENCES wallet_topups(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_uq ON payments (provider, provider_reference);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS payments_provider_payment_id_idx ON payments (provider, provider_payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active_order_uq ON payments(order_id) WHERE order_id IS NOT NULL AND status IN ('initiated','pending');
CREATE TABLE IF NOT EXISTS webhook_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed','rejected')),
  result       TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (provider, event_id)
);
CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,
  order_id           TEXT REFERENCES orders(id),
  payment_id         TEXT REFERENCES payments(id),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  fee_refund_cents   INTEGER NOT NULL DEFAULT 0 CHECK (fee_refund_cents >= 0),
  kind               TEXT NOT NULL CHECK (kind IN ('customer','event_cancelled','unfulfilled','goodwill','wallet_balance','pos_sale')),
  reason             TEXT NOT NULL,
  ticket_ids         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('requested','processing','manual_pending','completed','rejected','failed')),
  provider_reference TEXT,
  failure_reason     TEXT,
  note               TEXT,
  requested_by       TEXT REFERENCES users(id),
  decided_by         TEXT REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT,
  event_id           TEXT REFERENCES events(id),
  user_id            TEXT REFERENCES users(id),
  pos_sale_id        TEXT REFERENCES pos_sales(id),
  CHECK (amount_cents + fee_refund_cents > 0)
);
CREATE INDEX IF NOT EXISTS refunds_status_idx ON refunds (status, created_at);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id);
CREATE TABLE IF NOT EXISTS payouts (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  organiser_id        TEXT NOT NULL REFERENCES organisers(id),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  status              TEXT NOT NULL CHECK (status IN ('requested','approved','paid','rejected')),
  bank_name           TEXT,
  bank_account_holder TEXT,
  bank_account_last4  TEXT,
  bank_branch_code    TEXT,
  bank_reference      TEXT,
  note                TEXT,
  requested_by        TEXT REFERENCES users(id),
  approved_by         TEXT REFERENCES users(id),
  paid_by             TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  paid_at             TEXT,
  vendor_id           TEXT REFERENCES vendors(id)
);
CREATE INDEX IF NOT EXISTS payouts_org_idx ON payouts (organiser_id, status);
CREATE TABLE IF NOT EXISTS peach_payout_submissions (
  id                  TEXT PRIMARY KEY,
  payout_id           TEXT NOT NULL REFERENCES payouts(id),
  environment         TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  provider_payout_id  TEXT NOT NULL UNIQUE,
  payout_request_id   TEXT,
  status              TEXT NOT NULL CHECK (status IN ('submitting','pending','processing','successful','failed')),
  failure_reason      TEXT,
  provider_status     TEXT,
  provider_updated_at TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS peach_payout_submission_payout_idx ON peach_payout_submissions (payout_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS peach_payout_one_open_uq ON peach_payout_submissions (payout_id) WHERE status IN ('submitting','pending','processing');
CREATE TABLE IF NOT EXISTS peach_payout_reversals (
  id                  TEXT PRIMARY KEY,
  submission_id       TEXT NOT NULL UNIQUE REFERENCES peach_payout_submissions(id),
  payout_id           TEXT NOT NULL REFERENCES payouts(id),
  provider_payout_id  TEXT NOT NULL UNIQUE,
  provider_status     TEXT NOT NULL CHECK (provider_status IN ('cancelled','reversed')),
  provider_updated_at TEXT,
  ledger_reversed     INTEGER NOT NULL DEFAULT 0 CHECK (ledger_reversed IN (0,1)),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS peach_payout_reversal_payout_idx ON peach_payout_reversals (payout_id, created_at DESC);
CREATE TABLE IF NOT EXISTS integration_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    TEXT NOT NULL REFERENCES support_cases(id),
  author_id  TEXT REFERENCES users(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('customer','ticketroom','organiser','system')),
  body       TEXT NOT NULL,
  emailed    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_case_idx ON support_messages (case_id, id);
CREATE TABLE IF NOT EXISTS ledger_journals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,
  reference           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id          INTEGER NOT NULL REFERENCES ledger_journals(id),
  account             TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account);
CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx ON ledger_entries (journal_id);
CREATE TRIGGER IF NOT EXISTS ledger_journals_no_update BEFORE UPDATE ON ledger_journals BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_journals_no_delete BEFORE DELETE ON ledger_journals BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS recon_runs (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  summary             TEXT NOT NULL,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recon_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL REFERENCES recon_runs(id),
  provider_reference    TEXT NOT NULL,
  outcome               TEXT NOT NULL,
  provider_amount_cents INTEGER,
  internal_amount_cents INTEGER,
  provider_status       TEXT,
  internal_status       TEXT,
  resolved              INTEGER NOT NULL DEFAULT 0,
  resolution_note       TEXT,
  resolved_by           TEXT REFERENCES users(id),
  resolved_at           TEXT
);
CREATE INDEX IF NOT EXISTS recon_items_run_idx ON recon_items (run_id);

-- Promote: an organiser pays once (R1600 by default, admin-controlled) to promote one event until it
-- ends: unlimited email campaigns to opted-in buyers, SMS campaigns when SMS
-- is set up, posts on TicketRoom's socials and campaign analytics. Paid by
-- card (its own payment records, same providers and test mode as tickets) or
-- from the organiser's available balance.
CREATE TABLE IF NOT EXISTS event_promotions (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  event_id          TEXT NOT NULL REFERENCES events(id),
  organiser_id      TEXT NOT NULL REFERENCES organisers(id),
  status            TEXT NOT NULL CHECK (status IN ('pending_payment','active','ended','refunded','cancelled')),
  price_cents       INTEGER NOT NULL CHECK (price_cents > 0),
  paid_with         TEXT CHECK (paid_with IN ('card','balance')),
  test              INTEGER NOT NULL DEFAULT 0,
  social_status     TEXT CHECK (social_status IN ('requested','scheduled','posted')),
  social_request    TEXT,
  social_notes      TEXT,
  social_links      TEXT,
  social_updated_at TEXT,
  refund_status     TEXT CHECK (refund_status IN ('processing','manual_pending','completed','failed')),
  refund_reference  TEXT,
  refund_reason     TEXT,
  refund_provider_reference TEXT,
  refund_failure    TEXT,
  refunded_by       TEXT REFERENCES users(id),
  refunded_at       TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  paid_at           TEXT,
  ends_at           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_promotions_open_uq ON event_promotions (event_id) WHERE status IN ('pending_payment','active');
CREATE INDEX IF NOT EXISTS event_promotions_status_idx ON event_promotions (status, created_at);
CREATE INDEX IF NOT EXISTS event_promotions_org_idx ON event_promotions (organiser_id, created_at);
CREATE TABLE IF NOT EXISTS promotion_payments (
  id                 TEXT PRIMARY KEY,
  promotion_id       TEXT NOT NULL REFERENCES event_promotions(id),
  provider           TEXT NOT NULL,
  environment        TEXT NOT NULL,
  provider_reference TEXT,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  status             TEXT NOT NULL CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','refunded')),
  refunded_cents     INTEGER NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  confirmed_at       TEXT,
  provider_payment_id TEXT,
  checkout_url       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_payments_ref_uq ON promotion_payments (provider, provider_reference);
CREATE INDEX IF NOT EXISTS promotion_payments_promo_idx ON promotion_payments (promotion_id);
CREATE INDEX IF NOT EXISTS campaigns_promotion_idx ON campaigns (promotion_id);
CREATE INDEX IF NOT EXISTS tracking_links_campaign_idx ON tracking_links (campaign_id);
-- cashless:begin
-- Wristbands and tags, event wallets, vendors and POS. Upgrade 14 runs this
-- same block on older sites, so every statement here must be safe to repeat.
-- A tag stores only an HMAC of its chip UID or token, never the value itself.
-- Balances live on the attendee's account per event (never on the tag);
-- cashless_wallets holds them for fast, never-negative spending, and every
-- change is also booked to the ledger (wallet:<user>:<event>).
CREATE TABLE IF NOT EXISTS tag_batches (
  id           TEXT PRIMARY KEY,
  tag_type     TEXT NOT NULL CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  mode         TEXT NOT NULL CHECK (mode IN ('generate','import','desk')),
  event_id     TEXT REFERENCES events(id),
  organiser_id TEXT REFERENCES organisers(id),
  quantity     INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  notes        TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
  id                   TEXT PRIMARY KEY,
  tag_type             TEXT NOT NULL CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  token_hash           TEXT NOT NULL UNIQUE,
  display_code         TEXT NOT NULL UNIQUE,
  activation_code_hash TEXT,
  security_level       TEXT NOT NULL CHECK (security_level IN ('uid_only','random_token')),
  batch_id             TEXT REFERENCES tag_batches(id),
  event_id             TEXT REFERENCES events(id),
  user_id              TEXT REFERENCES users(id),
  ticket_id            TEXT REFERENCES tickets(id),
  status               TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','active','blocked','lost','revoked','replaced')),
  linked_at            TEXT,
  last_used_at         TEXT,
  status_reason        TEXT,
  replaced_by_tag_id   TEXT REFERENCES tags(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (status <> 'active' OR (user_id IS NOT NULL AND event_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_one_active_per_user_event ON tags (event_id, user_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS tags_one_active_per_ticket ON tags (ticket_id) WHERE status = 'active' AND ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tags_user_idx ON tags (user_id);
CREATE INDEX IF NOT EXISTS tags_event_idx ON tags (event_id, status);
CREATE TABLE IF NOT EXISTS tag_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id      TEXT NOT NULL REFERENCES tags(id),
  action      TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id),
  details     TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tag_events_tag_idx ON tag_events (tag_id, occurred_at);
CREATE TRIGGER IF NOT EXISTS tag_events_no_update BEFORE UPDATE ON tag_events BEGIN SELECT RAISE(ABORT, 'tag_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS tag_events_no_delete BEFORE DELETE ON tag_events BEGIN SELECT RAISE(ABORT, 'tag_events is append-only'); END;

CREATE TABLE IF NOT EXISTS cashless_wallets (
  user_id            TEXT NOT NULL REFERENCES users(id),
  event_id           TEXT NOT NULL REFERENCES events(id),
  balance_cents      INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  test_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (test_balance_cents >= 0),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS cashless_wallets_event_idx ON cashless_wallets (event_id);
CREATE TABLE IF NOT EXISTS wallet_topups (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  event_id        TEXT NOT NULL REFERENCES events(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','cancelled')),
  idempotency_key TEXT NOT NULL,
  test            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  confirmed_at    TEXT,
  paid_by         TEXT REFERENCES users(id),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS wallet_topups_wallet_idx ON wallet_topups (user_id, event_id, status);
CREATE INDEX IF NOT EXISTS wallet_topups_event_idx ON wallet_topups (event_id, status);

CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id),
  organiser_id   TEXT NOT NULL REFERENCES organisers(id),
  name           TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 5000),
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  category       TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT
);
CREATE INDEX IF NOT EXISTS vendors_event_idx ON vendors (event_id);
CREATE TABLE IF NOT EXISTS vendor_members (
  vendor_id  TEXT NOT NULL REFERENCES vendors(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('manager','cashier')),
  added_by   TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (vendor_id, user_id)
);
CREATE INDEX IF NOT EXISTS vendor_members_user_idx ON vendor_members (user_id);
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  vendor_id   TEXT NOT NULL REFERENCES vendors(id),
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_vendor_idx ON products (vendor_id, active);
-- A terminal key is shown once when the till is registered; only its hash is kept.
CREATE TABLE IF NOT EXISTS terminals (
  id            TEXT PRIMARY KEY,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  event_id      TEXT NOT NULL REFERENCES events(id),
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  registered_by TEXT NOT NULL REFERENCES users(id),
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminals_vendor_idx ON terminals (vendor_id);
CREATE TABLE IF NOT EXISTS pos_sales (
  id               TEXT PRIMARY KEY,
  reference        TEXT NOT NULL UNIQUE,
  event_id         TEXT NOT NULL REFERENCES events(id),
  vendor_id        TEXT NOT NULL REFERENCES vendors(id),
  terminal_id      TEXT NOT NULL REFERENCES terminals(id),
  cashier_id       TEXT NOT NULL REFERENCES users(id),
  tag_id           TEXT REFERENCES tags(id),
  user_id          TEXT REFERENCES users(id),
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  commission_cents INTEGER NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  status           TEXT NOT NULL CHECK (status IN ('confirmed','declined','reversed')),
  decline_reason   TEXT,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  test             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  reversed_at      TEXT,
  UNIQUE (terminal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS pos_sales_vendor_idx ON pos_sales (vendor_id, created_at);
CREATE INDEX IF NOT EXISTS pos_sales_user_idx ON pos_sales (user_id, event_id);
CREATE TABLE IF NOT EXISTS pos_sale_items (
  sale_id          TEXT NOT NULL REFERENCES pos_sales(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  name             TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (sale_id, product_id)
);
CREATE INDEX IF NOT EXISTS payments_topup_idx ON payments (topup_id);
CREATE INDEX IF NOT EXISTS refunds_event_idx ON refunds (event_id, status);
CREATE INDEX IF NOT EXISTS refunds_user_idx ON refunds (user_id);
-- One open (or completed) refund per POS sale.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_pos_sale ON refunds (pos_sale_id) WHERE kind = 'pos_sale' AND status IN ('requested','processing','completed');
CREATE INDEX IF NOT EXISTS payouts_vendor_idx ON payouts (vendor_id, status);
-- A till can offer a two-sided QR checkout. The QR contains only a random,
-- short-lived bearer token; the token hash and exact server-priced basket are
-- held here until the signed-in customer approves the debit on their phone.
CREATE TABLE IF NOT EXISTS pos_qr_intents (
  id               TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  event_id         TEXT NOT NULL REFERENCES events(id),
  vendor_id        TEXT NOT NULL REFERENCES vendors(id),
  terminal_id      TEXT NOT NULL REFERENCES terminals(id),
  cashier_id       TEXT NOT NULL REFERENCES users(id),
  items_json       TEXT NOT NULL,
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','expired')),
  payer_user_id    TEXT REFERENCES users(id),
  sale_id          TEXT UNIQUE REFERENCES pos_sales(id),
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_qr_intents_terminal_idx ON pos_qr_intents (terminal_id, status, expires_at);
CREATE INDEX IF NOT EXISTS pos_qr_intents_payer_idx ON pos_qr_intents (payer_user_id, event_id, created_at);
-- cashless:end

-- cashdesk:begin
-- Top-ups and cash-outs in person (upgrade 17 runs this same block, so every
-- statement here must be safe to repeat). Money taken at a desk is held by
-- the organiser (ledger organiser:<org>:event:<ev>:desk_cash / :desk_card)
-- and comes off what TicketRoom pays them; cash paid out at the cash-out
-- desk goes back on.
CREATE TABLE IF NOT EXISTS cashless_event_settings (
  event_id             TEXT PRIMARY KEY REFERENCES events(id),
  cashout_desk_open    INTEGER NOT NULL DEFAULT 0,
  desk_daily_cap_cents INTEGER CHECK (desk_daily_cap_cents IS NULL OR desk_daily_cap_cents > 0),
  updated_by           TEXT REFERENCES users(id),
  updated_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desk_topups (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  event_id        TEXT NOT NULL REFERENCES events(id),
  organiser_id    TEXT NOT NULL REFERENCES organisers(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  tag_id          TEXT REFERENCES tags(id),
  method          TEXT NOT NULL CHECK (method IN ('cash','card')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','undone','reversed')),
  staff_id        TEXT NOT NULL REFERENCES users(id),
  staff_kind      TEXT NOT NULL CHECK (staff_kind IN ('organiser','event_staff','ticketroom')),
  idempotency_key TEXT NOT NULL,
  test            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  undone_at       TEXT,
  undone_by       TEXT REFERENCES users(id),
  undo_reason     TEXT,
  UNIQUE (staff_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS desk_topups_event_idx ON desk_topups (event_id, staff_id, created_at);
CREATE INDEX IF NOT EXISTS desk_topups_user_idx ON desk_topups (user_id, event_id);
-- A guest's balance paid out by EFT (finance pays) or as cash at the venue's
-- cash-out desk (the guest shows a code). Card cash-outs are refunds.
CREATE TABLE IF NOT EXISTS wallet_cashouts (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  event_id            TEXT NOT NULL REFERENCES events(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  method              TEXT NOT NULL CHECK (method IN ('eft','cash')),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents           INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  test                INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (status IN ('requested','approved_once','approved','paid','rejected','cancelled')),
  bank_account_holder TEXT,
  bank_name           TEXT,
  bank_branch_code    TEXT,
  bank_account_enc    TEXT,
  bank_account_last4  TEXT,
  code_hash           TEXT UNIQUE,
  code_enc            TEXT,
  first_approved_by   TEXT REFERENCES users(id),
  approved_by         TEXT REFERENCES users(id),
  paid_by             TEXT REFERENCES users(id),
  bank_reference      TEXT,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  paid_at             TEXT
);
CREATE INDEX IF NOT EXISTS wallet_cashouts_status_idx ON wallet_cashouts (status, created_at);
CREATE INDEX IF NOT EXISTS wallet_cashouts_user_idx ON wallet_cashouts (user_id, event_id);
CREATE INDEX IF NOT EXISTS wallet_cashouts_paid_idx ON wallet_cashouts (event_id, paid_by);
-- cashdesk:end

-- exchange:begin
-- Waitlists for sold-out tickets and TicketRoom Exchange, the fair resale of
-- tickets at no more than the seller paid (upgrade 18 runs this same block,
-- so every statement here must be safe to repeat). Policy values are the
-- constants at the top of lib/exchange.php.
-- One row per person waiting for a ticket type. When a ticket comes free the
-- next person gets a private link (only its hash is kept) that holds it for them.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events(id),
  ticket_type_id   TEXT NOT NULL REFERENCES ticket_types(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','claimed','expired','left','closed')),
  offer_kind       TEXT CHECK (offer_kind IN ('primary','resale')),
  listing_id       TEXT,
  offer_token_hash TEXT UNIQUE,
  offered_at       TEXT,
  offer_expires_at TEXT,
  order_id         TEXT REFERENCES orders(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_one_open ON waitlist_entries (ticket_type_id, user_id) WHERE status IN ('waiting','offered');
CREATE INDEX IF NOT EXISTS waitlist_queue_idx ON waitlist_entries (ticket_type_id, status, created_at);
CREATE INDEX IF NOT EXISTS waitlist_user_idx ON waitlist_entries (user_id, status);
CREATE INDEX IF NOT EXISTS waitlist_offer_idx ON waitlist_entries (status, offer_expires_at);
-- A ticket put up for resale. When it sells, the seller's ticket is voided
-- and the buyer gets a new ticket with a new code.
CREATE TABLE IF NOT EXISTS resale_listings (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  ticket_id           TEXT NOT NULL REFERENCES tickets(id),
  event_id            TEXT NOT NULL REFERENCES events(id),
  ticket_type_id      TEXT NOT NULL REFERENCES ticket_types(id),
  seller_id           TEXT NOT NULL REFERENCES users(id),
  price_cents         INTEGER NOT NULL CHECK (price_cents > 0),
  face_value_cents    INTEGER NOT NULL CHECK (face_value_cents > 0),
  payout_method       TEXT NOT NULL CHECK (payout_method IN ('card','eft')),
  status              TEXT NOT NULL CHECK (status IN ('active','offered','held','sold','cancelled','closed')),
  test                INTEGER NOT NULL DEFAULT 0,
  held_order_id       TEXT REFERENCES orders(id),
  new_ticket_id       TEXT REFERENCES tickets(id),
  bank_account_holder TEXT,
  bank_name           TEXT,
  bank_branch_code    TEXT,
  bank_account_enc    TEXT,
  bank_account_last4  TEXT,
  close_reason        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  sold_at             TEXT,
  withdraw_requested_at TEXT,
  CHECK (price_cents <= face_value_cents)
);
CREATE UNIQUE INDEX IF NOT EXISTS resale_listings_one_open ON resale_listings (ticket_id) WHERE status IN ('active','offered','held');
CREATE INDEX IF NOT EXISTS resale_listings_event_idx ON resale_listings (event_id, ticket_type_id, status, created_at);
CREATE INDEX IF NOT EXISTS resale_listings_seller_idx ON resale_listings (seller_id, status);
-- What a seller is paid for a ticket that sold: back to the card they paid
-- with (a refund on their original payment) or by EFT, paid by finance.
CREATE TABLE IF NOT EXISTS resale_payouts (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  listing_id          TEXT NOT NULL REFERENCES resale_listings(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  event_id            TEXT NOT NULL REFERENCES events(id),
  method              TEXT NOT NULL CHECK (method IN ('card','eft')),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  test                INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (status IN ('processing','manual_pending','requested','approved','paid','failed')),
  payment_id          TEXT REFERENCES payments(id),
  provider            TEXT,
  provider_reference  TEXT,
  bank_account_holder TEXT,
  bank_name           TEXT,
  bank_branch_code    TEXT,
  bank_account_enc    TEXT,
  bank_account_last4  TEXT,
  bank_reference      TEXT,
  failure_reason      TEXT,
  approved_by         TEXT REFERENCES users(id),
  paid_by             TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  paid_at             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS resale_payouts_listing_uq ON resale_payouts (listing_id);
CREATE INDEX IF NOT EXISTS resale_payouts_status_idx ON resale_payouts (status, created_at);
CREATE INDEX IF NOT EXISTS orders_resale_idx ON orders (resale_listing_id);
CREATE INDEX IF NOT EXISTS wallet_topups_paid_by_idx ON wallet_topups (paid_by, event_id);
-- exchange:end

-- Organiser verification (FICA / KYC). Kept in its own tables: documents
-- live encrypted in the data folder's private/ folder, never in public_html.
-- (bootstrap.php's upgrade 12 runs everything from this comment down.)
CREATE TABLE IF NOT EXISTS organiser_verification (
  organiser_id        TEXT PRIMARY KEY REFERENCES organisers(id),
  entity_type         TEXT NOT NULL DEFAULT 'individual' CHECK (entity_type IN ('individual','company','npo')),
  nationality         TEXT NOT NULL DEFAULT 'sa' CHECK (nationality IN ('sa','foreign')),
  legal_name          TEXT,
  id_number_enc       TEXT,
  id_number_last4     TEXT,
  id_dob              TEXT,
  registration_number TEXT,
  rep_is_director     INTEGER NOT NULL DEFAULT 1,
  plans_paid          INTEGER NOT NULL DEFAULT 0,
  terms_version       TEXT,
  terms_signed_at     TEXT,
  terms_signed_by     TEXT REFERENCES users(id),
  terms_signed_name   TEXT,
  terms_ip            TEXT,
  risk_override       TEXT CHECK (risk_override IS NULL OR risk_override IN ('high','normal')),
  risk_note           TEXT,
  completed_at        TEXT,
  completed_scope     TEXT,
  closed_at           TEXT,
  updated_at          TEXT NOT NULL,
  company_name        TEXT,
  surname             TEXT,
  bank_account_type   TEXT
);
CREATE TABLE IF NOT EXISTS verification_documents (
  id                  TEXT PRIMARY KEY,
  organiser_id        TEXT NOT NULL REFERENCES organisers(id),
  event_id            TEXT REFERENCES events(id),
  requirement         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('submitted','approved','rejected','replaced')),
  file_name           TEXT NOT NULL,
  original_name       TEXT,
  mime_type           TEXT NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes          INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256              TEXT NOT NULL,
  uploaded_by         TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  reviewed_by         TEXT REFERENCES users(id),
  reviewed_at         TEXT,
  reject_reason       TEXT,
  replaced_at         TEXT,
  deleted_at          TEXT,
  provider            TEXT,
  provider_status     TEXT,
  provider_message    TEXT,
  provider_ref        TEXT,
  provider_checked_at TEXT
);
CREATE INDEX IF NOT EXISTS verification_documents_org_idx ON verification_documents (organiser_id, event_id, requirement);
CREATE INDEX IF NOT EXISTS verification_documents_status_idx ON verification_documents (status, created_at);
CREATE TABLE IF NOT EXISTS event_risk (
  event_id      TEXT PRIMARY KEY REFERENCES events(id),
  sells_alcohol INTEGER NOT NULL DEFAULT 0,
  public_space  INTEGER NOT NULL DEFAULT 0,
  third_party   INTEGER NOT NULL DEFAULT 0,
  risk_override TEXT CHECK (risk_override IS NULL OR risk_override IN ('high','normal')),
  updated_by    TEXT REFERENCES users(id),
  updated_at    TEXT NOT NULL
);

-- Phone numbers confirmed with a code sent by SMS (upgrade 16).
CREATE TABLE IF NOT EXISTS phone_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- VerifyNow electronic checks on organisers (upgrade 50, lib/verifynow.php).
-- POPIA consent: one row per organiser and consent text version.
CREATE TABLE IF NOT EXISTS kyc_consents (
  id           TEXT PRIMARY KEY,
  organiser_id TEXT NOT NULL REFERENCES organisers(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  text_version TEXT NOT NULL,
  text_sha256  TEXT NOT NULL,
  full_name    TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS kyc_consents_org_idx ON kyc_consents (organiser_id, text_version);
-- One row per check run. Never holds images or full ID or account numbers.
CREATE TABLE IF NOT EXISTS kyc_checks (
  id              TEXT PRIMARY KEY,
  organiser_id    TEXT NOT NULL REFERENCES organisers(id),
  check_type      TEXT NOT NULL CHECK (check_type IN ('said','aml_person','aml_company','cipc','bank','face')),
  status          TEXT NOT NULL CHECK (status IN ('queued','running','waiting','passed','review','failed','error','superseded')),
  mode            TEXT NOT NULL CHECK (mode IN ('sandbox','production')),
  subject_hash    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_ref    TEXT,
  job_id          TEXT,
  reasons         TEXT,
  response_json   TEXT,
  http_status     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  override        TEXT CHECK (override IS NULL OR override IN ('accepted','rejected')),
  decision_note   TEXT,
  decided_by      TEXT REFERENCES users(id),
  decided_at      TEXT,
  consent_id      TEXT REFERENCES kyc_consents(id),
  requested_by    TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS kyc_checks_org_idx ON kyc_checks (organiser_id, check_type, created_at);
CREATE INDEX IF NOT EXISTS kyc_checks_due_idx ON kyc_checks (status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS kyc_checks_job_uq ON kyc_checks (job_id) WHERE job_id IS NOT NULL;
