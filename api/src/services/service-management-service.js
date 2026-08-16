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
  ["qr-pay", "QR Pay", "qr", "qr-pay", "Scan and pay TitoPay QR codes. A R0.50 QR payment fee applies.", "active", true, true, 50, "none"],
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
  ["business-ticketing-staff", "Event Scanners", "contacts", "business-ticketing-staff", "The people who scan tickets at your door. Add them, and they scan from their own phone.", "active", false, true, 301, "new"],
  ["shop-marketplace", "Shop Marketplace", "store", "shop-marketplace", "Marketplace services for local brands and digital products.", "disabled", false, false, 310, "none"],
  ["rewards", "Rewards", "sparkles", "rewards", "Personal rewards programme.", "disabled", false, false, 320, "none"],
  ["business-rewards", "Business Rewards", "sparkles", "business-rewards", "Business rewards programme.", "disabled", false, false, 330, "none"],
  ["virtual-doctor", "Virtual Doctor", "health", "virtual-doctor", "Digital healthcare services.", "disabled", false, false, 340, "none"],
  ["travel", "Travel", "plane", "travel", "Travel booking and payment services.", "disabled", false, false, 350, "none"],
  ["donate", "Donate", "heart", "donate", "Donation and community giving campaigns.", "disabled", false, false, 360, "none"],
  ["cross-border", "Cross Border", "globe", "cross-border", "Cross-border payment services.", "disabled", false, false, 370, "none"],
  ["get-cash", "Get Cash", "withdraw", "get-cash", "Personal cash-out services.", "disabled", false, false, 380, "none"],
  ["cash-back", "Cash Back", "refresh", "cash-back", "Business cashback services.", "disabled", false, false, 390, "none"]
];

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
  return rows;
}

async function ensureDefaultServices() {
  const serviceCodes = DEFAULT_SERVICES.map((item) => item[0]);
  const { rows } = await pool.query("SELECT COUNT(*)::INT AS count FROM service_config WHERE service_code = ANY($1)", [serviceCodes]);
  if (rows[0].count >= DEFAULT_SERVICES.length) {
    await pool.query(
      "UPDATE service_config SET fee = 0.50, description = 'Scan and pay TitoPay QR codes. A R0.50 QR payment fee applies.', updated_at = NOW() WHERE service_code = 'qr-pay' AND COALESCE(fee, 0) < 0.50"
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
    "UPDATE service_config SET fee = 0.50, description = 'Scan and pay TitoPay QR codes. A R0.50 QR payment fee applies.', updated_at = NOW() WHERE service_code = 'qr-pay' AND COALESCE(fee, 0) < 0.50"
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
  return rows[0];
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
  return rows[0];
}

module.exports = {
  createService,
  ensureDefaultServices,
  listServices,
  updateService,
};
