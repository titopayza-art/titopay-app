-- TicketRoom schema for MySQL 8 / MariaDB 10.6 and later.
-- Generated from schema.sql by ticketroom/scripts/mysql-schema.php. Do not edit by hand.
-- Statements are separated by lines holding only ;;

;;
CREATE TABLE users (
  id VARCHAR(255) NOT NULL,
  email MEDIUMTEXT NOT NULL,
  phone VARCHAR(255),
  phone_verified_at MEDIUMTEXT,
  full_name MEDIUMTEXT NOT NULL,
  password_hash MEDIUMTEXT NOT NULL,
  status MEDIUMTEXT NOT NULL DEFAULT ('active'),
  email_verified_at MEDIUMTEXT,
  failed_logins BIGINT NOT NULL DEFAULT 0,
  locked_until MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  deleted_at MEDIUMTEXT,
  email_key VARCHAR(255),
  guest BIGINT NOT NULL DEFAULT 0,
  account_type VARCHAR(255) NOT NULL DEFAULT 'customer',
  spending_pin_hash MEDIUMTEXT,
  pin_failed_attempts BIGINT NOT NULL DEFAULT 0,
  pin_locked_until MEDIUMTEXT,
  email_otp_enabled BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  g_users_email_uq_0 VARCHAR(255) GENERATED ALWAYS AS (lower(email)) STORED INVISIBLE,
  CHECK (status IN ('active','suspended','deleted')),
  CHECK (account_type IN ('customer','organiser','staff')),
  CHECK (email_otp_enabled IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX users_email_uq ON users (g_users_email_uq_0)
;;
CREATE INDEX users_type_idx ON users (account_type, created_at)
;;
CREATE INDEX users_email_key_idx ON users (email_key)
;;
CREATE INDEX users_phone_idx ON users (phone)
;;
CREATE TABLE platform_roles (
  user_id VARCHAR(255) NOT NULL,
  role VARCHAR(255) NOT NULL,
  granted_by VARCHAR(255),
  granted_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (granted_by) REFERENCES users (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  CHECK (role IN ('admin','finance','support'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE sessions (
  id VARCHAR(255) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  csrf_token MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  expires_at MEDIUMTEXT NOT NULL,
  revoked_at MEDIUMTEXT,
  user_agent MEDIUMTEXT,
  ip MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_10 (token_hash),
  FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX sessions_user_idx ON sessions (user_id)
;;
CREATE TABLE staff_login_codes (
  user_id VARCHAR(255) NOT NULL,
  challenge_hash VARCHAR(255) NOT NULL,
  code_hash MEDIUMTEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  expires_at MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX staff_login_challenge_uq ON staff_login_codes (challenge_hash)
;;
CREATE TABLE user_login_codes (
  user_id VARCHAR(255) NOT NULL,
  challenge_hash VARCHAR(255) NOT NULL,
  code_hash MEDIUMTEXT NOT NULL,
  portal MEDIUMTEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  expires_at MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CHECK (portal IN ('site','customer','organiser'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX user_login_challenge_uq ON user_login_codes (challenge_hash)
;;
CREATE TABLE password_resets (
  token_hash VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  expires_at MEDIUMTEXT NOT NULL,
  used_at MEDIUMTEXT,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (token_hash),
  FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE organisers (
  id VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  slug VARCHAR(255) NOT NULL,
  contact_email MEDIUMTEXT NOT NULL,
  contact_phone MEDIUMTEXT,
  description MEDIUMTEXT,
  status MEDIUMTEXT NOT NULL DEFAULT ('pending'),
  bank_name MEDIUMTEXT,
  bank_account_holder MEDIUMTEXT,
  bank_account_enc MEDIUMTEXT,
  bank_account_last4 MEDIUMTEXT,
  bank_branch_code MEDIUMTEXT,
  payout_hold_days BIGINT NOT NULL DEFAULT 3,
  commission_bps BIGINT,
  created_at MEDIUMTEXT NOT NULL,
  approved_at MEDIUMTEXT,
  approved_by VARCHAR(255),
  ref VARCHAR(255),
  logo_upload_id MEDIUMTEXT,
  is_test BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organisers_21 (slug),
  FOREIGN KEY (approved_by) REFERENCES users (id),
  CHECK (status IN ('pending','approved','suspended','rejected')),
  CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX organisers_ref_uq ON organisers (ref)
;;
CREATE TABLE organiser_members (
  organiser_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  role MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (organiser_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (role IN ('owner','manager','marketing','finance','viewer'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  occurred_at MEDIUMTEXT NOT NULL,
  actor_id MEDIUMTEXT,
  actor_role MEDIUMTEXT,
  action MEDIUMTEXT NOT NULL,
  entity_type MEDIUMTEXT,
  entity_id MEDIUMTEXT,
  organiser_id MEDIUMTEXT,
  ip MEDIUMTEXT,
  details MEDIUMTEXT NOT NULL DEFAULT ('{}'),
  prev_hash MEDIUMTEXT NOT NULL,
  row_hash MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE support_cases (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  email MEDIUMTEXT NOT NULL,
  category MEDIUMTEXT NOT NULL,
  subject MEDIUMTEXT NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'open',
  assigned_to VARCHAR(255),
  resolution MEDIUMTEXT,
  phone MEDIUMTEXT,
  full_name MEDIUMTEXT,
  preferred_time MEDIUMTEXT,
  source MEDIUMTEXT NOT NULL DEFAULT ('web'),
  due_at VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  organiser_id VARCHAR(255),
  event_id VARCHAR(255),
  handled_by MEDIUMTEXT NOT NULL DEFAULT ('ticketroom'),
  transferred_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_support_cases_22 (reference),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (assigned_to) REFERENCES users (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  CHECK (category IN ('tickets','refund','tag','payment','account','organiser','advertising','callback','other')),
  CHECK (status IN ('open','in_progress','resolved','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX support_cases_status_idx ON support_cases (status, due_at)
;;
CREATE TABLE uploads (
  id VARCHAR(255) NOT NULL,
  owner_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255),
  mime_type MEDIUMTEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 MEDIUMTEXT,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (owner_id) REFERENCES users (id),
  CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  CHECK (size_bytes > 0 AND size_bytes <= 2097152)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE events (
  id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  title MEDIUMTEXT NOT NULL,
  summary MEDIUMTEXT,
  description MEDIUMTEXT,
  category MEDIUMTEXT NOT NULL DEFAULT ('other'),
  venue_name MEDIUMTEXT NOT NULL,
  address MEDIUMTEXT,
  city MEDIUMTEXT NOT NULL,
  province MEDIUMTEXT,
  starts_at VARCHAR(255) NOT NULL,
  ends_at VARCHAR(255) NOT NULL,
  doors_open_at MEDIUMTEXT,
  image_upload_id VARCHAR(255),
  capacity BIGINT NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'draft',
  sales_start_at MEDIUMTEXT,
  sales_end_at MEDIUMTEXT,
  presale_queue_enabled BIGINT NOT NULL DEFAULT 0,
  park_ride_info MEDIUMTEXT,
  park_ride_url MEDIUMTEXT,
  refund_policy MEDIUMTEXT NOT NULL DEFAULT ('Tickets are non-refundable unless the event is cancelled or materially changed.'),
  accessibility_info MEDIUMTEXT,
  age_restriction MEDIUMTEXT,
  transfers_enabled BIGINT NOT NULL DEFAULT 1,
  cashless_enabled BIGINT NOT NULL DEFAULT 0,
  featured BIGINT NOT NULL DEFAULT 0,
  is_free BIGINT NOT NULL DEFAULT 0,
  status_reason MEDIUMTEXT,
  cancellation_requested_at MEDIUMTEXT,
  cancellation_reason MEDIUMTEXT,
  created_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  published_at MEDIUMTEXT,
  ref VARCHAR(255),
  age_groups MEDIUMTEXT,
  lineup MEDIUMTEXT,
  resale_enabled BIGINT NOT NULL DEFAULT 1,
  service_fee_payer MEDIUMTEXT NOT NULL DEFAULT ('customer'),
  prohibited_items MEDIUMTEXT,
  ticket_groups MEDIUMTEXT,
  is_test BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_events_45 (slug),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (image_upload_id) REFERENCES uploads (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (category IN ('music','festival','comedy','sport','arts','food','business','family','nightlife','other')),
  CHECK (capacity > 0),
  CHECK (status IN ('draft','pending_approval','published','suspended','cancelled','completed')),
  CHECK (service_fee_payer IN ('customer','organiser')),
  CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX events_test_idx ON events (is_test, ends_at)
;;
CREATE UNIQUE INDEX events_ref_uq ON events (ref)
;;
CREATE INDEX events_status_idx ON events (status, starts_at)
;;
CREATE INDEX events_organiser_idx ON events (organiser_id)
;;
CREATE TABLE presale_queue_entries (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  email MEDIUMTEXT NOT NULL,
  email_key VARCHAR(255) NOT NULL,
  full_name MEDIUMTEXT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'waiting',
  joined_at VARCHAR(255) NOT NULL,
  admitted_until MEDIUMTEXT,
  order_id VARCHAR(255),
  PRIMARY KEY (id),
  UNIQUE KEY uq_presale_queue_entries_11 (event_id, email_key),
  UNIQUE KEY uq_presale_queue_entries_12 (token_hash),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('waiting','admitted','used','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX presale_queue_fifo_idx ON presale_queue_entries (event_id, status, joined_at, id)
;;
CREATE TABLE recently_viewed_events (
  user_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  viewed_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX recently_viewed_user_idx ON recently_viewed_events (user_id, viewed_at DESC)
;;
CREATE TABLE event_change_requests (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  requested_by VARCHAR(255) NOT NULL,
  request_reason MEDIUMTEXT NOT NULL,
  changes_json MEDIUMTEXT NOT NULL,
  before_json MEDIUMTEXT NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'pending',
  review_note MEDIUMTEXT,
  review_checks_json MEDIUMTEXT,
  reviewed_by VARCHAR(255),
  reviewed_at MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  g_event_change_requests_pending_uq_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN event_id END) STORED INVISIBLE,
  FOREIGN KEY (reviewed_by) REFERENCES users (id),
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('pending','approved','rejected','withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX event_change_requests_pending_uq ON event_change_requests (g_event_change_requests_pending_uq_0)
;;
CREATE INDEX event_change_requests_status_idx ON event_change_requests (status, created_at)
;;
CREATE INDEX event_change_requests_organiser_idx ON event_change_requests (organiser_id, created_at)
;;
CREATE TABLE ticket_types (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  description MEDIUMTEXT,
  price_cents BIGINT NOT NULL,
  quantity_total BIGINT NOT NULL,
  quantity_sold BIGINT NOT NULL DEFAULT 0,
  quantity_held BIGINT NOT NULL DEFAULT 0,
  per_order_limit BIGINT NOT NULL DEFAULT 10,
  sales_start_at MEDIUMTEXT,
  sales_end_at MEDIUMTEXT,
  status MEDIUMTEXT NOT NULL DEFAULT ('on_sale'),
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  kind MEDIUMTEXT NOT NULL DEFAULT ('general'),
  admits BIGINT NOT NULL DEFAULT 1,
  group_name MEDIUMTEXT,
  release_after MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (price_cents >= 0),
  CHECK (quantity_total >= 0),
  CHECK (quantity_sold >= 0),
  CHECK (quantity_held >= 0),
  CHECK (per_order_limit BETWEEN 1 AND 50),
  CHECK (status IN ('on_sale','paused','hidden')),
  CHECK (admits BETWEEN 1 AND 20),
  CHECK (quantity_sold + quantity_held <= quantity_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX ticket_types_event_idx ON ticket_types (event_id)
;;
CREATE TABLE promo_codes (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  code MEDIUMTEXT NOT NULL,
  code_type MEDIUMTEXT NOT NULL DEFAULT ('promo'),
  kind MEDIUMTEXT NOT NULL,
  value BIGINT NOT NULL,
  max_uses BIGINT,
  max_uses_per_email BIGINT,
  minimum_subtotal_cents BIGINT NOT NULL DEFAULT 0,
  used_count BIGINT NOT NULL DEFAULT 0,
  valid_from VARCHAR(255),
  valid_to VARCHAR(255),
  active BIGINT NOT NULL DEFAULT 1,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  g_promo_codes_event_code_uq_1 VARCHAR(255) GENERATED ALWAYS AS (upper(code)) STORED INVISIBLE,
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (code_type IN ('promo','voucher')),
  CHECK (kind IN ('percent','fixed')),
  CHECK (value > 0),
  CHECK (max_uses IS NULL OR max_uses > 0),
  CHECK (max_uses_per_email IS NULL OR max_uses_per_email > 0),
  CHECK (minimum_subtotal_cents >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX promo_codes_event_code_uq ON promo_codes (event_id, g_promo_codes_event_code_uq_1)
;;
CREATE INDEX promo_codes_event_active_idx ON promo_codes (event_id, active, valid_from, valid_to)
;;
CREATE TABLE tracking_links (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  code VARCHAR(255) NOT NULL,
  label MEDIUMTEXT NOT NULL,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  campaign_id VARCHAR(255),
  PRIMARY KEY (id),
  FOREIGN KEY (event_id) REFERENCES events (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX tracking_links_event_code_uq ON tracking_links (event_id, code)
;;
CREATE INDEX tracking_links_campaign_idx ON tracking_links (campaign_id)
;;
CREATE TABLE orders (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL,
  buyer_name MEDIUMTEXT NOT NULL,
  buyer_email MEDIUMTEXT NOT NULL,
  buyer_phone MEDIUMTEXT,
  subtotal_cents BIGINT NOT NULL,
  discount_cents BIGINT NOT NULL DEFAULT 0,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  organiser_fee_cents BIGINT NOT NULL DEFAULT 0,
  organiser_commission_fixed_cents BIGINT NOT NULL DEFAULT 0,
  organiser_service_fee_cents BIGINT NOT NULL DEFAULT 0,
  currency MEDIUMTEXT NOT NULL DEFAULT ('ZAR'),
  promo_code_id VARCHAR(255),
  tracking_link_id VARCHAR(255),
  retail_partner_id VARCHAR(255),
  retail_commission_share_cents BIGINT NOT NULL DEFAULT 0,
  retail_service_share_cents BIGINT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(255) NOT NULL,
  expires_at MEDIUMTEXT NOT NULL,
  paid_at MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  resale_listing_id VARCHAR(255),
  link_shows_tickets BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_31 (user_id, idempotency_key),
  UNIQUE KEY uq_orders_32 (reference),
  FOREIGN KEY (retail_partner_id) REFERENCES retail_partners (id),
  FOREIGN KEY (tracking_link_id) REFERENCES tracking_links (id),
  FOREIGN KEY (promo_code_id) REFERENCES promo_codes (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('pending_payment','paid','expired','cancelled','failed','refunded','partially_refunded','paid_unfulfilled')),
  CHECK (subtotal_cents >= 0),
  CHECK (discount_cents >= 0),
  CHECK (fee_cents >= 0),
  CHECK (total_cents >= 0),
  CHECK (organiser_commission_fixed_cents >= 0),
  CHECK (organiser_service_fee_cents >= 0),
  CHECK (retail_commission_share_cents >= 0),
  CHECK (retail_service_share_cents >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX orders_event_idx ON orders (event_id, status)
;;
CREATE INDEX orders_user_idx ON orders (user_id)
;;
CREATE INDEX orders_retail_partner_idx ON orders (retail_partner_id, created_at)
;;
CREATE INDEX orders_event_created_idx ON orders (event_id, created_at)
;;
CREATE INDEX orders_resale_idx ON orders (resale_listing_id)
;;
CREATE TABLE order_items (
  id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  ticket_type_id VARCHAR(255) NOT NULL,
  quantity BIGINT NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  unit_fee_cents BIGINT NOT NULL DEFAULT 0,
  unit_organiser_service_fee_cents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  FOREIGN KEY (ticket_type_id) REFERENCES ticket_types (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (quantity > 0),
  CHECK (unit_price_cents >= 0),
  CHECK (unit_fee_cents >= 0),
  CHECK (unit_organiser_service_fee_cents >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX order_items_order_idx ON order_items (order_id)
;;
CREATE TABLE tickets (
  id VARCHAR(255) NOT NULL,
  code VARCHAR(255) NOT NULL,
  qr_version BIGINT NOT NULL DEFAULT 1,
  order_id VARCHAR(255) NOT NULL,
  order_item_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  ticket_type_id VARCHAR(255) NOT NULL,
  owner_user_id VARCHAR(255) NOT NULL,
  holder_name MEDIUMTEXT,
  price_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL DEFAULT 'valid',
  admitted_at MEDIUMTEXT,
  admitted_by VARCHAR(255),
  revoked_reason MEDIUMTEXT,
  created_at MEDIUMTEXT NOT NULL,
  updated_at VARCHAR(255) NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tickets_19 (code),
  FOREIGN KEY (admitted_by) REFERENCES users (id),
  FOREIGN KEY (owner_user_id) REFERENCES users (id),
  FOREIGN KEY (ticket_type_id) REFERENCES ticket_types (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (order_item_id) REFERENCES order_items (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (status IN ('valid','used','revoked','refunded')),
  CHECK (status <> 'used' OR admitted_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX tickets_owner_idx ON tickets (owner_user_id)
;;
CREATE INDEX tickets_event_idx ON tickets (event_id, status)
;;
CREATE INDEX tickets_event_updated_idx ON tickets (event_id, updated_at)
;;
CREATE INDEX tickets_order_idx ON tickets (order_id)
;;
CREATE TABLE replaced_codes (
  code VARCHAR(255) NOT NULL,
  kind MEDIUMTEXT NOT NULL,
  ref_id MEDIUMTEXT NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  reason MEDIUMTEXT NOT NULL,
  replaced_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (code),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (kind IN ('ticket','pass'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX replaced_codes_event_idx ON replaced_codes (event_id, replaced_at)
;;
CREATE TABLE wallet_passes (
  serial VARCHAR(255) NOT NULL,
  kind MEDIUMTEXT NOT NULL,
  ticket_id VARCHAR(255) NOT NULL,
  qr_version BIGINT NOT NULL,
  snapshot MEDIUMTEXT NOT NULL,
  state VARCHAR(255) NOT NULL DEFAULT 'active',
  fingerprint MEDIUMTEXT NOT NULL,
  expires_at VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (serial),
  CHECK (kind IN ('apple','google')),
  CHECK (state IN ('active','void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX wallet_passes_state_idx ON wallet_passes (state, expires_at)
;;
CREATE INDEX wallet_passes_ticket_idx ON wallet_passes (ticket_id)
;;
CREATE TABLE wallet_devices (
  device_id VARCHAR(255) NOT NULL,
  serial VARCHAR(255) NOT NULL,
  push_token MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (device_id, serial)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE ticket_entry_days (
  ticket_id VARCHAR(255) NOT NULL,
  day VARCHAR(255) NOT NULL,
  admitted_at MEDIUMTEXT NOT NULL,
  admitted_by VARCHAR(255),
  PRIMARY KEY (ticket_id, day),
  FOREIGN KEY (admitted_by) REFERENCES users (id),
  FOREIGN KEY (ticket_id) REFERENCES tickets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE gate_passes (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  code VARCHAR(255) NOT NULL,
  qr_version BIGINT NOT NULL DEFAULT 1,
  holder_name MEDIUMTEXT NOT NULL,
  email MEDIUMTEXT,
  role MEDIUMTEXT NOT NULL,
  access_note MEDIUMTEXT,
  reentry BIGINT NOT NULL DEFAULT 1,
  status MEDIUMTEXT NOT NULL DEFAULT ('active'),
  link_token_hash VARCHAR(255) NOT NULL,
  scans BIGINT NOT NULL DEFAULT 0,
  first_scanned_at MEDIUMTEXT,
  last_scanned_at MEDIUMTEXT,
  created_by VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  updated_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gate_passes_18 (link_token_hash),
  UNIQUE KEY uq_gate_passes_19 (code),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('active','revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX gate_passes_event_idx ON gate_passes (event_id, updated_at)
;;
CREATE TABLE ticket_transfers (
  id VARCHAR(255) NOT NULL,
  ticket_id VARCHAR(255) NOT NULL,
  from_user_id VARCHAR(255) NOT NULL,
  to_email VARCHAR(255) NOT NULL,
  to_user_id VARCHAR(255),
  claim_token_hash VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'pending',
  created_at MEDIUMTEXT NOT NULL,
  expires_at MEDIUMTEXT NOT NULL,
  completed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_transfers_11 (claim_token_hash),
  g_ticket_transfers_one_pending_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN ticket_id END) STORED INVISIBLE,
  FOREIGN KEY (to_user_id) REFERENCES users (id),
  FOREIGN KEY (from_user_id) REFERENCES users (id),
  FOREIGN KEY (ticket_id) REFERENCES tickets (id),
  CHECK (status IN ('pending','accepted','cancelled','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX ticket_transfers_one_pending ON ticket_transfers (g_ticket_transfers_one_pending_0)
;;
CREATE INDEX ticket_transfers_to_idx ON ticket_transfers (to_email, status)
;;
CREATE TABLE admission_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(255) NOT NULL,
  ticket_id VARCHAR(255),
  scanned_by VARCHAR(255) NOT NULL,
  outcome MEDIUMTEXT NOT NULL,
  gate MEDIUMTEXT,
  occurred_at VARCHAR(255) NOT NULL,
  pass_id MEDIUMTEXT,
  reason MEDIUMTEXT,
  offline BIGINT NOT NULL DEFAULT 0,
  synced_by VARCHAR(255),
  synced_at MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (synced_by) REFERENCES users (id),
  FOREIGN KEY (scanned_by) REFERENCES users (id),
  FOREIGN KEY (ticket_id) REFERENCES tickets (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (outcome IN ('admitted','already_used','invalid','wrong_event','revoked','refunded','event_not_live'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX admission_event_idx ON admission_log (event_id, occurred_at)
;;
CREATE INDEX admission_scanner_idx ON admission_log (event_id, scanned_by)
;;
CREATE TABLE event_staff (
  event_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  can_scan BIGINT NOT NULL DEFAULT 1,
  can_manage_tags BIGINT NOT NULL DEFAULT 0,
  can_sell_tickets BIGINT NOT NULL DEFAULT 0,
  added_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (added_by) REFERENCES users (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE door_shifts (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  retail_partner_id VARCHAR(255),
  cashier_id VARCHAR(255) NOT NULL,
  opening_float_cents BIGINT NOT NULL DEFAULT 0,
  counted_cash_cents BIGINT,
  counted_card_cents BIGINT,
  cash_variance_cents BIGINT,
  card_variance_cents BIGINT,
  status MEDIUMTEXT NOT NULL,
  opened_at VARCHAR(255) NOT NULL,
  closed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_door_shifts_13 (id, event_id),
  g_door_shifts_one_open_cashier_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN event_id END) STORED INVISIBLE,
  g_door_shifts_one_open_cashier_1 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN cashier_id END) STORED INVISIBLE,
  FOREIGN KEY (cashier_id) REFERENCES users (id),
  FOREIGN KEY (retail_partner_id) REFERENCES retail_partners (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (opening_float_cents >= 0),
  CHECK (counted_cash_cents >= 0),
  CHECK (counted_card_cents >= 0),
  CHECK (status IN ('open','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX door_shifts_one_open_cashier ON door_shifts (g_door_shifts_one_open_cashier_0, g_door_shifts_one_open_cashier_1)
;;
CREATE INDEX door_shifts_event_idx ON door_shifts (event_id, opened_at)
;;
CREATE TABLE door_order_intents (
  order_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  retail_partner_id VARCHAR(255),
  shift_id VARCHAR(255) NOT NULL,
  cashier_id VARCHAR(255) NOT NULL,
  tender_method MEDIUMTEXT NOT NULL,
  status MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  confirmed_at MEDIUMTEXT,
  PRIMARY KEY (order_id),
  FOREIGN KEY (cashier_id) REFERENCES users (id),
  FOREIGN KEY (shift_id) REFERENCES door_shifts (id),
  FOREIGN KEY (retail_partner_id) REFERENCES retail_partners (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (tender_method IN ('cash','external_card','yoco','snapscan','titopay')),
  CHECK (status IN ('awaiting_tender','confirmed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE door_tenders (
  id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  shift_id VARCHAR(255) NOT NULL,
  cashier_id VARCHAR(255) NOT NULL,
  payment_id VARCHAR(255) NOT NULL,
  method VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  cash_received_cents BIGINT,
  change_cents BIGINT NOT NULL DEFAULT 0,
  external_reference VARCHAR(255),
  receipt_reference VARCHAR(255) NOT NULL,
  created_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_door_tenders_14 (shift_id, method, external_reference),
  UNIQUE KEY uq_door_tenders_15 (receipt_reference),
  UNIQUE KEY uq_door_tenders_16 (payment_id),
  UNIQUE KEY uq_door_tenders_17 (order_id),
  FOREIGN KEY (payment_id) REFERENCES payments (id),
  FOREIGN KEY (cashier_id) REFERENCES users (id),
  FOREIGN KEY (shift_id) REFERENCES door_shifts (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (method IN ('cash','external_card','yoco','snapscan','titopay')),
  CHECK (amount_cents > 0),
  CHECK (cash_received_cents >= amount_cents),
  CHECK (change_cents >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX door_tenders_shift_idx ON door_tenders (shift_id, created_at)
;;
CREATE INDEX door_tenders_event_idx ON door_tenders (event_id, cashier_id)
;;
CREATE TABLE retail_partners (
  id VARCHAR(255) NOT NULL,
  ref VARCHAR(255) NOT NULL,
  owner_user_id VARCHAR(255) NOT NULL,
  business_name MEDIUMTEXT NOT NULL,
  registration_number MEDIUMTEXT,
  contact_phone MEDIUMTEXT NOT NULL,
  store_address MEDIUMTEXT NOT NULL,
  sales_channels MEDIUMTEXT NOT NULL DEFAULT ('[]'),
  website_url MEDIUMTEXT,
  status VARCHAR(255) NOT NULL DEFAULT 'pending',
  review_note MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  approved_at MEDIUMTEXT,
  approved_by VARCHAR(255),
  location_lat_e6 BIGINT,
  location_lng_e6 BIGINT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retail_partners_18 (ref),
  FOREIGN KEY (approved_by) REFERENCES users (id),
  FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CHECK (status IN ('pending','approved','rejected','suspended')),
  CHECK (location_lat_e6 IS NULL OR location_lat_e6 BETWEEN -90000000 AND 90000000),
  CHECK (location_lng_e6 IS NULL OR location_lng_e6 BETWEEN -180000000 AND 180000000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX retail_partners_status_idx ON retail_partners (status, created_at)
;;
CREATE TABLE retail_partner_members (
  partner_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  role MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (partner_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (partner_id) REFERENCES retail_partners (id),
  CHECK (role IN ('owner','seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE retail_partner_payouts (
  id VARCHAR(255) NOT NULL,
  partner_id VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  bank_reference VARCHAR(255) NOT NULL,
  paid_by VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retail_partner_payouts_7 (partner_id, bank_reference),
  FOREIGN KEY (paid_by) REFERENCES users (id),
  FOREIGN KEY (partner_id) REFERENCES retail_partners (id),
  CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE marketing_consents (
  id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255),
  channel VARCHAR(255) NOT NULL,
  granted BIGINT NOT NULL,
  source MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  g_marketing_consents_uq_1 VARCHAR(255) GENERATED ALWAYS AS (COALESCE(organiser_id, '')) STORED INVISIBLE,
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  CHECK (channel IN ('email','sms'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX marketing_consents_uq ON marketing_consents (user_id, g_marketing_consents_uq_1, channel)
;;
CREATE TABLE consent_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255),
  channel MEDIUMTEXT NOT NULL,
  granted BIGINT NOT NULL,
  source MEDIUMTEXT NOT NULL,
  occurred_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE campaigns (
  id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  channel MEDIUMTEXT NOT NULL,
  name MEDIUMTEXT NOT NULL,
  subject MEDIUMTEXT,
  body MEDIUMTEXT NOT NULL,
  audience MEDIUMTEXT NOT NULL DEFAULT ('{}'),
  status MEDIUMTEXT NOT NULL DEFAULT ('draft'),
  scheduled_at MEDIUMTEXT,
  sent_at MEDIUMTEXT,
  recipients_count BIGINT NOT NULL DEFAULT 0,
  delivered_count BIGINT NOT NULL DEFAULT 0,
  failed_count BIGINT NOT NULL DEFAULT 0,
  estimated_cost_cents BIGINT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  promotion_id VARCHAR(255),
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (channel IN ('email','sms')),
  CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX campaigns_promotion_idx ON campaigns (promotion_id)
;;
CREATE TABLE message_outbox (
  id VARCHAR(255) NOT NULL,
  channel MEDIUMTEXT NOT NULL,
  kind MEDIUMTEXT NOT NULL,
  to_address MEDIUMTEXT NOT NULL,
  subject MEDIUMTEXT,
  body MEDIUMTEXT NOT NULL,
  campaign_id VARCHAR(255),
  user_id VARCHAR(255),
  status VARCHAR(255) NOT NULL DEFAULT 'queued',
  provider MEDIUMTEXT,
  provider_message_id MEDIUMTEXT,
  attempts BIGINT NOT NULL DEFAULT 0,
  last_error MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  sent_at MEDIUMTEXT,
  claimed_until MEDIUMTEXT,
  next_attempt_at VARCHAR(255),
  event_id VARCHAR(255),
  PRIMARY KEY (id),
  g_message_outbox_event_idx_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN event_id IS NOT NULL THEN event_id END) STORED INVISIBLE,
  g_message_outbox_campaign_user_uq_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN campaign_id IS NOT NULL THEN campaign_id END) STORED INVISIBLE,
  g_message_outbox_campaign_user_uq_1 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN campaign_id IS NOT NULL THEN user_id END) STORED INVISIBLE,
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CHECK (channel IN ('email','sms')),
  CHECK (kind IN ('transactional','marketing')),
  CHECK (status IN ('queued','sent','failed','suppressed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX message_outbox_event_idx ON message_outbox (g_message_outbox_event_idx_0)
;;
CREATE INDEX message_outbox_status_idx ON message_outbox (status, created_at)
;;
CREATE INDEX message_outbox_due_idx ON message_outbox (status, next_attempt_at)
;;
CREATE UNIQUE INDEX message_outbox_campaign_user_uq ON message_outbox (g_message_outbox_campaign_user_uq_0, g_message_outbox_campaign_user_uq_1)
;;
CREATE INDEX message_outbox_user_idx ON message_outbox (user_id)
;;
CREATE TABLE site_settings (
  "key" VARCHAR(255) NOT NULL,
  value MEDIUMTEXT NOT NULL,
  updated_by VARCHAR(255),
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY ("key"),
  FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE ad_posters (
  id VARCHAR(255) NOT NULL,
  title MEDIUMTEXT NOT NULL,
  subtitle MEDIUMTEXT,
  image_upload_id VARCHAR(255),
  link_url MEDIUMTEXT,
  placement MEDIUMTEXT NOT NULL DEFAULT ('home'),
  starts_at MEDIUMTEXT,
  ends_at MEDIUMTEXT,
  active BIGINT NOT NULL DEFAULT 1,
  sort_order BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (image_upload_id) REFERENCES uploads (id),
  CHECK (link_url IS NULL OR link_url LIKE '/%' OR link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  CHECK (placement IN ('home','events'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE job_posts (
  id VARCHAR(255) NOT NULL,
  title MEDIUMTEXT NOT NULL,
  department MEDIUMTEXT NOT NULL,
  location MEDIUMTEXT NOT NULL,
  employment_type MEDIUMTEXT NOT NULL,
  summary MEDIUMTEXT NOT NULL,
  description MEDIUMTEXT NOT NULL,
  application_url MEDIUMTEXT,
  closes_at VARCHAR(255),
  status VARCHAR(255) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  CHECK (status IN ('draft','published'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX job_posts_public_idx ON job_posts (status, closes_at, created_at DESC)
;;
CREATE TABLE kb_articles (
  id VARCHAR(255) NOT NULL,
  question MEDIUMTEXT NOT NULL,
  answer MEDIUMTEXT NOT NULL,
  keywords MEDIUMTEXT NOT NULL DEFAULT ('[]'),
  link_url MEDIUMTEXT,
  active BIGINT NOT NULL DEFAULT 1,
  sort_order BIGINT NOT NULL DEFAULT 0,
  updated_by VARCHAR(255),
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE chat_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  conversation MEDIUMTEXT NOT NULL,
  question MEDIUMTEXT NOT NULL,
  answer MEDIUMTEXT NOT NULL,
  source MEDIUMTEXT NOT NULL,
  article_id VARCHAR(255),
  helpful BIGINT,
  created_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (article_id) REFERENCES kb_articles (id) ON DELETE SET NULL,
  CHECK (source IN ('kb','ai','fallback'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at)
;;
CREATE TABLE notification_log (
  "key" VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY ("key")
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE rate_limits (
  "key" VARCHAR(255) NOT NULL,
  count BIGINT NOT NULL,
  reset_at BIGINT NOT NULL,
  PRIMARY KEY ("key")
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE job_runs (
  name VARCHAR(255) NOT NULL,
  last_run BIGINT NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE meta (
  "key" VARCHAR(255) NOT NULL,
  value MEDIUMTEXT NOT NULL,
  PRIMARY KEY ("key")
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE newsletter_subscribers (
  id VARCHAR(255) NOT NULL,
  email MEDIUMTEXT NOT NULL,
  status VARCHAR(255) NOT NULL,
  source MEDIUMTEXT NOT NULL DEFAULT ('web'),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  confirmed_at MEDIUMTEXT,
  unsubscribed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  g_newsletter_email_uq_0 VARCHAR(255) GENERATED ALWAYS AS (lower(email)) STORED INVISIBLE,
  CHECK (status IN ('pending','subscribed','unsubscribed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX newsletter_email_uq ON newsletter_subscribers (g_newsletter_email_uq_0)
;;
CREATE INDEX newsletter_status_idx ON newsletter_subscribers (status)
;;
CREATE TABLE newsletter_issues (
  id VARCHAR(255) NOT NULL,
  subject MEDIUMTEXT NOT NULL,
  body MEDIUMTEXT NOT NULL,
  recipients BIGINT NOT NULL,
  sent_by VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (sent_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE event_likes (
  user_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX event_likes_event_idx ON event_likes (event_id)
;;
CREATE TABLE payments (
  id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255),
  provider VARCHAR(255) NOT NULL,
  environment MEDIUMTEXT NOT NULL,
  provider_reference VARCHAR(255),
  amount_cents BIGINT NOT NULL,
  status VARCHAR(255) NOT NULL,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  failure_reason MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  confirmed_at MEDIUMTEXT,
  checkout_url MEDIUMTEXT,
  provider_payment_id VARCHAR(255),
  purpose MEDIUMTEXT NOT NULL DEFAULT ('order'),
  topup_id VARCHAR(255),
  PRIMARY KEY (id),
  g_payments_one_active_order_uq_0 VARCHAR(255) GENERATED ALWAYS AS (order_id) WHERE order_id IS NOT NULL AND status IN ('initiated') STORED INVISIBLE,
  g_payments_one_active_order_uq_1 VARCHAR(255) GENERATED ALWAYS AS ('pending') STORED INVISIBLE,
  FOREIGN KEY (topup_id) REFERENCES wallet_topups (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (amount_cents > 0),
  CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','refunded','partially_refunded')),
  CHECK (purpose IN ('order','topup'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_reference)
;;
CREATE INDEX payments_order_idx ON payments (order_id)
;;
CREATE INDEX payments_status_idx ON payments (status, created_at)
;;
CREATE INDEX payments_provider_payment_id_idx ON payments (provider, provider_payment_id)
;;
CREATE UNIQUE INDEX payments_one_active_order_uq ON payments (g_payments_one_active_order_uq_0, g_payments_one_active_order_uq_1)
;;
CREATE INDEX payments_topup_idx ON payments (topup_id)
;;
CREATE TABLE webhook_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  provider VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  status MEDIUMTEXT NOT NULL DEFAULT ('received'),
  result MEDIUMTEXT,
  error MEDIUMTEXT,
  attempts BIGINT NOT NULL DEFAULT 1,
  received_at MEDIUMTEXT NOT NULL,
  processed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_events_10 (provider, event_id),
  CHECK (status IN ('received','processed','ignored','failed','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE refunds (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  order_id VARCHAR(255),
  payment_id VARCHAR(255),
  amount_cents BIGINT NOT NULL,
  fee_refund_cents BIGINT NOT NULL DEFAULT 0,
  kind MEDIUMTEXT NOT NULL,
  reason MEDIUMTEXT NOT NULL,
  ticket_ids MEDIUMTEXT,
  status VARCHAR(255) NOT NULL,
  provider_reference MEDIUMTEXT,
  failure_reason MEDIUMTEXT,
  note MEDIUMTEXT,
  requested_by VARCHAR(255),
  decided_by VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  completed_at MEDIUMTEXT,
  event_id VARCHAR(255),
  user_id VARCHAR(255),
  pos_sale_id VARCHAR(255),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refunds_22 (reference),
  g_refunds_one_pos_sale_0 VARCHAR(255) GENERATED ALWAYS AS (pos_sale_id) WHERE kind = 'pos_sale' AND status IN ('requested') STORED INVISIBLE,
  g_refunds_one_pos_sale_1 VARCHAR(255) GENERATED ALWAYS AS ('processing') STORED INVISIBLE,
  g_refunds_one_pos_sale_2 VARCHAR(255) GENERATED ALWAYS AS ('completed') STORED INVISIBLE,
  FOREIGN KEY (pos_sale_id) REFERENCES pos_sales (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (decided_by) REFERENCES users (id),
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (payment_id) REFERENCES payments (id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CHECK (amount_cents >= 0),
  CHECK (fee_refund_cents >= 0),
  CHECK (kind IN ('customer','event_cancelled','unfulfilled','goodwill','wallet_balance','pos_sale')),
  CHECK (status IN ('requested','processing','manual_pending','completed','rejected','failed')),
  CHECK (amount_cents + fee_refund_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX refunds_status_idx ON refunds (status, created_at)
;;
CREATE INDEX refunds_order_idx ON refunds (order_id)
;;
CREATE INDEX refunds_event_idx ON refunds (event_id, status)
;;
CREATE INDEX refunds_user_idx ON refunds (user_id)
;;
CREATE UNIQUE INDEX refunds_one_pos_sale ON refunds (g_refunds_one_pos_sale_0, g_refunds_one_pos_sale_1, g_refunds_one_pos_sale_2)
;;
CREATE TABLE payouts (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  status VARCHAR(255) NOT NULL,
  bank_name MEDIUMTEXT,
  bank_account_holder MEDIUMTEXT,
  bank_account_last4 MEDIUMTEXT,
  bank_branch_code MEDIUMTEXT,
  bank_reference MEDIUMTEXT,
  note MEDIUMTEXT,
  requested_by VARCHAR(255),
  approved_by VARCHAR(255),
  paid_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  paid_at MEDIUMTEXT,
  vendor_id VARCHAR(255),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payouts_19 (reference),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  FOREIGN KEY (paid_by) REFERENCES users (id),
  FOREIGN KEY (approved_by) REFERENCES users (id),
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (amount_cents > 0),
  CHECK (status IN ('requested','approved','paid','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX payouts_org_idx ON payouts (organiser_id, status)
;;
CREATE INDEX payouts_vendor_idx ON payouts (vendor_id, status)
;;
CREATE TABLE peach_payout_submissions (
  id VARCHAR(255) NOT NULL,
  payout_id VARCHAR(255) NOT NULL,
  environment MEDIUMTEXT NOT NULL,
  provider_payout_id VARCHAR(255) NOT NULL,
  payout_request_id MEDIUMTEXT,
  status MEDIUMTEXT NOT NULL,
  failure_reason MEDIUMTEXT,
  provider_status MEDIUMTEXT,
  provider_updated_at MEDIUMTEXT,
  created_by VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  completed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_peach_payout_submissions_14 (provider_payout_id),
  g_peach_payout_one_open_uq_0 VARCHAR(255) GENERATED ALWAYS AS (payout_id) WHERE status IN ('submitting') STORED INVISIBLE,
  g_peach_payout_one_open_uq_1 VARCHAR(255) GENERATED ALWAYS AS ('pending') STORED INVISIBLE,
  g_peach_payout_one_open_uq_2 VARCHAR(255) GENERATED ALWAYS AS ('processing') STORED INVISIBLE,
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (payout_id) REFERENCES payouts (id),
  CHECK (environment IN ('sandbox','live')),
  CHECK (status IN ('submitting','pending','processing','successful','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX peach_payout_submission_payout_idx ON peach_payout_submissions (payout_id, created_at DESC)
;;
CREATE UNIQUE INDEX peach_payout_one_open_uq ON peach_payout_submissions (g_peach_payout_one_open_uq_0, g_peach_payout_one_open_uq_1, g_peach_payout_one_open_uq_2)
;;
CREATE TABLE peach_payout_reversals (
  id VARCHAR(255) NOT NULL,
  submission_id VARCHAR(255) NOT NULL,
  payout_id VARCHAR(255) NOT NULL,
  provider_payout_id VARCHAR(255) NOT NULL,
  provider_status MEDIUMTEXT NOT NULL,
  provider_updated_at MEDIUMTEXT,
  ledger_reversed BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_peach_payout_reversals_9 (provider_payout_id),
  UNIQUE KEY uq_peach_payout_reversals_10 (submission_id),
  FOREIGN KEY (payout_id) REFERENCES payouts (id),
  FOREIGN KEY (submission_id) REFERENCES peach_payout_submissions (id),
  CHECK (provider_status IN ('cancelled','reversed')),
  CHECK (ledger_reversed IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX peach_payout_reversal_payout_idx ON peach_payout_reversals (payout_id, created_at DESC)
;;
CREATE TABLE integration_settings (
  "key" VARCHAR(255) NOT NULL,
  value MEDIUMTEXT NOT NULL,
  updated_by VARCHAR(255),
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY ("key"),
  FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE support_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_id VARCHAR(255) NOT NULL,
  author_id VARCHAR(255),
  author_kind MEDIUMTEXT NOT NULL,
  body MEDIUMTEXT NOT NULL,
  emailed BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (author_id) REFERENCES users (id),
  FOREIGN KEY (case_id) REFERENCES support_cases (id),
  CHECK (author_kind IN ('customer','ticketroom','organiser','system'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX support_messages_case_idx ON support_messages (case_id, id)
;;
CREATE TABLE ledger_journals (
  id BIGINT NOT NULL AUTO_INCREMENT,
  kind MEDIUMTEXT NOT NULL,
  reference MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE ledger_entries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  journal_id BIGINT NOT NULL,
  account VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (journal_id) REFERENCES ledger_journals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account)
;;
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id)
;;
CREATE TABLE recon_runs (
  id VARCHAR(255) NOT NULL,
  provider MEDIUMTEXT NOT NULL,
  period_start MEDIUMTEXT NOT NULL,
  period_end MEDIUMTEXT NOT NULL,
  summary MEDIUMTEXT NOT NULL,
  created_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE recon_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(255) NOT NULL,
  provider_reference MEDIUMTEXT NOT NULL,
  outcome MEDIUMTEXT NOT NULL,
  provider_amount_cents BIGINT,
  internal_amount_cents BIGINT,
  provider_status MEDIUMTEXT,
  internal_status MEDIUMTEXT,
  resolved BIGINT NOT NULL DEFAULT 0,
  resolution_note MEDIUMTEXT,
  resolved_by VARCHAR(255),
  resolved_at MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (resolved_by) REFERENCES users (id),
  FOREIGN KEY (run_id) REFERENCES recon_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX recon_items_run_idx ON recon_items (run_id)
;;
CREATE TABLE event_promotions (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL,
  price_cents BIGINT NOT NULL,
  paid_with MEDIUMTEXT,
  test BIGINT NOT NULL DEFAULT 0,
  social_status MEDIUMTEXT,
  social_request MEDIUMTEXT,
  social_notes MEDIUMTEXT,
  social_links MEDIUMTEXT,
  social_updated_at MEDIUMTEXT,
  refund_status MEDIUMTEXT,
  refund_reference MEDIUMTEXT,
  refund_reason MEDIUMTEXT,
  refund_provider_reference MEDIUMTEXT,
  refund_failure MEDIUMTEXT,
  refunded_by VARCHAR(255),
  refunded_at MEDIUMTEXT,
  created_by VARCHAR(255) NOT NULL,
  paid_at MEDIUMTEXT,
  ends_at MEDIUMTEXT NOT NULL,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_promotions_26 (reference),
  g_event_promotions_open_uq_0 VARCHAR(255) GENERATED ALWAYS AS (event_id) WHERE status IN ('pending_payment') STORED INVISIBLE,
  g_event_promotions_open_uq_1 VARCHAR(255) GENERATED ALWAYS AS ('active') STORED INVISIBLE,
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (refunded_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('pending_payment','active','ended','refunded','cancelled')),
  CHECK (price_cents > 0),
  CHECK (paid_with IN ('card','balance')),
  CHECK (social_status IN ('requested','scheduled','posted')),
  CHECK (refund_status IN ('processing','manual_pending','completed','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX event_promotions_open_uq ON event_promotions (g_event_promotions_open_uq_0, g_event_promotions_open_uq_1)
;;
CREATE INDEX event_promotions_status_idx ON event_promotions (status, created_at)
;;
CREATE INDEX event_promotions_org_idx ON event_promotions (organiser_id, created_at)
;;
CREATE TABLE promotion_payments (
  id VARCHAR(255) NOT NULL,
  promotion_id VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  environment MEDIUMTEXT NOT NULL,
  provider_reference VARCHAR(255),
  amount_cents BIGINT NOT NULL,
  status MEDIUMTEXT NOT NULL,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  failure_reason MEDIUMTEXT,
  created_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  confirmed_at MEDIUMTEXT,
  provider_payment_id MEDIUMTEXT,
  checkout_url MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (promotion_id) REFERENCES event_promotions (id),
  CHECK (amount_cents > 0),
  CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','refunded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX promotion_payments_ref_uq ON promotion_payments (provider, provider_reference)
;;
CREATE INDEX promotion_payments_promo_idx ON promotion_payments (promotion_id)
;;
CREATE TABLE tag_batches (
  id VARCHAR(255) NOT NULL,
  tag_type MEDIUMTEXT NOT NULL,
  mode MEDIUMTEXT NOT NULL,
  event_id VARCHAR(255),
  organiser_id VARCHAR(255),
  quantity BIGINT NOT NULL,
  notes MEDIUMTEXT,
  created_by VARCHAR(255) NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  CHECK (mode IN ('generate','import','desk')),
  CHECK (quantity BETWEEN 1 AND 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE tags (
  id VARCHAR(255) NOT NULL,
  tag_type MEDIUMTEXT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  display_code VARCHAR(255) NOT NULL,
  activation_code_hash MEDIUMTEXT,
  security_level MEDIUMTEXT NOT NULL,
  batch_id VARCHAR(255),
  event_id VARCHAR(255),
  user_id VARCHAR(255),
  ticket_id VARCHAR(255),
  status VARCHAR(255) NOT NULL DEFAULT 'unassigned',
  linked_at MEDIUMTEXT,
  last_used_at MEDIUMTEXT,
  status_reason MEDIUMTEXT,
  replaced_by_tag_id VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tags_18 (display_code),
  UNIQUE KEY uq_tags_19 (token_hash),
  g_tags_one_active_per_user_event_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN event_id END) STORED INVISIBLE,
  g_tags_one_active_per_user_event_1 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN user_id END) STORED INVISIBLE,
  g_tags_one_active_per_ticket_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'active' AND ticket_id IS NOT NULL THEN ticket_id END) STORED INVISIBLE,
  FOREIGN KEY (replaced_by_tag_id) REFERENCES tags (id),
  FOREIGN KEY (ticket_id) REFERENCES tickets (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (batch_id) REFERENCES tag_batches (id),
  CHECK (tag_type IN ('nfc_wristband','nfc_card','qr_tag')),
  CHECK (security_level IN ('uid_only','random_token')),
  CHECK (status IN ('unassigned','assigned','active','blocked','lost','revoked','replaced')),
  CHECK (status <> 'active' OR (user_id IS NOT NULL AND event_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX tags_one_active_per_user_event ON tags (g_tags_one_active_per_user_event_0, g_tags_one_active_per_user_event_1)
;;
CREATE UNIQUE INDEX tags_one_active_per_ticket ON tags (g_tags_one_active_per_ticket_0)
;;
CREATE INDEX tags_user_idx ON tags (user_id)
;;
CREATE INDEX tags_event_idx ON tags (event_id, status)
;;
CREATE TABLE tag_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tag_id VARCHAR(255) NOT NULL,
  action MEDIUMTEXT NOT NULL,
  actor_id VARCHAR(255),
  details MEDIUMTEXT NOT NULL DEFAULT ('{}'),
  occurred_at VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (actor_id) REFERENCES users (id),
  FOREIGN KEY (tag_id) REFERENCES tags (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX tag_events_tag_idx ON tag_events (tag_id, occurred_at)
;;
CREATE TABLE cashless_wallets (
  user_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  test_balance_cents BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  CHECK (balance_cents >= 0),
  CHECK (test_balance_cents >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX cashless_wallets_event_idx ON cashless_wallets (event_id)
;;
CREATE TABLE wallet_topups (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'pending',
  idempotency_key VARCHAR(255) NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  confirmed_at MEDIUMTEXT,
  paid_by VARCHAR(255),
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_topups_12 (user_id, idempotency_key),
  UNIQUE KEY uq_wallet_topups_13 (reference),
  FOREIGN KEY (paid_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  CHECK (amount_cents > 0),
  CHECK (status IN ('pending','confirmed','failed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX wallet_topups_wallet_idx ON wallet_topups (user_id, event_id, status)
;;
CREATE INDEX wallet_topups_event_idx ON wallet_topups (event_id, status)
;;
CREATE INDEX wallet_topups_paid_by_idx ON wallet_topups (paid_by, event_id)
;;
CREATE TABLE vendors (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  description MEDIUMTEXT,
  status MEDIUMTEXT NOT NULL DEFAULT ('active'),
  commission_bps BIGINT NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  category MEDIUMTEXT,
  contact_name MEDIUMTEXT,
  contact_email MEDIUMTEXT,
  contact_phone MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('active','suspended')),
  CHECK (commission_bps BETWEEN 0 AND 5000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX vendors_event_idx ON vendors (event_id)
;;
CREATE TABLE vendor_members (
  vendor_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  role MEDIUMTEXT NOT NULL,
  added_by VARCHAR(255),
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (vendor_id, user_id),
  FOREIGN KEY (added_by) REFERENCES users (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  CHECK (role IN ('manager','cashier'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX vendor_members_user_idx ON vendor_members (user_id)
;;
CREATE TABLE products (
  id VARCHAR(255) NOT NULL,
  vendor_id VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  price_cents BIGINT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1,
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at MEDIUMTEXT NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  CHECK (price_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX products_vendor_idx ON products (vendor_id, active)
;;
CREATE TABLE terminals (
  id VARCHAR(255) NOT NULL,
  vendor_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  label MEDIUMTEXT NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  status MEDIUMTEXT NOT NULL DEFAULT ('active'),
  registered_by VARCHAR(255) NOT NULL,
  last_seen_at MEDIUMTEXT,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_terminals_10 (key_hash),
  FOREIGN KEY (registered_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  CHECK (status IN ('active','suspended','retired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX terminals_vendor_idx ON terminals (vendor_id)
;;
CREATE TABLE pos_sales (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  vendor_id VARCHAR(255) NOT NULL,
  terminal_id VARCHAR(255) NOT NULL,
  cashier_id VARCHAR(255) NOT NULL,
  tag_id VARCHAR(255),
  user_id VARCHAR(255),
  total_cents BIGINT NOT NULL,
  commission_cents BIGINT NOT NULL DEFAULT 0,
  status MEDIUMTEXT NOT NULL,
  decline_reason MEDIUMTEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash MEDIUMTEXT NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(255) NOT NULL,
  reversed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pos_sales_18 (terminal_id, idempotency_key),
  UNIQUE KEY uq_pos_sales_19 (reference),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (tag_id) REFERENCES tags (id),
  FOREIGN KEY (cashier_id) REFERENCES users (id),
  FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (total_cents > 0),
  CHECK (commission_cents >= 0),
  CHECK (status IN ('confirmed','declined','reversed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX pos_sales_vendor_idx ON pos_sales (vendor_id, created_at)
;;
CREATE INDEX pos_sales_user_idx ON pos_sales (user_id, event_id)
;;
CREATE TABLE pos_sale_items (
  sale_id VARCHAR(255) NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  quantity BIGINT NOT NULL,
  PRIMARY KEY (sale_id, product_id),
  FOREIGN KEY (product_id) REFERENCES products (id),
  FOREIGN KEY (sale_id) REFERENCES pos_sales (id),
  CHECK (quantity BETWEEN 1 AND 99)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE pos_qr_intents (
  id VARCHAR(255) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  vendor_id VARCHAR(255) NOT NULL,
  terminal_id VARCHAR(255) NOT NULL,
  cashier_id VARCHAR(255) NOT NULL,
  items_json MEDIUMTEXT NOT NULL,
  total_cents BIGINT NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'pending',
  payer_user_id VARCHAR(255),
  sale_id VARCHAR(255),
  expires_at VARCHAR(255) NOT NULL,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pos_qr_intents_15 (sale_id),
  UNIQUE KEY uq_pos_qr_intents_16 (token_hash),
  FOREIGN KEY (sale_id) REFERENCES pos_sales (id),
  FOREIGN KEY (payer_user_id) REFERENCES users (id),
  FOREIGN KEY (cashier_id) REFERENCES users (id),
  FOREIGN KEY (terminal_id) REFERENCES terminals (id),
  FOREIGN KEY (vendor_id) REFERENCES vendors (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (total_cents > 0),
  CHECK (status IN ('pending','paid','cancelled','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX pos_qr_intents_terminal_idx ON pos_qr_intents (terminal_id, status, expires_at)
;;
CREATE INDEX pos_qr_intents_payer_idx ON pos_qr_intents (payer_user_id, event_id, created_at)
;;
CREATE TABLE cashless_event_settings (
  event_id VARCHAR(255) NOT NULL,
  cashout_desk_open BIGINT NOT NULL DEFAULT 0,
  desk_daily_cap_cents BIGINT,
  updated_by VARCHAR(255),
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (event_id),
  FOREIGN KEY (updated_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (desk_daily_cap_cents IS NULL OR desk_daily_cap_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE desk_topups (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  tag_id VARCHAR(255),
  method MEDIUMTEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  status MEDIUMTEXT NOT NULL DEFAULT ('confirmed'),
  staff_id VARCHAR(255) NOT NULL,
  staff_kind MEDIUMTEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(255) NOT NULL,
  undone_at MEDIUMTEXT,
  undone_by VARCHAR(255),
  undo_reason MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_desk_topups_18 (staff_id, idempotency_key),
  UNIQUE KEY uq_desk_topups_19 (reference),
  FOREIGN KEY (undone_by) REFERENCES users (id),
  FOREIGN KEY (staff_id) REFERENCES users (id),
  FOREIGN KEY (tag_id) REFERENCES tags (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (method IN ('cash','card')),
  CHECK (amount_cents > 0),
  CHECK (status IN ('confirmed','undone','reversed')),
  CHECK (staff_kind IN ('organiser','event_staff','ticketroom'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX desk_topups_event_idx ON desk_topups (event_id, staff_id, created_at)
;;
CREATE INDEX desk_topups_user_idx ON desk_topups (user_id, event_id)
;;
CREATE TABLE wallet_cashouts (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  method MEDIUMTEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  test BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL,
  bank_account_holder MEDIUMTEXT,
  bank_name MEDIUMTEXT,
  bank_branch_code MEDIUMTEXT,
  bank_account_enc MEDIUMTEXT,
  bank_account_last4 MEDIUMTEXT,
  code_hash VARCHAR(255),
  code_enc MEDIUMTEXT,
  first_approved_by VARCHAR(255),
  approved_by VARCHAR(255),
  paid_by VARCHAR(255),
  bank_reference MEDIUMTEXT,
  note MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  paid_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_cashouts_25 (code_hash),
  UNIQUE KEY uq_wallet_cashouts_26 (reference),
  FOREIGN KEY (paid_by) REFERENCES users (id),
  FOREIGN KEY (approved_by) REFERENCES users (id),
  FOREIGN KEY (first_approved_by) REFERENCES users (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (method IN ('eft','cash')),
  CHECK (amount_cents > 0),
  CHECK (fee_cents >= 0),
  CHECK (status IN ('requested','approved_once','approved','paid','rejected','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX wallet_cashouts_status_idx ON wallet_cashouts (status, created_at)
;;
CREATE INDEX wallet_cashouts_user_idx ON wallet_cashouts (user_id, event_id)
;;
CREATE INDEX wallet_cashouts_paid_idx ON wallet_cashouts (event_id, paid_by)
;;
CREATE TABLE waitlist_entries (
  id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  ticket_type_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'waiting',
  offer_kind MEDIUMTEXT,
  listing_id MEDIUMTEXT,
  offer_token_hash VARCHAR(255),
  offered_at MEDIUMTEXT,
  offer_expires_at VARCHAR(255),
  order_id VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_waitlist_entries_14 (offer_token_hash),
  g_waitlist_one_open_1 VARCHAR(255) GENERATED ALWAYS AS (user_id) WHERE status IN ('waiting') STORED INVISIBLE,
  g_waitlist_one_open_2 VARCHAR(255) GENERATED ALWAYS AS ('offered') STORED INVISIBLE,
  FOREIGN KEY (order_id) REFERENCES orders (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (ticket_type_id) REFERENCES ticket_types (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (status IN ('waiting','offered','claimed','expired','left','closed')),
  CHECK (offer_kind IN ('primary','resale'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX waitlist_one_open ON waitlist_entries (ticket_type_id, g_waitlist_one_open_1, g_waitlist_one_open_2)
;;
CREATE INDEX waitlist_queue_idx ON waitlist_entries (ticket_type_id, status, created_at)
;;
CREATE INDEX waitlist_user_idx ON waitlist_entries (user_id, status)
;;
CREATE INDEX waitlist_offer_idx ON waitlist_entries (status, offer_expires_at)
;;
CREATE TABLE resale_listings (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  ticket_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  ticket_type_id VARCHAR(255) NOT NULL,
  seller_id VARCHAR(255) NOT NULL,
  price_cents BIGINT NOT NULL,
  face_value_cents BIGINT NOT NULL,
  payout_method MEDIUMTEXT NOT NULL,
  status VARCHAR(255) NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  held_order_id VARCHAR(255),
  new_ticket_id VARCHAR(255),
  bank_account_holder MEDIUMTEXT,
  bank_name MEDIUMTEXT,
  bank_branch_code MEDIUMTEXT,
  bank_account_enc MEDIUMTEXT,
  bank_account_last4 MEDIUMTEXT,
  close_reason MEDIUMTEXT,
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  sold_at MEDIUMTEXT,
  withdraw_requested_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_resale_listings_24 (reference),
  g_resale_listings_one_open_0 VARCHAR(255) GENERATED ALWAYS AS (ticket_id) WHERE status IN ('active') STORED INVISIBLE,
  g_resale_listings_one_open_1 VARCHAR(255) GENERATED ALWAYS AS ('offered') STORED INVISIBLE,
  g_resale_listings_one_open_2 VARCHAR(255) GENERATED ALWAYS AS ('held') STORED INVISIBLE,
  FOREIGN KEY (new_ticket_id) REFERENCES tickets (id),
  FOREIGN KEY (held_order_id) REFERENCES orders (id),
  FOREIGN KEY (seller_id) REFERENCES users (id),
  FOREIGN KEY (ticket_type_id) REFERENCES ticket_types (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (ticket_id) REFERENCES tickets (id),
  CHECK (price_cents > 0),
  CHECK (face_value_cents > 0),
  CHECK (payout_method IN ('card','eft')),
  CHECK (status IN ('active','offered','held','sold','cancelled','closed')),
  CHECK (price_cents <= face_value_cents)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX resale_listings_one_open ON resale_listings (g_resale_listings_one_open_0, g_resale_listings_one_open_1, g_resale_listings_one_open_2)
;;
CREATE INDEX resale_listings_event_idx ON resale_listings (event_id, ticket_type_id, status, created_at)
;;
CREATE INDEX resale_listings_seller_idx ON resale_listings (seller_id, status)
;;
CREATE TABLE resale_payouts (
  id VARCHAR(255) NOT NULL,
  reference VARCHAR(255) NOT NULL,
  listing_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  method MEDIUMTEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  test BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL,
  payment_id VARCHAR(255),
  provider MEDIUMTEXT,
  provider_reference MEDIUMTEXT,
  bank_account_holder MEDIUMTEXT,
  bank_name MEDIUMTEXT,
  bank_branch_code MEDIUMTEXT,
  bank_account_enc MEDIUMTEXT,
  bank_account_last4 MEDIUMTEXT,
  bank_reference MEDIUMTEXT,
  failure_reason MEDIUMTEXT,
  approved_by VARCHAR(255),
  paid_by VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  paid_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_resale_payouts_25 (reference),
  FOREIGN KEY (paid_by) REFERENCES users (id),
  FOREIGN KEY (approved_by) REFERENCES users (id),
  FOREIGN KEY (payment_id) REFERENCES payments (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (listing_id) REFERENCES resale_listings (id),
  CHECK (method IN ('card','eft')),
  CHECK (amount_cents > 0),
  CHECK (status IN ('processing','manual_pending','requested','approved','paid','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE UNIQUE INDEX resale_payouts_listing_uq ON resale_payouts (listing_id)
;;
CREATE INDEX resale_payouts_status_idx ON resale_payouts (status, created_at)
;;
CREATE TABLE organiser_verification (
  organiser_id VARCHAR(255) NOT NULL,
  entity_type MEDIUMTEXT NOT NULL DEFAULT ('individual'),
  nationality MEDIUMTEXT NOT NULL DEFAULT ('sa'),
  legal_name MEDIUMTEXT,
  id_number_enc MEDIUMTEXT,
  id_number_last4 MEDIUMTEXT,
  id_dob MEDIUMTEXT,
  registration_number MEDIUMTEXT,
  rep_is_director BIGINT NOT NULL DEFAULT 1,
  plans_paid BIGINT NOT NULL DEFAULT 0,
  terms_version MEDIUMTEXT,
  terms_signed_at MEDIUMTEXT,
  terms_signed_by VARCHAR(255),
  terms_signed_name MEDIUMTEXT,
  terms_ip MEDIUMTEXT,
  risk_override MEDIUMTEXT,
  risk_note MEDIUMTEXT,
  completed_at MEDIUMTEXT,
  completed_scope MEDIUMTEXT,
  closed_at MEDIUMTEXT,
  updated_at MEDIUMTEXT NOT NULL,
  company_name MEDIUMTEXT,
  surname MEDIUMTEXT,
  bank_account_type MEDIUMTEXT,
  PRIMARY KEY (organiser_id),
  FOREIGN KEY (terms_signed_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (entity_type IN ('individual','company','npo')),
  CHECK (nationality IN ('sa','foreign')),
  CHECK (risk_override IS NULL OR risk_override IN ('high','normal'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE verification_documents (
  id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255),
  requirement VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL,
  file_name MEDIUMTEXT NOT NULL,
  original_name MEDIUMTEXT,
  mime_type MEDIUMTEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 MEDIUMTEXT NOT NULL,
  uploaded_by VARCHAR(255) NOT NULL,
  created_at VARCHAR(255) NOT NULL,
  reviewed_by VARCHAR(255),
  reviewed_at MEDIUMTEXT,
  reject_reason MEDIUMTEXT,
  replaced_at MEDIUMTEXT,
  deleted_at MEDIUMTEXT,
  provider MEDIUMTEXT,
  provider_status MEDIUMTEXT,
  provider_message MEDIUMTEXT,
  provider_ref MEDIUMTEXT,
  provider_checked_at MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (reviewed_by) REFERENCES users (id),
  FOREIGN KEY (uploaded_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (status IN ('submitted','approved','rejected','replaced')),
  CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  CHECK (size_bytes > 0 AND size_bytes <= 10485760)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX verification_documents_org_idx ON verification_documents (organiser_id, event_id, requirement)
;;
CREATE INDEX verification_documents_status_idx ON verification_documents (status, created_at)
;;
CREATE TABLE event_risk (
  event_id VARCHAR(255) NOT NULL,
  sells_alcohol BIGINT NOT NULL DEFAULT 0,
  public_space BIGINT NOT NULL DEFAULT 0,
  third_party BIGINT NOT NULL DEFAULT 0,
  risk_override MEDIUMTEXT,
  updated_by VARCHAR(255),
  updated_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (event_id),
  FOREIGN KEY (updated_by) REFERENCES users (id),
  FOREIGN KEY (event_id) REFERENCES events (id),
  CHECK (risk_override IS NULL OR risk_override IN ('high','normal'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE phone_codes (
  user_id VARCHAR(255) NOT NULL,
  phone MEDIUMTEXT NOT NULL,
  code_hash MEDIUMTEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  expires_at MEDIUMTEXT NOT NULL,
  created_at MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE TABLE kyc_consents (
  id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  text_version VARCHAR(255) NOT NULL,
  text_sha256 MEDIUMTEXT NOT NULL,
  full_name MEDIUMTEXT,
  ip MEDIUMTEXT,
  created_at MEDIUMTEXT NOT NULL,
  withdrawn_at MEDIUMTEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX kyc_consents_org_idx ON kyc_consents (organiser_id, text_version)
;;
CREATE TABLE kyc_checks (
  id VARCHAR(255) NOT NULL,
  organiser_id VARCHAR(255) NOT NULL,
  check_type VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL,
  mode MEDIUMTEXT NOT NULL,
  subject_hash MEDIUMTEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  provider_ref MEDIUMTEXT,
  job_id VARCHAR(255),
  reasons MEDIUMTEXT,
  response_json MEDIUMTEXT,
  http_status BIGINT,
  attempts BIGINT NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(255),
  last_error MEDIUMTEXT,
  override MEDIUMTEXT,
  decision_note MEDIUMTEXT,
  decided_by VARCHAR(255),
  decided_at MEDIUMTEXT,
  consent_id VARCHAR(255),
  requested_by VARCHAR(255),
  created_at VARCHAR(255) NOT NULL,
  updated_at MEDIUMTEXT NOT NULL,
  completed_at MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kyc_checks_25 (idempotency_key),
  g_kyc_checks_job_uq_0 VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN job_id IS NOT NULL THEN job_id END) STORED INVISIBLE,
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (consent_id) REFERENCES kyc_consents (id),
  FOREIGN KEY (decided_by) REFERENCES users (id),
  FOREIGN KEY (organiser_id) REFERENCES organisers (id),
  CHECK (check_type IN ('said','aml_person','aml_company','cipc','bank','face')),
  CHECK (status IN ('queued','running','waiting','passed','review','failed','error','superseded')),
  CHECK (mode IN ('sandbox','production')),
  CHECK (override IS NULL OR override IN ('accepted','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC
;;
CREATE INDEX kyc_checks_org_idx ON kyc_checks (organiser_id, check_type, created_at)
;;
CREATE INDEX kyc_checks_due_idx ON kyc_checks (status, next_attempt_at)
;;
CREATE UNIQUE INDEX kyc_checks_job_uq ON kyc_checks (g_kyc_checks_job_uq_0)
;;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'; END
;;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'; END
;;
CREATE TRIGGER events_delete_only_test BEFORE DELETE ON events FOR EACH ROW BEGIN IF (COALESCE(OLD.is_test, 0) <> 1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only test events can be deleted'; END IF; END
;;
CREATE TRIGGER free_event_prices_ins BEFORE INSERT ON ticket_types FOR EACH ROW BEGIN IF (NEW.price_cents > 0 AND (SELECT is_free FROM events WHERE id = NEW.event_id) = 1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ticket types of a free event must cost R0'; END IF; END
;;
CREATE TRIGGER free_event_prices_upd BEFORE UPDATE ON ticket_types FOR EACH ROW BEGIN IF (NOT (NEW.price_cents <=> OLD.price_cents)) AND (NEW.price_cents > 0 AND (SELECT is_free FROM events WHERE id = NEW.event_id) = 1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ticket types of a free event must cost R0'; END IF; END
;;
CREATE TRIGGER admission_log_no_update BEFORE UPDATE ON admission_log FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admission_log is append-only'; END
;;
CREATE TRIGGER admission_log_no_delete BEFORE DELETE ON admission_log FOR EACH ROW BEGIN IF (COALESCE((SELECT is_test FROM events WHERE id = OLD.event_id), 0) <> 1
   AND COALESCE((SELECT e.is_test FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = OLD.ticket_id), 0) <> 1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admission_log is append-only'; END IF; END
;;
CREATE TRIGGER ledger_journals_no_update BEFORE UPDATE ON ledger_journals FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger is append-only'; END
;;
CREATE TRIGGER ledger_journals_no_delete BEFORE DELETE ON ledger_journals FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger is append-only'; END
;;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger is append-only'; END
;;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger is append-only'; END
;;
CREATE TRIGGER tag_events_no_update BEFORE UPDATE ON tag_events FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tag_events is append-only'; END
;;
CREATE TRIGGER tag_events_no_delete BEFORE DELETE ON tag_events FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tag_events is append-only'; END
;;
