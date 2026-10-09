-- TicketRoom (PHP edition) — SQLite schema.
-- Same tables and column names as the Node/PostgreSQL edition, minus the
-- payment, cashless, vendor and finance tables (switched off in this edition).
-- Conventions: ids are UUID text; timestamps are ISO-8601 UTC text
-- ("2026-10-09T12:00:00.000Z"), so text order = time order; booleans are 0/1;
-- JSON values are text.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  phone             TEXT,
  full_name         TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  email_verified_at TEXT,
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

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
  approved_by         TEXT REFERENCES users(id)
);

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
  updated_at     TEXT NOT NULL
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
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_status_idx ON events (status, starts_at);
CREATE INDEX events_organiser_idx ON events (organiser_id);

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
  kind       TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value      INTEGER NOT NULL CHECK (value > 0),
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX promo_codes_event_code_uq ON promo_codes (event_id, upper(code));

CREATE TABLE tracking_links (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  currency            TEXT NOT NULL DEFAULT 'ZAR',
  promo_code_id       TEXT REFERENCES promo_codes(id),
  tracking_link_id    TEXT REFERENCES tracking_links(id),
  idempotency_key     TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  paid_at             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_event_idx ON orders (event_id, status);
CREATE INDEX orders_user_idx ON orders (user_id);

CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  ticket_type_id   TEXT NOT NULL REFERENCES ticket_types(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  unit_fee_cents   INTEGER NOT NULL DEFAULT 0 CHECK (unit_fee_cents >= 0)
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
  CHECK (status <> 'used' OR admitted_at IS NOT NULL)
);
CREATE INDEX tickets_owner_idx ON tickets (owner_user_id);
CREATE INDEX tickets_event_idx ON tickets (event_id, status);
CREATE INDEX tickets_event_updated_idx ON tickets (event_id, updated_at);
CREATE INDEX tickets_order_idx ON tickets (order_id);

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
  occurred_at TEXT NOT NULL
);
CREATE INDEX admission_event_idx ON admission_log (event_id, occurred_at);
CREATE INDEX admission_scanner_idx ON admission_log (event_id, scanned_by);
CREATE TRIGGER admission_log_no_update BEFORE UPDATE ON admission_log BEGIN SELECT RAISE(ABORT, 'admission_log is append-only'); END;
CREATE TRIGGER admission_log_no_delete BEFORE DELETE ON admission_log BEGIN SELECT RAISE(ABORT, 'admission_log is append-only'); END;

CREATE TABLE event_staff (
  event_id        TEXT NOT NULL REFERENCES events(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  can_scan        INTEGER NOT NULL DEFAULT 1,
  can_manage_tags INTEGER NOT NULL DEFAULT 0,
  added_by        TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
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
  updated_at           TEXT NOT NULL
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
  sent_at             TEXT
);
CREATE INDEX message_outbox_status_idx ON message_outbox (status, created_at);
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
