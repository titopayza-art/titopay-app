const { randomUUID } = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

const VALID_STATUSES = new Set(["active", "coming_soon", "disabled"]);
const VALID_BADGES = new Set(["new", "soon", "none"]);
const VALID_AUDIENCES = new Set(["personal", "business", "all"]);
const DEFAULT_SERVICES = [
  ["top-up", "Top Up", "upload", "top-up", "Add money to your TitoPay wallet.", "active", true, true, 10, "none"],
  ["withdraw", "Withdraw", "withdraw", "withdraw", "Withdraw available wallet funds.", "active", true, false, 20, "none"],
  ["send-money", "Send Money", "send", "send-money", "Send money using a username, cellphone number or email address.", "active", true, false, 30, "none"],
  ["receive-money", "Receive Money", "download", "receive-money", "Generate a TitoPay QR to receive money.", "active", true, true, 40, "none"],
  ["qr-pay", "QR Pay", "qr", "qr-pay", "Scan and pay TitoPay QR codes. A flat R0.50 QR payment fee applies.", "active", true, true, 50, "none"],
  ["payment-request", "Payment Request", "download", "payment-request", "Request money from a customer, friend or family member.", "active", true, true, 60, "none"],
  ["bill-split", "Bill Split", "scissors", "bill-split", "Split bills and send payment requests to participants.", "active", true, false, 70, "new"],
  ["send-gift", "Send Gift", "gift", "send-gift", "Send money as a thoughtful digital gift.", "active", true, false, 80, "none"],
  ["airtime", "Airtime", "phone", "airtime", "Buy airtime for South African networks.", "active", true, true, 90, "none"],
  ["data", "Data", "phone", "data", "Buy mobile data bundles.", "active", true, true, 100, "none"],
  ["electricity", "Electricity", "zap", "electricity", "Buy prepaid electricity tokens.", "active", true, true, 110, "none"],
  ["voucher", "Voucher", "tag", "voucher", "Purchase digital vouchers.", "active", true, true, 120, "none"],
  ["stockvel", "Stockvel", "stockvel", "stockvel", "Create and manage community savings groups.", "active", true, false, 130, "new"],
  ["tip", "Tip", "tip", "tip", "Generate tip QR codes and receive instant tips.", "active", true, true, 140, "new"],
  ["learn", "Learn", "learn", "learn", "Practical TitoPay financial education for personal and business users.", "active", true, true, 150, "none"],
  ["transactions", "Transactions", "list", "transactions", "Search, filter and export wallet transactions.", "active", true, true, 160, "none"],
  ["profile-security", "Profile & Security", "shield", "profile-security", "Manage FICA, wallet lock, devices and profile security.", "active", true, false, 170, "none"],
  ["fica", "FICA", "shield", "fica", "Submit and track verification documents.", "active", true, false, 180, "none"],
  // Buying a ticket is not a personal-only act: a business books a stand at an
  // expo, sends staff to a conference, buys a table at a fundraiser. The tile
  // was hidden from business accounts while the whole path behind it already
  // worked, so this only stopped them reaching a door that was open.
  // Selling tickets stays separate: that is the "ticketing" service below, and
  // it remains business only.
  ["tickets", "Tickets", "ticket", "tickets", "Browse approved TitoPay events and buy secure digital tickets.", "active", true, true, 185, "new"],
  ["statements", "Statements", "list", "statements", "Download PDF statements and CSV exports.", "active", false, true, 190, "none"],
  ["payouts", "Payouts", "withdraw", "payouts", "Request business payouts to bank beneficiaries.", "active", false, true, 200, "none"],
  ["business-profile", "Business Profile", "user", "business-profile", "Manage merchant profile and business wallet settings.", "active", false, true, 210, "none"],
  ["invoice", "Invoice", "list", "invoice", "Create business invoices. PDF download is R2.50.", "active", false, true, 220, "none"],
  ["quote", "Quote", "list", "quote", "Create customer quotes. PDF download is R2.50.", "active", false, true, 230, "none"],
  ["proforma-invoice", "Proforma Invoice", "list", "proforma-invoice", "Create proforma invoices. PDF download is R2.50.", "active", false, true, 240, "none"],
  ["ticketing", "Ticketing", "ticket", "ticketing", "Create approved events, manage ticket sales and prepare attendee entry controls.", "active", false, true, 300, "new"],
  // TitoPay Book. Business-only, deliberately: a customer BOOKS through Book,
  // they do not run one, so a personal tile would open a console with nothing in
  // it. Customers reach a venue through discovery and the shared link instead.
  ["book", "Book", "calendar", "book", "Book a table, an appointment or a service, and take bookings for your own business.", "active", true, true, 305, "new"],
  ["business-ticketing-staff", "Event Scanners", "contacts", "business-ticketing-staff", "The people who scan tickets at your door. Add them, and they scan from their own phone.", "active", false, true, 301, "new"],
  ["shop-marketplace", "Shop Marketplace", "store", "shop-marketplace", "Marketplace services for local brands and digital products.", "disabled", false, false, 310, "none"],
  ["rewards", "Rewards", "sparkles", "rewards", "Offers, promotions and coupon codes published by TitoPay.", "active", true, true, 320, "new"],
  ["business-rewards", "Business Rewards", "sparkles", "business-rewards", "Business rewards programme.", "disabled", false, false, 330, "none"],
  ["virtual-doctor", "Virtual Doctor", "health", "virtual-doctor", "Digital healthcare services.", "disabled", false, false, 340, "none"],
  ["travel", "Travel", "plane", "travel", "Travel booking and payment services.", "disabled", false, false, 350, "none"],
  ["donate", "Donate", "heart", "donate", "Donation and community giving campaigns.", "disabled", false, false, 360, "none"],
  ["cross-border", "Cross Border", "globe", "cross-border", "Cross-border payment services.", "disabled", false, false, 370, "none"],
  ["get-cash", "Get Cash", "withdraw", "get-cash", "Personal cash-out services.", "disabled", false, false, 380, "none"],
  ["cash-back", "Cash Back", "refresh", "cash-back", "Business cashback services.", "disabled", false, false, 390, "none"]
];

// A SERVICE MAY NOT BE PUBLISHED AS ACTIVE WHILE THE CAPABILITY BEHIND IT
// CANNOT TRANSACT.
//
// The catalogue is a promise. Every tile in it says: tap this and TitoPay will
// do it. Six of them promised airtime, data, electricity, vouchers and bill
// payments while the value-added services capability had no adapter that could
// send a purchase — the seam exists, the contract does not. A customer tapping
// one reached a refusal, and every screen that counts what TitoPay offers
// counted them.
//
// Marking them by hand would work exactly once. This derives it instead: the
// adapter declares whether it can transact (see providers/vas-provider.js) and
// the catalogue reads that declaration on every read. Sign the contract, wire
// the adapter, set VAS_PROVIDER, and the tiles come back on their own.
//
// It downgrades to `coming_soon`, never to `disabled`: the service is real, it
// is coming, and the app already has an honest place for that — a separate
// section, a "soon" badge, and a tap that explains instead of failing. Hiding
// them would lose the roadmap; leaving them active would keep the claim.
const CAPABILITY_BACKED_SERVICES = {
  airtime: "vas",
  data: "vas",
  "mobile-data": "vas",
  "airtime-data": "vas",
  "airtime-and-data": "vas",
  "airtime-data-bundles": "vas",
  electricity: "vas",
  voucher: "vas",
  "pay-bills": "vas"
};

function capabilityCanTransact(capability) {
  if (capability === "vas") return require("../providers/vas-provider").vasCanPurchase();
  // A capability nobody has claimed here is not gated: this list names the
  // rails TitoPay knows it buys from a supplier, and silence is not a claim.
  return true;
}

// Applied to every read, so no surface — app, console, analytics or export —
// can show a service as live that the platform cannot perform.
function applyCapabilityGate(row) {
  const capability = CAPABILITY_BACKED_SERVICES[row.service_code];
  if (!capability || capabilityCanTransact(capability)) return row;
  return {
    ...row,
    status: row.status === "disabled" ? row.status : "coming_soon",
    // Said out loud, so the console shows an operator WHY the status they
    // stored is not the status being served, instead of looking like a bug.
    //
    // storedStatus is the row as it actually sits in service_config. Without
    // it the console can only show the served answer, so an operator who sets
    // a service active, saves it, and sees "coming soon" come back has no way
    // to tell a gate from a failed write.
    storedStatus: row.status,
    capability,
    capabilityLive: false,
    unavailableReason: "No provider is contracted for this capability yet, so the service cannot be published as active."
  };
}

// WHAT THE CATALOGUE IS READING WHEN IT HOLDS A SERVICE BACK.
//
// The gate is derived, so a service stuck on "coming soon" is not a row an
// operator can edit — it is a fact about a supplier. Without this, the console
// could show that a service is held back but not what would release it, which
// leaves an operator hunting for a toggle that does not exist.
//
// It reads the adapters' own declarations rather than naming any vendor, so it
// stays true when a contract is signed: wire the adapter, declare canPurchase,
// set the variable named here, and both this report and the tiles move on
// their own.
function capabilityReport() {
  const gated = [...new Set(Object.values(CAPABILITY_BACKED_SERVICES))];
  // AN ADAPTER THAT NOTHING HAS LOADED DECLARES NOTHING.
  //
  // Registration is a side effect of requiring the provider module, so reading
  // the registry before that happens returns an empty declaration — and the
  // page would say "declares: nothing" for an adapter that plainly declares
  // canPurchase: false. The API server loads every provider at boot so it
  // never saw this, but nothing about this function guaranteed it.
  //
  // capabilityCanTransact() requires the module it asks about, so resolving
  // `live` FIRST is what makes the declaration below readable. The order is
  // load-bearing; it is not a tidy-up.
  const live = new Map(gated.map((capability) => [capability, capabilityCanTransact(capability)]));
  const declared = require("../providers").describeProviders();
  return gated.map((capability) => {
    const provider = declared.find((entry) => entry.capability === capability) || null;
    const services = Object.keys(CAPABILITY_BACKED_SERVICES)
      .filter((code) => CAPABILITY_BACKED_SERVICES[code] === capability);
    return {
      capability,
      live: live.get(capability),
      // Which adapter is selected, and by what. Both are needed: "none" set by
      // default and "none" set deliberately in the environment are different
      // situations for whoever is trying to fix it.
      configured: provider?.configured || null,
      variable: provider?.variable || `${String(capability).toUpperCase()}_PROVIDER`,
      source: provider?.source || null,
      declares: provider?.declares || {},
      services,
      releasedBy: "Wire the adapter so it can send a purchase, declare canPurchase: true on it, and select it with "
        + `${provider?.variable || `${String(capability).toUpperCase()}_PROVIDER`}. The catalogue then publishes these services on its own.`
    };
  });
}

function normalizeAudience(audience = "all") {
  return VALID_AUDIENCES.has(audience) ? audience : "all";
}

function normalizeStatus(status = "active") {
  return VALID_STATUSES.has(status) ? status : "active";
}

function normalizeBadge(badge = "none") {
  return VALID_BADGES.has(badge) ? badge : "none";
}

async function listServices({ audience = "all", includeDisabled = false } = {}) {
  await ensureDefaultServices();
  const params = [];
  const where = [];
  const normalizedAudience = normalizeAudience(audience);

  if (!includeDisabled) {
    where.push("status <> 'disabled'");
  }

  if (normalizedAudience === "personal") where.push("personal_visible = TRUE");
  if (normalizedAudience === "business") where.push("business_visible = TRUE");

  const { rows } = await pool.query(
    `
      SELECT
        id,
        service_code,
        service_name,
        service_icon,
        action,
        description,
        fee,
        commission,
        status,
        personal_visible,
        business_visible,
        sort_order,
        feature_badge,
        created_at,
        updated_at
      FROM service_config
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sort_order ASC, service_name ASC
    `,
    params
  );
  return rows.map(applyCapabilityGate);
}

async function ensureDefaultServices() {
  const serviceCodes = DEFAULT_SERVICES.map((item) => item[0]);
  const { rows } = await pool.query("SELECT COUNT(*)::INT AS count FROM service_config WHERE service_code = ANY($1)", [serviceCodes]);
  if (rows[0].count >= DEFAULT_SERVICES.length) {
    await pool.query(
    // The tile a customer reads BEFORE they scan, so it must agree with what
    // pricing_rules will actually charge - the approved schedule puts the
    // customer side of a QR payment at a flat R0.50. The guard lists every
    // figure TitoPay itself has ever written here (0, 0.50, 1.00, 1.50), so a
    // stale catalogue converges while a number an operator set by hand is left
    // exactly as they set it.
    `UPDATE service_config
        SET fee = 0.50,
            description = 'Scan and pay TitoPay QR codes. A flat R0.50 QR payment fee applies.',
            updated_at = NOW()
      WHERE service_code = 'qr-pay'
        AND ROUND(COALESCE(fee, 0)::NUMERIC, 2) IN (0, 0.50, 1.00, 1.50)`
    );
    await applyServiceCopyFixups();
    return;
  }
  const values = [];
  const placeholders = DEFAULT_SERVICES.map((item, index) => {
    const offset = index * 13;
    values.push(randomUUID(), ...item.slice(0, 5), 0, 0, ...item.slice(5));
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13})`;
  });
  await pool.query(
    `
      INSERT INTO service_config (
        id, service_code, service_name, service_icon, action, description,
        fee, commission, status, personal_visible, business_visible, sort_order, feature_badge
      )
      VALUES ${placeholders.join(",")}
      ON CONFLICT (service_code) DO NOTHING
    `,
    values
  );
  await pool.query(
    // The tile a customer reads BEFORE they scan, so it must agree with what
    // pricing_rules will actually charge - the approved schedule puts the
    // customer side of a QR payment at a flat R0.50. The guard lists every
    // figure TitoPay itself has ever written here (0, 0.50, 1.00, 1.50), so a
    // stale catalogue converges while a number an operator set by hand is left
    // exactly as they set it.
    `UPDATE service_config
        SET fee = 0.50,
            description = 'Scan and pay TitoPay QR codes. A flat R0.50 QR payment fee applies.',
            updated_at = NOW()
      WHERE service_code = 'qr-pay'
        AND ROUND(COALESCE(fee, 0)::NUMERIC, 2) IN (0, 0.50, 1.00, 1.50)`
  );
  await applyServiceCopyFixups();
}

// The seed only inserts rows that do not exist yet, so renaming a service in
// DEFAULT_SERVICES would never reach an installation that already has the row.
// Renames worth pushing out live here instead. The guard on the old name means
// an admin who has renamed the tile themselves keeps their wording.
async function applyServiceCopyFixups() {
  await pool.query(
    `UPDATE service_config
        SET service_name = 'Event Scanners',
            description = 'The people who scan tickets at your door. Add them, and they scan from their own phone.',
            updated_at = NOW()
      WHERE service_code = 'business-ticketing-staff'
        AND service_name = 'Ticketing Staff'`
  );
  await openTicketsToBusinessOnce();
  await openBookToCustomersOnce();
  await openRewardsOnce();
  // Priced changes ride the same one-shot mechanism, for the same reason: the
  // approved schedule only reaches a database through db:init, which also
  // overwrites every fee an operator has set by hand.
  await require("./pricing-service").applyQrPricingFixupOnce();
  // The approved schedule runs AFTER the QR fixup on purpose. Both touch the QR
  // rules; the schedule is the later, authoritative figure, so it must be the
  // one that lands last on a database where neither has run yet.
  await require("./pricing-service").applyApprovedScheduleFixupOnce();
}

// Event Tickets was seeded business_visible = FALSE, which hid the tile from
// business accounts even though every step behind it already worked for a
// business wallet: a business books a stand at an expo, sends staff to a
// conference, buys a table at a fundraiser. Correcting DEFAULT_SERVICES alone
// never reaches an installation that already has the row, for the same reason
// the rename above is pushed out here rather than left in the seed.
//
// It runs ONCE, ever, and records that it has. An admin who afterwards decides
// to hide the tile from businesses keeps that decision: this will not run a
// second time and quietly turn it back on. That is the difference between
// correcting a default and overriding a choice.
//
// It never throws. This sits on the path of every catalogue read, and a
// platform_settings hiccup must not take the whole service list down with it.
const TICKETS_BUSINESS_FIXUP_KEY = "service_fixup_tickets_business_visible";
async function openTicketsToBusinessOnce() {
  try {
    const applied = await pool.query(
      "SELECT 1 FROM platform_settings WHERE key = $1 LIMIT 1", [TICKETS_BUSINESS_FIXUP_KEY]);
    if (applied.rows.length) return;
    const { rowCount } = await pool.query(
      `UPDATE service_config
          SET business_visible = TRUE, updated_at = NOW()
        WHERE service_code = 'tickets' AND business_visible = FALSE`);
    await pool.query(
      `INSERT INTO platform_settings (key, value)
       VALUES ($1, $2::JSONB) ON CONFLICT (key) DO NOTHING`,
      [TICKETS_BUSINESS_FIXUP_KEY, JSON.stringify({ appliedAt: new Date().toISOString(), rowsChanged: rowCount })]);
    if (rowCount) console.info("[services] Event Tickets is now available to business accounts");
  } catch (error) {
    console.error("[services] could not open Event Tickets to business accounts", { message: error.message });
  }
}

// BOOK REACHES CUSTOMERS TOO, and a row that already exists never learns that.
//
// service_config seeds with ON CONFLICT DO NOTHING, so the `book` row created by
// an earlier build carries personal_visible = FALSE forever no matter what
// DEFAULT_SERVICES says today. Book began as a business-only console; it now
// also has a customer side, and without this fixup every deployment that
// installed the earlier build would show it to businesses only.
//
// GUARDED AND ONE-SHOT, exactly like the Event Tickets fixup above and for the
// same reason: if an operator later decides to hide Book from customers, this
// must not switch it back on. It corrects a default once; it does not override
// a choice. It never throws, because it sits on the path of every catalogue read.
const BOOK_PERSONAL_FIXUP_KEY = "service_fixup_book_personal_visible";
async function openBookToCustomersOnce() {
  try {
    const applied = await pool.query(
      "SELECT 1 FROM platform_settings WHERE key = $1 LIMIT 1", [BOOK_PERSONAL_FIXUP_KEY]);
    if (applied.rows.length) return;
    const { rowCount } = await pool.query(
      `UPDATE service_config
          SET personal_visible = TRUE, updated_at = NOW()
        WHERE service_code = 'book' AND personal_visible = FALSE`);
    await pool.query(
      `INSERT INTO platform_settings (key, value)
       VALUES ($1, $2::JSONB) ON CONFLICT (key) DO NOTHING`,
      [BOOK_PERSONAL_FIXUP_KEY, JSON.stringify({ appliedAt: new Date().toISOString(), rowsChanged: rowCount })]);
    if (rowCount) console.info("[services] Book is now available to personal accounts");
  } catch (error) {
    console.error("[services] could not open Book to personal accounts", { message: error.message });
  }
}

// REWARDS GOES LIVE ONCE. The `rewards` row seeded by earlier builds is
// disabled and invisible, and ON CONFLICT DO NOTHING means changing the
// defaults never reaches an installed database. The Rewards screen now exists
// (admin-published offers behind approval seats), so the tile switches on —
// once. Guarded and one-shot exactly like the fixups above: if an operator
// later hides or disables Rewards in the Service Builder, this must not switch
// it back on. business-rewards stays disabled: business accounts see the same
// single Rewards tile, not a duplicate.
const REWARDS_OPEN_FIXUP_KEY = "service_fixup_rewards_open";
async function openRewardsOnce() {
  try {
    const applied = await pool.query(
      "SELECT 1 FROM platform_settings WHERE key = $1 LIMIT 1", [REWARDS_OPEN_FIXUP_KEY]);
    if (applied.rows.length) return;
    const { rowCount } = await pool.query(
      `UPDATE service_config
          SET status = 'active', personal_visible = TRUE, business_visible = TRUE,
              feature_badge = 'new',
              description = 'Offers, promotions and coupon codes published by TitoPay.',
              updated_at = NOW()
        WHERE service_code = 'rewards' AND status = 'disabled'`);
    await pool.query(
      `INSERT INTO platform_settings (key, value)
       VALUES ($1, $2::JSONB) ON CONFLICT (key) DO NOTHING`,
      [REWARDS_OPEN_FIXUP_KEY, JSON.stringify({ appliedAt: new Date().toISOString(), rowsChanged: rowCount })]);
    if (rowCount) console.info("[services] Rewards is now available to personal and business accounts");
  } catch (error) {
    console.error("[services] could not open Rewards", { message: error.message });
  }
}

function servicePayload(payload = {}) {
  const serviceCode = String(payload.service_code || payload.serviceCode || "").trim();
  const serviceName = String(payload.service_name || payload.serviceName || "").trim();
  const action = String(payload.action || serviceCode).trim();
  if (!serviceCode || !serviceName || !action) {
    throw new AppError(400, "Service code, service name and action are required");
  }

  return {
    service_code: serviceCode,
    service_name: serviceName,
    service_icon: String(payload.service_icon || payload.serviceIcon || "grid-3x3").trim(),
    action,
    description: String(payload.description || "").trim(),
    fee: Math.max(0, Number(payload.fee || 0)),
    commission: Math.max(0, Number(payload.commission || 0)),
    status: normalizeStatus(String(payload.status || "active").toLowerCase()),
    personal_visible: Boolean(payload.personal_visible ?? payload.personalVisible),
    business_visible: Boolean(payload.business_visible ?? payload.businessVisible),
    sort_order: Number(payload.sort_order ?? payload.sortOrder ?? 100),
    feature_badge: normalizeBadge(String(payload.feature_badge || payload.featureBadge || "none").toLowerCase()),
  };
}

async function createService(payload, actor) {
  const item = servicePayload(payload);
  const id = randomUUID();
  const actorId = actor?.userId || actor?.sub || null;
  const { rows } = await pool.query(
    `
      INSERT INTO service_config (
        id,
        service_code,
        service_name,
        service_icon,
        action,
        description,
        fee,
        commission,
        status,
        personal_visible,
        business_visible,
        sort_order,
        feature_badge,
        created_by,
        updated_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      RETURNING *
    `,
    [
      id,
      item.service_code,
      item.service_name,
      item.service_icon,
      item.action,
      item.description,
      item.fee,
      item.commission,
      item.status,
      item.personal_visible,
      item.business_visible,
      item.sort_order,
      item.feature_badge,
      actorId,
    ]
  );
  await writeAuditLog({
    actorType: "admin",
    actorId,
    action: "service_config_created",
    entityType: "service_config",
    entityId: id,
    metadata: { service_code: item.service_code },
  });
  return applyCapabilityGate(rows[0]);
}

async function updateService(id, payload, actor) {
  const actorId = actor?.userId || actor?.sub || null;
  const allowed = [
    "service_name",
    "service_icon",
    "action",
    "description",
    "fee",
    "commission",
    "status",
    "personal_visible",
    "business_visible",
    "sort_order",
    "feature_badge",
  ];
  const normalized = servicePayload({
    service_code: payload.service_code || payload.serviceCode || "existing",
    service_name: payload.service_name || payload.serviceName || "Existing",
    action: payload.action || "existing",
    ...payload,
  });
  const sets = [];
  const values = [];
  for (const key of allowed) {
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (payload[key] !== undefined || payload[camel] !== undefined) {
      values.push(normalized[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (!sets.length) {
    throw new AppError(400, "No service fields supplied");
  }
  values.push(actorId);
  sets.push(`updated_by = $${values.length}`);
  values.push(id);
  const { rows } = await pool.query(
    `
      UPDATE service_config
      SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `,
    values
  );
  if (!rows[0]) {
    throw new AppError(404, "Service not found");
  }
  await writeAuditLog({
    actorType: "admin",
    actorId,
    action: "service_config_updated",
    entityType: "service_config",
    entityId: id,
    metadata: payload,
  });
  // Gated on the way back too: an operator who sets a capability-backed service
  // to active must be told immediately that it will still be served as coming
  // soon, rather than discovering it on the next list.
  return applyCapabilityGate(rows[0]);
}

module.exports = {
  capabilityReport,
  createService,
  ensureDefaultServices,
  listServices,
  updateService,
};
