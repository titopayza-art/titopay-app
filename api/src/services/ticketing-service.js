const { randomUUID, createHash } = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { ensureDefaultPricingRule, calculateFee } = require("./pricing-service");
const { applyWalletMovement } = require("./wallet-service");
const { deliverSms, deliverEmail, createNotification, markNotification } = require("./notification-service");

const VERIFIED_STATUSES = new Set(["verified", "approved", "complete", "completed", "fully_verified"]);
const BLOCKED_USER_STATUSES = new Set(["suspended", "frozen", "restricted", "under_review", "closed", "inactive"]);
const EVENT_STATUSES = new Set(["draft", "submitted", "under_review", "additional_information_required", "approved", "rejected", "suspended", "cancelled", "completed"]);

function slugify(value = "") {
  return String(value || "event")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "event";
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
      transfer_allowed BOOLEAN NOT NULL DEFAULT FALSE,
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

async function uniqueSlug(base, eventId = null) {
  let candidate = slugify(base);
  const suffix = createHash("sha1").update(`${base}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 6);
  let counter = 0;
  while (true) {
    const value = counter === 0 ? candidate : `${candidate}-${suffix}${counter > 1 ? `-${counter}` : ""}`;
    const { rows } = await pool.query("SELECT id FROM events WHERE slug = $1 AND ($2::UUID IS NULL OR id <> $2::UUID) LIMIT 1", [value, eventId]);
    if (!rows[0]) return value;
    counter += 1;
  }
}

function normalizeTicketTypes(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item, index) => ({
      ticketName: cleanText(item.ticketName || item.ticket_name || item.name || "General", 120),
      description: cleanText(item.description, 500),
      price: money(item.price),
      quantityAvailable: Math.max(0, Number.parseInt(item.quantityAvailable ?? item.quantity_available ?? item.quantity ?? 0, 10) || 0),
      minPurchaseQuantity: Math.max(1, Number.parseInt(item.minPurchaseQuantity ?? item.min_purchase_quantity ?? 1, 10) || 1),
      maxPurchaseQuantity: Math.max(1, Number.parseInt(item.maxPurchaseQuantity ?? item.max_purchase_quantity ?? 10, 10) || 10),
      salesOpeningAt: item.salesOpeningAt || item.sales_opening_at || null,
      salesClosingAt: item.salesClosingAt || item.sales_closing_at || null,
      perCustomerPurchaseLimit: item.perCustomerPurchaseLimit || item.per_customer_purchase_limit || null,
      attendeeDetailsRequired: Boolean(item.attendeeDetailsRequired ?? item.attendee_details_required),
      transferAllowed: Boolean(item.transferAllowed ?? item.transfer_allowed),
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
    ticketTypes: normalizeTicketTypes(payload.ticketTypes || payload.ticket_types),
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
    sortOrder: row.sort_order
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
     (id, business_user_id, merchant_id, status, slug, event_name, category, description, event_date, start_time, end_time, venue_name, full_venue_address, city, province, country, event_mode, organiser_details, business_details, contact_email, contact_number, event_banner_url, event_images, age_restriction, capacity, terms_conditions, refund_policy, entry_rules, prohibited_items, accessibility_information, parking_information, additional_instructions)
     VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::JSONB,$18::JSONB,$19,$20,$21,$22::JSONB,$23,$24,$25,$26::JSONB,$27,$28,$29,$30,$31)
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
      data.additionalInstructions
    ]
  );
  await replaceTicketTypes(eventId, data.ticketTypes);
  await replaceDocuments(eventId, data.documents);
  await eventAudit({ eventId, actorType: "customer", actorId: userId, action: "event_draft_created", metadata: { slug }, ...meta });
  return publicEvent(rows[0], await getTicketTypes(eventId), await getDocuments(eventId));
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
         parking_information=$29, additional_instructions=$30, updated_at=NOW()
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
      data.additionalInstructions
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
        "— TitoPay"
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

async function listPublicApprovedEvents() {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT * FROM events WHERE status = 'approved' ORDER BY event_date ASC NULLS LAST, approved_at DESC LIMIT 100");
  const items = [];
  for (const row of rows) items.push(publicEvent(row, await getTicketTypes(row.id), []));
  return items;
}

async function getPublicApprovedEvent(slug) {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT * FROM events WHERE slug = $1 AND status = 'approved' LIMIT 1", [slugify(slug)]);
  if (!rows[0]) throw new AppError(404, "Event is not available");
  return publicEvent(rows[0], await getTicketTypes(rows[0].id), []);
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

async function adminTransitionEvent(eventId, payload, actor, meta = {}) {
  await ensureTicketingSchema();
  const { action, status } = adminActionStatus(payload.action);
  const note = cleanText(payload.note || payload.reason || "", 2000);
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1 LIMIT 1", [eventId]);
  const event = rows[0];
  if (!event) throw new AppError(404, "Event not found");
  const previousStatus = event.status;
  const sets = ["status = $2", "updated_at = NOW()"];
  const params = [eventId, status];
  if (status === "approved") {
    params.push(actor.userId);
    sets.push(`approved_at = NOW()`, `approved_by = $${params.length}`);
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
  await eventAudit({
    eventId,
    actorType: "admin",
    actorId: actor.userId,
    action: `event_${action}`,
    metadata: { previousStatus, newStatus: status, note },
    ...meta
  });
  return getAdminEvent(updated[0].id);
}

async function uniqueNumericCode(table, column, length = 10) {
  const digits = Math.min(10, Math.max(6, Number(length) || 10));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = String(Math.floor(Math.random() * (10 ** digits))).padStart(digits, "0");
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

async function ticketPurchasePreview(slug, payload = {}) {
  await ensureTicketingSchema();
  const quantity = Math.max(1, Math.min(20, Number.parseInt(payload.quantity || 1, 10) || 1));
  const ticketTypeId = cleanText(payload.ticketTypeId || payload.ticket_type_id, 80);
  const { rows } = await pool.query(
    `SELECT e.*, tt.id AS ticket_type_id, tt.ticket_name, tt.price, tt.quantity_available, tt.quantity_reserved, tt.quantity_sold,
            tt.min_purchase_quantity, tt.max_purchase_quantity, tt.sales_opening_at, tt.sales_closing_at
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
  if (quantity < Number(row.min_purchase_quantity || 1)) throw new AppError(400, `Minimum purchase is ${row.min_purchase_quantity} ticket(s)`);
  if (quantity > Number(row.max_purchase_quantity || 10)) throw new AppError(400, `Maximum purchase is ${row.max_purchase_quantity} ticket(s)`);
  if (available < quantity) throw new AppError(409, "Not enough tickets available");
  const subtotal = money(Number(row.price || 0) * quantity);
  // A free ticket is free all the way through. The buyer service fee is a flat
  // R10, so without this a "free" ticket would still charge the buyer R10 and
  // demand they hold a balance — which is not a free ticket. No subtotal means
  // no fee, no commission, and nothing to move.
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
    subtotal,
    buyerFee,
    businessCommission,
    businessNet: money(subtotal - businessCommission),
    total: money(subtotal + buyerFee)
  };
}

async function loadWalletForUpdate(client, userId, kindPreference = null) {
  const kindSql = kindPreference ? "AND kind = $2" : "";
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

async function deliverTicketOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT o.*, e.event_name, e.slug, u.id AS buyer_id, u.full_name, u.email, u.phone
     FROM ticket_orders o
     JOIN events e ON e.id = o.event_id
     JOIN users u ON u.id = o.buyer_user_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return;
  const { rows: tickets } = await pool.query("SELECT * FROM tickets WHERE order_id = $1 ORDER BY created_at ASC", [orderId]);
  const title = "Your TitoPay event tickets";
  const ticketCodes = tickets.map((ticket) => ticket.ticket_code).join(", ");
  const eventUrl = `https://app.titopay.co.za/events/${order.slug}`;
  const body = `Your TitoPay tickets for ${order.event_name} are confirmed. Order ${order.order_reference}. Ticket code(s): ${ticketCodes}. View event: ${eventUrl}`;
  let smsOk = false;
  let emailOk = false;

  if (order.phone) {
    const notificationId = await createNotification({
      user: { id: order.buyer_id, user_type: "customer" },
      channel: "sms",
      notificationType: "ticket_delivery",
      title,
      body,
      provider: "sms",
      metadata: { orderId, ticketCodes }
    });
    try {
      const result = await deliverSms({ to: order.phone, body, metadata: { orderId, purpose: "ticket_delivery" } });
      await markNotification(notificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
      smsOk = true;
    } catch (error) {
      await markNotification(notificationId, "failed", null, { error: error.message });
    }
  }

  if (order.email) {
    const notificationId = await createNotification({
      user: { id: order.buyer_id, user_type: "customer" },
      channel: "email",
      notificationType: "ticket_delivery",
      title,
      body,
      provider: "email",
      metadata: { orderId, ticketCodes }
    });
    try {
      const result = await deliverEmail({ to: order.email, subject: title, body, metadata: { orderId, purpose: "ticket_delivery" } });
      await markNotification(notificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
      emailOk = true;
    } catch (error) {
      await markNotification(notificationId, "failed", null, { error: error.message });
    }
  }

  const status = smsOk || emailOk ? "sent" : "failed";
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
    "Keep this code private — anyone who has it can enter."
  ].filter((line) => line !== null && line !== undefined).join("\n");

  await deliverEmail({ to, subject, body, metadata: { ticketCode: ticket.ticket_code, purpose: "ticket_self_service_email" } });
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
  const preview = await ticketPurchasePreview(slug, payload);
  const client = await pool.connect();
  const orderId = randomUUID();
  const txId = randomUUID();
  const reference = `TICKET-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const orderReference = await uniqueNumericCode("ticket_orders", "order_reference", 10);
  const ticketRows = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT e.*, tt.id AS ticket_type_id, tt.ticket_name, tt.price, tt.quantity_available, tt.quantity_reserved, tt.quantity_sold,
              tt.min_purchase_quantity, tt.max_purchase_quantity, m.id AS merchant_uuid
       FROM events e
       JOIN event_ticket_types tt ON tt.event_id = e.id
       LEFT JOIN merchants m ON m.id = e.merchant_id
       WHERE e.id = $1 AND tt.id = $2 AND e.status = 'approved'
       FOR UPDATE OF tt`,
      [preview.eventId, preview.ticketTypeId]
    );
    const locked = rows[0];
    if (!locked) throw new AppError(404, "Event ticket type is not available");
    const available = Number(locked.quantity_available || 0) - Number(locked.quantity_reserved || 0) - Number(locked.quantity_sold || 0);
    if (available < preview.quantity) throw new AppError(409, "Not enough tickets available");

    const buyerWallet = await loadWalletForUpdate(client, actor.userId);
    if (!buyerWallet) throw new AppError(404, "Buyer wallet not found");
    // A free ticket has total 0, so this correctly asks nothing of the buyer's
    // balance; the guard only bites when there is something to pay.
    if (preview.total > 0 && Number(buyerWallet.available_balance || 0) < preview.total) {
      throw new AppError(400, "Insufficient balance");
    }
    // The business wallet is only needed when there is money to settle into it.
    // A free event never credits the business, so a missing wallet must not stop
    // a free ticket being issued.
    const businessWallet = await loadWalletForUpdate(client, locked.business_user_id, "business") || await loadWalletForUpdate(client, locked.business_user_id);
    if (preview.businessNet > 0 && !businessWallet) throw new AppError(404, "Event business wallet not found");
    // The revenue wallet only collects platform fees. A free ticket charges no
    // fee, so it must never be required — loading it unconditionally made every
    // purchase (free included) 500 on an environment where no revenue wallet is
    // configured. Load it only when there is a fee to bank.
    const hasFees = money(preview.buyerFee + preview.businessCommission) > 0;
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
        preview.subtotal,
        money(preview.buyerFee + preview.businessCommission),
        preview.total,
        reference,
        locked.event_name,
        JSON.stringify({ eventId: preview.eventId, ticketTypeId: preview.ticketTypeId, orderId, orderReference, businessNet: preview.businessNet })
      ]
    );
    // applyWalletMovement refuses a zero amount by design, so every movement
    // below is guarded — a free ticket moves no money and simply skips them.
    if (preview.total > 0) {
      await applyWalletMovement(client, {
        walletId: buyerWallet.id,
        transactionId: txId,
        entryType: "debit",
        amount: preview.total,
        reference,
        metadata: { serviceCode: "ticket_purchase", orderId, eventId: preview.eventId }
      });
    }
    if (businessWallet && preview.businessNet > 0) {
      await applyWalletMovement(client, {
        walletId: businessWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: preview.businessNet,
        reference,
        metadata: { serviceCode: "ticket_purchase", orderId, eventId: preview.eventId, settlement: "instant_wallet_credit" }
      });
    }
    if (hasFees && revenueWallet) {
      await applyWalletMovement(client, {
        walletId: revenueWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: money(preview.buyerFee + preview.businessCommission),
        reference,
        metadata: { serviceCode: "ticket_purchase", source: "ticket_fees", orderId, eventId: preview.eventId }
      });
      await client.query(
        `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,'ticket_purchase',$3,$4)`,
        [randomUUID(), txId, money(preview.buyerFee + preview.businessCommission), revenueWallet.id]
      );
    }

    await client.query(
      `INSERT INTO ticket_orders
        (id, event_id, ticket_type_id, buyer_user_id, merchant_id, transaction_id, order_reference, quantity, subtotal, buyer_fee, business_commission, business_net, total, status, delivery_status, buyer_details, metadata, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'paid','queued',$14::JSONB,$15::JSONB,NOW())`,
      [
        orderId,
        preview.eventId,
        preview.ticketTypeId,
        actor.userId,
        locked.merchant_uuid || null,
        txId,
        orderReference,
        preview.quantity,
        preview.subtotal,
        preview.buyerFee,
        preview.businessCommission,
        preview.businessNet,
        preview.total,
        JSON.stringify(payload.buyerDetails || {}),
        JSON.stringify({ source: "pwa", paymentMethod: "titopay_wallet" })
      ]
    );

    for (let index = 0; index < preview.quantity; index += 1) {
      const ticketId = randomUUID();
      const ticketCode = await uniqueNumericCode("tickets", "ticket_code", 10);
      const qrPayload = { type: "titopay_ticket", ticketId, ticketCode, orderReference, eventId: preview.eventId };
      const { rows: inserted } = await client.query(
        `INSERT INTO tickets
          (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, qr_payload, attendee_name, attendee_phone, attendee_email, status, delivery_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10,'valid','queued')
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
          cleanEmail(payload.attendeeEmail || payload.buyerDetails?.email || "")
        ]
      );
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
    metadata: { orderId, orderReference, quantity: preview.quantity, total: preview.total },
    ...meta
  });
  deliverTicketOrder(orderId).catch((error) => console.error("[ticket-delivery-failed]", { orderId, message: error.message }));
  const { rows: orderRows } = await pool.query("SELECT * FROM ticket_orders WHERE id = $1", [orderId]);
  return ticketOrderResponse(orderRows[0], ticketRows);
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
async function listMyTickets(userId) {
  await ensureTicketingSchema();
  const { rows } = await pool.query(
    `SELECT t.*,
            o.order_reference, o.status AS order_status, o.created_at AS order_created_at,
            tt.ticket_name,
            e.event_name, e.slug, e.event_date, e.start_time, e.venue_name, e.city, e.province
       FROM tickets t
       JOIN ticket_orders o ON o.id = t.order_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
      WHERE t.owner_user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 200`,
    [userId]
  );
  return rows.map((row) => ({
    ...ticketResponse(row),
    ticketTypeName: row.ticket_name,
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
  const ticketCode = cleanText(payload.ticketCode || payload.ticket_code || payload.code, 40);
  if (!ticketCode) throw new AppError(400, "Ticket code is required");
  const { rows } = await pool.query(
    `SELECT t.*, e.event_name, e.business_user_id, tt.ticket_name
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
  if (ticket.status === "scanned") {
    return { valid: false, status: "already_scanned", ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "Ticket has already been scanned" };
  }
  if (ticket.status !== "valid") {
    return { valid: false, status: ticket.status, ticket: ticketResponse(ticket), attendance: await eventAttendance(ticket.event_id), message: "Ticket is not valid for entry" };
  }
  const { rows: updated } = await pool.query(
    `UPDATE tickets
     SET status = 'scanned', scanned_at = NOW(), scanned_by = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [ticket.id, actor.userId]
  );
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
  const digits = value.replace(/\D/g, "");
  const { rows } = await pool.query(
    `SELECT id, full_name, username, email, phone, fica_status, status
     FROM users
     WHERE LOWER(username) = $1
        OR LOWER(email) = $1
        OR LOWER(phone) = $1
        OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $2
     LIMIT 1`,
    [value.replace(/^@/, ""), digits]
  );
  const user = rows[0];
  if (!user) throw new AppError(404, "TitoPay user not found");
  if (user.status !== "active" || !VERIFIED_STATUSES.has(String(user.fica_status || "").toLowerCase())) {
    throw new AppError(403, "Only active verified TitoPay users can be added as event staff");
  }
  return user;
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
  return { ...rows[0], user };
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

async function requestTicketRefund(actor, orderId, payload = {}, meta = {}) {
  await ensureTicketingSchema();
  const { rows } = await pool.query("SELECT * FROM ticket_orders WHERE id = $1 AND buyer_user_id = $2 LIMIT 1", [orderId, actor.userId]);
  const order = rows[0];
  if (!order) throw new AppError(404, "Ticket order not found");
  if (order.status !== "paid") throw new AppError(409, "This order is not eligible for refund request");
  // A free ticket cost nothing, so there is nothing to refund. This also keeps
  // the refund money path — which charges a R0.50 processing fee — off orders
  // that never moved money.
  if (money(order.total || 0) <= 0) throw new AppError(409, "This ticket was free, so there is nothing to refund. You can release your spot by not attending.");
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
  let refund;

  if (status === "rejected") {
    const { rows } = await pool.query(
      `UPDATE ticket_refunds
       SET status = 'rejected', processed_by = $2, processed_at = NOW(), decision_note = $3, updated_at = NOW()
       WHERE id = $1 AND status IN ('requested','under_review')
       RETURNING *`,
      [refundId, actor.userId || null, decisionNote]
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
      const refundAmount = money(Math.min(Number(refund.amount || order.subtotal || 0), Number(order.subtotal || 0)));
      const refundFeePreview = await calculateFee("ticket_refund_processing", refundAmount);
      const refundProcessingFee = money(refundFeePreview.fee || 0);
      const businessDebitTotal = money(refundAmount + refundProcessingFee);
      const buyerWallet = await loadWalletForUpdate(client, order.buyer_user_id);
      const businessWallet = await loadWalletForUpdate(client, order.business_user_id, "business") || await loadWalletForUpdate(client, order.business_user_id);
      const revenueWallet = refundProcessingFee > 0 ? await loadRevenueWalletForUpdate(client) : null;
      if (!buyerWallet || !businessWallet) throw new AppError(404, "Refund wallet not found");
      if (Number(businessWallet.available_balance || 0) < businessDebitTotal) throw new AppError(400, "Business wallet has insufficient available balance for refund");
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
          JSON.stringify({ refundId, orderId: order.id, eventId: order.event_id, reason: refund.reason, refundProcessingFee })
        ]
      );
      await applyWalletMovement(client, {
        walletId: businessWallet.id,
        transactionId: refundTxId,
        entryType: "debit",
        amount: refundAmount,
        reference,
        metadata: { serviceCode: "ticket_refund", refundId, orderId: order.id }
      });
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
             processed_at = NOW(),
             decision_note = $3,
             transaction_id = $4,
             amount = $5,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [refundId, actor.userId || null, decisionNote, refundTxId, refundAmount]
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

module.exports = {
  ensureTicketingSchema,
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
  emailTicketToRecipient,
  listMyTicketOrders,
  listMyTickets,
  scanTicket,
  // Exported so a door-scanner view can show the running count before the first
  // scan, for the organiser and for any staff assigned the scan permission.
  eventAttendance,
  addEventStaff,
  listEventStaff,
  requestTicketRefund,
  listTicketRefunds,
  processTicketRefund,
  eventSalesReport,
  createTicketSettlement
};
