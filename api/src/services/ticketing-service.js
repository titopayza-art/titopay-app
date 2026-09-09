const { randomUUID, createHash, randomInt } = require("crypto");
const QRCode = require("qrcode");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { ensureDefaultPricingRule, calculateFee } = require("./pricing-service");
const { applyWalletMovement } = require("./wallet-service");
// Ticketing communicates by EMAIL (and in-app), never SMS.
const { deliverEmail, createNotification, markNotification } = require("./notification-service");

const VERIFIED_STATUSES = new Set(["verified", "approved", "complete", "completed", "fully_verified"]);
const BLOCKED_USER_STATUSES = new Set(["suspended", "frozen", "restricted", "under_review", "closed", "inactive"]);
const EVENT_STATUSES = new Set(["draft", "submitted", "under_review", "additional_information_required", "approved", "rejected", "suspended", "cancelled", "completed"]);

function slugify(value = "") {
  return String(value || "event")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    // The slice happens after the trim, so a long name could be cut mid-word
    // and leave a dangling hyphen: "the-annual-general-" as a web address.
    .replace(/-+$/g, "") || "event";
}

function cleanText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function cleanEmail(value = "") {
  return cleanText(value, 180).toLowerCase();
}

function cleanPhone(value = "") {
  return cleanText(value, 40).replace(/\s+/g, "");
}

function toJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function money(value) {
  return Math.max(0, Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100);
}

async function ensureTicketingSchema() {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'gen_random_uuid'
          AND pg_catalog.pg_function_is_visible(p.oid)
      ) THEN
        EXECUTE $fn$
          CREATE FUNCTION gen_random_uuid()
          RETURNS uuid
          LANGUAGE SQL
          VOLATILE
          AS $body$
            SELECT (
              SUBSTR(seed, 1, 8) || '-' ||
              SUBSTR(seed, 9, 4) || '-4' ||
              SUBSTR(seed, 14, 3) || '-' ||
              SUBSTR('89ab', (FLOOR(RANDOM() * 4)::INT + 1), 1) ||
              SUBSTR(seed, 18, 3) || '-' ||
              SUBSTR(seed, 21, 12)
            )::uuid
            FROM (
              SELECT MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT || TXID_CURRENT()::TEXT) AS seed
            ) s
          $body$
        $fn$;
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      slug TEXT NOT NULL UNIQUE,
      event_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT NOT NULL DEFAULT '',
      event_date DATE,
      start_time TEXT,
      end_time TEXT,
      venue_name TEXT,
      full_venue_address TEXT,
      city TEXT,
      province TEXT,
      country TEXT NOT NULL DEFAULT 'South Africa',
      event_mode TEXT NOT NULL DEFAULT 'physical',
      organiser_details JSONB NOT NULL DEFAULT '{}'::JSONB,
      business_details JSONB NOT NULL DEFAULT '{}'::JSONB,
      contact_email TEXT,
      contact_number TEXT,
      event_banner_url TEXT,
      event_images JSONB NOT NULL DEFAULT '[]'::JSONB,
      age_restriction TEXT,
      capacity INTEGER,
      terms_conditions TEXT NOT NULL DEFAULT '',
      refund_policy JSONB NOT NULL DEFAULT '{}'::JSONB,
      entry_rules TEXT NOT NULL DEFAULT '',
      prohibited_items TEXT NOT NULL DEFAULT '',
      accessibility_information TEXT NOT NULL DEFAULT '',
      parking_information TEXT NOT NULL DEFAULT '',
      additional_instructions TEXT NOT NULL DEFAULT '',
      risk_flags JSONB NOT NULL DEFAULT '[]'::JSONB,
      rejection_reason TEXT,
      suspended_reason TEXT,
      submitted_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_details JSONB NOT NULL DEFAULT '{}'::JSONB;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS business_details JSONB NOT NULL DEFAULT '{}'::JSONB;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS risk_flags JSONB NOT NULL DEFAULT '[]'::JSONB;
    CREATE INDEX IF NOT EXISTS idx_events_business_user ON events (business_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events (status, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_slug ON events (slug);

    CREATE TABLE IF NOT EXISTS event_ticket_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      ticket_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price NUMERIC(18,2) NOT NULL DEFAULT 0,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      quantity_reserved INTEGER NOT NULL DEFAULT 0,
      quantity_sold INTEGER NOT NULL DEFAULT 0,
      min_purchase_quantity INTEGER NOT NULL DEFAULT 1,
      max_purchase_quantity INTEGER NOT NULL DEFAULT 10,
      sales_opening_at TIMESTAMPTZ,
      sales_closing_at TIMESTAMPTZ,
      per_customer_purchase_limit INTEGER,
      attendee_details_required BOOLEAN NOT NULL DEFAULT FALSE,
      transfer_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      refunds_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      refund_deadline TIMESTAMPTZ,
      refund_conditions TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_ticket_types_event ON event_ticket_types (event_id, sort_order);

    CREATE TABLE IF NOT EXISTS event_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,
      document_name TEXT NOT NULL,
      file_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'uploaded',
      requested_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      review_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_documents_event ON event_documents (event_id, status);

    CREATE TABLE IF NOT EXISTS event_approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      note TEXT,
      previous_status TEXT,
      new_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_approvals_event ON event_approvals (event_id, created_at DESC);

    -- Organiser-initiated requests against an APPROVED event: postpone (new
    -- date), cancel, update details, or a free-text "other". An organiser cannot
    -- silently change a live event that has sold tickets, so these are reviewed
    -- by admin, who applies the effect on approval. The named CHECK constraints
    -- are deliberate: the status vocabulary is likely to grow, and a named
    -- constraint can be widened by a later migration deterministically.
    CREATE TABLE IF NOT EXISTS event_change_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      request_type TEXT NOT NULL,
      requested_changes JSONB NOT NULL DEFAULT '{}'::JSONB,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      decision_note TEXT,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT event_change_requests_type_check CHECK (request_type IN ('postpone','cancel','update_details','other')),
      CONSTRAINT event_change_requests_status_check CHECK (status IN ('requested','under_review','approved','rejected','applied'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_change_requests_event ON event_change_requests (event_id, status);
    CREATE INDEX IF NOT EXISTS idx_event_change_requests_status ON event_change_requests (status, created_at DESC);
    -- One OPEN request per event, enforced by the database so a concurrent
    -- double-submit cannot slip past the application-level check.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_event_change_requests_open
      ON event_change_requests (event_id) WHERE status IN ('requested','under_review');

    CREATE TABLE IF NOT EXISTS event_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID REFERENCES events(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id UUID,
      action TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_audit_logs_event ON event_audit_logs (event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS event_staff (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'scanner',
      permissions JSONB NOT NULL DEFAULT '["scan"]'::JSONB,
      status TEXT NOT NULL DEFAULT 'active',
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_staff_event ON event_staff (event_id, status);
    CREATE INDEX IF NOT EXISTS idx_event_staff_user ON event_staff (user_id, status);

    CREATE TABLE IF NOT EXISTS ticket_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      ticket_type_id UUID NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
      buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
      transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
      order_reference TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 1,
      subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
      buyer_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
      business_commission NUMERIC(18,2) NOT NULL DEFAULT 0,
      business_net NUMERIC(18,2) NOT NULL DEFAULT 0,
      total NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_status TEXT NOT NULL DEFAULT 'queued',
      buyer_details JSONB NOT NULL DEFAULT '{}'::JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      paid_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_orders_buyer ON ticket_orders (buyer_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ticket_orders_event ON ticket_orders (event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ticket_orders_status ON ticket_orders (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      ticket_type_id UUID NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      ticket_code TEXT NOT NULL UNIQUE,
      qr_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      attendee_name TEXT,
      attendee_phone TEXT,
      attendee_email TEXT,
      status TEXT NOT NULL DEFAULT 'valid',
      delivery_status TEXT NOT NULL DEFAULT 'queued',
      scanned_at TIMESTAMPTZ,
      scanned_by UUID REFERENCES users(id) ON DELETE SET NULL,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets (owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets (event_id, status);
    CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets (order_id);

    -- RESERVED SEATING.
    --
    -- Until now every ticket type was general admission: a name, a price and a
    -- quantity. A seat is the other model — a specific place that exactly one
    -- person may hold — and the difference that matters is not the display, it
    -- is that a seat can be sold twice if nothing stops it.
    --
    -- Two constraints do the stopping, and they are in the database rather
    -- than in application code on purpose:
    --   * (event_id, section, row_label, seat_number) is unique, so a venue
    --     layout cannot contain the same seat twice.
    --   * tickets.seat_id is unique, so one seat can back at most one ticket.
    --     Whatever races, whatever retries, the second insert fails.
    CREATE TABLE IF NOT EXISTS event_seats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      ticket_type_id UUID REFERENCES event_ticket_types(id) ON DELETE SET NULL,
      section TEXT NOT NULL,
      row_label TEXT NOT NULL,
      seat_number TEXT NOT NULL,
      -- available: on sale. held: allocated to an order in flight. sold: has a
      -- ticket. blocked: the organiser has taken it out of sale (a camera
      -- position, a broken seat, a wheelchair space held back).
      status TEXT NOT NULL DEFAULT 'available',
      ticket_id UUID,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_seats_unique
      ON event_seats (event_id, section, row_label, seat_number);
    CREATE INDEX IF NOT EXISTS idx_event_seats_available
      ON event_seats (event_id, ticket_type_id, status) WHERE status = 'available';

    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS seat_id UUID REFERENCES event_seats(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_seat_unique ON tickets (seat_id) WHERE seat_id IS NOT NULL;

    -- A ticket type is seated or it is not. Derived from "does it have seats"
    -- would be ambiguous the moment a seated event sells out, so it is stated.
    ALTER TABLE event_ticket_types ADD COLUMN IF NOT EXISTS seated BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS ticket_refunds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      processed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      reason TEXT NOT NULL DEFAULT '',
      amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
      decision_note TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_refunds_event ON ticket_refunds (event_id, status);
    CREATE INDEX IF NOT EXISTS idx_ticket_refunds_order ON ticket_refunds (order_id);

    CREATE TABLE IF NOT EXISTS ticket_settlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
      settlement_reference TEXT NOT NULL UNIQUE,
      gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
      buyer_fees NUMERIC(18,2) NOT NULL DEFAULT 0,
      commission NUMERIC(18,2) NOT NULL DEFAULT 0,
      refunds NUMERIC(18,2) NOT NULL DEFAULT 0,
      net_settlement NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      processed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_settlements_event ON ticket_settlements (event_id, created_at DESC);

    /* ---- Event Tags -----------------------------------------------------
       Cashless NFC/RFID credentials for an event. A tag is a CREDENTIAL, not a
       wallet: there is deliberately no balance column here and no second
       ledger. A tap resolves the tag to the attendee's existing TitoPay wallet
       and the existing wallet_ledger does the rest.

       Every column is additive and every statement is IF NOT EXISTS, matching
       how the rest of this schema bootstraps. Events without cashless enabled
       are untouched and behave exactly as before. */
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cashless_tags_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    -- A registration event collects attendees rather than selling to them.
    -- It rides the existing free-ticket path, so the money rules are
    -- untouched: free needs no FICA, paid always does.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_mode BOOLEAN NOT NULL DEFAULT FALSE;
    -- Organiser socials, shown on the public event page.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::JSONB;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cashless_settings JSONB NOT NULL DEFAULT '{}'::JSONB;

    CREATE TABLE IF NOT EXISTS event_tags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      -- Only the SHA-256 of the tag credential is stored. The credential itself
      -- is shown once at issue time and never persisted, so a database read
      -- cannot yield a working tag.
      token_hash TEXT NOT NULL UNIQUE,
      -- A short opaque label for staff to identify a physical tag by sight.
      -- Deliberately not derived from the credential.
      tag_label TEXT NOT NULL,
      ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'UNASSIGNED'
        CHECK (status IN ('UNASSIGNED','ASSIGNED','ACTIVE','BLOCKED','LOST','REPLACED','DEACTIVATED')),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      blocked_at TIMESTAMPTZ,
      replaced_at TIMESTAMPTZ,
      deactivated_at TIMESTAMPTZ,
      replaced_by_tag_id UUID REFERENCES event_tags(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_tags_event ON event_tags (event_id, status);
    CREATE INDEX IF NOT EXISTS idx_event_tags_user ON event_tags (user_id, status);
    -- One live tag per ticket. A replacement can only be activated once the old
    -- one has left ASSIGNED/ACTIVE, which is what makes lost-tag replacement
    -- safe rather than a way to double up.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_event_tags_live_ticket
      ON event_tags (ticket_id) WHERE status IN ('ASSIGNED','ACTIVE') AND ticket_id IS NOT NULL;

    -- Which merchants may take Event Tag payments at which event. Absence of a
    -- row is a refusal, so vendors are isolated per event by construction.
    CREATE TABLE IF NOT EXISTS event_vendors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, merchant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_vendors_event ON event_vendors (event_id, status);

    -- Append-only trail of every sensitive tag action.
    CREATE TABLE IF NOT EXISTS event_tag_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tag_id UUID NOT NULL REFERENCES event_tags(id) ON DELETE CASCADE,
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      previous_status TEXT,
      next_status TEXT,
      actor_type TEXT,
      actor_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_tag_events_tag ON event_tag_events (tag_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_event_tag_events_event ON event_tag_events (event_id, created_at DESC);

    -- DISCOUNT CODES, THE ORGANISER'S OWN PROMOTION.
    --
    -- A coupon reduces the ticket price, so the organiser earns less on that
    -- sale. TitoPay's commission is charged on what the organiser actually
    -- received, never on the money the discount gave away, which is why the
    -- fees are recomputed on the discounted subtotal rather than the list one.
    --
    -- redeemed_count is a counter on the row rather than a COUNT over the
    -- redemptions table so that "is there one left?" can be answered under a
    -- single row lock inside the purchase transaction. The redemptions table
    -- is the audit trail and the per-customer tally.
    CREATE TABLE IF NOT EXISTS ticket_coupons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      -- NULL means the code works on every ticket type for this event.
      ticket_type_id UUID REFERENCES event_ticket_types(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'percentage',
      discount_value NUMERIC(18,2) NOT NULL DEFAULT 0,
      -- NULL expiry means the code runs until the organiser turns it off.
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      -- NULL means unlimited.
      max_redemptions INTEGER,
      max_per_customer INTEGER NOT NULL DEFAULT 1,
      redeemed_count INTEGER NOT NULL DEFAULT 0,
      discount_given NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT NOT NULL DEFAULT '',
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- One meaning per code per event. Two organisers may both run SUMMER20.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_coupons_event_code ON ticket_coupons (event_id, code);
    CREATE INDEX IF NOT EXISTS idx_ticket_coupons_event ON ticket_coupons (event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ticket_coupon_redemptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coupon_id UUID NOT NULL REFERENCES ticket_coupons(id) ON DELETE CASCADE,
      order_id UUID NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL DEFAULT 1,
      discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      -- Set when the order is refunded: the redemption stops counting against
      -- the coupon's remaining uses, because the sale did not stand.
      released_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_coupon_redemptions_coupon ON ticket_coupon_redemptions (coupon_id, released_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_coupon_redemptions_user ON ticket_coupon_redemptions (coupon_id, user_id, released_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_coupon_redemptions_order ON ticket_coupon_redemptions (order_id);

    -- Nullable with a zero default, so every order written before discount
    -- codes existed stays exactly as valid as it was. subtotal continues to
    -- hold what the buyer was actually charged for the tickets; this records
    -- what came off the list price to get there.
    ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS coupon_id UUID;
    ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

    -- A TICKET A CUSTOMER HAS PUT AWAY, NOT ONE THAT NEVER EXISTED.
    --
    -- My Tickets is a wallet, and a wallet nobody can tidy fills with last
    -- year's stubs until the one ticket needed at a gate is four screens down.
    -- So a customer can remove a ticket, and removing it hides it: the row
    -- stays, the money it represents stays auditable, the organiser's counts
    -- are untouched, and the customer can bring it back.
    --
    -- Deleting it outright was the other option and is wrong. A ticket is a
    -- paid asset and evidence in a refund dispute, and a scanned one is the
    -- record that somebody came through the gate.
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

    -- WHO ACTIONED A REFUND.
    --
    -- processed_by points at admin_users, because refunds used to be a TitoPay
    -- back-office job. An organiser is a customer, so their id cannot go in
    -- that column without breaking the foreign key. These record the organiser
    -- instead, and the role says which of the two acted.
    ALTER TABLE ticket_refunds ADD COLUMN IF NOT EXISTS processed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE ticket_refunds ADD COLUMN IF NOT EXISTS processed_by_role TEXT;

    -- A MULTI-DAY EVENT IS ONE EVENT WITH AN END DATE.
    --
    -- Deliberately not a recurrence engine. Every ticket, scan, report and
    -- settlement in this system keys off a single events row, so a series of
    -- occurrences would be a rewrite of the money path rather than a feature.
    -- A festival that runs Friday to Sunday is one event with one inventory,
    -- which is also how its organiser sells it.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS event_end_date DATE;

    -- WAITLIST: DEMAND THAT ARRIVES AFTER THE LAST TICKET.
    --
    -- A sold-out event is currently a dead end for the buyer and invisible to
    -- the organiser, who never learns that fifty more people wanted in. One
    -- row per person per ticket type, so releasing capacity has an audience to
    -- tell.
    CREATE TABLE IF NOT EXISTS ticket_waitlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      ticket_type_id UUID REFERENCES event_ticket_types(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'waiting',
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- One place in the queue per person per tier. Joining twice must not buy
    -- somebody two places ahead of everybody else.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_waitlist_unique
      ON ticket_waitlist (event_id, COALESCE(ticket_type_id, '00000000-0000-0000-0000-000000000000'::UUID), user_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_waitlist_event ON ticket_waitlist (event_id, status, created_at);

    -- PROMOTER LINKS: WHO ACTUALLY SOLD THE TICKET.
    --
    -- An organiser hands each promoter a link carrying a code. The code rides
    -- through to the order, so "who sold what" is answered from the ledger
    -- rather than from an argument after the event. This is attribution only:
    -- it moves no money and pays no commission, because paying promoters
    -- automatically would need its own agreement and its own compliance story.
    CREATE TABLE IF NOT EXISTS event_promoters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      promoter_name TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      clicks INTEGER NOT NULL DEFAULT 0,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_promoters_event_code ON event_promoters (event_id, code);
    ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS promoter_id UUID;
    CREATE INDEX IF NOT EXISTS idx_ticket_orders_promoter ON ticket_orders (promoter_id) WHERE promoter_id IS NOT NULL;
  `);
  await ensureDefaultPricingRule("ticket_purchase");
  await ensureDefaultPricingRule("ticket_business_commission");
  await ensureDefaultPricingRule("ticket_buyer_service_fee");
  await ensureDefaultPricingRule("ticket_refund_processing");
  await ensureDefaultPricingRule("ticket_scanning");
  await ensureDefaultPricingRule("ticket_staff_access");
  // transactions.service_code is a foreign key into pricing_rules, so this row
  // has to exist before the first Event Tag tap can be written to the ledger.
  await ensureDefaultPricingRule("event_tag");
}

async function eventAudit({ eventId, actorType, actorId, action, metadata = {}, ipAddress, userAgent }) {
  await ensureTicketingSchema();
  await pool.query(
    `INSERT INTO event_audit_logs (id, event_id, actor_type, actor_id, action, metadata, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8)`,
    [randomUUID(), eventId || null, actorType, actorId || null, action, JSON.stringify(metadata || {}), ipAddress || null, userAgent || null]
  );
  await writeAuditLog({
    actorType,
    actorId: actorId || null,
    action,
    entityType: "event",
    entityId: eventId || null,
    ipAddress,
    userAgent,
    metadata
  }).catch((error) => {
    console.error("[ticketing-audit-log-failed]", { action, eventId, message: error.message });
  });
}

async function getBusinessEligibility(userId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.account_type,
       u.full_name,
       u.username,
       u.email,
       u.phone,
       u.status AS user_status,
       u.profile_locked,
       u.fica_status,
       m.id AS merchant_uuid,
       m.business_name,
       m.merchant_id,
       m.status AS merchant_status,
       m.verification_status AS merchant_verification_status,
       w.id AS wallet_id,
       w.wallet_number,
       w.status AS wallet_status
     FROM users u
     LEFT JOIN merchants m ON m.user_id = u.id
     LEFT JOIN wallets w ON w.user_id = u.id AND w.kind = 'business'
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "TitoPay account not found");

  // Two kinds of requirement, and the split is the whole point of free events.
  //
  // STRUCTURAL requirements are the bare minimum to be a real, usable business
  // account: it IS a business, it is active and unrestricted, and it is not
  // locked. Nothing more. A free seminar or conference can be created on this
  // alone — no merchant profile, no completed business registration, no FICA.
  //
  // PAYMENT requirements gate the ability to RECEIVE MONEY: a registered merchant
  // profile, completed registration details, approved verification, FICA and an
  // active wallet. A free event receives nothing, so it needs none of them. They
  // come back the moment an event carries a paid ticket, enforced at create,
  // edit AND submit, so a free draft cannot quietly become a paid one. The
  // merchant-profile and registration checks used to sit in the structural list,
  // which is what blocked a business from setting up a free event — they belong
  // here with the rest of the money-readiness checks.
  const structuralBlockers = [];
  if (row.account_type !== "business") structuralBlockers.push("Only TitoPay Business accounts can create events.");
  if (row.user_status !== "active" || BLOCKED_USER_STATUSES.has(row.user_status)) structuralBlockers.push("Business account must be active and unrestricted.");
  if (row.profile_locked) structuralBlockers.push("Business profile is locked. Contact TitoPay Support.");

  const paymentBlockers = [];
  if (!row.merchant_uuid) paymentBlockers.push("A registered business merchant profile is required before selling paid tickets.");
  if (row.merchant_uuid && row.merchant_status !== "active") paymentBlockers.push("Business merchant profile must be active before selling paid tickets.");
  if (!row.business_name || !row.merchant_id) paymentBlockers.push("Business registration details must be completed before selling paid tickets.");
  if (!VERIFIED_STATUSES.has(String(row.fica_status || "").toLowerCase())) paymentBlockers.push("Full business FICA verification is required before selling paid tickets.");
  if (row.merchant_uuid && !VERIFIED_STATUSES.has(String(row.merchant_verification_status || "").toLowerCase())) paymentBlockers.push("Business verification must be fully approved before selling paid tickets.");
  if (!row.wallet_id || row.wallet_status !== "active") paymentBlockers.push("An active business wallet is required to receive ticket payments.");

  // `blockers` and `eligible` keep their original meaning — fully ready to sell
  // paid tickets — so existing callers and the eligibility endpoint the PWA
  // already reads do not change behaviour.
  const blockers = [...structuralBlockers, ...paymentBlockers];

  return {
    eligible: blockers.length === 0,
    blockers,
    structuralBlockers,
    paymentBlockers,
    // Can this business create and run a FREE event right now?
    canCreateFreeEvents: structuralBlockers.length === 0,
    action: blockers.some((item) => /FICA|verification/i.test(item)) ? "complete_fica" : "contact_support",
    business: {
      userId: row.id,
      fullName: row.full_name,
      username: row.username,
      email: row.email,
      phone: row.phone,
      ficaStatus: row.fica_status,
      merchantId: row.merchant_uuid,
      merchantCode: row.merchant_id,
      businessName: row.business_name,
      merchantStatus: row.merchant_status,
      merchantVerificationStatus: row.merchant_verification_status,
      walletId: row.wallet_id,
      walletNumber: row.wallet_number,
      walletStatus: row.wallet_status
    }
  };
}

// Does this set of ticket types charge anyone anything?
function ticketTypesIncludePaid(ticketTypes = []) {
  return (Array.isArray(ticketTypes) ? ticketTypes : [])
    .some((item) => Number(item.price ?? item.price_amount ?? 0) > 0);
}

// The single gate every event-writing path calls. Structural blockers stop any
// event; payment blockers stop only an event that carries a paid ticket. Called
// at create, edit and submit, so the check re-runs whenever the ticket mix could
// have changed — a free draft that gains a paid tier is caught here, not waved
// through because it started free.
function assertTicketingEligibility(eligibility, ticketTypes, verbPhrase) {
  if (eligibility.structuralBlockers.length) {
    throw new AppError(403, `Business verification is required before ${verbPhrase}`,
      { ...eligibility, blockers: eligibility.structuralBlockers });
  }
  if (ticketTypesIncludePaid(ticketTypes) && eligibility.paymentBlockers.length) {
    throw new AppError(403, "Full business FICA verification is required before selling paid tickets",
      { ...eligibility, blockers: eligibility.paymentBlockers, action: "complete_fica" });
  }
}

// The event poster. Two shapes are accepted: an uploaded image, which arrives
// as a base64 data URL exactly like profile photos do and is stored the same
// way, and a plain http(s) URL, which is the historical behaviour and stays
// working. A data URL is size-checked here as a backstop — the client resizes
// first — because it lands in the events row and the JSON body limit is 768 KB.
function cleanEventBanner(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
    if (Buffer.byteLength(raw, "utf8") > 700 * 1024) {
      throw new AppError(413, "Event poster is too large. Choose a smaller image.");
    }
    return raw;
  }
  if (/^https?:\/\//i.test(raw)) return raw.slice(0, 800);
  return "";
}

// THE SLUG IS THE LINK AN ORGANISER SENDS TO THEIR AUDIENCE.
//
// A free name is used as it is, and always has been:
//
//   app.titopay.co.za/events/titopay-launch
//
// The question is only what happens on a COLLISION, when a second event wants a
// name some other event already holds. That used to append six characters of a
// sha1 digest:
//
//   app.titopay.co.za/events/titopay-launch-3d4c29
//
// which is unreadable, impossible to say out loud, and looks like something has
// gone wrong. It is now the obvious thing, the way every publishing tool does
// it: the next free number.
//
//   titopay-launch, titopay-launch-2, titopay-launch-3
//
// Only NEW slugs are affected. Every event already published keeps the exact
// slug it has, so no link that has been shared, printed or posted changes.
async function uniqueSlug(base, eventId = null) {
  const candidate = slugify(base);
  const taken = async (value) => {
    const { rows } = await pool.query(
      "SELECT id FROM events WHERE slug = $1 AND ($2::UUID IS NULL OR id <> $2::UUID) LIMIT 1", [value, eventId]);
    return Boolean(rows[0]);
  };
  if (!(await taken(candidate))) return candidate;
  for (let counter = 2; counter <= 50; counter += 1) {
    const value = `${candidate}-${counter}`;
    if (!(await taken(value))) return value;
  }
  // Fifty events sharing one name is not a naming problem any more. A short
  // digest ends the loop rather than letting it run without a bound.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = `${candidate}-${createHash("sha1")
      .update(`${base}:${Date.now()}:${Math.random()}:${attempt}`).digest("hex").slice(0, 6)}`;
    if (!(await taken(value))) return value;
  }
  throw new AppError(409, "Could not create a web address for this event. Try a slightly different name.");
}

/* ---- Ticket phases -------------------------------------------------------
   A phase is a ticket type with a gate on it. Early Bird runs until the end of
   the month or until 100 are gone, whichever comes first; General opens after
   it. Both gates already had columns (sales_opening_at, sales_closing_at,
   quantity_available) and both were SELECTed at purchase and then ignored, so
   an organiser could set a window and watch TitoPay sell straight through it.

   This is the decision, kept pure so it can be tested without a database and
   so the buyer, the organiser and the server all read the same rule.

   A NULL window means "no restriction", which is what every ticket sold so far
   has. That is deliberate: enforcement must not retroactively close events
   that were created before phases existed. */
const PHASE_STATES = {
  scheduled: "Opens later",
  on_sale: "On sale",
  sold_out: "Sold out",
  closed: "Closed"
};

function ticketPhaseState(row = {}, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const opensAt = row.sales_opening_at ?? row.salesOpeningAt ?? null;
  const closesAt = row.sales_closing_at ?? row.salesClosingAt ?? null;
  const opens = opensAt ? new Date(opensAt).getTime() : null;
  const closes = closesAt ? new Date(closesAt).getTime() : null;
  const total = Number(row.quantity_available ?? row.quantityAvailable ?? 0);
  const taken = Number(row.quantity_reserved ?? row.quantityReserved ?? 0)
    + Number(row.quantity_sold ?? row.quantitySold ?? 0);
  const remaining = Math.max(0, total - taken);

  // Order matters. A phase that has not opened says so even if it has no
  // stock yet, because the organiser can still add stock before it opens.
  let state = "on_sale";
  if (opens && Number.isFinite(opens) && at < opens) state = "scheduled";
  else if (closes && Number.isFinite(closes) && at > closes) state = "closed";
  else if (remaining <= 0) state = "sold_out";

  return {
    state,
    label: PHASE_STATES[state],
    onSale: state === "on_sale",
    remaining,
    opensAt: opensAt || null,
    closesAt: closesAt || null
  };
}

// One sentence a buyer can act on, for whichever gate is closed.
function phaseRefusalMessage(phase, ticketName = "This ticket") {
  if (phase.state === "scheduled") {
    return `${ticketName} goes on sale on ${new Date(phase.opensAt).toLocaleString("en-ZA", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg"
    })}.`;
  }
  if (phase.state === "closed") return `Sales for ${ticketName} have closed.`;
  if (phase.state === "sold_out") return `${ticketName} is sold out.`;
  return "";
}

/* ---- Organiser social links ----------------------------------------------
   Rendered on the public event page, so every one of them is a link a
   stranger will click. Only https is allowed: a javascript: or data: URL in
   an organiser field would be stored XSS on a page anyone can visit. */
const SOCIAL_PLATFORMS = ["website", "instagram", "facebook", "x", "tiktok", "youtube", "whatsapp"];

function cleanSocialUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // A bare handle or domain is what people paste. Give it a scheme rather
  // than refusing it, but never guess a scheme other than https.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    // http is upgraded rather than thrown away. Somebody pasting an http link
    // meant the page, not the scheme, and silently dropping their work is the
    // unhelpful answer. Every OTHER scheme is refused outright, which is what
    // keeps javascript: and data: off a page strangers open.
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return "";
    if (!url.hostname.includes(".")) return "";
    return url.toString().slice(0, 300);
  } catch {
    return "";
  }
}

function normalizeSocialLinks(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const links = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const cleaned = cleanSocialUrl(source[platform]);
    if (cleaned) links[platform] = cleaned;
  }
  return links;
}

function normalizeTicketTypes(items = [], { forceFree = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item, index) => ({
      ticketName: cleanText(item.ticketName || item.ticket_name || item.name || "General", 120),
      description: cleanText(item.description, 500),
      price: forceFree ? 0 : money(item.price),
      quantityAvailable: Math.max(0, Number.parseInt(item.quantityAvailable ?? item.quantity_available ?? item.quantity ?? 0, 10) || 0),
      minPurchaseQuantity: Math.max(1, Number.parseInt(item.minPurchaseQuantity ?? item.min_purchase_quantity ?? 1, 10) || 1),
      maxPurchaseQuantity: Math.max(1, Number.parseInt(item.maxPurchaseQuantity ?? item.max_purchase_quantity ?? 10, 10) || 10),
      salesOpeningAt: item.salesOpeningAt || item.sales_opening_at || null,
      salesClosingAt: item.salesClosingAt || item.sales_closing_at || null,
      perCustomerPurchaseLimit: item.perCustomerPurchaseLimit || item.per_customer_purchase_limit || null,
      attendeeDetailsRequired: Boolean(item.attendeeDetailsRequired ?? item.attendee_details_required),
      // Defaults to ALLOWED, not to false. Boolean(undefined) is false, and no
      // organiser UI has ever sent this field — so defaulting to false meant
      // every ticket type on the platform said "not transferable" while the
      // claim happily transferred it. Now that the claim enforces the column,
      // the default has to describe the behaviour organisers actually expect.
      transferAllowed: item.transferAllowed ?? item.transfer_allowed ?? true,
      refundsAllowed: Boolean(item.refundsAllowed ?? item.refunds_allowed),
      refundDeadline: item.refundDeadline || item.refund_deadline || null,
      refundConditions: cleanText(item.refundConditions || item.refund_conditions, 800),
      sortOrder: Number.parseInt(item.sortOrder ?? item.sort_order ?? ((index + 1) * 10), 10)
    }))
    .filter((item) => item.ticketName);
}

function normalizeDocuments(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => ({
      documentType: cleanText(item.documentType || item.document_type || "supporting_document", 80),
      documentName: cleanText(item.documentName || item.document_name || item.name || "Supporting document", 160),
      fileUrl: cleanText(item.fileUrl || item.file_url || item.url || "", 800)
    }))
    .filter((item) => item.documentType && item.documentName);
}

function eventPayload(payload = {}, eligibility) {
  const eventName = cleanText(payload.eventName || payload.event_name || payload.name, 180);
  if (!eventName) throw new AppError(400, "Event name is required");
  const refundPolicy = toJson(payload.refundPolicy || payload.refund_policy, {});
  const eventImages = toJson(payload.eventImages || payload.event_images, []);
  return {
    eventName,
    category: cleanText(payload.category || "general", 100),
    description: cleanText(payload.description, 5000),
    eventDate: payload.eventDate || payload.event_date || null,
    startTime: cleanText(payload.startTime || payload.start_time, 20),
    endTime: cleanText(payload.endTime || payload.end_time, 20),
    venueName: cleanText(payload.venueName || payload.venue_name, 180),
    fullVenueAddress: cleanText(payload.fullVenueAddress || payload.full_venue_address, 500),
    city: cleanText(payload.city, 120),
    province: cleanText(payload.province, 120),
    country: cleanText(payload.country || "South Africa", 120),
    eventMode: ["physical", "online", "hybrid"].includes(String(payload.eventMode || payload.event_mode || "physical")) ? String(payload.eventMode || payload.event_mode || "physical") : "physical",
    organiserDetails: toJson(payload.organiserDetails || payload.organiser_details, {}),
    businessDetails: toJson(payload.businessDetails || payload.business_details, {
      // A free event may have no merchant profile yet, so fall back to the
      // account's own name rather than leaving the organiser blank.
      businessName: eligibility?.business?.businessName || eligibility?.business?.fullName,
      merchantCode: eligibility?.business?.merchantCode
    }),
    contactEmail: cleanEmail(payload.contactEmail || payload.contact_email || eligibility?.business?.email),
    contactNumber: cleanPhone(payload.contactNumber || payload.contact_number || eligibility?.business?.phone),
    eventBannerUrl: cleanEventBanner(payload.eventBannerUrl || payload.event_banner_url),
    eventImages: Array.isArray(eventImages) ? eventImages.slice(0, 10) : [],
    ageRestriction: cleanText(payload.ageRestriction || payload.age_restriction, 120),
    capacity: payload.capacity === undefined || payload.capacity === "" ? null : Math.max(0, Number.parseInt(payload.capacity, 10) || 0),
    termsConditions: cleanText(payload.termsConditions || payload.terms_conditions, 8000),
    refundPolicy,
    entryRules: cleanText(payload.entryRules || payload.entry_rules, 3000),
    prohibitedItems: cleanText(payload.prohibitedItems || payload.prohibited_items, 3000),
    accessibilityInformation: cleanText(payload.accessibilityInformation || payload.accessibility_information, 3000),
    parkingInformation: cleanText(payload.parkingInformation || payload.parking_information, 3000),
    additionalInstructions: cleanText(payload.additionalInstructions || payload.additional_instructions, 3000),
    registrationMode: Boolean(payload.registrationMode ?? payload.registration_mode ?? false),
    socialLinks: normalizeSocialLinks(payload.socialLinks || payload.social_links),
    ticketTypes: normalizeTicketTypes(payload.ticketTypes || payload.ticket_types, {
      // A registration event cannot charge. Forcing it here rather than
      // trusting the client means a registration event can never quietly
      // become a paid one, which would need FICA the organiser has not done.
      forceFree: Boolean(payload.registrationMode ?? payload.registration_mode ?? false)
    }),
    documents: normalizeDocuments(payload.documents)
  };
}

function validateEventSubmission(event, ticketTypes) {
  const missing = [];
  if (!event.event_date) missing.push("Event date");
  if (!event.start_time) missing.push("Start time");
  if (!event.end_time) missing.push("End time");
  if (event.event_mode !== "online" && !event.venue_name) missing.push("Venue name");
  if (event.event_mode !== "online" && !event.full_venue_address) missing.push("Venue address");
  if (!event.city) missing.push("City");
  if (!event.province) missing.push("Province");
  if (!event.contact_email && !event.contact_number) missing.push("Contact email or contact number");
  if (!event.terms_conditions || event.terms_conditions.length < 12) missing.push("Terms and conditions");
  const refundPolicy = event.refund_policy || {};
  if (!refundPolicy || typeof refundPolicy !== "object" || !String(refundPolicy.summary || refundPolicy.conditions || refundPolicy.refundConditions || "").trim()) {
    missing.push("Refund policy");
  }
  if (!ticketTypes.length) missing.push("At least one ticket type");
  if (ticketTypes.some((item) => item.quantity_available <= 0)) missing.push("Ticket quantity");
  if (ticketTypes.some((item) => Number(item.price) < 0)) missing.push("Ticket price");
  if (missing.length) {
    throw new AppError(400, "Complete required event details before submission", { missing });
  }
}

function publicEvent(row = {}, ticketTypes = [], documents = []) {
  return {
    id: row.id,
    status: row.status,
    slug: row.slug,
    eventName: row.event_name,
    category: row.category,
    description: row.description,
    eventDate: row.event_date,
    startTime: row.start_time,
    endTime: row.end_time,
    venueName: row.venue_name,
    fullVenueAddress: row.full_venue_address,
    city: row.city,
    province: row.province,
    country: row.country,
    eventMode: row.event_mode,
    organiserDetails: row.organiser_details,
    businessDetails: row.business_details,
    contactEmail: row.contact_email,
    contactNumber: row.contact_number,
    eventBannerUrl: row.event_banner_url,
    eventImages: row.event_images || [],
    ageRestriction: row.age_restriction,
    capacity: row.capacity,
    termsConditions: row.terms_conditions,
    refundPolicy: row.refund_policy || {},
    entryRules: row.entry_rules,
    prohibitedItems: row.prohibited_items,
    accessibilityInformation: row.accessibility_information,
    parkingInformation: row.parking_information,
    additionalInstructions: row.additional_instructions,
    marketingLink: row.status === "approved" ? `https://app.titopay.co.za/events/${row.slug}` : "",
    ticketTypes: ticketTypes.map(publicTicketType),
    documents: documents.map(publicDocument),
    // Whether the event runs cashless Event Tags. Not a secret — an attendee
    // benefits from knowing before they arrive — and it is what the organiser
    // and admin screens read to decide whether to offer the tag controls.
    cashlessTagsEnabled: Boolean(row.cashless_tags_enabled),
    // A registration event collects attendees instead of selling to them.
    registrationMode: Boolean(row.registration_mode),
    socialLinks: row.social_links && typeof row.social_links === "object" ? row.social_links : {},
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicTicketType(row = {}) {
  return {
    id: row.id,
    ticketName: row.ticket_name,
    description: row.description,
    price: Number(row.price || 0),
    quantityAvailable: Number(row.quantity_available || 0),
    quantityReserved: Number(row.quantity_reserved || 0),
    quantitySold: Number(row.quantity_sold || 0),
    minPurchaseQuantity: Number(row.min_purchase_quantity || 1),
    maxPurchaseQuantity: Number(row.max_purchase_quantity || 10),
    salesOpeningAt: row.sales_opening_at,
    salesClosingAt: row.sales_closing_at,
    perCustomerPurchaseLimit: row.per_customer_purchase_limit,
    attendeeDetailsRequired: Boolean(row.attendee_details_required),
    transferAllowed: Boolean(row.transfer_allowed),
    refundsAllowed: Boolean(row.refunds_allowed),
    refundDeadline: row.refund_deadline,
    refundConditions: row.refund_conditions,
    sortOrder: row.sort_order,
    phase: ticketPhaseState(row)
  };
}

function publicDocument(row = {}) {
  return {
    id: row.id,
    documentType: row.document_type,
    documentName: row.document_name,
    fileUrl: row.file_url,
    status: row.status,
    reviewNote: row.review_note || "",
    createdAt: row.created_at
  };
}

async function getTicketTypes(eventId) {
  const { rows } = await pool.query("SELECT * FROM event_ticket_types WHERE event_id = $1 ORDER BY sort_order ASC, created_at ASC", [eventId]);
  return rows;
}

async function getDocuments(eventId) {
  const { rows } = await pool.query("SELECT * FROM event_documents WHERE event_id = $1 ORDER BY created_at ASC", [eventId]);
  return rows;
}

async function replaceTicketTypes(eventId, ticketTypes) {
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]);
  for (const item of ticketTypes) {
    await pool.query(
      `INSERT INTO event_ticket_types
       (id, event_id, ticket_name, description, price, quantity_available, min_purchase_quantity, max_purchase_quantity, sales_opening_at, sales_closing_at, per_customer_purchase_limit, attendee_details_required, transfer_allowed, refunds_allowed, refund_deadline, refund_conditions, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        randomUUID(),
        eventId,
        item.ticketName,
        item.description,
        item.price,
        item.quantityAvailable,
        item.minPurchaseQuantity,
        item.maxPurchaseQuantity,
        item.salesOpeningAt,
        item.salesClosingAt,
        item.perCustomerPurchaseLimit,
        item.attendeeDetailsRequired,
        item.transferAllowed,
        item.refundsAllowed,
        item.refundDeadline,
        item.refundConditions,
        item.sortOrder
      ]
    );
  }
}

async function replaceDocuments(eventId, documents) {
  if (!documents.length) return;
  await pool.query("DELETE FROM event_documents WHERE event_id = $1 AND status = 'uploaded'", [eventId]);
  for (const item of documents) {
    await pool.query(
      `INSERT INTO event_documents (id, event_id, document_type, document_name, file_url, status)
       VALUES ($1,$2,$3,$4,$5,'uploaded')`,
      [randomUUID(), eventId, item.documentType, item.documentName, item.fileUrl]
    );
  }
}

async function createEventDraft(userId, payload, meta = {}) {
  await ensureTicketingSchema();
  const eligibility = await getBusinessEligibility(userId);
  const data = eventPayload(payload, eligibility);
  // Free events need only the structural checks; paid ones need FICA too.
  assertTicketingEligibility(eligibility, data.ticketTypes, "creating events");
  const eventId = randomUUID();
  const slug = await uniqueSlug(data.eventName);
  const { rows } = await pool.query(
    `INSERT INTO events
     (id, business_user_id, merchant_id, status, slug, event_name, category, description, event_date, start_time, end_time, venue_name, full_venue_address, city, province, country, event_mode, organiser_details, business_details, contact_email, contact_number, event_banner_url, event_images, age_restriction, capacity, terms_conditions, refund_policy, entry_rules, prohibited_items, accessibility_information, parking_information, additional_instructions, registration_mode, social_links)
     VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::JSONB,$18::JSONB,$19,$20,$21,$22::JSONB,$23,$24,$25,$26::JSONB,$27,$28,$29,$30,$31,$32,$33::JSONB)
     RETURNING *`,
    [
      eventId,
      userId,
      eligibility.business.merchantId,
      slug,
      data.eventName,
      data.category,
      data.description,
      data.eventDate,
      data.startTime,
      data.endTime,
      data.venueName,
      data.fullVenueAddress,
      data.city,
      data.province,
      data.country,
      data.eventMode,
      JSON.stringify(data.organiserDetails),
      JSON.stringify(data.businessDetails),
      data.contactEmail,
      data.contactNumber,
      data.eventBannerUrl,
      JSON.stringify(data.eventImages),
      data.ageRestriction,
      data.capacity,
      data.termsConditions,
      JSON.stringify(data.refundPolicy),
      data.entryRules,
      data.prohibitedItems,
      data.accessibilityInformation,
      data.parkingInformation,
      data.additionalInstructions,
      data.registrationMode,
      JSON.stringify(data.socialLinks)
    ]
  );
  await replaceTicketTypes(eventId, data.ticketTypes);
  await replaceDocuments(eventId, data.documents);
  await eventAudit({ eventId, actorType: "customer", actorId: userId, action: "event_draft_created", metadata: { slug }, ...meta });
  return publicEvent(rows[0], await getTicketTypes(eventId), await getDocuments(eventId));
}

/* THE POSTER IS THE ONE THING AN ORGANISER MAY CHANGE ON A LIVE EVENT.
 *
 * Everything else about an approved event goes through a change request an
 * admin reviews, and that is right: the date, the venue, the price and the
 * refund terms are what a buyer decided on. The poster is different. It is the
 * shop window, it is the thing most often wrong on the day, and an organiser
 * who cannot fix a crooked or cropped poster on a selling event has a broken
 * event and no way to help themselves.
 *
 * So it replaces immediately, and every replacement is written to the event
 * audit log with who did it and when. Nothing else on the event is touched:
 * this reads and writes exactly one column.
 *
 * A finished or cancelled event is refused. There is nothing to advertise, and
 * a poster changing under a closed event only confuses whoever is looking at
 * the record later.
 */
const POSTER_LOCKED_STATUSES = new Set(["cancelled", "completed"]);
async function replaceEventPoster(userId, eventId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT id, status, event_name, event_banner_url FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1",
    [eventId, userId]
  );
  const existing = rows[0];
  if (!existing) throw new AppError(404, "Event not found");
  if (POSTER_LOCKED_STATUSES.has(existing.status)) {
    throw new AppError(409, existing.status === "cancelled"
      ? "This event is cancelled, so its poster can no longer be changed."
      : "This event has finished, so its poster can no longer be changed.");
  }

  const poster = cleanEventBanner(payload.eventBannerUrl || payload.event_banner_url || payload.poster);
  if (!poster) {
    throw new AppError(400, "Choose a poster image to upload. JPG, PNG or WebP.");
  }

  const { rows: updated } = await pool.query(
    "UPDATE events SET event_banner_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [poster, eventId]
  );
  await eventAudit({
    eventId,
    actorType: "customer",
    actorId: userId,
    action: "event_poster_replaced",
    // The images themselves are far too big for an audit row, so what is kept
    // is enough to answer "was there one before, and did this actually change
    // anything" without storing the pictures twice.
    metadata: {
      status: existing.status,
      hadPoster: Boolean(existing.event_banner_url),
      replacedIdenticalImage: existing.event_banner_url === poster,
      eventName: existing.event_name || ""
    },
    ...meta
  });
  return publicEvent(updated[0], await getTicketTypes(eventId), await getDocuments(eventId));
}

async function updateEventDraft(userId, eventId, payload, meta = {}) {
  await ensureTicketingSchema();
  const { rows: existingRows } = await pool.query("SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, userId]);
  const existing = existingRows[0];
  if (!existing) throw new AppError(404, "Event not found");
  if (!["draft", "additional_information_required", "rejected"].includes(existing.status)) {
    throw new AppError(409, "This event can no longer be edited in the PWA");
  }
  const eligibility = await getBusinessEligibility(userId);
  const data = eventPayload({ ...existing, ...payload, eventName: payload.eventName || payload.event_name || existing.event_name }, eligibility);
  // Re-checked on every edit: adding a paid tier to a free draft trips FICA here.
  assertTicketingEligibility(eligibility, data.ticketTypes, "editing events");
  const slug = payload.eventName || payload.event_name ? await uniqueSlug(data.eventName, eventId) : existing.slug;
  const { rows } = await pool.query(
    `UPDATE events
     SET slug=$3, event_name=$4, category=$5, description=$6, event_date=$7, start_time=$8, end_time=$9,
         venue_name=$10, full_venue_address=$11, city=$12, province=$13, country=$14, event_mode=$15,
         organiser_details=$16::JSONB, business_details=$17::JSONB, contact_email=$18, contact_number=$19,
         event_banner_url=$20, event_images=$21::JSONB, age_restriction=$22, capacity=$23, terms_conditions=$24,
         refund_policy=$25::JSONB, entry_rules=$26, prohibited_items=$27, accessibility_information=$28,
         parking_information=$29, additional_instructions=$30,
         registration_mode=$31, social_links=$32::JSONB, updated_at=NOW()
     WHERE id=$1 AND business_user_id=$2
     RETURNING *`,
    [
      eventId,
      userId,
      slug,
      data.eventName,
      data.category,
      data.description,
      data.eventDate,
      data.startTime,
      data.endTime,
      data.venueName,
      data.fullVenueAddress,
      data.city,
      data.province,
      data.country,
      data.eventMode,
      JSON.stringify(data.organiserDetails),
      JSON.stringify(data.businessDetails),
      data.contactEmail,
      data.contactNumber,
      data.eventBannerUrl,
      JSON.stringify(data.eventImages),
      data.ageRestriction,
      data.capacity,
      data.termsConditions,
      JSON.stringify(data.refundPolicy),
      data.entryRules,
      data.prohibitedItems,
      data.accessibilityInformation,
      data.parkingInformation,
      data.additionalInstructions,
      data.registrationMode,
      JSON.stringify(data.socialLinks)
    ]
  );
  await replaceTicketTypes(eventId, data.ticketTypes);
  await replaceDocuments(eventId, data.documents);
  await eventAudit({ eventId, actorType: "customer", actorId: userId, action: "event_draft_updated", metadata: { slug }, ...meta });
  return publicEvent(rows[0], await getTicketTypes(eventId), await getDocuments(eventId));
}

async function submitEvent(userId, eventId, meta = {}) {
  await ensureTicketingSchema();
  const eligibility = await getBusinessEligibility(userId);
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, userId]);
  const event = rows[0];
  if (!event) throw new AppError(404, "Event not found");
  if (!["draft", "additional_information_required", "rejected"].includes(event.status)) {
    throw new AppError(409, "This event has already been submitted for review");
  }
  const ticketTypes = await getTicketTypes(eventId);
  // The authoritative gate: submission is where a paid event leaves the
  // business's hands for review, so the FICA requirement for paid tickets is
  // enforced against the tickets actually stored, not a client-supplied payload.
  assertTicketingEligibility(eligibility, ticketTypes, "submitting events");
  validateEventSubmission(event, ticketTypes);
  const { rows: updated } = await pool.query(
    `UPDATE events SET status='submitted', submitted_at=NOW(), rejection_reason=NULL, suspended_reason=NULL, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [eventId]
  );
  await eventAudit({ eventId, actorType: "customer", actorId: userId, action: "event_submitted", metadata: { status: "submitted" }, ...meta });
  // Confirm the submission by email. Non-blocking on purpose — a mail hiccup
  // must never fail a submission that has already been recorded.
  const organiserEmail = cleanEmail(event.contact_email || eligibility.business?.email || "");
  if (organiserEmail) {
    deliverEmail({
      to: organiserEmail,
      subject: `We've received your event: ${event.event_name}`,
      body: [
        `Hi${eligibility.business?.fullName ? ` ${eligibility.business.fullName}` : ""},`,
        "",
        `Your event "${event.event_name}" has been submitted to TitoPay for approval.`,
        "",
        "Our team reviews new events before they go live. You'll get another email once it is approved, or if we need any more information.",
        "",
        "You can track its status any time under Business Ticketing in the TitoPay app.",
        "",
        "TitoPay"
      ].join("\n"),
      metadata: { eventId, purpose: "event_submission_confirmation" }
    }).catch((error) => console.error("[event-submission-email-failed]", { eventId, message: error.message }));
  }
  return publicEvent(updated[0], ticketTypes, await getDocuments(eventId));
}

async function listBusinessEvents(userId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT * FROM events WHERE business_user_id = $1 ORDER BY updated_at DESC", [userId]);
  const items = [];
  for (const row of rows) items.push(publicEvent(row, await getTicketTypes(row.id), await getDocuments(row.id)));
  return items;
}

async function getBusinessEvent(userId, eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, userId]);
  if (!rows[0]) throw new AppError(404, "Event not found");
  return publicEvent(rows[0], await getTicketTypes(eventId), await getDocuments(eventId));
}

/* ==========================================================================
   BROWSING WHAT IS ON
   ==========================================================================
   Search and category filtering happen HERE rather than in the app. The old
   screen pulled 100 events and filtered them in JavaScript, which meant the
   101st event was invisible to search no matter what somebody typed, and a
   phone on a slow connection paid for every event's poster to filter three of
   them out. Doing it in SQL means search covers the whole catalogue and the
   phone downloads only what it shows.
   ========================================================================== */

// The categories a buyer can filter by. Organisers pick from this list, which
// is what makes the filter trustworthy: free text produced "Concert", "concert"
// and "Live Music" as three separate things nobody could browse.
//
// Free text already stored on existing events is NOT rewritten. It still shows
// on the event and is still searchable; it simply does not become a chip.
const EVENT_CATEGORIES = [
  "Music & Concerts",
  "Festivals",
  "Sports & Fitness",
  "Conferences & Business",
  "Workshops & Training",
  "Food & Drink",
  "Arts & Culture",
  "Comedy & Theatre",
  "Nightlife & Parties",
  "Community & Faith",
  "Family & Kids",
  "Charity & Fundraising",
  "Other"
];

async function listPublicApprovedEvents({ search = "", category = "", limit = 60 } = {}) {
  await ensureTicketingSchema();
  const term = cleanText(search, 80).trim();
  const chosenCategory = cleanText(category, 80).trim();
  const capped = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 60));

  const values = [];
  const where = ["status = 'approved'"];
  if (term) {
    // One parameter, matched across the fields a person actually thinks in:
    // the event, where it is, and what kind of thing it is. ILIKE with a
    // parameter, never string building, so a search box can never become SQL.
    values.push(`%${term}%`);
    where.push(`(event_name ILIKE $${values.length}
              OR venue_name ILIKE $${values.length}
              OR city ILIKE $${values.length}
              OR province ILIKE $${values.length}
              OR category ILIKE $${values.length}
              OR description ILIKE $${values.length})`);
  }
  if (chosenCategory) {
    values.push(chosenCategory);
    where.push(`category = $${values.length}`);
  }
  const clause = where.join(" AND ");

  // The facet list is built from the WHOLE approved catalogue, not from the
  // filtered rows: a category chip has to stay on screen after it is tapped,
  // and a buyer needs to see the categories they could switch to.
  const { rows: facetRows } = await pool.query(
    `SELECT category, COUNT(*)::INT AS count
       FROM events
      WHERE status = 'approved' AND category IS NOT NULL AND category <> ''
      GROUP BY category
      ORDER BY count DESC, category ASC`
  );

  values.push(capped);
  const { rows } = await pool.query(
    `SELECT * FROM events
      WHERE ${clause}
      ORDER BY event_date ASC NULLS LAST, approved_at DESC
      LIMIT $${values.length}`,
    values
  );
  const items = [];
  for (const row of rows) items.push(publicEvent(row, await getTicketTypes(row.id), []));
  return {
    items,
    categories: facetRows.map((row) => ({ category: row.category, count: Number(row.count) })),
    total: items.length,
    search: term,
    activeCategory: chosenCategory
  };
}

// A CANCELLED EVENT IS ANSWERED, NOT HIDDEN.
//
// This used to match status = 'approved' only, so the moment an event was
// cancelled its page answered 404 and every link to it died: the share a buyer
// posted, the link in their confirmation email, the poster QR on a wall. "Event
// is not available" reads as a broken link, and the people most likely to open
// it are the ones holding tickets who need to be told it is off.
//
// Cancelled events are served with the cancellation stated and selling closed.
// Everything else that is not approved stays a 404, because a draft or a
// rejected submission is not something the public was ever shown.
async function getPublicApprovedEvent(slug) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM events WHERE slug = $1 AND status IN ('approved', 'cancelled') LIMIT 1",
    [slugify(slug)]
  );
  if (!rows[0]) throw new AppError(404, "Event is not available");
  const cancelled = rows[0].status === "cancelled";
  const event = publicEvent(rows[0], await getTicketTypes(rows[0].id), []);
  // Nothing here needs to close selling: the purchase path matches
  // e.status = 'approved' of its own accord, so a cancelled event already
  // cannot be bought from. These two fields exist so the page can SAY so
  // rather than present a buyable-looking event that refuses at the last step.
  return {
    ...event,
    cancelled,
    cancelledNotice: cancelled
      ? "This event has been cancelled by the organiser. Tickets are no longer on sale. If you bought a ticket, open My Tickets in the TitoPay app for the refund position."
      : ""
  };
}

async function listAdminEvents({ status = "", limit = 150 } = {}) {
  await ensureTicketingSchema();
  const params = [];
  let where = "";
  if (status && EVENT_STATUSES.has(status)) {
    params.push(status);
    where = "WHERE e.status = $1";
  }
  params.push(Math.min(300, Math.max(1, Number(limit) || 150)));
  const { rows } = await pool.query(
    `SELECT e.*, u.full_name AS business_owner_name, u.fica_status AS owner_fica_status, m.business_name, m.verification_status AS merchant_verification_status
     FROM events e
     LEFT JOIN users u ON u.id = e.business_user_id
     LEFT JOIN merchants m ON m.id = e.merchant_id
     ${where}
     ORDER BY COALESCE(e.submitted_at, e.updated_at) DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({
    ...publicEvent(row, [], []),
    businessOwnerName: row.business_owner_name,
    businessName: row.business_name,
    ownerFicaStatus: row.owner_fica_status,
    merchantVerificationStatus: row.merchant_verification_status
  }));
}

async function getAdminEvent(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT e.*, u.full_name AS business_owner_name, u.email AS business_owner_email, u.phone AS business_owner_phone, u.fica_status AS owner_fica_status, m.business_name, m.verification_status AS merchant_verification_status
     FROM events e
     LEFT JOIN users u ON u.id = e.business_user_id
     LEFT JOIN merchants m ON m.id = e.merchant_id
     WHERE e.id = $1
     LIMIT 1`,
    [eventId]
  );
  if (!rows[0]) throw new AppError(404, "Event not found");
  const { rows: approvals } = await pool.query("SELECT * FROM event_approvals WHERE event_id = $1 ORDER BY created_at DESC", [eventId]);
  const { rows: audit } = await pool.query("SELECT * FROM event_audit_logs WHERE event_id = $1 ORDER BY created_at DESC LIMIT 100", [eventId]);
  return {
    ...publicEvent(rows[0], await getTicketTypes(eventId), await getDocuments(eventId)),
    businessOwnerName: rows[0].business_owner_name,
    businessOwnerEmail: rows[0].business_owner_email,
    businessOwnerPhone: rows[0].business_owner_phone,
    ownerFicaStatus: rows[0].owner_fica_status,
    businessName: rows[0].business_name,
    merchantVerificationStatus: rows[0].merchant_verification_status,
    approvals,
    audit
  };
}

function adminActionStatus(action) {
  const normalized = String(action || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const map = {
    under_review: "under_review",
    request_information: "additional_information_required",
    approve: "approved",
    reject: "rejected",
    suspend: "suspended",
    cancel: "cancelled",
    reinstate: "approved"
  };
  if (!map[normalized]) throw new AppError(400, "Unsupported ticketing action");
  return { action: normalized, status: map[normalized] };
}

// Which statuses each admin action may act FROM. Previously any action was
// accepted from any status, so an admin could approve a never-submitted draft
// (skipping submission validation), reject a live event, or reinstate a
// cancelled one. The change-request applier reuses this transition, so a loose
// state machine would let an organiser-triggered action land on a nonsensical
// state. draft is the organiser's private state; rejected is resolved by the
// organiser resubmitting; cancelled/completed are terminal.
const EVENT_ACTION_ALLOWED_FROM = {
  under_review: ["submitted", "under_review", "additional_information_required"],
  request_information: ["submitted", "under_review"],
  approve: ["submitted", "under_review", "additional_information_required"],
  reject: ["submitted", "under_review", "additional_information_required"],
  suspend: ["approved"],
  cancel: ["submitted", "under_review", "additional_information_required", "approved", "suspended"],
  reinstate: ["suspended"]
};

// Cancel a live event's tickets WITHOUT moving money. Buyers holding paid
// tickets must not be silently stranded: their tickets are invalidated (so they
// stop scanning in — see the scanTicket guard) and a refund REQUEST is opened
// for each paid order, which admin then settles through the existing, guarded
// processTicketRefund money path. Deliberately no wallet movement here: mass
// auto-refund could find a drained business wallet mid-cancel and leave the
// event half-refunded, which is exactly the "money mishandled" failure we must
// avoid. Idempotent — re-running invalidates nothing already invalidated and
// opens no duplicate refund request. Returns the buyers to notify.
async function cancelEventCascade(eventId, { reason = "", actorId = null, actorType = "admin" } = {}) {
  const client = await pool.connect();
  const cancelReason = cleanText(reason || "Event cancelled.", 1000);
  try {
    await client.query("BEGIN");
    // Serialize concurrent cancels of the same event. Without this, two
    // near-simultaneous cancels could both evaluate the refund dedup below on
    // pre-commit snapshots and open a duplicate refund request for the same
    // order (the duplicate could never move money twice — the order-status
    // guard in processTicketRefund blocks that — but it is a mess admin then
    // has to clean up). Transaction-scoped, keyed on the event.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-cancel:${eventId}`]);
    // Invalidate every still-valid ticket for the event. Scanned tickets are
    // left as-is (they represent a real entry that happened).
    await client.query(
      "UPDATE tickets SET status = 'cancelled', updated_at = NOW() WHERE event_id = $1 AND status = 'valid'",
      [eventId]
    );
    // Open a refund request for each paid order that actually moved money and
    // does not already have one open or settled. A free order moved no money, so
    // it gets no refund request.
    const { rows: refundTargets } = await client.query(
      `SELECT o.id AS order_id, o.buyer_user_id, o.subtotal, o.total,
              u.email, u.phone, u.full_name
         FROM ticket_orders o
         JOIN users u ON u.id = o.buyer_user_id
        WHERE o.event_id = $1
          AND o.status = 'paid'
          AND o.total > 0
          AND NOT EXISTS (
            SELECT 1 FROM ticket_refunds r
             WHERE r.order_id = o.id
               AND r.status IN ('requested','under_review','approved')
          )
        FOR UPDATE OF o`,
      [eventId]
    );
    for (const target of refundTargets) {
      await client.query(
        `INSERT INTO ticket_refunds (id, order_id, event_id, requested_by, status, reason, amount)
         VALUES ($1,$2,$3,$4,'requested',$5,$6)`,
        [randomUUID(), target.order_id, eventId, target.buyer_user_id || null,
         `Event cancelled: ${cancelReason}`, money(target.subtotal || 0)]
      );
    }
    // Everyone who holds a ticket for the event should hear it was cancelled,
    // paid or free. De-duplicated by buyer.
    const { rows: holders } = await client.query(
      `SELECT DISTINCT o.buyer_user_id, u.email, u.phone, u.full_name,
              BOOL_OR(o.total > 0) AS paid
         FROM ticket_orders o
         JOIN users u ON u.id = o.buyer_user_id
        WHERE o.event_id = $1 AND o.status = 'paid'
        GROUP BY o.buyer_user_id, u.email, u.phone, u.full_name`,
      [eventId]
    );
    await client.query("COMMIT");
    return { refundRequestsCreated: refundTargets.length, holders };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Tell the organiser what happened to their event. Non-blocking: a mail or
// notification hiccup must never fail a state change that is already recorded.
async function notifyOrganiserOfEvent(event, { title, body, purpose, metadata = {} }) {
  try {
    const { rows } = await pool.query(
      "SELECT id, full_name, email, phone FROM users WHERE id = $1 LIMIT 1",
      [event.business_user_id]
    );
    const organiser = rows[0];
    const email = cleanEmail(event.contact_email || organiser?.email || "");
    if (organiser) {
      await createNotification({
        user: { id: organiser.id, user_type: "customer" },
        channel: "in_app",
        notificationType: "event_status",
        title,
        body,
        provider: "in_app",
        metadata: { eventId: event.id, purpose, ...metadata }
      }).catch(() => null);
    }
    if (email) {
      await deliverEmail({ to: email, subject: title, body, metadata: { eventId: event.id, purpose, ...metadata } });
    }
  } catch (error) {
    console.error("[event-organiser-notify-failed]", { eventId: event.id, purpose, message: error.message });
  }
}

// Tell a ticket holder their event changed (cancelled or postponed).
// Non-blocking, best effort per buyer.
async function notifyTicketHolder(buyer, { title, body, purpose, eventId }) {
  try {
    if (buyer.buyer_user_id) {
      await createNotification({
        user: { id: buyer.buyer_user_id, user_type: "customer" },
        channel: "in_app",
        notificationType: "event_update",
        title,
        body,
        provider: "in_app",
        metadata: { eventId, purpose }
      }).catch(() => null);
    }
    const email = cleanEmail(buyer.email || "");
    if (email) await deliverEmail({ to: email, subject: title, body, metadata: { eventId, purpose } });
  } catch (error) {
    console.error("[ticket-holder-notify-failed]", { eventId, purpose, message: error.message });
  }
}

const EVENT_STATUS_MESSAGE = {
  approved: (name) => ({ title: `Your event is approved: ${name}`, body: `Good news: "${name}" has been approved and is now live on TitoPay. You can share your public event page and start selling or issuing tickets.` }),
  rejected: (name, note) => ({ title: `Update on your event: ${name}`, body: `Your event "${name}" was not approved.${note ? ` Reason: ${note}` : ""} You can make changes and submit it again from Business Ticketing in the TitoPay app.` }),
  additional_information_required: (name, note) => ({ title: `More information needed: ${name}`, body: `TitoPay needs a bit more information before "${name}" can go live.${note ? ` ${note}` : ""} Please update the event in Business Ticketing and submit it again.` }),
  suspended: (name, note) => ({ title: `Your event has been suspended: ${name}`, body: `"${name}" has been temporarily suspended and is not selling tickets.${note ? ` Reason: ${note}` : ""} Please contact TitoPay support if you have questions.` }),
  cancelled: (name, note) => ({ title: `Your event has been cancelled: ${name}`, body: `"${name}" has been cancelled.${note ? ` ${note}` : ""} Ticket holders are being notified and paid orders are being refunded.` })
};

async function adminTransitionEvent(eventId, payload, actor, meta = {}) {
  await ensureTicketingSchema();
  const { action, status } = adminActionStatus(payload.action);
  const note = cleanText(payload.note || payload.reason || "", 2000);
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1 LIMIT 1", [eventId]);
  const event = rows[0];
  if (!event) throw new AppError(404, "Event not found");
  const previousStatus = event.status;
  // Enforce the state machine: an action is only valid from certain statuses.
  const allowedFrom = EVENT_ACTION_ALLOWED_FROM[action] || [];
  if (!allowedFrom.includes(previousStatus)) {
    throw new AppError(409, `Cannot ${action.replace(/_/g, " ")} an event that is ${previousStatus.replace(/_/g, " ")}.`);
  }
  const sets = ["status = $2", "updated_at = NOW()"];
  const params = [eventId, status];
  if (status === "approved") {
    params.push(actor.userId);
    sets.push(`approved_at = NOW()`, `approved_by = $${params.length}`);
    // A re-approval (after a rejection or a suspension→reinstate) must not carry
    // the old rejection/suspension text on a now-live event.
    sets.push("rejection_reason = NULL", "suspended_reason = NULL");
  }
  if (status === "rejected") {
    params.push(note || "Event rejected by TitoPay Admin.");
    sets.push(`rejection_reason = $${params.length}`);
  }
  if (status === "suspended") {
    params.push(note || "Event suspended by TitoPay Admin.");
    sets.push(`suspended_reason = $${params.length}`);
  }
  const { rows: updated } = await pool.query(`UPDATE events SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
  await pool.query(
    `INSERT INTO event_approvals (id, event_id, admin_id, action, note, previous_status, new_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), eventId, actor.userId || null, action, note, previousStatus, status]
  );
  // A cancel must not be a bare status flip: invalidate tickets and open refund
  // requests so buyers are made whole and cannot use a dead ticket.
  let cascade = null;
  if (status === "cancelled") {
    cascade = await cancelEventCascade(eventId, { reason: note, actorId: actor.userId, actorType: "admin" });
    for (const holder of cascade.holders) {
      await notifyTicketHolder(holder, {
        title: `Event cancelled: ${event.event_name}`,
        body: `"${event.event_name}" has been cancelled.${holder.paid ? " A refund for your paid tickets is being processed." : ""}`,
        purpose: "event_cancelled",
        eventId
      });
    }
  }
  await eventAudit({
    eventId,
    actorType: "admin",
    actorId: actor.userId,
    action: `event_${action}`,
    metadata: { previousStatus, newStatus: status, note, ...(cascade ? { refundRequestsCreated: cascade.refundRequestsCreated } : {}) },
    ...meta
  });
  // Keep the promise the submission email made: tell the organiser the outcome.
  const messageFor = EVENT_STATUS_MESSAGE[status];
  if (messageFor) {
    const { title, body } = messageFor(event.event_name, note);
    await notifyOrganiserOfEvent(updated[0], { title, body, purpose: `event_${status}` });
  }
  return getAdminEvent(updated[0].id);
}

async function uniqueNumericCode(table, column, length = 10) {
  const digits = Math.min(10, Math.max(6, Number(length) || 10));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // crypto.randomInt, not Math.random: this mints ticket_code, the value
    // scanned to admit entry. Math.random is a non-cryptographic PRNG whose
    // internal state an attacker recovers from a few observed codes, letting
    // them predict the next tickets and forge admission. Flagged in the
    // 20 August 2026 security audit. randomInt is a CSPRNG; max 10^10 < 2^48.
    const code = String(randomInt(10 ** digits)).padStart(digits, "0");
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [code]);
    if (!rows[0]) return code;
  }
  return String(Date.now()).slice(-digits);
}

function ticketOrderResponse(order = {}, tickets = []) {
  return {
    id: order.id,
    orderReference: order.order_reference,
    eventId: order.event_id,
    ticketTypeId: order.ticket_type_id,
    buyerUserId: order.buyer_user_id,
    quantity: Number(order.quantity || 0),
    subtotal: Number(order.subtotal || 0),
    buyerFee: Number(order.buyer_fee || 0),
    businessCommission: Number(order.business_commission || 0),
    businessNet: Number(order.business_net || 0),
    total: Number(order.total || 0),
    status: order.status,
    deliveryStatus: order.delivery_status,
    paidAt: order.paid_at,
    createdAt: order.created_at,
    tickets: tickets.map(ticketResponse)
  };
}

// Render the ticket's stored QR payload as a scannable image, the same way the
// payment QRs are drawn (same library, JSON payload). The PWA's ticket stub and
// its PDF both already look for qrImageDataUrl — this is what finally fills the
// "Entry code is issued by the organiser" placeholder with a real code. A QR
// failure must never break a ticket response, so it degrades to the placeholder.
async function ticketQrDataUrl(row = {}) {
  const payload = row.qr_payload && typeof row.qr_payload === "object" && Object.keys(row.qr_payload).length
    ? row.qr_payload
    : { type: "titopay_ticket", ticketCode: row.ticket_code };
  try {
    return await QRCode.toDataURL(JSON.stringify(payload), { margin: 1, width: 480 });
  } catch (error) {
    console.error("[ticket-qr-failed]", { ticketCode: row.ticket_code, message: error.message });
    return "";
  }
}

function ticketResponse(row = {}) {
  return {
    id: row.id,
    orderId: row.order_id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    ticketCode: row.ticket_code,
    qrPayload: row.qr_payload || {},
    attendeeName: row.attendee_name || "",
    attendeePhone: row.attendee_phone || "",
    attendeeEmail: row.attendee_email || "",
    status: row.status,
    deliveryStatus: row.delivery_status,
    scannedAt: row.scanned_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at
  };
}

// Refunded orders do not count against a per-person limit: the buyer no
// longer holds those tickets.
async function ticketsAlreadyHeld(buyerUserId, ticketTypeId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::INT AS held
       FROM ticket_orders
      WHERE buyer_user_id = $1 AND ticket_type_id = $2 AND status = 'paid'`,
    [buyerUserId, ticketTypeId]
  );
  return Number(rows[0]?.held || 0);
}

/* ==========================================================================
   DISCOUNT CODES
   ==========================================================================
   An organiser's own promotion. Three rules hold the money straight:

   1. The discount comes off the SUBTOTAL, so the organiser funds it. Fees are
      then recomputed on what was actually charged, which means TitoPay never
      takes commission on money the organiser gave away.
   2. A discount can never exceed the subtotal. There is no such thing as a
      negative ticket price, and a coupon must never turn a sale into a payout.
   3. The code is resolved TWICE: once for the preview the buyer sees, and
      again inside the purchase transaction under a row lock. The second one
      is the one that counts, because a code can expire or run out between the
      two. If it fails there, the purchase is REFUSED rather than quietly
      charged at full price: a buyer must never pay more than they were shown.
   ========================================================================== */

const COUPON_TYPES = new Set(["percentage", "amount"]);

// Codes are what a person types off a poster, so they are stored and compared
// in one shape: upper case, no spaces, letters digits dash underscore only.
function normalizeCouponCode(value = "") {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function couponResponse(row = {}) {
  return {
    id: row.id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id || null,
    code: row.code,
    discountType: row.discount_type,
    discountValue: money(row.discount_value),
    startsAt: row.starts_at || null,
    expiresAt: row.expires_at || null,
    maxRedemptions: row.max_redemptions === null || row.max_redemptions === undefined ? null : Number(row.max_redemptions),
    maxPerCustomer: Number(row.max_per_customer || 1),
    redeemedCount: Number(row.redeemed_count || 0),
    discountGiven: money(row.discount_given),
    remaining: row.max_redemptions === null || row.max_redemptions === undefined
      ? null
      : Math.max(0, Number(row.max_redemptions) - Number(row.redeemed_count || 0)),
    status: row.status,
    description: row.description || "",
    // Computed for the organiser's list so an expired code reads as expired
    // without them having to compare dates themselves.
    state: couponState(row),
    createdAt: row.created_at
  };
}

function couponState(row = {}, now = new Date()) {
  if (String(row.status) !== "active") return "disabled";
  if (row.starts_at && new Date(row.starts_at).getTime() > now.getTime()) return "scheduled";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  const max = row.max_redemptions;
  if (max !== null && max !== undefined && Number(row.redeemed_count || 0) >= Number(max)) return "used_up";
  return "active";
}

// What a discount is worth against a given subtotal. Kept separate from the
// lookup so the same arithmetic serves the preview, the purchase and the tests.
function couponDiscountFor(coupon, subtotal) {
  const base = money(subtotal);
  if (base <= 0) return 0;
  const value = money(coupon.discount_value);
  if (value <= 0) return 0;
  const raw = String(coupon.discount_type) === "percentage"
    ? base * (Math.min(100, value) / 100)
    : value;
  // Never more than the tickets cost. A R500 code against a R100 order takes
  // R100 off, not R500, and certainly never leaves TitoPay owing the buyer.
  return money(Math.max(0, Math.min(base, raw)));
}

// Look up and validate a code. `db` is a pool or a transaction client; pass
// lock: true inside a transaction so two buyers cannot both take the last one.
// Returns null when no code was supplied. Throws a customer-safe AppError when
// a code was supplied and cannot be used.
async function resolveCoupon(db, { eventId, ticketTypeId, code, userId, subtotal, lock = false }) {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return null;
  const { rows } = await db.query(
    `SELECT * FROM ticket_coupons WHERE event_id = $1 AND code = $2 LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [eventId, normalized]
  );
  const coupon = rows[0];
  // A wrong code and a code belonging to another event read the same way, so
  // this never confirms that somebody else's code exists.
  if (!coupon) throw new AppError(404, "That discount code is not valid for this event.");

  const state = couponState(coupon);
  if (state === "disabled") throw new AppError(409, "That discount code is no longer active.");
  if (state === "scheduled") throw new AppError(409, "That discount code is not available yet.");
  if (state === "expired") throw new AppError(409, "That discount code has expired.");
  if (state === "used_up") throw new AppError(409, "That discount code has been fully redeemed.");
  if (coupon.ticket_type_id && String(coupon.ticket_type_id) !== String(ticketTypeId)) {
    throw new AppError(409, "That discount code does not apply to this ticket type.");
  }

  if (userId && Number(coupon.max_per_customer || 0) > 0) {
    const { rows: usedRows } = await db.query(
      `SELECT COUNT(*)::INT AS used
         FROM ticket_coupon_redemptions
        WHERE coupon_id = $1 AND user_id = $2 AND released_at IS NULL`,
      [coupon.id, userId]
    );
    if (Number(usedRows[0]?.used || 0) >= Number(coupon.max_per_customer)) {
      throw new AppError(409, "You have already used this discount code.");
    }
  }

  const discount = couponDiscountFor(coupon, subtotal);
  if (discount <= 0) throw new AppError(409, "That discount code takes nothing off this order.");
  return { coupon, discount, code: normalized };
}

async function listEventCoupons(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM ticket_coupons WHERE event_id = $1 ORDER BY created_at DESC",
    [eventId]
  );
  return rows.map(couponResponse);
}

function couponPayload(payload = {}) {
  const code = normalizeCouponCode(payload.code);
  if (code.length < 3) throw new AppError(400, "A discount code needs at least 3 letters or numbers.");
  const discountType = String(payload.discountType || payload.discount_type || "percentage").toLowerCase();
  if (!COUPON_TYPES.has(discountType)) throw new AppError(400, "Choose a percentage or an amount off.");
  const discountValue = money(payload.discountValue ?? payload.discount_value ?? 0);
  if (discountValue <= 0) throw new AppError(400, "Enter how much the code takes off.");
  if (discountType === "percentage" && discountValue > 100) {
    throw new AppError(400, "A percentage discount cannot be more than 100%.");
  }
  const parseDate = (value, label) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new AppError(400, `${label} is not a valid date.`);
    return parsed;
  };
  const startsAt = parseDate(payload.startsAt || payload.starts_at, "Start date");
  const expiresAt = parseDate(payload.expiresAt || payload.expires_at, "Expiry date");
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    throw new AppError(400, "The expiry date must be after the start date.");
  }
  // An expiry already in the past would create a code that can never be used,
  // which reads as a bug to the organiser rather than as their own typo.
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, "The expiry date must be in the future.");
  }
  const wholeOrNull = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) throw new AppError(400, `${label} must be 1 or more.`);
    return parsed;
  };
  return {
    code,
    discountType,
    discountValue,
    startsAt,
    expiresAt,
    maxRedemptions: wholeOrNull(payload.maxRedemptions ?? payload.max_redemptions, "Total uses"),
    maxPerCustomer: wholeOrNull(payload.maxPerCustomer ?? payload.max_per_customer, "Uses per person") || 1,
    ticketTypeId: cleanText(payload.ticketTypeId || payload.ticket_type_id, 80) || null,
    description: cleanText(payload.description, 200)
  };
}

async function createEventCoupon(actor, eventId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const input = couponPayload(payload);
  if (input.ticketTypeId) {
    const { rows } = await pool.query(
      "SELECT id FROM event_ticket_types WHERE id = $1 AND event_id = $2 LIMIT 1",
      [input.ticketTypeId, eventId]
    );
    if (!rows[0]) throw new AppError(404, "That ticket type does not belong to this event.");
  }
  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO ticket_coupons
        (id, event_id, ticket_type_id, code, discount_type, discount_value, starts_at, expires_at,
         max_redemptions, max_per_customer, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [randomUUID(), eventId, input.ticketTypeId, input.code, input.discountType, input.discountValue,
        input.startsAt, input.expiresAt, input.maxRedemptions, input.maxPerCustomer,
        input.description, actor.userId]
    ));
  } catch (error) {
    if (error?.code === "23505") throw new AppError(409, `You already have a code called ${input.code} on this event.`);
    throw error;
  }
  await eventAudit({
    eventId, actorType: "customer", actorId: actor.userId, action: "coupon_created",
    metadata: { code: input.code, discountType: input.discountType, discountValue: input.discountValue },
    ipAddress: meta.ipAddress, userAgent: meta.userAgent
  });
  return couponResponse(rows[0]);
}

// Editing is deliberately narrow. A code people already hold must not change
// its value under them, so only the things that can be safely tightened or
// extended are editable: turn it off, move the expiry, change how many uses
// remain. Changing the discount itself means issuing a new code.
async function updateEventCoupon(actor, eventId, couponId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const { rows: existing } = await pool.query(
    "SELECT * FROM ticket_coupons WHERE id = $1 AND event_id = $2 LIMIT 1",
    [couponId, eventId]
  );
  const coupon = existing[0];
  if (!coupon) throw new AppError(404, "Discount code not found");

  const sets = [];
  const values = [];
  const addSet = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (payload.status !== undefined) {
    const status = String(payload.status).toLowerCase();
    if (!["active", "disabled"].includes(status)) throw new AppError(400, "A discount code is either active or disabled.");
    addSet("status", status);
  }
  if (payload.expiresAt !== undefined || payload.expires_at !== undefined) {
    const raw = payload.expiresAt ?? payload.expires_at;
    if (!raw) addSet("expires_at", null);
    else {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new AppError(400, "Expiry date is not a valid date.");
      addSet("expires_at", parsed);
    }
  }
  if (payload.maxRedemptions !== undefined || payload.max_redemptions !== undefined) {
    const raw = payload.maxRedemptions ?? payload.max_redemptions;
    if (raw === null || raw === "") addSet("max_redemptions", null);
    else {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new AppError(400, "Total uses must be 1 or more.");
      // Below what has already been taken would silently invalidate codes
      // people are holding, so it is refused with the real number.
      if (parsed < Number(coupon.redeemed_count || 0)) {
        throw new AppError(409, `This code has already been used ${coupon.redeemed_count} times, so the total cannot be lower than that.`);
      }
      addSet("max_redemptions", parsed);
    }
  }
  if (payload.description !== undefined) addSet("description", cleanText(payload.description, 200));
  if (!sets.length) return couponResponse(coupon);

  values.push(couponId);
  const { rows } = await pool.query(
    `UPDATE ticket_coupons SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values
  );
  await eventAudit({
    eventId, actorType: "customer", actorId: actor.userId, action: "coupon_updated",
    metadata: { code: coupon.code, changes: Object.keys(payload) },
    ipAddress: meta.ipAddress, userAgent: meta.userAgent
  });
  return couponResponse(rows[0]);
}

// A code that has never been used can be removed outright. One that has been
// used is disabled instead, because deleting it would take its redemptions,
// and therefore the record of the discount on real orders, with it.
async function deleteEventCoupon(actor, eventId, couponId, meta = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM ticket_coupons WHERE id = $1 AND event_id = $2 LIMIT 1",
    [couponId, eventId]
  );
  const coupon = rows[0];
  if (!coupon) throw new AppError(404, "Discount code not found");
  if (Number(coupon.redeemed_count || 0) > 0) {
    const disabled = await updateEventCoupon(actor, eventId, couponId, { status: "disabled" }, meta);
    return { deleted: false, coupon: disabled,
      message: `${coupon.code} has already been used, so it was switched off instead of deleted. Its record stays with the orders that used it.` };
  }
  await pool.query("DELETE FROM ticket_coupons WHERE id = $1", [couponId]);
  await eventAudit({
    eventId, actorType: "customer", actorId: actor.userId, action: "coupon_deleted",
    metadata: { code: coupon.code }, ipAddress: meta.ipAddress, userAgent: meta.userAgent
  });
  return { deleted: true, message: `${coupon.code} was deleted.` };
}

async function ticketPurchasePreview(slug, payload = {}, buyerUserId = null) {
  await ensureTicketingSchema();
  const quantity = Math.max(1, Math.min(20, Number.parseInt(payload.quantity || 1, 10) || 1));
  const ticketTypeId = cleanText(payload.ticketTypeId || payload.ticket_type_id, 80);
  const { rows } = await pool.query(
    `SELECT e.*, tt.id AS ticket_type_id, tt.ticket_name, tt.price, tt.quantity_available, tt.quantity_reserved, tt.quantity_sold,
            tt.min_purchase_quantity, tt.max_purchase_quantity, tt.sales_opening_at, tt.sales_closing_at,
            tt.per_customer_purchase_limit,
            -- Selected so the preview can tell the buyer the refund terms
            -- BEFORE they pay. Without these, refundPolicyFor reads undefined
            -- and every ticket quietly previews as non-refundable.
            tt.refunds_allowed, tt.refund_deadline, tt.refund_conditions
     FROM events e
     JOIN event_ticket_types tt ON tt.event_id = e.id
     WHERE e.slug = $1 AND e.status = 'approved'
       AND ($2::UUID IS NULL OR tt.id = $2::UUID)
     ORDER BY tt.sort_order ASC
     LIMIT 1`,
    [slugify(slug), ticketTypeId || null]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "Event ticket type is not available");
  const available = Number(row.quantity_available || 0) - Number(row.quantity_reserved || 0) - Number(row.quantity_sold || 0);
  // The phase gate. These columns were stored and read for months and never
  // checked, so a sales window was decoration: TitoPay sold straight through
  // it. Checked here and again inside the purchase transaction, because a
  // phase can close between the two.
  const phase = ticketPhaseState(row);
  if (!phase.onSale) throw new AppError(409, phaseRefusalMessage(phase, row.ticket_name));
  if (quantity < Number(row.min_purchase_quantity || 1)) throw new AppError(400, `Minimum purchase is ${row.min_purchase_quantity} ticket(s)`);
  if (quantity > Number(row.max_purchase_quantity || 10)) throw new AppError(400, `Maximum purchase is ${row.max_purchase_quantity} ticket(s)`);
  if (available < quantity) throw new AppError(409, "Not enough tickets available");
  if (buyerUserId && row.per_customer_purchase_limit) {
    const limit = Number(row.per_customer_purchase_limit);
    const held = await ticketsAlreadyHeld(buyerUserId, row.ticket_type_id);
    if (held + quantity > limit) {
      throw new AppError(409, held >= limit
        ? `You have already bought the maximum of ${limit} for ${row.ticket_name}.`
        : `You may buy ${limit - held} more of ${row.ticket_name}, up to ${limit} per person.`);
    }
  }
  const listSubtotal = money(Number(row.price || 0) * quantity);
  // The organiser's discount comes off before anything else is worked out, so
  // every number below - fee, commission, what the organiser banks - is based
  // on what the buyer is actually being charged.
  const applied = await resolveCoupon(pool, {
    eventId: row.id,
    ticketTypeId: row.ticket_type_id,
    code: payload.couponCode || payload.coupon_code,
    userId: buyerUserId,
    subtotal: listSubtotal
  });
  const discount = applied ? applied.discount : 0;
  const subtotal = money(listSubtotal - discount);
  // A free ticket is free all the way through. The buyer service fee is a flat
  // R10, so without this a "free" ticket would still charge the buyer R10 and
  // demand they hold a balance — which is not a free ticket. No subtotal means
  // no fee, no commission, and nothing to move. A discount that takes the price
  // all the way to zero lands here too, and is free on exactly the same terms.
  const isFree = subtotal <= 0;
  const buyerFee = isFree ? 0 : (await calculateFee("ticket_buyer_service_fee", subtotal)).fee;
  const businessCommission = isFree ? 0 : (await calculateFee("ticket_business_commission", subtotal)).fee;
  return {
    eventId: row.id,
    eventName: row.event_name,
    ticketTypeId: row.ticket_type_id,
    ticketName: row.ticket_name,
    quantity,
    available,
    listSubtotal,
    discount,
    couponCode: applied ? applied.code : null,
    couponId: applied ? applied.coupon.id : null,
    subtotal,
    buyerFee,
    businessCommission,
    businessNet: money(subtotal - businessCommission),
    total: money(subtotal + buyerFee),
    // Shown next to the Pay button. A buyer must be able to read the refund
    // terms BEFORE they commit, not discover them when they ask for money back.
    refundPolicy: refundPolicyFor(row, row)
  };
}

async function loadWalletForUpdate(client, userId, kindPreference = null) {
  // No-preference means "the user's own spending wallet" — never a TitoKids
  // custody wallet, whatever creation order a backfill produces.
  const kindSql = kindPreference ? "AND kind = $2" : "AND kind <> 'system'";
  const params = kindPreference ? [userId, kindPreference] : [userId];
  const { rows } = await client.query(
    `SELECT *
     FROM wallets
     WHERE user_id = $1 ${kindSql}
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE`,
    params
  );
  return rows[0] || null;
}

async function loadRevenueWalletForUpdate(client) {
  const { rows } = await client.query(
    `SELECT *
     FROM wallets
     WHERE kind = 'revenue' AND user_id IS NULL
     LIMIT 1
     FOR UPDATE`
  );
  if (!rows[0]) throw new AppError(500, "TitoPay revenue wallet is not configured");
  return rows[0];
}

// Every purchase automatically emails the buyer a confirmation carrying the
// order and every ticket code. EMAIL ONLY, by design — no SMS — and through
// the Email Centre queue (a database insert delivered by the standalone worker
// with retries, visible in Admin → Email Centre), never a live mail connection
// inside the purchase flow. Idempotent per order, so a retry cannot send the
// confirmation twice.
async function deliverTicketOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT o.*, e.event_name, e.slug, e.event_date, e.start_time, e.venue_name, e.city,
            u.id AS buyer_id, u.full_name, u.email
     FROM ticket_orders o
     JOIN events e ON e.id = o.event_id
     JOIN users u ON u.id = o.buyer_user_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return;
  const { rows: tickets } = await pool.query(
    `SELECT t.*, tt.ticket_name
       FROM tickets t
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.order_id = $1
      ORDER BY t.created_at ASC`,
    [orderId]
  );

  const to = cleanEmail(order.email);
  if (!to) {
    // No email on file: the tickets still live in the app under My Tickets; the
    // failed delivery status makes the gap visible instead of silent.
    await pool.query("UPDATE ticket_orders SET delivery_status = 'failed', updated_at = NOW() WHERE id = $1", [orderId]);
    await pool.query("UPDATE tickets SET delivery_status = 'failed', updated_at = NOW() WHERE order_id = $1", [orderId]);
    return;
  }

  const when = order.event_date
    ? `${new Date(order.event_date).toLocaleDateString("en-ZA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}${order.start_time ? ` at ${order.start_time}` : ""}`
    : "Date to be confirmed";
  const where = [order.venue_name, order.city].filter(Boolean).join(", ") || "Venue to be confirmed";
  const eventUrl = `https://app.titopay.co.za/events/${order.slug}`;
  const subject = `Your ticket${tickets.length > 1 ? "s" : ""} for ${order.event_name}`;
  const ticketLines = tickets.map((ticket, index) =>
    `  ${index + 1}. ${ticket.ticket_name || "General admission"}, ticket code ${ticket.ticket_code}`);
  const textBody = [
    `Hi${order.full_name ? ` ${order.full_name}` : ""},`,
    "",
    `Your purchase is confirmed. Here ${tickets.length > 1 ? "are your tickets" : "is your ticket"} for ${order.event_name}.`,
    "",
    `Order: ${order.order_reference}`,
    `When: ${when}`,
    `Where: ${where}`,
    `Total paid: R ${money(order.total).toFixed(2)}`,
    "",
    `Your ticket${tickets.length > 1 ? "s" : ""}:`,
    ...ticketLines,
    "",
    "Each code (and its QR in the TitoPay app) admits one person at the entrance.",
    "Keep the codes private. Anyone who has one can enter.",
    "",
    "Open TitoPay → My Tickets to show the QR at the door, download a PDF, or add the ticket to your phone's wallet.",
    `Event details: ${eventUrl}`
  ].join("\n");
  const ticketCodes = tickets.map((ticket) => ticket.ticket_code).join(", ");

  const notificationId = await createNotification({
    user: { id: order.buyer_id, user_type: "customer" },
    channel: "email",
    notificationType: "ticket_delivery",
    title: subject,
    body: textBody,
    provider: "email",
    metadata: { orderId, ticketCodes }
  });

  let delivered = false;
  try {
    const emailCentre = require("./email-centre-service");
    const htmlTickets = tickets.map((ticket) =>
      `<p style="margin:6px 0">${emailCentre.escapeHtml(ticket.ticket_name || "General admission")}, ticket code <strong style="font-size:18px;letter-spacing:2px">${emailCentre.escapeHtml(ticket.ticket_code)}</strong></p>`).join("");
    const result = await emailCentre.queueRawEmail({
      recipient: to,
      subject,
      textBody,
      htmlBody: [
        `<p>Hi${order.full_name ? ` ${emailCentre.escapeHtml(order.full_name)}` : ""},</p>`,
        `<p>Your purchase is confirmed. Here ${tickets.length > 1 ? "are your tickets" : "is your ticket"} for <strong>${emailCentre.escapeHtml(order.event_name)}</strong>.</p>`,
        `<p>Order <strong>${emailCentre.escapeHtml(order.order_reference)}</strong><br>When: ${emailCentre.escapeHtml(when)}<br>Where: ${emailCentre.escapeHtml(where)}<br>Total paid: <strong>R ${money(order.total).toFixed(2)}</strong></p>`,
        htmlTickets,
        `<p>Each code (and its QR in the TitoPay app) admits one person at the entrance. Keep the codes private. Anyone who has one can enter.</p>`,
        `<p>Open TitoPay → My Tickets to show the QR at the door, download a PDF, or add the ticket to your phone's wallet.</p>`
      ].join(""),
      userId: order.buyer_user_id,
      idempotencyKey: `ticket-order-delivery:${orderId}`,
      metadata: { orderId, ticketCodes, purpose: "ticket_order_delivery" }
    });
    delivered = Boolean(result && !result.skipped);
    if (delivered) await markNotification(notificationId, "sent", result.id || null, { queued: true });
  } catch (error) {
    console.error("[ticket-order-email-queue-failed]", { orderId, message: error.message });
  }
  if (!delivered) {
    try {
      const result = await deliverEmail({ to, subject, body: textBody, metadata: { orderId, purpose: "ticket_order_delivery" } });
      await markNotification(notificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
      delivered = true;
    } catch (error) {
      await markNotification(notificationId, "failed", null, { error: error.message });
    }
  }

  const status = delivered ? "sent" : "failed";
  await pool.query("UPDATE ticket_orders SET delivery_status = $2, updated_at = NOW() WHERE id = $1", [orderId, status]);
  await pool.query("UPDATE tickets SET delivery_status = $2, updated_at = NOW() WHERE order_id = $1", [orderId, status]);
}

// Email a ticket the caller OWNS to themselves or to someone else — a friend
// they bought it for, or their own second address. Ownership is enforced by
// owner_user_id, so a caller can only ever send a ticket that is theirs; the
// destination is validated but otherwise free, which is the whole point.
async function emailTicketToRecipient(actor, ticketCode, destination, meta = {}) {
  await ensureTicketingSchema();
  const code = cleanText(ticketCode, 40);
  if (!code) throw new AppError(400, "Ticket code is required");

  const { rows } = await pool.query(
    `SELECT t.ticket_code, t.qr_payload, t.attendee_name,
            o.order_reference,
            tt.ticket_name,
            e.id AS event_id, e.event_name, e.slug, e.event_date, e.start_time, e.venue_name, e.city, e.province,
            u.email AS owner_email, u.full_name AS owner_name
       FROM tickets t
       JOIN ticket_orders o ON o.id = t.order_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.owner_user_id
      WHERE t.ticket_code = $1 AND t.owner_user_id = $2
      LIMIT 1`,
    [code, actor.userId]
  );
  const ticket = rows[0];
  // Not found OR not owned both answer the same way, so this never confirms a
  // ticket code exists to someone who does not hold it.
  if (!ticket) throw new AppError(404, "Ticket not found");

  // Default to the account's own email; accept an override for sending to
  // someone else. An invalid override is rejected rather than silently sent to
  // the owner, so the caller is never surprised about where it went.
  const requested = cleanEmail(destination);
  if (destination && !requested) throw new AppError(400, "Enter a valid email address");
  if (requested && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requested)) throw new AppError(400, "Enter a valid email address");
  const to = requested || cleanEmail(ticket.owner_email);
  if (!to) throw new AppError(400, "No email address on file. Enter one to send this ticket to.");

  const when = ticket.event_date
    ? `${new Date(ticket.event_date).toLocaleDateString("en-ZA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}${ticket.start_time ? ` at ${ticket.start_time}` : ""}`
    : "Date to be confirmed";
  const where = [ticket.venue_name, ticket.city, ticket.province].filter(Boolean).join(", ") || "Venue to be confirmed";
  const eventUrl = `https://app.titopay.co.za/events/${ticket.slug}`;
  const subject = `Your ticket for ${ticket.event_name}`;
  const body = [
    `Here is your TitoPay ticket for ${ticket.event_name}.`,
    "",
    `Ticket: ${ticket.ticket_name || "General admission"}`,
    `When: ${when}`,
    `Where: ${where}`,
    `Ticket code: ${ticket.ticket_code}`,
    ticket.order_reference ? `Order: ${ticket.order_reference}` : "",
    "",
    "Show the ticket code (or its QR in the TitoPay app) at the entrance.",
    `Event details: ${eventUrl}`,
    "",
    "Keep this code private. Anyone who has it can enter."
  ].filter((line) => line !== null && line !== undefined).join("\n");

  // The ticket itself travels as a PDF: QR, code, event, holder - the thing
  // the recipient actually expects to find attached. If rendering fails for
  // any reason the email still goes out with the code in the body, because a
  // missing attachment must never block a ticket.
  let pdfAttachment = null;
  try {
    const { renderTicketPdf } = require("./ticket-pdf-service");
    const pdf = await renderTicketPdf({ ...ticket, when, where });
    pdfAttachment = {
      filename: `titopay-ticket-${ticket.ticket_code}.pdf`,
      contentBase64: pdf.toString("base64"),
      contentType: "application/pdf"
    };
  } catch (error) {
    console.error("[ticket-pdf-failed]", { ticketCode: ticket.ticket_code, message: error.message });
  }

  // The send goes through the Email Centre QUEUE, not a live SMTP connection
  // inside this request. A slow or broken mail server used to hold this request
  // hostage until the connection gave up — which the app could only report as
  // "services are not reachable". Queueing is a single database insert: the
  // response is instant, the standalone email worker delivers with retries, and
  // the attempt is visible in Admin → Email Centre. Direct delivery remains as
  // the fallback if the queue itself is unavailable.
  let queued = false;
  try {
    const emailCentre = require("./email-centre-service");
    const result = await emailCentre.queueRawEmail({
      recipient: to,
      subject,
      textBody: pdfAttachment ? `${body}\n\nYour ticket is attached as a PDF you can save, print or show at the door.` : body,
      htmlBody: `<p>${emailCentre.escapeHtml(body).replace(/\n/g, "<br>")}</p>${pdfAttachment ? "<p><strong>Your ticket is attached as a PDF</strong> you can save, print or show at the door.</p>" : ""}`,
      userId: actor.userId,
      idempotencyKey: `ticket-email:${ticket.ticket_code}:${createHash("sha256").update(`${to}:${Date.now()}`).digest("hex").slice(0, 24)}`,
      metadata: { ticketCode: ticket.ticket_code, purpose: "ticket_self_service_email" },
      attachments: pdfAttachment ? [pdfAttachment] : []
    });
    queued = Boolean(result && !result.skipped);
  } catch (error) {
    console.error("[ticket-email-queue-failed]", { ticketCode: ticket.ticket_code, message: error.message });
  }
  if (!queued) {
    // A mail hiccup must come back as a clear, retryable message — not a generic
    // 500 that reads as "something is broken with my ticket".
    try {
      await deliverEmail({ to, subject, body, metadata: { ticketCode: ticket.ticket_code, purpose: "ticket_self_service_email" } });
    } catch (error) {
      console.error("[ticket-email-send-failed]", { ticketCode: ticket.ticket_code, message: error.message });
      throw new AppError(502, "TitoPay could not send the email right now. Your ticket is unaffected. Please try again in a few minutes.");
    }
  }
  await eventAudit({
    eventId: ticket.event_id,
    actorType: "customer",
    actorId: actor.userId,
    action: "ticket_emailed",
    metadata: { ticketCode: ticket.ticket_code, sentToSelf: to === cleanEmail(ticket.owner_email) },
    ...meta
  });
  // Never echo the address back in full — enough to confirm, not to leak.
  return { ok: true, sentTo: to.replace(/^(.).*(@.*)$/, "$1***$2") };
}

async function purchaseTickets(actor, slug, payload = {}, meta = {}) {
  if (actor.profileLocked) throw new AppError(423, "Profile is locked. Ticket purchases are disabled.");
  await ensureTicketingSchema();
  const preview = await ticketPurchasePreview(slug, payload, actor.userId);
  const client = await pool.connect();
  const orderId = randomUUID();
  const txId = randomUUID();
  const reference = `TICKET-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const orderReference = await uniqueNumericCode("ticket_orders", "order_reference", 10);
  const ticketRows = [];
  // Hoisted: the confirmation response after the transaction reads the event's
  // name/date/venue from this locked row.
  let locked;
  // Hoisted for the same reason. These are settled inside the transaction from
  // the LOCKED ticket row and the locked coupon, and the audit entry written
  // after it must report the figures that were actually charged.
  let applied = null;
  let discount = 0;
  let subtotal = 0;
  let buyerFee = 0;
  let businessCommission = 0;
  let businessNet = 0;
  let total = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT e.*, tt.id AS ticket_type_id, tt.ticket_name, tt.price, tt.quantity_available, tt.quantity_reserved, tt.quantity_sold,
              tt.min_purchase_quantity, tt.max_purchase_quantity, tt.sales_opening_at, tt.sales_closing_at,
              tt.per_customer_purchase_limit, m.id AS merchant_uuid
       FROM events e
       JOIN event_ticket_types tt ON tt.event_id = e.id
       LEFT JOIN merchants m ON m.id = e.merchant_id
       WHERE e.id = $1 AND tt.id = $2 AND e.status = 'approved'
       FOR UPDATE OF tt`,
      [preview.eventId, preview.ticketTypeId]
    );
    locked = rows[0];
    if (!locked) throw new AppError(404, "Event ticket type is not available");
    // Re-checked under the row lock. A phase can close, or its last ticket can
    // go, between the preview the buyer saw and this transaction.
    const lockedPhase = ticketPhaseState(locked);
    if (!lockedPhase.onSale) throw new AppError(409, phaseRefusalMessage(lockedPhase, locked.ticket_name));
    const available = Number(locked.quantity_available || 0) - Number(locked.quantity_reserved || 0) - Number(locked.quantity_sold || 0);
    if (available < preview.quantity) throw new AppError(409, "Not enough tickets available");
    if (locked.per_customer_purchase_limit) {
      const limit = Number(locked.per_customer_purchase_limit);
      const { rows: heldRows } = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::INT AS held
           FROM ticket_orders
          WHERE buyer_user_id = $1 AND ticket_type_id = $2 AND status = 'paid'`,
        [actor.userId, locked.ticket_type_id]
      );
      if (Number(heldRows[0]?.held || 0) + preview.quantity > limit) {
        throw new AppError(409, `Limit of ${limit} per person for ${locked.ticket_name}.`);
      }
    }

    // THE DISCOUNT IS RE-RESOLVED HERE, UNDER A ROW LOCK, AND THIS IS THE ONE
    // THAT COUNTS. The preview ran outside any transaction, so between it and
    // now the code could have expired, been switched off, or had its last use
    // taken by somebody else. The lock is what stops two buyers both taking a
    // one-use code.
    //
    // If it fails now the whole purchase is refused. That is deliberate: the
    // alternative is charging the buyer full price for something they were
    // shown at a discount, and a payment that costs more than the screen said
    // is worse than a payment that does not happen.
    const listSubtotal = money(Number(locked.price || 0) * preview.quantity);
    applied = await resolveCoupon(client, {
      eventId: preview.eventId,
      ticketTypeId: preview.ticketTypeId,
      code: payload.couponCode || payload.coupon_code,
      userId: actor.userId,
      subtotal: listSubtotal,
      lock: true
    });
    // Everything from here uses the locked figures, never the preview's.
    discount = applied ? applied.discount : 0;
    subtotal = money(listSubtotal - discount);
    const isFree = subtotal <= 0;
    buyerFee = isFree ? 0 : (await calculateFee("ticket_buyer_service_fee", subtotal)).fee;
    businessCommission = isFree ? 0 : (await calculateFee("ticket_business_commission", subtotal)).fee;
    businessNet = money(subtotal - businessCommission);
    total = money(subtotal + buyerFee);
    // A buyer who saw one price must never be charged a higher one. Prices can
    // only ever move in the buyer's favour between preview and payment.
    if (total > money(preview.total)) {
      throw new AppError(409, "The price of these tickets changed while you were checking out. Please review it again.");
    }

    const buyerWallet = await loadWalletForUpdate(client, actor.userId);
    if (!buyerWallet) throw new AppError(404, "Buyer wallet not found");
    // A free ticket has total 0, so this correctly asks nothing of the buyer's
    // balance; the guard only bites when there is something to pay.
    if (total > 0 && Number(buyerWallet.available_balance || 0) < total) {
      throw new AppError(400, "Insufficient balance");
    }
    // The business wallet is only needed when there is money to settle into it.
    // A free event never credits the business, so a missing wallet must not stop
    // a free ticket being issued.
    const businessWallet = await loadWalletForUpdate(client, locked.business_user_id, "business") || await loadWalletForUpdate(client, locked.business_user_id);
    if (businessNet > 0 && !businessWallet) throw new AppError(404, "Event business wallet not found");
    // The revenue wallet only collects platform fees. A free ticket charges no
    // fee, so it must never be required — loading it unconditionally made every
    // purchase (free included) 500 on an environment where no revenue wallet is
    // configured. Load it only when there is a fee to bank.
    const hasFees = money(buyerFee + businessCommission) > 0;
    const revenueWallet = hasFees ? await loadRevenueWalletForUpdate(client) : null;

    await client.query(
      `UPDATE event_ticket_types
       SET quantity_sold = quantity_sold + $2,
           updated_at = NOW()
       WHERE id = $1`,
      [preview.ticketTypeId, preview.quantity]
    );
    await client.query(
      `INSERT INTO transactions
        (id, user_id, wallet_id, merchant_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,$4,'ticket_purchase',$5,$6,$7,'completed','debit',$8,$9,$10::JSONB)`,
      [
        txId,
        actor.userId,
        buyerWallet.id,
        locked.merchant_uuid || null,
        subtotal,
        money(buyerFee + businessCommission),
        total,
        reference,
        locked.event_name,
        JSON.stringify({ eventId: preview.eventId, ticketTypeId: preview.ticketTypeId, orderId, orderReference, businessNet: businessNet })
      ]
    );
    // applyWalletMovement refuses a zero amount by design, so every movement
    // below is guarded — a free ticket moves no money and simply skips them.
    if (total > 0) {
      await applyWalletMovement(client, {
        walletId: buyerWallet.id,
        transactionId: txId,
        entryType: "debit",
        amount: total,
        reference,
        metadata: { serviceCode: "ticket_purchase", orderId, eventId: preview.eventId }
      });
    }
    if (businessWallet && businessNet > 0) {
      await applyWalletMovement(client, {
        walletId: businessWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: businessNet,
        reference,
        metadata: { serviceCode: "ticket_purchase", orderId, eventId: preview.eventId, settlement: "instant_wallet_credit" }
      });
    }
    if (hasFees && revenueWallet) {
      await applyWalletMovement(client, {
        walletId: revenueWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: money(buyerFee + businessCommission),
        reference,
        metadata: { serviceCode: "ticket_purchase", source: "ticket_fees", orderId, eventId: preview.eventId }
      });
      await client.query(
        `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,'ticket_purchase',$3,$4)`,
        [randomUUID(), txId, money(buyerFee + businessCommission), revenueWallet.id]
      );
    }

    await client.query(
      `INSERT INTO ticket_orders
        (id, event_id, ticket_type_id, buyer_user_id, merchant_id, transaction_id, order_reference, quantity, subtotal, buyer_fee, business_commission, business_net, total, status, delivery_status, buyer_details, metadata, paid_at, coupon_id, discount_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'paid','queued',$14::JSONB,$15::JSONB,NOW(),$16,$17)`,
      [
        orderId,
        preview.eventId,
        preview.ticketTypeId,
        actor.userId,
        locked.merchant_uuid || null,
        txId,
        orderReference,
        preview.quantity,
        subtotal,
        buyerFee,
        businessCommission,
        businessNet,
        total,
        JSON.stringify(payload.buyerDetails || {}),
        JSON.stringify({ source: "pwa", paymentMethod: "titopay_wallet" }),
        applied ? applied.coupon.id : null,
        discount
      ]
    );

    // Attribution, resolved inside the transaction so it lands with the order
    // or not at all. An unknown or switched-off code simply attributes nothing:
    // a promoter link that has been retired must never fail somebody's payment.
    const promoterCode = normalizeCouponCode(payload.promoterCode || payload.ref || "");
    if (promoterCode) {
      await client.query(
        `UPDATE ticket_orders SET promoter_id = (
            SELECT id FROM event_promoters
             WHERE event_id = $2 AND code = $3 AND status = 'active' LIMIT 1
         ) WHERE id = $1`,
        [orderId, preview.eventId, promoterCode]
      );
    }

    // The redemption is taken inside the same transaction as the money. If
    // anything below fails, the code goes back on the shelf along with the
    // payment; there is no state where a buyer paid nothing but burned a use,
    // or used a code and left no record of it.
    if (applied) {
      await client.query(
        `UPDATE ticket_coupons
            SET redeemed_count = redeemed_count + 1,
                discount_given = discount_given + $2,
                updated_at = NOW()
          WHERE id = $1`,
        [applied.coupon.id, discount]
      );
      await client.query(
        `INSERT INTO ticket_coupon_redemptions (id, coupon_id, order_id, user_id, quantity, discount_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), applied.coupon.id, orderId, actor.userId, preview.quantity, discount]
      );
    }

    // SEATS, IF THIS TICKET TYPE HAS THEM. Allocated inside this transaction,
    // under FOR UPDATE SKIP LOCKED, so two buyers reaching for the last seat
    // get different seats rather than the same one — and so a rollback below
    // puts the seats back on sale along with the money.
    const { rows: seatedRows } = await client.query(
      "SELECT seated FROM event_ticket_types WHERE id = $1",
      [preview.ticketTypeId]
    );
    const seats = seatedRows[0]?.seated
      ? await allocateSeats(client, {
        eventId: preview.eventId,
        ticketTypeId: preview.ticketTypeId,
        quantity: preview.quantity
      })
      : [];

    for (let index = 0; index < preview.quantity; index += 1) {
      const ticketId = randomUUID();
      const ticketCode = await uniqueNumericCode("tickets", "ticket_code", 10);
      const seat = seats[index] || null;
      const qrPayload = { type: "titopay_ticket", ticketId, ticketCode, orderReference, eventId: preview.eventId };
      const { rows: inserted } = await client.query(
        `INSERT INTO tickets
          (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, qr_payload, attendee_name, attendee_phone, attendee_email, status, delivery_status, seat_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10,'valid','queued',$11)
         RETURNING *`,
        [
          ticketId,
          orderId,
          preview.eventId,
          preview.ticketTypeId,
          actor.userId,
          ticketCode,
          JSON.stringify(qrPayload),
          cleanText(payload.attendeeName || payload.buyerDetails?.name || "", 180),
          cleanPhone(payload.attendeePhone || payload.buyerDetails?.phone || ""),
          cleanEmail(payload.attendeeEmail || payload.buyerDetails?.email || ""),
          seat ? seat.id : null
        ]
      );
      if (seat) await attachSeatToTicket(client, seat.id, ticketId);
      ticketRows.push(inserted[0]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await eventAudit({
    eventId: preview.eventId,
    actorType: "customer",
    actorId: actor.userId,
    action: "tickets_purchased",
    metadata: { orderId, orderReference, quantity: preview.quantity, total: total },
    ...meta
  });
  deliverTicketOrder(orderId).catch((error) => console.error("[ticket-delivery-failed]", { orderId, message: error.message }));
  // THE ORGANISER IS BEING PAID, AND WAS NEVER TOLD.
  //
  // A ticket sale credits the organiser's business wallet directly through
  // applyWalletMovement, not through createTransaction, so it never passed the
  // one place that writes a receipt. Every message this sale produced went to
  // the BUYER: their tickets, their confirmation, their email. The organiser
  // watching their event sell had to go and look at a balance.
  //
  // businessNet is what actually reached the wallet, after TitoPay's
  // commission, so the notice agrees with the balance. A free ticket moves no
  // money and the notifier declines a zero amount on its own.
  if (locked?.business_user_id && businessNet > 0) {
    const { rows: buyerRows } = await pool.query("SELECT full_name, username FROM users WHERE id=$1", [actor.userId]).catch(() => ({ rows: [] }));
    const buyer = buyerRows[0];
    require("./payment-received-service").notifyPaymentReceived({
      recipientUserId: locked.business_user_id,
      amount: businessNet,
      fee: businessCommission,
      transactionId: txId,
      reference: orderReference,
      serviceCode: "ticket_purchase",
      payerName: buyer?.full_name || (buyer?.username ? `@${buyer.username}` : ""),
      detail: [locked.event_name, preview.quantity > 1 ? `${preview.quantity} tickets` : "1 ticket"].filter(Boolean).join(", ")
    }).catch(() => {});
  }
  const { rows: orderRows } = await pool.query("SELECT * FROM ticket_orders WHERE id = $1", [orderId]);
  const response = ticketOrderResponse(orderRows[0], ticketRows);
  // The confirmation screen renders these tickets immediately, so each carries
  // its scannable QR and the event's real name/date/venue — without them the
  // stub showed "TitoPay event / Date to be confirmed" for a fully-detailed
  // event, and an empty entry-code box.
  for (let index = 0; index < response.tickets.length; index += 1) {
    response.tickets[index].qrImageDataUrl = await ticketQrDataUrl(ticketRows[index]);
    response.tickets[index].eventName = locked.event_name;
    response.tickets[index].eventDate = locked.event_date;
    response.tickets[index].venueName = locked.venue_name;
    response.tickets[index].city = locked.city;
  }
  response.eventName = locked.event_name;
  return response;
}

async function listMyTicketOrders(userId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT o.*, e.event_name, e.slug, tt.ticket_name
     FROM ticket_orders o
     JOIN events e ON e.id = o.event_id
     JOIN event_ticket_types tt ON tt.id = o.ticket_type_id
     WHERE o.buyer_user_id = $1
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [userId]
  );
  const items = [];
  for (const row of rows) {
    const { rows: tickets } = await pool.query("SELECT * FROM tickets WHERE order_id = $1 ORDER BY created_at ASC", [row.id]);
    items.push({ ...ticketOrderResponse(row, tickets), eventName: row.event_name, eventSlug: row.slug, ticketName: row.ticket_name });
  }
  return items;
}

async function canManageEventTicketing(userId, eventId, permission = "scan") {
  const { rows } = await pool.query(
    `SELECT e.business_user_id,
            EXISTS (
              SELECT 1 FROM event_staff s
              WHERE s.event_id = e.id
                AND s.user_id = $2
                AND s.status = 'active'
                AND (s.permissions ? $3 OR s.role IN ('owner','manager'))
            ) AS staff_allowed
     FROM events e
     WHERE e.id = $1
     LIMIT 1`,
    [eventId, userId, permission]
  );
  return Boolean(rows[0] && (rows[0].business_user_id === userId || rows[0].staff_allowed));
}

// The flat list of tickets a customer holds, which is what the PWA's "My
// Tickets" screen has always asked for at GET /v1/ticketing/tickets. That route
// did not exist, so the screen has been showing "Tickets could not be loaded"
// since it shipped. This is the read it was written against: one row per
// ticket, with the order and event it belongs to attached, so the ticket stub
// can render a name, a date and a venue without a second request.
//
// Read-only. It creates nothing, refunds nothing and changes no state.
// Claim a gifted ticket by its code: the ticket moves into the claimant's
// account, so it shows in My Tickets, scans at the gate under their name and
// can take an event wristband (Event Tag) like any ticket they bought.
//
// The code alone transfers ownership, so two guards make theft impractical:
// a hard per-user attempt throttle (codes are 10 random digits — a guesser
// gets nowhere at 8 tries an hour), and the previous owner is told the
// moment their ticket moves, in the app and by email.
const TICKET_CLAIM_MAX_FAILURES_PER_HOUR = 8;

/* ---------------------------------------------------------------- seating */

// DEFINE A VENUE LAYOUT.
//
// Not a seat-map editor: the organiser describes a section as rows and seats
// per row, and the platform generates the seats. That covers the shape almost
// every venue actually is — a block of numbered rows — and it is honest about
// what it does not do, which is curved tiers, tables, and boxes with their own
// numbering. Those need a real map and should not be faked with a grid.
//
// Idempotent by construction: the unique index on
// (event_id, section, row_label, seat_number) means re-running a definition
// adds only what is missing and never duplicates a seat.
async function defineSeating(actor, eventId, spec = {}) {
  await ensureTicketingSchema();
  const section = cleanText(spec.section, 60);
  if (!section) throw new AppError(400, "Name the section, for example Block A or Grand Tier");
  const ticketTypeId = spec.ticketTypeId || spec.ticket_type_id || null;
  const rows = Array.isArray(spec.rows) && spec.rows.length
    ? spec.rows.map((row) => cleanText(row, 12)).filter(Boolean)
    : [];
  const seatsPerRow = Math.max(0, Number.parseInt(spec.seatsPerRow ?? spec.seats_per_row ?? 0, 10) || 0);
  if (!rows.length) throw new AppError(400, "List the rows in this section, for example A, B, C");
  if (!seatsPerRow) throw new AppError(400, "Say how many seats are in each row");
  if (rows.length * seatsPerRow > 20000) {
    throw new AppError(400, "That is more than 20,000 seats in one section. Split it into smaller sections.");
  }
  const startAt = Math.max(1, Number.parseInt(spec.startNumber ?? 1, 10) || 1);

  const values = [];
  const placeholders = [];
  let order = 0;
  for (const rowLabel of rows) {
    for (let seat = 0; seat < seatsPerRow; seat += 1) {
      const offset = values.length;
      values.push(eventId, ticketTypeId, section, rowLabel, String(startAt + seat), order);
      placeholders.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`);
      order += 1;
    }
  }
  const { rowCount } = await pool.query(
    `INSERT INTO event_seats (event_id, ticket_type_id, section, row_label, seat_number, sort_order)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (event_id, section, row_label, seat_number) DO NOTHING`,
    values
  );
  if (ticketTypeId) {
    await pool.query("UPDATE event_ticket_types SET seated = TRUE, updated_at = NOW() WHERE id = $1 AND event_id = $2",
      [ticketTypeId, eventId]);
  }
  await eventAudit({
    eventId,
    actorType: "customer",
    actorId: actor?.userId || null,
    action: "event_seating_defined",
    metadata: { section, rows: rows.length, seatsPerRow, created: rowCount }
  }).catch(() => {});
  return { section, rows: rows.length, seatsPerRow, seatsCreated: rowCount };
}

// WHAT IS LEFT TO SELL, for the event page.
async function seatingAvailability(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT section,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'available')::int AS available
       FROM event_seats WHERE event_id = $1 GROUP BY section ORDER BY section`,
    [eventId]
  );
  return rows;
}

// ALLOCATE SEATS TO AN ORDER, INSIDE THE CALLER'S TRANSACTION.
//
// This is the whole reason seating is not just three extra columns. Two buyers
// reaching for the last seat at the same moment must not both get it.
//
// FOR UPDATE SKIP LOCKED is what makes that both correct and usable: the first
// transaction locks the rows it is taking, and the second SKIPS them and takes
// the next ones free rather than queueing behind the first and then failing.
// Two people buying at once get different seats instead of one waiting.
//
// The client is the caller's — the same transaction that writes the order and
// the tickets — so seats and tickets commit together or not at all.
async function allocateSeats(client, { eventId, ticketTypeId, quantity }) {
  const { rows } = await client.query(
    `SELECT id, section, row_label, seat_number
       FROM event_seats
      WHERE event_id = $1
        AND ($2::uuid IS NULL OR ticket_type_id = $2)
        AND status = 'available'
      ORDER BY sort_order, row_label, seat_number
      LIMIT $3
      FOR UPDATE SKIP LOCKED`,
    [eventId, ticketTypeId, quantity]
  );
  if (rows.length < quantity) {
    // Deliberately not "sold out": somebody else may be mid-checkout and the
    // seats may come back. The message says what the buyer can do about it.
    throw new AppError(409, rows.length
      ? `Only ${rows.length} seat${rows.length === 1 ? "" : "s"} left in that section. Choose a smaller quantity or another section.`
      : "Those seats have just gone. Choose another section.");
  }
  await client.query(
    "UPDATE event_seats SET status = 'held', updated_at = NOW() WHERE id = ANY($1)",
    [rows.map((row) => row.id)]
  );
  return rows;
}

// Called once the ticket exists, in the same transaction: the seat stops being
// held and starts being sold, and points at the ticket holding it.
async function attachSeatToTicket(client, seatId, ticketId) {
  await client.query(
    "UPDATE event_seats SET status = 'sold', ticket_id = $2, updated_at = NOW() WHERE id = $1",
    [seatId, ticketId]
  );
}

async function claimTicketByCode(actor, rawCode, meta = {}) {
  await ensureTicketingSchema();
  const code = String(rawCode || "").replace(/\s+/g, "");
  if (!/^\d{6,10}$/.test(code)) {
    throw new AppError(400, "Enter the ticket code, the 6 to 10 digit number printed on the ticket.");
  }

  const { rows: throttleRows } = await pool.query(
    `SELECT COUNT(*)::int AS failures
     FROM event_audit_logs
     WHERE actor_id = $1 AND action = 'ticket_claim_failed' AND created_at > NOW() - INTERVAL '1 hour'`,
    [actor.userId]
  );
  if (throttleRows[0].failures >= TICKET_CLAIM_MAX_FAILURES_PER_HOUR) {
    throw new AppError(429, "Too many ticket codes tried. Wait an hour and check the code on the ticket email or PDF.");
  }

  const { rows } = await pool.query(
    `SELECT t.*, e.event_name, e.status AS event_status, u.full_name AS owner_name, u.email AS owner_email,
            tt.transfer_allowed, tt.ticket_name AS ticket_type_name
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN users u ON u.id = t.owner_user_id
     JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
     WHERE t.ticket_code = $1
     LIMIT 1`,
    [code]
  );
  const ticket = rows[0];

  const failClaim = async (message, statusCode = 404) => {
    await eventAudit({
      eventId: ticket?.event_id || null,
      actorType: "customer",
      actorId: actor.userId,
      action: "ticket_claim_failed",
      metadata: { code, reason: message },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent
    }).catch(() => {});
    throw new AppError(statusCode, message);
  };

  if (!ticket) return failClaim("No ticket found with that code. Check the code on the ticket email or PDF.");
  if (ticket.owner_user_id === actor.userId) throw new AppError(409, "That ticket is already in your account. It is in My Tickets.");
  if (ticket.status === "scanned") return failClaim("That ticket has already been scanned in at the gate, so it cannot be added.", 409);
  if (ticket.status !== "valid") return failClaim("That ticket is no longer valid, so it cannot be added.", 409);
  if (["cancelled", "suspended"].includes(ticket.event_status)) {
    return failClaim("That event is not accepting entries at the moment, so the ticket cannot be added.", 409);
  }
  // THE ORGANISER'S OWN SETTING, ACTUALLY ENFORCED.
  //
  // event_ticket_types.transfer_allowed has been stored, editable in the
  // organiser's ticket form and returned by the API since the table was
  // written — and nothing ever read it. An organiser who switched transfer OFF
  // was told it was off while anybody holding the code could still pull the
  // ticket into their own account. A control that does nothing is worse than
  // no control: it is a promise to the organiser that the platform was not
  // keeping.
  //
  // Non-transferable is a real and common choice — named tickets for a
  // licensed venue, an age-restricted event, a corporate allocation — so the
  // refusal names the reason rather than pretending the code was wrong.
  if (!ticket.transfer_allowed) {
    return failClaim(
      `${ticket.ticket_type_name || "This ticket"} cannot be transferred. The organiser set it to stay with the person who bought it, so it has to be used from their account.`,
      409
    );
  }
  // A wristband already linked to this ticket belongs to the current holder.
  // Moving the ticket underneath it would leave a live tag on someone else's
  // entry — the giver must unlink (or the organiser reassign) first.
  const { rows: tagRows } = await pool.query(
    "SELECT 1 FROM event_tags WHERE ticket_id = $1 AND status IN ('ASSIGNED','ACTIVE') LIMIT 1",
    [ticket.id]
  ).catch(() => ({ rows: [] }));
  if (tagRows[0]) {
    return failClaim("That ticket already has an event wristband linked to it. Ask the person who gifted it to unlink their wristband first, then add the ticket again.", 409);
  }

  const { rows: claimantRows } = await pool.query("SELECT full_name, email, phone FROM users WHERE id = $1", [actor.userId]);
  const claimant = claimantRows[0] || {};
  await pool.query(
    `UPDATE tickets
     SET owner_user_id = $2, attendee_name = $3, attendee_email = $4, attendee_phone = $5, updated_at = NOW()
     WHERE id = $1`,
    [ticket.id, actor.userId, claimant.full_name || ticket.attendee_name, claimant.email || null, claimant.phone || null]
  );
  await eventAudit({
    eventId: ticket.event_id,
    actorType: "customer",
    actorId: actor.userId,
    action: "ticket_claimed",
    metadata: { ticketId: ticket.id, ticketCode: code, previousOwnerId: ticket.owner_user_id },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent
  }).catch(() => {});

  // Tell the previous owner. A real gift expects this message; a stolen code
  // turns it into the alarm that gets the transfer reversed by support.
  try {
    await createNotification({
      user: { id: ticket.owner_user_id, user_type: "customer" },
      channel: "in_app",
      notificationType: "ticket_transferred",
      title: "A ticket left your account",
      body: `Ticket ${code} for ${ticket.event_name} was added to another TitoPay account. If you gifted it, all is well. If not, contact TitoPay support immediately.`,
      provider: "in_app",
      metadata: { ticketId: ticket.id, ticketCode: code, clientNotificationId: `ticket-claim-${ticket.id}` }
    });
  } catch (error) {
    console.error("[ticket-claim] owner notification failed", { ticketId: ticket.id, message: error.message });
  }
  if (ticket.owner_email) {
    try {
      const emailCentre = require("./email-centre-service");
      await emailCentre.queueRawEmail({
        recipient: ticket.owner_email,
        subject: `Your ticket ${code} was added to another account`,
        textBody: [
          `Hi ${ticket.owner_name || "there"},`,
          "",
          `Ticket ${code} for ${ticket.event_name} has just been added to another TitoPay account using its ticket code.`,
          "",
          "If you gifted or passed this ticket on, no action is needed. The new holder now has it in their My Tickets, and entry will be under their name.",
          "If you did NOT give this ticket to anyone, contact TitoPay support immediately from the app (Support > Contact TitoPay) so the transfer can be reversed."
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${emailCentre.escapeHtml(ticket.owner_name || "there")},</p>`,
          `<p>Ticket <strong>${emailCentre.escapeHtml(code)}</strong> for <strong>${emailCentre.escapeHtml(ticket.event_name)}</strong> has just been added to another TitoPay account using its ticket code.</p>`,
          "<p>If you gifted or passed this ticket on, no action is needed. The new holder now has it in their My Tickets, and entry will be under their name.</p>",
          "<p>If you did <strong>not</strong> give this ticket to anyone, contact TitoPay support immediately from the app (<strong>Support &gt; Contact TitoPay</strong>) so the transfer can be reversed.</p>"
        ].join("\n"),
        userId: ticket.owner_user_id,
        idempotencyKey: `ticket-claim-owner-alert:${ticket.id}`,
        metadata: { ticketId: ticket.id }
      });
    } catch (error) {
      console.error("[ticket-claim] owner email failed", { ticketId: ticket.id, message: error.message });
    }
  }

  const mine = await listMyTickets(actor.userId);
  return mine.find((item) => item.ticketCode === code) || { ticketCode: code, claimed: true };
}

// includeRemoved brings back what the customer put away. The list is otherwise
// only the tickets they still want to see.
// Put a ticket away, or bring it back.
//
// This never deletes. The row, its scan history and its place in the
// organiser's counts all stay exactly as they were; only whether the customer
// sees it in My Tickets changes. That is why it is safe to offer on a ticket
// that is still valid: nothing is lost and the customer can undo it.
async function setMyTicketRemoved(userId, ticketId, removed) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `UPDATE tickets
        SET hidden_at = CASE WHEN $3 THEN NOW() ELSE NULL END
      WHERE id = $1 AND owner_user_id = $2
      RETURNING id, hidden_at`,
    [ticketId, userId, Boolean(removed)]
  );
  // Scoped to the owner, so a ticket id belonging to someone else is a 404
  // rather than a 403: it does not confirm the ticket exists.
  if (!rows[0]) throw new AppError(404, "Ticket not found");
  return { id: rows[0].id, removed: Boolean(rows[0].hidden_at) };
}

async function listMyTickets(userId, { includeRemoved = false } = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT t.*,
            o.order_reference, o.status AS order_status, o.created_at AS order_created_at,
            tt.ticket_name,
            e.event_name, e.slug, e.event_date, e.start_time, e.venue_name, e.city, e.province,
            -- The event's own state travels with the ticket. Without it a
            -- cancelled event looked exactly like a live one, so the holder
            -- kept a ticket that was never going to be scanned and only found
            -- out at the venue.
            e.status AS event_status,
            COALESCE(e.cashless_tags_enabled, FALSE) AS cashless_tags_enabled,
            EXISTS (
              SELECT 1 FROM event_tags g
               WHERE g.ticket_id = t.id AND g.status IN ('ASSIGNED','ACTIVE')
            ) AS wristband_linked
       FROM tickets t
       JOIN ticket_orders o ON o.id = t.order_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
      WHERE t.owner_user_id = $1
        AND ($2::BOOLEAN OR t.hidden_at IS NULL)
      ORDER BY t.created_at DESC
      LIMIT 200`,
    [userId, includeRemoved]
  );
  // Each ticket carries its scannable QR image (drawn from the payload signed
  // at purchase), so the stub and the PDF show a real entry code. Sequential on
  // purpose: the encoder is a few ms per code and this endpoint caps at 200.
  const qrImages = [];
  for (const row of rows) qrImages.push(await ticketQrDataUrl(row));
  return rows.map((row, index) => ({
    ...ticketResponse(row),
    qrImageDataUrl: qrImages[index],
    ticketTypeName: row.ticket_name,
    // Carried so a ticket can explain itself rather than leave a blank where a
    // "Link wristband" button would be. Silence reads as "the feature was
    // removed" to anyone who knows it exists.
    cashlessTagsEnabled: Boolean(row.cashless_tags_enabled),
    wristbandLinked: Boolean(row.wristband_linked),
    // A cancelled or suspended event is the single most important thing a
    // ticket holder can be told, and it was the one thing this list did not say.
    eventStatus: row.event_status,
    eventCancelled: row.event_status === "cancelled",
    removed: Boolean(row.hidden_at),
    removedAt: row.hidden_at,
    eventName: row.event_name,
    eventDate: row.event_date,
    venueName: row.venue_name,
    city: row.city,
    order: {
      id: row.order_id,
      orderReference: row.order_reference,
      status: row.order_status,
      createdAt: row.order_created_at
    },
    event: {
      id: row.event_id,
      slug: row.slug,
      eventName: row.event_name,
      eventDate: row.event_date,
      startTime: row.start_time,
      venueName: row.venue_name,
      city: row.city,
      province: row.province
    }
  }));
}

// How many tickets have been scanned in, out of how many were issued, for one
// event. Read after every scan so the door sees a live count.
async function eventAttendance(eventId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'scanned')::int AS scanned,
            COUNT(*)::int AS total
       FROM tickets WHERE event_id = $1`,
    [eventId]
  );
  return { scanned: rows[0]?.scanned || 0, total: rows[0]?.total || 0 };
}

async function scanTicket(actor, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  // A camera scan of the ticket's QR hands over its full JSON payload; the
  // typed path hands over the 10-digit code. Accept both — and refuse a TitoPay
  // PAYMENT QR by name. Tickets and payment QRs are separate instruments: a
  // payment QR must never admit anyone through a gate, and a ticket must never
  // be payable (payQr enforces the other direction).
  let rawCode = String(payload.ticketCode || payload.ticket_code || payload.code || "").trim();
  if (rawCode.startsWith("{")) {
    let parsed = null;
    try { parsed = JSON.parse(rawCode); } catch { parsed = null; }
    if (parsed && parsed.type === "titopay_ticket" && parsed.ticketCode) {
      rawCode = String(parsed.ticketCode).trim();
    } else if (parsed && (parsed.codeType || parsed.userId)) {
      throw new AppError(400, "This is a TitoPay payment QR, not an event ticket. It cannot admit anyone. Ask the attendee for their ticket QR or code.");
    } else {
      rawCode = "";
    }
  }
  const ticketCode = cleanText(rawCode, 40);
  if (!ticketCode) throw new AppError(400, "Ticket code is required");
  const { rows } = await pool.query(
    `SELECT t.*, e.event_name, e.business_user_id, e.status AS event_status, tt.ticket_name
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
     WHERE t.ticket_code = $1
     LIMIT 1`,
    [ticketCode]
  );
  const ticket = rows[0];
  if (!ticket) throw new AppError(404, "Ticket not found");
  if (!(await canManageEventTicketing(actor.userId, ticket.event_id, "scan"))) {
    throw new AppError(403, "You are not allowed to scan tickets for this event");
  }
  // A ticket for an event that is no longer live must not admit entry, even if
  // the ticket row itself was never individually updated. A cancelled event
  // invalidates its tickets, but a suspended event keeps them valid pending
  // reinstatement, so guard on the event status directly.
  if (ticket.event_status === "cancelled") {
    return { valid: false, status: "event_cancelled", ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "This event has been cancelled. Entry refused." };
  }
  if (ticket.event_status === "suspended") {
    return { valid: false, status: "event_suspended", ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "This event is suspended. Entry is on hold." };
  }
  if (ticket.status === "scanned") {
    return { valid: false, status: "already_scanned", ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "Ticket has already been scanned" };
  }
  if (ticket.status !== "valid") {
    return { valid: false, status: ticket.status, ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "Ticket is not valid for entry" };
  }
  // ONE TICKET, ONE ENTRY. The status read above ran unlocked, so two gate
  // scanners hitting the same ticket in the same instant both saw 'valid' and
  // both approved entry — two people in on one ticket (a shared screenshot is
  // exactly this attack). The guard admits one scan; the loser gets the same
  // already-scanned answer a late scan gets.
  const { rows: updated } = await pool.query(
    `UPDATE tickets
     SET status = 'scanned', scanned_at = NOW(), scanned_by = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'valid'
     RETURNING *`,
    [ticket.id, actor.userId]
  );
  if (!updated[0]) {
    return { valid: false, status: "already_scanned", ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "Ticket has already been scanned" };
  }
  await eventAudit({
    eventId: ticket.event_id,
    actorType: "customer",
    actorId: actor.userId,
    action: "ticket_scanned",
    metadata: { ticketId: ticket.id, ticketCode },
    ...meta
  });
  // A running attendance count so the person on the door sees how many have come
  // in, right after each scan.
  return { valid: true, status: "scanned", ticket: ticketResponse(updated[0]), attendance: await eventAttendance(ticket.event_id), message: "Ticket valid. Entry approved." };
}

async function lookupVerifiedCustomer(identifier) {
  const value = cleanText(identifier, 180).toLowerCase();
  const cleaned = value.replace(/^@/, "");
  const digits = value.replace(/\D/g, "");
  // Two matching bugs lived here. (1) When the identifier had no digits (an
  // @username or email), the digits clause compared against the EMPTY string —
  // which matched any user with no phone on file, and LIMIT 1 with no ordering
  // could then return a complete stranger. The clause now only applies to a
  // real phone-shaped value. (2) A person's business and personal accounts
  // often share a phone or email; with no ordering, the BUSINESS account could
  // be picked for a door-staff role meant for the person. An exact @username
  // wins outright (usernames are unique), then the personal account is
  // preferred.
  const params = [cleaned];
  let digitsClause = "FALSE";
  if (digits.length >= 6) {
    params.push(digits);
    digitsClause = `REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $2`;
  }
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, username, email, phone, fica_status, status
     FROM users
     WHERE LOWER(username) = $1
        OR LOWER(email) = $1
        OR LOWER(phone) = $1
        OR ${digitsClause}
     ORDER BY (LOWER(username) = $1) DESC,
              (account_type = 'personal') DESC,
              created_at ASC
     LIMIT 1`,
    params
  );
  const user = rows[0];
  if (!user) throw new AppError(404, "TitoPay user not found. Check the @username, phone or email.");
  // Scanning tickets moves no money, so staff need an ACTIVE account — not
  // FICA. Requiring FICA here blocked organisers from adding perfectly normal
  // helpers (most personal accounts are pending review), for a door role with
  // no financial reach. FICA continues to gate the things that move money.
  if (user.status !== "active") {
    throw new AppError(403, "This TitoPay account is not active, so it cannot be added as event staff.");
  }
  return user;
}

// The approved events THIS user may scan because an organiser added them as
// staff. This is what puts the door scanner on a personal account: assigned
// staff see exactly the events they were given, and nothing else.
async function listStaffScanEvents(userId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT e.id, e.event_name, e.status, e.event_date, e.venue_name, e.city
       FROM event_staff s
       JOIN events e ON e.id = s.event_id
      WHERE s.user_id = $1
        AND s.status = 'active'
        AND (s.permissions ? 'scan' OR s.role IN ('owner','manager'))
        AND e.status = 'approved'
      ORDER BY e.event_date ASC NULLS LAST`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    eventName: row.event_name,
    status: row.status,
    eventDate: row.event_date,
    venueName: row.venue_name,
    city: row.city
  }));
}

async function addEventStaff(actor, eventId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const { rows: eventRows } = await pool.query("SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, actor.userId]);
  const event = eventRows[0];
  if (!event) throw new AppError(404, "Event not found");
  const user = await lookupVerifiedCustomer(payload.identifier || payload.user || payload.phone || payload.email || payload.username);
  const permissions = Array.isArray(payload.permissions) && payload.permissions.length ? payload.permissions : ["scan"];
  const { rows } = await pool.query(
    `INSERT INTO event_staff (id, event_id, user_id, role, permissions, status, invited_by)
     VALUES ($1,$2,$3,$4,$5::JSONB,'active',$6)
     ON CONFLICT (event_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, status = 'active', updated_at = NOW()
     RETURNING *`,
    [randomUUID(), eventId, user.id, cleanText(payload.role || "scanner", 60), JSON.stringify(permissions), actor.userId]
  );
  await eventAudit({
    eventId,
    actorType: "customer",
    actorId: actor.userId,
    action: "event_staff_added",
    metadata: { staffUserId: user.id, permissions },
    ...meta
  });
  // Tell the person what they were added to do and where to find it. A staff
  // member who has to be phoned and talked to the right screen was the whole
  // complaint; the alert and the email walk them there. Best-effort — a mail
  // hiccup must not fail the add.
  const staffBody = `${event.event_name}: you can now scan tickets at the door. Open Event Tickets on your TitoPay profile. The "Scan entry" button for this event is ready.`;
  try {
    await createNotification({
      user: { id: user.id, user_type: "customer" },
      channel: "in_app",
      notificationType: "event_staff_added",
      title: "You are a ticket scanner",
      body: staffBody,
      provider: "in_app",
      metadata: { eventId, clientNotificationId: `event-staff-added-${rows[0].id}-${rows[0].updated_at?.toISOString?.() || ""}` }
    });
  } catch (error) {
    console.error("[event-staff] add notification failed", { eventId, staffUserId: user.id, message: error.message });
  }
  if (user.email) {
    try {
      const emailCentre = require("./email-centre-service");
      await emailCentre.queueRawEmail({
        recipient: user.email,
        subject: `You are a ticket scanner for ${event.event_name}`,
        textBody: [
          `Hi ${user.full_name || "there"},`,
          "",
          `${event.event_name} has added you as a ticket scanner${event.event_date ? ` (event date: ${String(event.event_date).slice(0, 10)})` : ""}.`,
          "",
          "What you can do: scan attendees' ticket QR codes at the gate and watch the live attendance count. You cannot move any money and you do not need FICA for this.",
          "",
          "Where to find it: open the TitoPay app on your own account, go to Event Tickets on your profile, and tap \"Scan entry\" for this event. The camera scanner and code entry are both there.",
          "",
          "If you were not expecting this, you can ignore it. Being staff gives you no access to the organiser's account."
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${emailCentre.escapeHtml(user.full_name || "there")},</p>`,
          `<p><strong>${emailCentre.escapeHtml(event.event_name)}</strong> has added you as a <strong>ticket scanner</strong>${event.event_date ? ` (event date: ${emailCentre.escapeHtml(String(event.event_date).slice(0, 10))})` : ""}.</p>`,
          "<p><strong>What you can do:</strong> scan attendees' ticket QR codes at the gate and watch the live attendance count. You cannot move any money and you do not need FICA for this.</p>",
          "<p><strong>Where to find it:</strong> open the TitoPay app on your own account, go to <strong>Event Tickets</strong> on your profile, and tap <strong>Scan entry</strong> for this event. The camera scanner and code entry are both there.</p>",
          "<p>If you were not expecting this, you can ignore it. Being staff gives you no access to the organiser's account.</p>"
        ].join("\n"),
        userId: user.id,
        idempotencyKey: `event-staff-added:${rows[0].id}:${rows[0].updated_at?.toISOString?.() || Date.now()}`,
        metadata: { eventId, staffUserId: user.id }
      });
    } catch (error) {
      console.error("[event-staff] add email failed", { eventId, staffUserId: user.id, message: error.message });
    }
  }
  return { ...rows[0], user };
}

// Owner-only, like adding: taking someone off the door is the organiser's
// call. The row is kept (status 'removed') so the audit trail stays whole; a
// re-add simply reactivates it.
async function removeEventStaff(actor, eventId, staffUserId, meta = {}) {
  await ensureTicketingSchema();
  const { rows: eventRows } = await pool.query("SELECT id, event_name FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, actor.userId]);
  if (!eventRows[0]) throw new AppError(404, "Event not found");
  const { rows } = await pool.query(
    `UPDATE event_staff SET status = 'removed', updated_at = NOW()
      WHERE event_id = $1 AND user_id = $2 AND status = 'active'
      RETURNING *`,
    [eventId, staffUserId]
  );
  if (!rows[0]) throw new AppError(404, "That person is not on this event's staff");
  await eventAudit({
    eventId,
    actorType: "customer",
    actorId: actor.userId,
    action: "event_staff_removed",
    metadata: { staffUserId },
    ...meta
  });
  // The person is told, so the scanner disappearing from their app is never
  // a mystery. In-app only — removal does not need an email.
  try {
    await createNotification({
      user: { id: staffUserId, user_type: "customer" },
      channel: "in_app",
      notificationType: "event_staff_removed",
      title: "Scanner access removed",
      body: `${eventRows[0].event_name}: you are no longer a ticket scanner for this event.`,
      provider: "in_app",
      metadata: { eventId, clientNotificationId: `event-staff-removed-${rows[0].id}-${rows[0].updated_at?.toISOString?.() || ""}` }
    });
  } catch (error) {
    console.error("[event-staff] removal notification failed", { eventId, staffUserId, message: error.message });
  }
  return rows[0];
}

async function listEventStaff(actor, eventId) {
  await ensureTicketingSchema();
  if (!(await canManageEventTicketing(actor.userId, eventId, "scan"))) throw new AppError(403, "You are not allowed to view this event staff list");
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name, u.username, u.email, u.phone, u.fica_status
     FROM event_staff s
     JOIN users u ON u.id = s.user_id
     WHERE s.event_id = $1
     ORDER BY s.created_at DESC`,
    [eventId]
  );
  return rows;
}

/* ==========================================================================
   THE REFUND POLICY, ENFORCED
   ==========================================================================
   refunds_allowed, refund_deadline and refund_conditions have been stored on
   every ticket type since ticketing shipped, and nothing has ever read them.
   The app also hard-coded refundsAllowed: true on every tier it created, so
   the organiser's stated policy was decoration twice over: they could not set
   it, the buyer never saw it, and nothing enforced it.

   ONE function answers "can this be refunded?", and both the buyer's screen
   and the refund gate call it. A policy shown on the checkout screen and a
   policy applied at the counter that could differ is worse than no policy.
   ========================================================================== */

// Describes the policy in the words a buyer needs BEFORE they pay. Pure: it
// takes rows and returns a description, so the same call serves the purchase
// preview, the public event page and the refund request.
function refundPolicyFor(ticketTypeRow = {}, eventRow = {}) {
  const allowed = Boolean(ticketTypeRow.refunds_allowed ?? ticketTypeRow.refundsAllowed);
  const deadlineRaw = ticketTypeRow.refund_deadline ?? ticketTypeRow.refundDeadline ?? null;
  const deadline = deadlineRaw ? new Date(deadlineRaw) : null;
  const validDeadline = deadline && !Number.isNaN(deadline.getTime());
  const conditions = cleanText(ticketTypeRow.refund_conditions ?? ticketTypeRow.refundConditions ?? "", 800);
  const eventPolicy = eventRow.refund_policy || eventRow.refundPolicy || {};
  const summary = cleanText(eventPolicy.summary || eventPolicy.conditions || "", 800);

  // The single sentence that goes next to the Pay button. It has to be true
  // whether or not the organiser wrote anything.
  let headline;
  if (!allowed) {
    headline = "This ticket is non-refundable.";
  } else if (validDeadline) {
    headline = `Refundable until ${deadline.toLocaleDateString("en-ZA", {
      day: "numeric", month: "long", year: "numeric"
    })}.`;
  } else {
    headline = "Refundable while the organiser's refund window is open.";
  }
  return {
    refundsAllowed: allowed,
    deadline: validDeadline ? deadline.toISOString() : null,
    headline,
    conditions,
    // The organiser's own words about the event as a whole, shown under the
    // headline so a buyer reads the policy rather than being told one exists.
    summary,
    // A refund always costs the processing fee, and a buyer who is told
    // "refundable" and then gets less back than they paid feels cheated.
    feeNotice: allowed ? "A refund returns the ticket price. The TitoPay service fee and the refund processing fee are not returned." : ""
  };
}

// Whether THIS order can be refunded right now, and if not, why not in words
// that name the organiser's rule rather than an internal state.
function refundEligibility(order = {}, ticketTypeRow = {}, eventRow = {}, { scannedCount = 0 } = {}) {
  const policy = refundPolicyFor(ticketTypeRow, eventRow);
  const refuse = (reason) => ({ ...policy, eligible: false, reason });

  if (String(order.status) === "refunded") return refuse("This order has already been refunded.");
  if (String(order.status) !== "paid") return refuse("This order is not eligible for a refund request.");
  if (money(order.total || 0) <= 0) {
    return refuse("This ticket was free, so there is nothing to refund. You can release your spot by not attending.");
  }
  if (scannedCount > 0) return refuse("A ticket that has already been scanned at the door cannot be refunded.");
  if (!policy.refundsAllowed) {
    return refuse(policy.conditions
      ? `The organiser does not offer refunds on this ticket. ${policy.conditions}`
      : "The organiser does not offer refunds on this ticket.");
  }
  if (policy.deadline && new Date(policy.deadline).getTime() < Date.now()) {
    return refuse(`The refund window for this ticket closed on ${new Date(policy.deadline).toLocaleDateString("en-ZA", {
      day: "numeric", month: "long", year: "numeric"
    })}.`);
  }
  // An event that has already happened cannot be refunded whatever the policy
  // says, or a no-show would be refundable for as long as the deadline column
  // happened to be left empty.
  const eventDate = eventRow.event_end_date || eventRow.event_date;
  if (eventDate) {
    const ends = new Date(eventDate);
    ends.setHours(23, 59, 59, 999);
    if (!Number.isNaN(ends.getTime()) && ends.getTime() < Date.now()) {
      return refuse("This event has already taken place, so it can no longer be refunded.");
    }
  }
  return { ...policy, eligible: true, reason: "" };
}

// Reads the policy for one order. Used by the app to decide whether to offer a
// Request refund button at all, so a buyer is never invited to tap something
// that is going to refuse them.
async function ticketOrderRefundPolicy(actor, orderId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT o.*, tt.refunds_allowed, tt.refund_deadline, tt.refund_conditions,
            e.refund_policy, e.event_date, e.event_end_date, e.event_name,
            (SELECT COUNT(*)::INT FROM tickets t WHERE t.order_id = o.id AND t.status = 'scanned') AS scanned
       FROM ticket_orders o
       JOIN event_ticket_types tt ON tt.id = o.ticket_type_id
       JOIN events e ON e.id = o.event_id
      WHERE o.id = $1 AND o.buyer_user_id = $2
      LIMIT 1`,
    [orderId, actor.userId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "Ticket order not found");
  const { rows: openRows } = await pool.query(
    "SELECT id, status FROM ticket_refunds WHERE order_id = $1 AND status IN ('requested','under_review') LIMIT 1",
    [orderId]
  );
  return {
    ...refundEligibility(row, row, row, { scannedCount: Number(row.scanned || 0) }),
    orderId,
    eventName: row.event_name,
    alreadyRequested: Boolean(openRows[0]),
    refundableAmount: money(row.subtotal)
  };
}

async function requestTicketRefund(actor, orderId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  // THE POLICY IS CHECKED HERE, not just displayed. The same function answers
  // the buyer's screen, so the button they were shown and the rule applied
  // when they tap it can never disagree.
  const { rows } = await pool.query(
    `SELECT o.*, tt.refunds_allowed, tt.refund_deadline, tt.refund_conditions,
            e.refund_policy, e.event_date, e.event_end_date,
            (SELECT COUNT(*)::INT FROM tickets t WHERE t.order_id = o.id AND t.status = 'scanned') AS scanned
       FROM ticket_orders o
       JOIN event_ticket_types tt ON tt.id = o.ticket_type_id
       JOIN events e ON e.id = o.event_id
      WHERE o.id = $1 AND o.buyer_user_id = $2
      LIMIT 1`,
    [orderId, actor.userId]
  );
  const order = rows[0];
  if (!order) throw new AppError(404, "Ticket order not found");
  const eligibility = refundEligibility(order, order, order, { scannedCount: Number(order.scanned || 0) });
  if (!eligibility.eligible) throw new AppError(409, eligibility.reason);
  const { rows: existing } = await pool.query("SELECT * FROM ticket_refunds WHERE order_id = $1 AND status IN ('requested','under_review') LIMIT 1", [orderId]);
  if (existing[0]) return existing[0];
  const refundId = randomUUID();
  const { rows: inserted } = await pool.query(
    `INSERT INTO ticket_refunds (id, order_id, event_id, requested_by, status, reason, amount)
     VALUES ($1,$2,$3,$4,'requested',$5,$6)
     RETURNING *`,
    [refundId, orderId, order.event_id, actor.userId, cleanText(payload.reason || "", 1000), money(payload.amount || order.subtotal)]
  );
  await eventAudit({
    eventId: order.event_id,
    actorType: "customer",
    actorId: actor.userId,
    action: "ticket_refund_requested",
    metadata: { orderId, refundId, amount: inserted[0].amount },
    ...meta
  });
  return inserted[0];
}

// The organiser's own refund queue, scoped to one of their events. Same rows
// the admin console sees, filtered to the event whose money is at stake.
async function listEventRefunds(eventId, { status = "" } = {}) {
  await ensureTicketingSchema();
  const params = [eventId];
  let clause = "r.event_id = $1";
  if (status) { params.push(status); clause += ` AND r.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT r.*, o.order_reference, o.quantity, o.total AS order_total, o.subtotal AS order_subtotal,
            u.full_name AS buyer_name, u.email AS buyer_email,
            tt.ticket_name
       FROM ticket_refunds r
       JOIN ticket_orders o ON o.id = r.order_id
       JOIN users u ON u.id = o.buyer_user_id
       JOIN event_ticket_types tt ON tt.id = o.ticket_type_id
      WHERE ${clause}
      ORDER BY r.requested_at DESC
      LIMIT 200`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderReference: row.order_reference,
    status: row.status,
    reason: row.reason,
    amount: money(row.amount),
    orderTotal: money(row.order_total),
    quantity: Number(row.quantity || 0),
    ticketName: row.ticket_name,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    decisionNote: row.decision_note || "",
    processedByRole: row.processed_by_role || null,
    requestedAt: row.requested_at,
    processedAt: row.processed_at
  }));
}

/* ==========================================================================
   WAITLIST
   ==========================================================================
   A sold-out event is currently a dead end: the buyer leaves and the organiser
   never learns that fifty more people wanted in. Joining the list is free and
   reserves nothing. It is a signal, not a claim on a ticket, and the copy says
   so, because a "waitlist" people believe is a reservation produces a worse
   argument than no waitlist at all.
   ========================================================================== */

async function joinTicketWaitlist(actor, slug, payload = {}) {
  await ensureTicketingSchema();
  const quantity = Math.max(1, Math.min(20, Number.parseInt(payload.quantity || 1, 10) || 1));
  const { rows } = await pool.query(
    "SELECT id, event_name FROM events WHERE slug = $1 AND status = 'approved' LIMIT 1",
    [slugify(slug)]
  );
  const event = rows[0];
  if (!event) throw new AppError(404, "Event is not available");
  const ticketTypeId = cleanText(payload.ticketTypeId || payload.ticket_type_id, 80) || null;
  if (ticketTypeId) {
    const { rows: typeRows } = await pool.query(
      "SELECT id FROM event_ticket_types WHERE id = $1 AND event_id = $2 LIMIT 1", [ticketTypeId, event.id]);
    if (!typeRows[0]) throw new AppError(404, "That ticket type does not belong to this event");
  }
  const { rows: saved } = await pool.query(
    `INSERT INTO ticket_waitlist (id, event_id, ticket_type_id, user_id, quantity)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id, COALESCE(ticket_type_id, '00000000-0000-0000-0000-000000000000'::UUID), user_id)
     DO UPDATE SET quantity = EXCLUDED.quantity, status = 'waiting', updated_at = NOW()
     RETURNING *`,
    [randomUUID(), event.id, ticketTypeId, actor.userId, quantity]
  );
  const { rows: positionRows } = await pool.query(
    `SELECT COUNT(*)::INT AS ahead FROM ticket_waitlist
      WHERE event_id = $1 AND status = 'waiting' AND created_at < $2`,
    [event.id, saved[0].created_at]
  );
  return {
    id: saved[0].id,
    eventName: event.event_name,
    quantity: saved[0].quantity,
    position: Number(positionRows[0]?.ahead || 0) + 1,
    // Said plainly, because a waitlist that sounds like a reservation is a
    // complaint waiting to happen.
    message: "You are on the list. Nothing is reserved and nothing has been charged. We will tell you if tickets are released."
  };
}

async function leaveTicketWaitlist(actor, slug) {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT id FROM events WHERE slug = $1 LIMIT 1", [slugify(slug)]);
  if (!rows[0]) throw new AppError(404, "Event is not available");
  await pool.query("DELETE FROM ticket_waitlist WHERE event_id = $1 AND user_id = $2", [rows[0].id, actor.userId]);
  return { ok: true, message: "You have been taken off the waitlist." };
}

async function myWaitlistEntry(actor, slug) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT w.* FROM ticket_waitlist w
       JOIN events e ON e.id = w.event_id
      WHERE e.slug = $1 AND w.user_id = $2 LIMIT 1`,
    [slugify(slug), actor.userId]
  );
  return rows[0] ? { onList: true, quantity: rows[0].quantity, status: rows[0].status } : { onList: false };
}

async function listEventWaitlist(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT w.*, u.full_name, u.email, tt.ticket_name
       FROM ticket_waitlist w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN event_ticket_types tt ON tt.id = w.ticket_type_id
      WHERE w.event_id = $1
      ORDER BY w.created_at ASC
      LIMIT 500`,
    [eventId]
  );
  // demand/waiting are counts over the WHOLE waitlist, not the 500-row display
  // page - a hot event past 500 entries drives the organiser's release decision,
  // so an under-count there releases too few tickets.
  const { rows: totals } = await pool.query(
    `SELECT COALESCE(SUM(quantity) FILTER (WHERE status = 'waiting'), 0)::INT AS demand,
            COUNT(*) FILTER (WHERE status = 'waiting')::INT AS waiting
       FROM ticket_waitlist WHERE event_id = $1`,
    [eventId]
  );
  const demand = Number(totals[0]?.demand || 0);
  return {
    demand,
    waiting: Number(totals[0]?.waiting || 0),
    items: rows.map((row) => ({
      id: row.id,
      name: row.full_name,
      email: row.email,
      ticketName: row.ticket_name || "Any ticket",
      quantity: Number(row.quantity || 0),
      status: row.status,
      notifiedAt: row.notified_at,
      joinedAt: row.created_at
    }))
  };
}

// The organiser released more tickets and wants the queue told. In-app and
// email, through the same queue every other notice uses, and never a
// claim-by-link message.
async function notifyEventWaitlist(actor, eventId, payload = {}) {
  await ensureTicketingSchema();
  const { rows: eventRows } = await pool.query("SELECT * FROM events WHERE id = $1 LIMIT 1", [eventId]);
  const event = eventRows[0];
  if (!event) throw new AppError(404, "Event not found");
  const { rows } = await pool.query(
    "SELECT w.*, u.id AS user_id FROM ticket_waitlist w JOIN users u ON u.id = w.user_id WHERE w.event_id = $1 AND w.status = 'waiting' ORDER BY w.created_at ASC LIMIT 500",
    [eventId]
  );
  const note = cleanText(payload.message || "", 400);
  const body = `${event.event_name}: tickets have been released. ${note || "Open TitoPay and get yours before they go again."}`;
  let told = 0;
  for (const entry of rows) {
    try {
      await createNotification({
        user: { id: entry.user_id, user_type: "customer" },
        channel: "in_app",
        notificationType: "ticket_waitlist_released",
        title: "Tickets released",
        body,
        provider: "in_app",
        metadata: { eventId, slug: event.slug, clientNotificationId: `waitlist-${entry.id}-${Date.now()}` }
      });
      told += 1;
    } catch (error) {
      console.error("[waitlist-notify-failed]", { eventId, entryId: entry.id, message: error.message });
    }
  }
  await pool.query(
    "UPDATE ticket_waitlist SET status = 'notified', notified_at = NOW(), updated_at = NOW() WHERE event_id = $1 AND status = 'waiting'",
    [eventId]
  );
  await eventAudit({
    eventId, actorType: "customer", actorId: actor.userId, action: "waitlist_notified",
    metadata: { told }
  });
  return { told, message: told ? `${told} ${told === 1 ? "person has" : "people have"} been told.` : "Nobody is waiting right now." };
}

/* ==========================================================================
   PROMOTER LINKS
   ==========================================================================
   Attribution, and deliberately nothing more. The code rides from the link
   through to the order, so "who actually sold this" is answered from the
   ledger. TitoPay pays no commission on it: paying promoters automatically
   would need its own agreement, its own tax treatment and its own compliance
   story, and inventing that quietly inside a ticketing feature would be wrong.
   ========================================================================== */

async function listEventPromoters(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*)::INT FROM ticket_orders o WHERE o.promoter_id = p.id AND o.status = 'paid') AS orders,
            (SELECT COALESCE(SUM(o.quantity), 0)::INT FROM ticket_orders o WHERE o.promoter_id = p.id AND o.status = 'paid') AS tickets,
            (SELECT COALESCE(SUM(o.subtotal), 0) FROM ticket_orders o WHERE o.promoter_id = p.id AND o.status = 'paid') AS sales
       FROM event_promoters p
      WHERE p.event_id = $1
      ORDER BY sales DESC, p.created_at DESC`,
    [eventId]
  );
  const { rows: slugRows } = await pool.query("SELECT slug FROM events WHERE id = $1 LIMIT 1", [eventId]);
  const slug = slugRows[0]?.slug || "";
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    promoterName: row.promoter_name,
    status: row.status,
    clicks: Number(row.clicks || 0),
    orders: Number(row.orders || 0),
    tickets: Number(row.tickets || 0),
    sales: money(row.sales),
    link: `https://app.titopay.co.za/events/${slug}?ref=${encodeURIComponent(row.code)}`,
    createdAt: row.created_at
  }));
}

async function createEventPromoter(actor, eventId, payload = {}) {
  await ensureTicketingSchema();
  const code = normalizeCouponCode(payload.code);
  if (code.length < 3) throw new AppError(400, "A promoter code needs at least 3 letters or numbers.");
  const promoterName = cleanText(payload.promoterName || payload.name || "", 120);
  if (!promoterName) throw new AppError(400, "Give the promoter a name so you know who this link belongs to.");
  try {
    const { rows } = await pool.query(
      `INSERT INTO event_promoters (id, event_id, code, promoter_name, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), eventId, code, promoterName, cleanText(payload.notes, 300), actor.userId]
    );
    await eventAudit({ eventId, actorType: "customer", actorId: actor.userId, action: "promoter_created", metadata: { code } });
    const list = await listEventPromoters(eventId);
    return list.find((item) => item.id === rows[0].id) || list[0];
  } catch (error) {
    if (error?.code === "23505") throw new AppError(409, `You already have a promoter link called ${code} on this event.`);
    throw error;
  }
}

async function removeEventPromoter(actor, eventId, promoterId) {
  await ensureTicketingSchema();
  // Orders keep pointing at the row, so a link that has sold anything is
  // switched off rather than deleted: deleting it would erase the answer to
  // "who sold these tickets" from every order it brought in.
  const { rows } = await pool.query(
    "SELECT (SELECT COUNT(*)::INT FROM ticket_orders o WHERE o.promoter_id = $1) AS used, code FROM event_promoters WHERE id = $1 AND event_id = $2",
    [promoterId, eventId]
  );
  if (!rows[0]) throw new AppError(404, "Promoter link not found");
  if (Number(rows[0].used || 0) > 0) {
    await pool.query("UPDATE event_promoters SET status = 'disabled', updated_at = NOW() WHERE id = $1", [promoterId]);
    return { deleted: false, message: `${rows[0].code} has already sold tickets, so it was switched off. Its sales stay on your report.` };
  }
  await pool.query("DELETE FROM event_promoters WHERE id = $1", [promoterId]);
  return { deleted: true, message: `${rows[0].code} was deleted.` };
}

// A promoter link was opened. Counted separately from sales so an organiser can
// see the difference between reach and conversion. Best-effort by design: a
// counter must never be the reason an event page fails to load.
async function recordPromoterVisit(slug, code) {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return;
  await pool.query(
    `UPDATE event_promoters SET clicks = clicks + 1, updated_at = NOW()
      WHERE code = $1 AND event_id = (SELECT id FROM events WHERE slug = $2 LIMIT 1)`,
    [normalized, slugify(slug)]
  ).catch(() => {});
}

// Duplicating an event is how a weekly market or a tour actually gets made.
// It copies the setup and NOTHING that belongs to the original's sales: no
// tickets, no orders, no promoter links, no waitlist. The copy starts as a
// draft and goes through approval like any other event.
async function duplicateEvent(actor, eventId, payload = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1", [eventId, actor.userId]);
  const source = rows[0];
  if (!source) throw new AppError(404, "Event not found");
  const eventDate = payload.eventDate ? new Date(payload.eventDate) : null;
  if (!eventDate || Number.isNaN(eventDate.getTime())) throw new AppError(400, "Choose the date for the new event.");
  const name = cleanText(payload.eventName, 180) || `${source.event_name} (copy)`;
  const newId = randomUUID();
  const slug = await uniqueSlug(name);
  await pool.query(
    `INSERT INTO events
      (id, business_user_id, merchant_id, event_name, slug, status, category, description,
       event_date, event_end_date, start_time, end_time, venue_name, full_venue_address, city, province, country,
       event_mode, organiser_details, business_details, contact_email, contact_number,
       event_banner_url, age_restriction, capacity, terms_conditions, refund_policy,
       entry_rules, prohibited_items, accessibility_information, parking_information,
       additional_instructions, social_links, registration_mode)
     SELECT $1, business_user_id, merchant_id, $2, $3, 'draft', category, description,
       $4, $5, start_time, end_time, venue_name, full_venue_address, city, province, country,
       event_mode, organiser_details, business_details, contact_email, contact_number,
       event_banner_url, age_restriction, capacity, terms_conditions, refund_policy,
       entry_rules, prohibited_items, accessibility_information, parking_information,
       additional_instructions, social_links, registration_mode
     FROM events WHERE id = $6`,
    [newId, name, slug, eventDate, payload.eventEndDate ? new Date(payload.eventEndDate) : null, eventId]
  );
  // Ticket types come across with their prices and capacity, and with their
  // sales counters back at zero. A copy that inherited "quantity_sold" would
  // open already sold out.
  await pool.query(
    `INSERT INTO event_ticket_types
      (id, event_id, ticket_name, description, price, quantity_available, min_purchase_quantity,
       max_purchase_quantity, per_customer_purchase_limit, attendee_details_required, transfer_allowed,
       refunds_allowed, refund_conditions, sort_order)
     SELECT gen_random_uuid(), $1, ticket_name, description, price, quantity_available, min_purchase_quantity,
       max_purchase_quantity, per_customer_purchase_limit, attendee_details_required, transfer_allowed,
       refunds_allowed, refund_conditions, sort_order
     FROM event_ticket_types WHERE event_id = $2`,
    [newId, eventId]
  );
  await eventAudit({ eventId: newId, actorType: "customer", actorId: actor.userId, action: "event_duplicated", metadata: { sourceEventId: eventId } });
  return getBusinessEvent(actor.userId, newId);
}

async function listTicketRefunds({ status = "", limit = 100 } = {}) {
  await ensureTicketingSchema();
  const params = [];
  let where = "";
  if (status) {
    params.push(cleanText(status, 40));
    where = "WHERE r.status = $1";
  }
  params.push(Math.min(300, Math.max(1, Number(limit) || 100)));
  const { rows } = await pool.query(
    `SELECT r.*, o.order_reference, o.total, e.event_name, u.full_name AS requester_name, u.phone AS requester_phone
     FROM ticket_refunds r
     JOIN ticket_orders o ON o.id = r.order_id
     JOIN events e ON e.id = r.event_id
     LEFT JOIN users u ON u.id = r.requested_by
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function processTicketRefund(refundId, payload = {}, actor, meta = {}) {
  await ensureTicketingSchema();
  const action = String(payload.action || "approve").toLowerCase();
  const status = action === "reject" ? "rejected" : "approved";
  const decisionNote = cleanText(payload.note || payload.reason || "", 1000);
  // An organiser is a customer, and processed_by is a foreign key into
  // admin_users, so their id would break the insert. Whoever acted is recorded
  // in the column that can actually hold them, and the role says which.
  const isAdmin = String(actor?.userType || "admin") === "admin";
  const adminId = isAdmin ? (actor?.userId || null) : null;
  const organiserId = isAdmin ? null : (actor?.userId || null);
  const actorRole = isAdmin ? "admin" : "organiser";
  let refund;

  if (status === "rejected") {
    const { rows } = await pool.query(
      `UPDATE ticket_refunds
       SET status = 'rejected', processed_by = $2, processed_by_user_id = $4, processed_by_role = $5,
           processed_at = NOW(), decision_note = $3, updated_at = NOW()
       WHERE id = $1 AND status IN ('requested','under_review')
       RETURNING *`,
      [refundId, adminId, decisionNote, organiserId, actorRole]
    );
    refund = rows[0];
    if (!refund) throw new AppError(404, "Refund request not found");
  } else {
    const client = await pool.connect();
    const refundTxId = randomUUID();
    const reference = `TICKET-REFUND-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    try {
      await client.query("BEGIN");
      const { rows: refundRows } = await client.query(
        `SELECT *
         FROM ticket_refunds
         WHERE id = $1 AND status IN ('requested','under_review')
         LIMIT 1
         FOR UPDATE`,
        [refundId]
      );
      refund = refundRows[0];
      if (!refund) throw new AppError(404, "Refund request not found");

      const { rows: orderRows } = await client.query(
        `SELECT o.*, e.business_user_id
         FROM ticket_orders o
         JOIN events e ON e.id = o.event_id
         WHERE o.id = $1
         LIMIT 1
         FOR UPDATE`,
        [refund.order_id]
      );
      const order = orderRows[0];
      if (!order) throw new AppError(404, "Ticket order not found");
      if (order.status !== "paid") throw new AppError(409, "Only paid ticket orders can be refunded");
      const { rows: scannedRows } = await client.query(
        "SELECT COUNT(*)::INT AS scanned FROM tickets WHERE order_id = $1 AND status = 'scanned'",
        [refund.order_id]
      );
      if (Number(scannedRows[0]?.scanned || 0) > 0) {
        throw new AppError(409, "Scanned tickets cannot be refunded");
      }
      const subtotalNum = money(order.subtotal || 0);
      const refundAmount = money(Math.min(Number(refund.amount || subtotalNum || 0), subtotalNum));
      // A zero-value refund has nothing to move; refuse it plainly here rather
      // than letting the buyer credit below throw a generic wallet error.
      if (refundAmount <= 0) throw new AppError(409, "This order carries no refundable amount");
      // Reverse the ORIGINAL sale split instead of debiting the business the
      // whole subtotal. At purchase the business was credited business_net and
      // the platform kept business_commission (business_net + commission =
      // subtotal). A refund must claw each side back in the same proportion, or
      // the business pays back money it never received (the commission) and can
      // be left unable to refund at all — which is exactly what strands a
      // cancelled event's buyers. Prorate so a partial refund reverses
      // proportionally too.
      const ratio = subtotalNum > 0 ? refundAmount / subtotalNum : 0;
      // Clamped to refundAmount to defend the business_net <= subtotal
      // invariant: on a corrupt row the business could otherwise be debited
      // more than the buyer is credited.
      const businessPortion = Math.min(money(Number(order.business_net || 0) * ratio), refundAmount);
      // Whatever the business share does not cover is the platform's commission,
      // reversed from the revenue wallet where it was banked.
      const commissionPortion = money(refundAmount - businessPortion);
      const refundFeePreview = await calculateFee("ticket_refund_processing", refundAmount);
      const refundProcessingFee = money(refundFeePreview.fee || 0);
      // The business is only ever debited its own net share plus the refund fee.
      const businessDebitTotal = money(businessPortion + refundProcessingFee);
      const buyerWallet = await loadWalletForUpdate(client, order.buyer_user_id);
      const businessWallet = await loadWalletForUpdate(client, order.business_user_id, "business") || await loadWalletForUpdate(client, order.business_user_id);
      // The revenue wallet both funds the commission reversal and receives the
      // refund fee. A paid order can only have been sold with a revenue wallet
      // configured, so it exists whenever there is a commission to reverse.
      const revenueWallet = (commissionPortion > 0 || refundProcessingFee > 0) ? await loadRevenueWalletForUpdate(client) : null;
      if (!buyerWallet || !businessWallet) throw new AppError(404, "Refund wallet not found");
      if (Number(businessWallet.available_balance || 0) < businessDebitTotal) throw new AppError(400, "Business wallet has insufficient available balance for refund");
      if (commissionPortion > 0 && (!revenueWallet || Number(revenueWallet.available_balance || 0) < commissionPortion)) {
        throw new AppError(400, "Platform revenue wallet cannot cover the commission reversal for this refund");
      }
      await client.query(
        `INSERT INTO transactions
          (id, user_id, wallet_id, merchant_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
         VALUES ($1,$2,$3,$4,'ticket_refund',$5,$6,$7,'completed','credit',$8,$9,$10::JSONB)`,
        [
          refundTxId,
          order.buyer_user_id,
          buyerWallet.id,
          order.merchant_id || null,
          refundAmount,
          refundProcessingFee,
          businessDebitTotal,
          reference,
          order.order_reference,
          JSON.stringify({ refundId, orderId: order.id, eventId: order.event_id, reason: refund.reason, refundProcessingFee, businessPortion, commissionPortion })
        ]
      );
      // Business gives back only its net share of the sale.
      if (businessPortion > 0) {
        await applyWalletMovement(client, {
          walletId: businessWallet.id,
          transactionId: refundTxId,
          entryType: "debit",
          amount: businessPortion,
          reference,
          metadata: { serviceCode: "ticket_refund", refundId, orderId: order.id }
        });
      }
      // Platform reverses the commission it collected on the now-refunded sale,
      // and records the reversal as negative revenue so reports stay accurate.
      if (commissionPortion > 0 && revenueWallet) {
        await applyWalletMovement(client, {
          walletId: revenueWallet.id,
          transactionId: refundTxId,
          entryType: "debit",
          amount: commissionPortion,
          reference,
          metadata: { serviceCode: "ticket_refund", source: "commission_reversal", refundId, orderId: order.id }
        });
        await client.query(
          `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,'ticket_business_commission',$3,$4)`,
          [randomUUID(), refundTxId, -commissionPortion, revenueWallet.id]
        );
      }
      // Buyer gets the full subtotal back, funded by the two debits above.
      await applyWalletMovement(client, {
        walletId: buyerWallet.id,
        transactionId: refundTxId,
        entryType: "credit",
        amount: refundAmount,
        reference,
        metadata: { serviceCode: "ticket_refund", refundId, orderId: order.id }
      });
      if (refundProcessingFee > 0 && revenueWallet) {
        await applyWalletMovement(client, {
          walletId: businessWallet.id,
          transactionId: refundTxId,
          entryType: "debit",
          amount: refundProcessingFee,
          reference,
          metadata: { serviceCode: "ticket_refund_processing", refundId, orderId: order.id }
        });
        await applyWalletMovement(client, {
          walletId: revenueWallet.id,
          transactionId: refundTxId,
          entryType: "credit",
          amount: refundProcessingFee,
          reference,
          metadata: { serviceCode: "ticket_refund_processing", source: "ticket_refund_fee", refundId, orderId: order.id }
        });
        await client.query(
          `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,'ticket_refund_processing',$3,$4)`,
          [randomUUID(), refundTxId, refundProcessingFee, revenueWallet.id]
        );
      }
      await client.query("UPDATE ticket_orders SET status = 'refunded', updated_at = NOW() WHERE id = $1", [refund.order_id]);
      // A refunded sale gives the discount code back. The organiser capped the
      // promotion at a number of real sales, and this one did not stand, so it
      // must not keep consuming a use or count against the buyer's own limit.
      // Scoped to redemptions not already released, so a second pass over the
      // same order can never drive the counter below zero.
      const { rows: releasedRows } = await client.query(
        `UPDATE ticket_coupon_redemptions
            SET released_at = NOW()
          WHERE order_id = $1 AND released_at IS NULL
          RETURNING coupon_id, discount_amount`,
        [refund.order_id]
      );
      for (const released of releasedRows) {
        await client.query(
          `UPDATE ticket_coupons
              SET redeemed_count = GREATEST(0, redeemed_count - 1),
                  discount_given = GREATEST(0, discount_given - $2),
                  updated_at = NOW()
            WHERE id = $1`,
          [released.coupon_id, money(released.discount_amount)]
        );
      }
      await client.query("UPDATE tickets SET status = 'refunded', refunded_at = NOW(), updated_at = NOW() WHERE order_id = $1 AND status <> 'scanned'", [refund.order_id]);
      await client.query(
        `UPDATE event_ticket_types
         SET quantity_sold = GREATEST(0, quantity_sold - $2), updated_at = NOW()
         WHERE id = $1`,
        [order.ticket_type_id, order.quantity]
      );
      const { rows: updatedRefundRows } = await client.query(
        `UPDATE ticket_refunds
         SET status = 'approved',
             processed_by = $2,
             processed_by_user_id = $6,
             processed_by_role = $7,
             processed_at = NOW(),
             decision_note = $3,
             transaction_id = $4,
             amount = $5,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [refundId, adminId, decisionNote, refundTxId, refundAmount, organiserId, actorRole]
      );
      refund = updatedRefundRows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await eventAudit({
    eventId: refund.event_id,
    actorType: "admin",
    actorId: actor.userId,
    action: `ticket_refund_${status}`,
    metadata: { refundId, orderId: refund.order_id, amount: refund.amount },
    ...meta
  });
  return refund;
}

/* ==========================================================================
   ORGANISER CHANGE REQUESTS
   An approved event is frozen to the organiser — they cannot silently edit,
   postpone or pull an event that may already have sold tickets. Instead they
   ask, and admin (who already holds the suspend/cancel/edit powers) reviews and
   applies. Postpone and detail edits never touch ticket types or move money; a
   cancel goes through cancelEventCascade, which opens refund requests rather
   than moving money inline.
   ========================================================================== */

const CHANGE_REQUEST_TYPES = new Set(["postpone", "cancel", "update_details", "other"]);
const CHANGE_REQUEST_OPEN = ["requested", "under_review"];
// The statuses an organiser may raise a change request from — a live-ish event
// that is out of their own hands. draft/submitted/etc. are still editable or
// in review, so a change request there is meaningless.
const CHANGE_REQUEST_ALLOWED_EVENT_STATUS = new Set(["approved", "suspended"]);

// camelCase request field -> [db column, kind]. Only these may be changed
// through a change request; ticket types, prices, status and ownership are
// never touched here.
const EVENT_DETAIL_COLUMNS = {
  eventDate: ["event_date", "date"],
  startTime: ["start_time", "text"],
  endTime: ["end_time", "text"],
  description: ["description", "text"],
  venueName: ["venue_name", "text"],
  fullVenueAddress: ["full_venue_address", "text"],
  city: ["city", "text"],
  province: ["province", "text"],
  termsConditions: ["terms_conditions", "text"],
  entryRules: ["entry_rules", "text"],
  additionalInstructions: ["additional_instructions", "text"],
  parkingInformation: ["parking_information", "text"],
  accessibilityInformation: ["accessibility_information", "text"],
  ageRestriction: ["age_restriction", "text"],
  contactEmail: ["contact_email", "text"],
  contactNumber: ["contact_number", "text"],
  eventBannerUrl: ["event_banner_url", "banner"]
};
const EVENT_DATE_KEYS = new Set(["eventDate", "startTime", "endTime"]);

function cleanEventDate(value) {
  const text = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new AppError(400, "A valid event date (YYYY-MM-DD) is required.");
  return text;
}

// Build a narrow UPDATE from a whitelisted change set. dateOnly restricts it to
// the date/time columns (used by a postpone). Returns null when nothing valid
// was supplied.
function buildEventDetailUpdate(changes = {}, { dateOnly = false } = {}) {
  const sets = [];
  const params = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const spec = EVENT_DETAIL_COLUMNS[key];
    if (!spec) continue;
    if (dateOnly && !EVENT_DATE_KEYS.has(key)) continue;
    const [column, kind] = spec;
    let value;
    if (kind === "date") value = cleanEventDate(raw);
    else if (kind === "banner") value = cleanEventBanner(raw);
    else value = cleanText(raw, 4000);
    params.push(value);
    sets.push(`${column} = $${params.length + 1}`);
  }
  if (!sets.length) return null;
  return { sets, params };
}

async function applyEventDetailUpdate(eventId, changes, { dateOnly = false } = {}) {
  const built = buildEventDetailUpdate(changes, { dateOnly });
  if (!built) throw new AppError(400, dateOnly ? "A new event date is required to postpone." : "No valid changes were provided.");
  const params = [eventId, ...built.params];
  const { rows } = await pool.query(
    `UPDATE events SET ${built.sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0];
}

function changeRequestResponse(row = {}) {
  return {
    id: row.id,
    eventId: row.event_id,
    requestType: row.request_type,
    requestedChanges: row.requested_changes || {},
    reason: row.reason || "",
    status: row.status,
    decisionNote: row.decision_note || "",
    processedAt: row.processed_at,
    createdAt: row.created_at,
    eventName: row.event_name,
    requesterName: row.requester_name
  };
}

async function requestEventChange(actor, eventId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1",
    [eventId, actor.userId]
  );
  const event = rows[0];
  if (!event) throw new AppError(404, "Event not found");
  if (!CHANGE_REQUEST_ALLOWED_EVENT_STATUS.has(event.status)) {
    throw new AppError(409, "Change requests are only for events that are already approved. Draft and in-review events can still be edited directly.");
  }
  const requestType = String(payload.requestType || payload.type || "").trim().toLowerCase();
  if (!CHANGE_REQUEST_TYPES.has(requestType)) throw new AppError(400, "Choose what you would like to change: postpone, cancel, update details or other.");
  const reason = cleanText(payload.reason || payload.note || "", 2000);
  // Validate and normalise the proposed changes up front so a request never
  // stores something that cannot be applied.
  let requestedChanges = {};
  if (requestType === "postpone") {
    const changes = payload.requestedChanges || payload.changes || {};
    requestedChanges = { eventDate: cleanEventDate(changes.eventDate || changes.event_date) };
    if (changes.startTime || changes.start_time) requestedChanges.startTime = cleanText(changes.startTime || changes.start_time, 20);
    if (changes.endTime || changes.end_time) requestedChanges.endTime = cleanText(changes.endTime || changes.end_time, 20);
  } else if (requestType === "update_details") {
    const changes = payload.requestedChanges || payload.changes || {};
    const built = buildEventDetailUpdate(changes);
    if (!built) throw new AppError(400, "Add at least one detail to change (for example the description or venue).");
    // Re-store only the recognised keys, normalised.
    for (const key of Object.keys(EVENT_DETAIL_COLUMNS)) {
      if (changes[key] !== undefined) {
        requestedChanges[key] = EVENT_DETAIL_COLUMNS[key][1] === "banner"
          ? cleanEventBanner(changes[key])
          : EVENT_DETAIL_COLUMNS[key][1] === "date" ? cleanEventDate(changes[key]) : cleanText(changes[key], 4000);
      }
    }
  } else if ((requestType === "cancel" || requestType === "other") && !reason) {
    throw new AppError(400, requestType === "cancel" ? "Please tell us why you need to cancel." : "Please describe the change you need.");
  }
  // One open request per event at a time keeps the admin queue and the organiser
  // view unambiguous.
  const { rows: open } = await pool.query(
    `SELECT * FROM event_change_requests WHERE event_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [eventId, CHANGE_REQUEST_OPEN]
  );
  if (open[0]) throw new AppError(409, "You already have a pending change request for this event. Please wait for TitoPay to review it.");
  const id = randomUUID();
  let inserted;
  try {
    ({ rows: inserted } = await pool.query(
      `INSERT INTO event_change_requests (id, event_id, requested_by, request_type, requested_changes, reason, status)
       VALUES ($1,$2,$3,$4,$5::JSONB,$6,'requested')
       RETURNING *`,
      [id, eventId, actor.userId, requestType, JSON.stringify(requestedChanges), reason]
    ));
  } catch (error) {
    // The partial unique index turns a concurrent double-submit into a clean
    // duplicate error rather than two open requests.
    if (error.code === "23505") throw new AppError(409, "You already have a pending change request for this event. Please wait for TitoPay to review it.");
    throw error;
  }
  await eventAudit({
    eventId,
    actorType: "customer",
    actorId: actor.userId,
    action: "event_change_requested",
    metadata: { requestId: id, requestType },
    ...meta
  });
  return changeRequestResponse(inserted[0]);
}

async function listMyEventChangeRequests(actor, eventId = null) {
  await ensureTicketingSchema();
  const params = [actor.userId];
  let where = "e.business_user_id = $1";
  if (eventId) { params.push(eventId); where += ` AND c.event_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT c.*, e.event_name
       FROM event_change_requests c
       JOIN events e ON e.id = c.event_id
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT 100`,
    params
  );
  return rows.map(changeRequestResponse);
}

async function listEventChangeRequests({ status = "", limit = 100 } = {}) {
  await ensureTicketingSchema();
  const params = [];
  let where = "";
  if (status) { params.push(cleanText(status, 40)); where = "WHERE c.status = $1"; }
  params.push(Math.min(300, Math.max(1, Number(limit) || 100)));
  const { rows } = await pool.query(
    `SELECT c.*, e.event_name, e.status AS event_status, u.full_name AS requester_name, u.phone AS requester_phone
       FROM event_change_requests c
       JOIN events e ON e.id = c.event_id
       LEFT JOIN users u ON u.id = c.requested_by
       ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({ ...changeRequestResponse(row), eventStatus: row.event_status, requesterPhone: row.requester_phone }));
}

async function processEventChangeRequest(requestId, payload = {}, actor, meta = {}) {
  await ensureTicketingSchema();
  const decision = String(payload.action || "").trim().toLowerCase();
  if (!["approve", "reject", "decline"].includes(decision)) throw new AppError(400, "Choose approve or decline.");
  const decisionNote = cleanText(payload.note || payload.reason || "", 2000);
  const { rows } = await pool.query(
    `SELECT * FROM event_change_requests WHERE id = $1 AND status = ANY($2) LIMIT 1`,
    [requestId, CHANGE_REQUEST_OPEN]
  );
  const request = rows[0];
  if (!request) throw new AppError(404, "Change request not found or already actioned");
  const { rows: eventRows } = await pool.query("SELECT * FROM events WHERE id = $1 LIMIT 1", [request.event_id]);
  const event = eventRows[0];
  if (!event) throw new AppError(404, "Event not found");

  if (decision === "reject" || decision === "decline") {
    const { rows: updated } = await pool.query(
      `UPDATE event_change_requests SET status='rejected', admin_id=$2, decision_note=$3, processed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [requestId, actor.userId || null, decisionNote]
    );
    await eventAudit({ eventId: request.event_id, actorType: "admin", actorId: actor.userId, action: "event_change_declined", metadata: { requestId, requestType: request.request_type }, ...meta });
    await notifyOrganiserOfEvent(event, {
      title: `Change request declined: ${event.event_name}`,
      body: `Your request to ${request.request_type.replace(/_/g, " ")} "${event.event_name}" was not approved.${decisionNote ? ` ${decisionNote}` : ""} Please contact TitoPay support if you have questions.`,
      purpose: "event_change_declined"
    });
    return changeRequestResponse(updated[0]);
  }

  // Approve: apply the effect. Money-touching effects (cancel) go through the
  // guarded cascade; postpone/update are narrow, ticket-type-safe edits.
  const changes = request.requested_changes || {};
  let finalStatus = "applied";
  if (request.request_type === "postpone") {
    const updatedEvent = await applyEventDetailUpdate(request.event_id, changes, { dateOnly: true });
    // Tell ticket holders the event moved, and to what date.
    const { rows: holders } = await pool.query(
      `SELECT DISTINCT o.buyer_user_id, u.email FROM ticket_orders o JOIN users u ON u.id = o.buyer_user_id WHERE o.event_id = $1 AND o.status = 'paid'`,
      [request.event_id]
    );
    for (const holder of holders) {
      await notifyTicketHolder(holder, {
        title: `Event postponed: ${event.event_name}`,
        body: `"${event.event_name}" has a new date: ${changes.eventDate}. Your existing tickets remain valid.`,
        purpose: "event_postponed",
        eventId: request.event_id
      });
    }
    void updatedEvent;
  } else if (request.request_type === "update_details") {
    await applyEventDetailUpdate(request.event_id, changes, { dateOnly: false });
  } else if (request.request_type === "cancel") {
    // Reuse the admin cancel transition so the event status, approvals row,
    // audit, ticket invalidation, refund requests and holder notifications all
    // happen exactly as an admin-initiated cancel would.
    await adminTransitionEvent(request.event_id, { action: "cancel", note: request.reason || decisionNote || "Cancelled at organiser request." }, actor, meta);
  } else {
    // "other" carries no automatic effect — admin has read it and will act
    // manually. Record it as approved rather than applied.
    finalStatus = "approved";
  }

  const { rows: updated } = await pool.query(
    `UPDATE event_change_requests SET status=$2, admin_id=$3, decision_note=$4, processed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [requestId, finalStatus, actor.userId || null, decisionNote]
  );
  await eventAudit({ eventId: request.event_id, actorType: "admin", actorId: actor.userId, action: "event_change_applied", metadata: { requestId, requestType: request.request_type, finalStatus }, ...meta });
  await notifyOrganiserOfEvent(event, {
    title: `Change request approved: ${event.event_name}`,
    body: `Your request to ${request.request_type.replace(/_/g, " ")} "${event.event_name}" has been approved${request.request_type === "cancel" ? " and the event has been cancelled" : request.request_type === "postpone" ? ` and the new date is ${changes.eventDate}` : ""}.`,
    purpose: "event_change_approved"
  });
  return changeRequestResponse(updated[0]);
}

async function eventSalesReport(eventId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `WITH order_summary AS (
       SELECT
         event_id,
         COUNT(*)::INT AS orders,
         COALESCE(SUM(CASE WHEN status IN ('paid','refunded') THEN quantity ELSE 0 END), 0)::INT AS tickets_sold,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN subtotal ELSE 0 END), 0)::NUMERIC AS gross_sales,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN buyer_fee ELSE 0 END), 0)::NUMERIC AS buyer_fees,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN business_commission ELSE 0 END), 0)::NUMERIC AS commission,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN business_net ELSE 0 END), 0)::NUMERIC AS net_revenue
       FROM ticket_orders
       WHERE event_id = $1
       GROUP BY event_id
     ),
     ticket_summary AS (
       SELECT event_id, COUNT(CASE WHEN status = 'scanned' THEN 1 END)::INT AS scanned_tickets
       FROM tickets
       WHERE event_id = $1
       GROUP BY event_id
     ),
     refund_summary AS (
       SELECT event_id, COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0)::NUMERIC AS refunds
       FROM ticket_refunds
       WHERE event_id = $1
       GROUP BY event_id
     )
     SELECT
       e.id,
       e.event_name,
       e.status,
       COALESCE(o.orders, 0)::INT AS orders,
       COALESCE(o.tickets_sold, 0)::INT AS tickets_sold,
       COALESCE(o.gross_sales, 0)::NUMERIC AS gross_sales,
       COALESCE(o.buyer_fees, 0)::NUMERIC AS buyer_fees,
       COALESCE(o.commission, 0)::NUMERIC AS commission,
       COALESCE(r.refunds, 0)::NUMERIC AS refunds,
       COALESCE(o.net_revenue, 0)::NUMERIC AS net_revenue,
       COALESCE(t.scanned_tickets, 0)::INT AS scanned_tickets
     FROM events e
     LEFT JOIN order_summary o ON o.event_id = e.id
     LEFT JOIN ticket_summary t ON t.event_id = e.id
     LEFT JOIN refund_summary r ON r.event_id = e.id
     WHERE e.id = $1`,
    [eventId]
  );
  if (!rows[0]) throw new AppError(404, "Event not found");
  return rows[0];
}

async function createTicketSettlement(eventId, actor, meta = {}) {
  await ensureTicketingSchema();
  const report = await eventSalesReport(eventId);
  const { rows: eventRows } = await pool.query("SELECT merchant_id FROM events WHERE id = $1 LIMIT 1", [eventId]);
  const settlementReference = await uniqueNumericCode("ticket_settlements", "settlement_reference", 10);
  const { rows } = await pool.query(
    `INSERT INTO ticket_settlements
      (id, event_id, merchant_id, settlement_reference, gross_sales, buyer_fees, commission, refunds, net_settlement, status, processed_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11::JSONB)
     RETURNING *`,
    [
      randomUUID(),
      eventId,
      eventRows[0]?.merchant_id || null,
      settlementReference,
      report.gross_sales || 0,
      report.buyer_fees || 0,
      report.commission || 0,
      report.refunds || 0,
      money(Number(report.net_revenue || 0) - Number(report.refunds || 0)),
      actor.userId || null,
      JSON.stringify({ report })
    ]
  );
  await eventAudit({
    eventId,
    actorType: "admin",
    actorId: actor.userId,
    action: "ticket_settlement_created",
    metadata: { settlementReference },
    ...meta
  });
  return rows[0];
}

// Admin ticketing analytics: the sales picture across every event on the
// platform, plus the public advert link per event so the team can push an
// event onto socials straight from the console.
async function adminTicketingAnalytics() {
  await ensureTicketingSchema();
  const appOrigin = process.env.APP_ORIGIN || "https://app.titopay.co.za";
  const [{ rows: statusRows }, { rows: orderTotals }, { rows: ticketTotals }, { rows: refundTotals }, { rows: trendRows }, { rows: eventRows }] = await Promise.all([
    pool.query("SELECT status, COUNT(*)::int AS count FROM events GROUP BY status"),
    pool.query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total), 0) AS gross,
              COALESCE(SUM(buyer_fee + business_commission), 0) AS platform_revenue,
              COALESCE(SUM(business_net), 0) AS to_organisers
       FROM ticket_orders
       WHERE status = 'paid'`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS issued,
              COUNT(*) FILTER (WHERE status = 'scanned')::int AS scanned
       FROM tickets`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS refunds, COALESCE(SUM(amount), 0) AS refunded
       FROM ticket_refunds
       WHERE status = 'approved'`
    ),
    pool.query(
      `SELECT TO_CHAR((created_at AT TIME ZONE 'Africa/Johannesburg')::DATE, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM(total), 0) AS gross
       FROM ticket_orders
       WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY (created_at AT TIME ZONE 'Africa/Johannesburg')::DATE
       ORDER BY day ASC`
    ),
    pool.query(
      `SELECT e.id, e.event_name AS name, e.slug, e.status, e.event_date, e.venue_name, e.city,
              u.full_name AS organiser_name, u.username AS organiser_username,
              COALESCE(o.orders, 0)::int AS orders,
              COALESCE(o.tickets_sold, 0)::int AS tickets_sold,
              COALESCE(o.gross, 0) AS gross,
              COALESCE(o.business_net, 0) AS business_net,
              COALESCE(t.scanned, 0)::int AS scanned
       FROM events e
       JOIN users u ON u.id = e.business_user_id
       LEFT JOIN (
         SELECT event_id, COUNT(*)::int AS orders, COALESCE(SUM(quantity), 0)::int AS tickets_sold,
                COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(business_net), 0) AS business_net
         FROM ticket_orders WHERE status = 'paid' GROUP BY event_id
       ) o ON o.event_id = e.id
       LEFT JOIN (
         SELECT event_id, COUNT(*)::int AS scanned FROM tickets WHERE status = 'scanned' GROUP BY event_id
       ) t ON t.event_id = e.id
       WHERE e.status IN ('approved', 'suspended', 'completed', 'cancelled')
       ORDER BY COALESCE(o.gross, 0) DESC, e.event_date DESC NULLS LAST
       LIMIT 25`
    )
  ]);
  return {
    statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
    totals: {
      orders: orderTotals[0].orders,
      gross: money(orderTotals[0].gross),
      platformRevenue: money(orderTotals[0].platform_revenue),
      toOrganisers: money(orderTotals[0].to_organisers),
      ticketsIssued: ticketTotals[0].issued,
      ticketsScanned: ticketTotals[0].scanned,
      refunds: refundTotals[0].refunds,
      refunded: money(refundTotals[0].refunded)
    },
    trend: trendRows.map((row) => ({ day: row.day, orders: row.orders, gross: money(row.gross) })),
    events: eventRows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      eventDate: row.event_date,
      venueName: row.venue_name,
      city: row.city,
      organiserName: row.organiser_name,
      organiserUsername: row.organiser_username,
      orders: row.orders,
      ticketsSold: row.tickets_sold,
      gross: money(row.gross),
      businessNet: money(row.business_net),
      scanned: row.scanned,
      publicUrl: row.slug ? `${appOrigin}/events/${row.slug}` : ""
    }))
  };
}

module.exports = {
  defineSeating,
  seatingAvailability,
  allocateSeats,
  ensureTicketingSchema,
  adminTicketingAnalytics,
  // Exported so the Event Tag routes can gate on exactly the same staff rules
  // the scanner already uses, rather than growing a second answer to
  // "may this person act on this event?".
  canManageEventTicketing,
  getBusinessEligibility,
  // Exported so the free-vs-paid gate can be tested as the pure decision it is,
  // without standing up a database.
  ticketTypesIncludePaid,
  assertTicketingEligibility,
  // Exported so the poster validator can be tested directly — the format regex
  // and the size ceiling both matter, since the value lands in the events row.
  cleanEventBanner,
  createEventDraft,
  updateEventDraft,
  replaceEventPoster,
  submitEvent,
  listBusinessEvents,
  getBusinessEvent,
  listPublicApprovedEvents,
  getPublicApprovedEvent,
  listAdminEvents,
  getAdminEvent,
  adminTransitionEvent,
  ticketPurchasePreview,
  purchaseTickets,
  // Exported so the phase gate can be tested as the pure decision it is,
  // and so the organiser and buyer screens read the same rule.
  ticketPhaseState,
  normalizeSocialLinks,
  SOCIAL_PLATFORMS,
  emailTicketToRecipient,
  listMyTicketOrders,
  listMyTickets,
  setMyTicketRemoved,
  claimTicketByCode,
  scanTicket,
  // Exported so a door-scanner view can show the running count before the first
  // scan, for the organiser and for any staff assigned the scan permission.
  eventAttendance,
  addEventStaff,
  removeEventStaff,
  listEventStaff,
  listStaffScanEvents,
  EVENT_CATEGORIES,
  refundPolicyFor,
  refundEligibility,
  ticketOrderRefundPolicy,
  listEventRefunds,
  joinTicketWaitlist,
  leaveTicketWaitlist,
  myWaitlistEntry,
  listEventWaitlist,
  notifyEventWaitlist,
  listEventPromoters,
  createEventPromoter,
  removeEventPromoter,
  recordPromoterVisit,
  duplicateEvent,
  listEventCoupons,
  createEventCoupon,
  updateEventCoupon,
  deleteEventCoupon,
  // Exported for the tests: the discount arithmetic is the part that must
  // never drift, so it is checkable without standing up an event.
  couponDiscountFor,
  normalizeCouponCode,
  requestTicketRefund,
  listTicketRefunds,
  processTicketRefund,
  // Organiser change requests: the organiser asks, admin reviews and applies.
  requestEventChange,
  listMyEventChangeRequests,
  listEventChangeRequests,
  processEventChangeRequest,
  eventSalesReport,
  createTicketSettlement
};
