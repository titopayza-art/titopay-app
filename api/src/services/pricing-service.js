const { pool } = require("../db/pool");
const { v4: uuidv4 } = require("uuid");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");

const APPROVED_PRICING_SCHEDULE = [
  ["personal_wallet", "Personal Wallet"],
  ["wallet_top_up", "Wallet Top Up", 6],
  ["top_up", "Wallet Top Up", 6],
  ["receive_money", "Receive Money"],
  ["send_money", "Send Money"],
  ["wallet_transfer", "Wallet Transfer"],
  ["bank_transfer", "Withdraw Money to Bank", 7],
  ["bank_withdrawal", "Bank Withdrawal", 7],
  ["withdraw", "Withdraw Money to Bank", 7],
  ["withdraw_money_to_bank", "Withdraw Money to Bank", 7],
  ["cash_withdrawal", "Withdraw Cash", 10],
  ["withdraw_cash", "Withdraw Cash", 10],
  ["qr_payment", "QR Pay", 0.50, 0.50],
  ["qr_pay", "QR Pay", 0.50, 0.50],
  ["customer_qr_payment", "Customer QR Payment", 0.50, 0.50],
  ["payment_request", "Payment Request"],
  ["request_money", "Payment Request"],
  ["bill_split", "Bill Split", 1],
  ["send_gift", "Send Gift", 3],
  ["airtime", "Airtime", 1],
  ["data", "Data", 1],
  ["electricity", "Electricity", 5],
  ["voucher", "Voucher", 4],
  ["vouchers", "Vouchers", 4],
  ["pay_bills", "Pay Bills", 5],
  ["bill_payments", "Bill Payments", 5],
  ["stockvel", "Stockvel", 0, 0, 1.5, 10],
  ["stockvel_contribution", "Stockvel Contribution", 0, 0, 1.5, 10],
  ["statement_pdf", "Statement PDF"],
  ["statements", "Statements"],
  ["learn", "Learn"],
  ["transactions", "Transactions"],
  ["transaction_history", "Transaction History"],
  ["profile_security", "Profile & Security"],
  ["fica", "FICA Verification"],
  ["kyc", "KYC Verification"],
  ["business_wallet", "Business Wallet"],
  ["business_registration", "Business Registration"],
  ["receive_payments", "Receive Payments"],
  ["merchant_qr", "Merchant QR Payments", 0, 0, 1.7],
  ["merchant_qr_payment", "Merchant QR Payments", 0, 0, 1.7],
  ["make_a_sale", "Make a Sale", 0, 0, 1.7],
  // "payouts" is the code the business Payouts tile actually submits (see the
  // service catalogue). It was missing from the approved schedule, so a fee
  // preview auto-created it at zero and business payouts would have been free.
  // Priced identically to Business Payout, which is the same product.
  ["payouts", "Business Payout", 0, 0, 1.5],
  ["business_payout", "Business Payout", 0, 0, 1.5],
  ["merchant_payout", "Business Payout", 0, 0, 1.5],
  ["merchant_payouts", "Business Payouts", 0, 0, 1.5],
  ["refund_processing", "Refund Processing", 0.50],
  ["business_document_pdf", "Business Document PDF", 2.50],
  ["invoice_pdf", "Invoice PDF", 2.50],
  ["invoice_creation", "Invoice Creation", 2.50],
  ["quote_pdf", "Quote PDF", 2.50],
  ["quote_creation", "Quote Creation", 2.50],
  ["proforma_invoice_pdf", "Proforma Invoice PDF", 2.50],
  ["pro_forma_creation", "Pro Forma Creation", 2.50],
  ["business_statement_pdf", "Business Statement PDF"],
  ["business_profile", "Business Profile"],
  ["marketplace", "Marketplace"],
  ["marketplace_seller_commission", "Marketplace Seller Commission", 0, 0, 12],
  ["marketplace_commission", "Marketplace Commission", 0, 0, 12],
  ["marketplace_buyer_service_fee", "Marketplace Buyer Service Fee", 5],
  ["seller_payout", "Seller Payout", 0, 0, 1.5],
  ["marketplace_refund_processing", "Marketplace Refund Processing", 0.50],
  ["ticket_sales", "Ticket Sales"],
  ["ticket_purchase", "Ticket Purchase"],
  ["ticket_buyer_service_fee", "Ticket Buyer Service Fee", 10],
  ["ticket_business_commission", "Ticket Business Commission", 0, 0, 12],
  ["ticket_refund_processing", "Ticket Refund Processing", 0.50],
  ["ticket_refund", "Ticket Refund", 0.50],
  ["ticket_scanning", "Ticket Scanning"],
  ["ticket_staff_access", "Ticket Staff Access"],
  // An Event Tag tap is the cashless equivalent of a card tap at the same
  // terminal, so it carries no customer fee — the same choice already made for
  // pos_qr. Registered here because transactions.service_code is a foreign key
  // into this table; without a row, a tap could not be written to the ledger.
  ["event_tag", "Event Tag Payment"],
  ["bulk_distribution_fee", "Bulk Distribution Fee", 0, 0, 4],
  ["bulk_distribution_batch_fee", "Bulk Distribution Fee", 0, 0, 4],
  ["bulk_distribution_wallet_payout", "Bulk Distribution Wallet Payout"],
  ["bulk_distribution_bank_payout", "Bulk Distribution Bank Payout"],
  ["bulk_distribution_failed_item_fee", "Bulk Distribution Failed Item Fee"],
  ["bulk_distribution_reversal_fee", "Bulk Distribution Reversal Fee"],
  ["in_app_notifications", "In-App Notifications"],
  ["email_otp", "Email OTP"],
  ["email_statement", "Email Statement", 0.10],
  ["email_notifications", "Email Notifications"],
  ["otp_sms", "OTP SMS"],
  ["security_sms", "Security SMS"],
  ["optional_sms_notifications", "Optional SMS Notifications", 0.30],
  ["future_services", "Future Services"],
  ["card_payments", "Card Payments"],
  ["card_topups", "Card Top-ups"],
  ["cash_services", "Cash Services"],
  ["gift_cards", "Gift Cards"],
  ["tip", "Tip"]
].map(([serviceCode, serviceName, flatFee = 0, minimumFee = 0, percentageFee = 0, maximumFee = 0]) => ({
  serviceCode,
  serviceName,
  flatFee,
  percentageFee,
  minimumFee,
  maximumFee,
  vatPercentage: 0,
  enabled: true,
  effectiveDate: new Date().toISOString().slice(0, 10)
}));

const DEFAULT_PRICING_RULES = APPROVED_PRICING_SCHEDULE;

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeServiceCode(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function defaultRuleFor(serviceCode) {
  const normalized = normalizeServiceCode(serviceCode);
  return DEFAULT_PRICING_RULES.find((rule) => rule.serviceCode === normalized) || {
    serviceCode: normalized || "future_services",
    serviceName: String(serviceCode || "Future Services").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    flatFee: 0,
    percentageFee: 0,
    minimumFee: 0,
    maximumFee: 0,
    vatPercentage: 0,
    enabled: true,
    effectiveDate: new Date().toISOString().slice(0, 10)
  };
}

function normalizePricingRow(row = {}) {
  const flatFee = row.flat_fee === undefined || row.flat_fee === null
    ? (row.fee_type === "FIXED" ? Number(row.fee_value || 0) : 0)
    : Number(row.flat_fee || 0);
  const percentageFee = row.percentage_fee === undefined || row.percentage_fee === null
    ? (row.fee_type === "PERCENTAGE" ? Number(row.fee_value || 0) : 0)
    : Number(row.percentage_fee || 0);
  return {
    ...row,
    flat_fee: flatFee,
    percentage_fee: percentageFee,
    vat_percentage: Number(row.vat_percentage ?? 0),
    enabled: row.enabled === undefined ? Boolean(row.active) : Boolean(row.enabled),
    effective_date: row.effective_date || null
  };
}

let pricingSchemaReadyPromise = null;

async function ensurePricingSchema() {
  if (!pricingSchemaReadyPromise) {
    pricingSchemaReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS pricing_rules (
        id UUID PRIMARY KEY,
        service_code TEXT NOT NULL UNIQUE,
        service_name TEXT NOT NULL,
        fee_type TEXT NOT NULL DEFAULT 'FREE',
        fee_value NUMERIC(18,2) NOT NULL DEFAULT 0,
        flat_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
        percentage_fee NUMERIC(18,4) NOT NULL DEFAULT 0,
        minimum_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
        maximum_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
        vat_percentage NUMERIC(8,4) NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID,
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS service_name TEXT;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS fee_type TEXT NOT NULL DEFAULT 'FREE';
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS fee_value NUMERIC(18,2) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS flat_fee NUMERIC(18,2) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS percentage_fee NUMERIC(18,4) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS minimum_fee NUMERIC(18,2) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS maximum_fee NUMERIC(18,2) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS vat_percentage NUMERIC(8,4) NOT NULL DEFAULT 0;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS effective_date DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS created_by UUID;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS updated_by UUID;
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE pricing_rules
      SET service_name = COALESCE(service_name, service_code),
          flat_fee = CASE WHEN fee_type = 'FIXED' AND COALESCE(flat_fee, 0) = 0 THEN fee_value ELSE flat_fee END,
          percentage_fee = CASE WHEN fee_type = 'PERCENTAGE' AND COALESCE(percentage_fee, 0) = 0 THEN fee_value ELSE percentage_fee END,
          enabled = COALESCE(enabled, active, TRUE),
          vat_percentage = COALESCE(vat_percentage, 0),
          effective_date = COALESCE(effective_date, CURRENT_DATE)
      WHERE service_code IS NOT NULL;
    `).catch((error) => {
      pricingSchemaReadyPromise = null;
      throw error;
    });
  }
  return pricingSchemaReadyPromise;
}

async function ensureDefaultPricingRule(serviceCode, actorId = null) {
  await ensurePricingSchema();
  const rule = defaultRuleFor(serviceCode);
  const feeType = rule.percentageFee > 0 ? "PERCENTAGE" : rule.flatFee > 0 ? "FIXED" : "FREE";
  const feeValue = rule.percentageFee > 0 ? rule.percentageFee : rule.flatFee;
  const { rows } = await pool.query(
    `INSERT INTO pricing_rules
      (id, service_code, service_name, fee_type, fee_value, flat_fee, percentage_fee, minimum_fee, maximum_fee, vat_percentage, enabled, active, effective_date, created_by, updated_by)
     VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, TRUE, $10::DATE, $11, $11)
     ON CONFLICT (service_code)
     DO UPDATE SET
       service_name = COALESCE(pricing_rules.service_name, EXCLUDED.service_name),
       flat_fee = COALESCE(pricing_rules.flat_fee, EXCLUDED.flat_fee),
       percentage_fee = COALESCE(pricing_rules.percentage_fee, EXCLUDED.percentage_fee),
       vat_percentage = COALESCE(pricing_rules.vat_percentage, EXCLUDED.vat_percentage),
       enabled = COALESCE(pricing_rules.enabled, pricing_rules.active, TRUE),
      active = COALESCE(pricing_rules.active, TRUE),
      effective_date = COALESCE(pricing_rules.effective_date, EXCLUDED.effective_date),
      updated_at = NOW()
     RETURNING *`,
    [
      rule.serviceCode,
      rule.serviceName,
      feeType,
      feeValue,
      rule.flatFee,
      rule.percentageFee,
      rule.minimumFee,
      rule.maximumFee,
      rule.vatPercentage,
      rule.effectiveDate,
      actorId,
      uuidv4()
    ]
  );
  return normalizePricingRow(rows[0]);
}

async function syncApprovedPricingSchedule(actorId = null) {
  await ensurePricingSchema();
  const rows = [];
  for (const rule of APPROVED_PRICING_SCHEDULE) {
    const feeType = rule.percentageFee > 0 ? "PERCENTAGE" : rule.flatFee > 0 ? "FIXED" : "FREE";
    const feeValue = rule.percentageFee > 0 ? rule.percentageFee : rule.flatFee;
    const result = await pool.query(
      `INSERT INTO pricing_rules
        (id, service_code, service_name, fee_type, fee_value, flat_fee, percentage_fee, minimum_fee, maximum_fee, vat_percentage, enabled, active, effective_date, created_by, updated_by)
       VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, 0, TRUE, TRUE, $9::DATE, $10, $11)
       ON CONFLICT (service_code)
       DO UPDATE SET
         service_name = EXCLUDED.service_name,
         fee_type = EXCLUDED.fee_type,
         fee_value = EXCLUDED.fee_value,
         flat_fee = EXCLUDED.flat_fee,
         percentage_fee = EXCLUDED.percentage_fee,
         minimum_fee = EXCLUDED.minimum_fee,
         maximum_fee = EXCLUDED.maximum_fee,
         vat_percentage = 0,
         enabled = TRUE,
         active = TRUE,
         effective_date = COALESCE(pricing_rules.effective_date, EXCLUDED.effective_date),
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        rule.serviceCode,
        rule.serviceName,
        feeType,
        feeValue,
        rule.flatFee,
        rule.percentageFee,
        rule.minimumFee,
        rule.maximumFee,
        rule.effectiveDate,
        actorId,
        actorId,
        uuidv4()
      ]
    );
    rows.push(normalizePricingRow(result.rows[0]));
  }
  console.info("[pricing-sync] approved pricing schedule applied", { count: rows.length, vatPercentage: 0 });
  return rows;
}

async function ensureDefaultPricingRules() {
  const rows = [];
  for (const rule of DEFAULT_PRICING_RULES) {
    rows.push(await ensureDefaultPricingRule(rule.serviceCode));
  }
  return rows;
}

async function listPricingRules() {
  try {
    await ensureDefaultPricingRules();
    const { rows } = await pool.query(
      `SELECT *
       FROM pricing_rules
       ORDER BY service_name ASC`
    );
    return rows.map(normalizePricingRow);
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("pricing.listPricingRules", error);
    return [];
  }
}

async function getPricingRule(serviceCode) {
  await ensurePricingSchema();
  const normalizedCode = normalizeServiceCode(serviceCode);
  const { rows } = await pool.query(
    "SELECT * FROM pricing_rules WHERE service_code = $1 AND COALESCE(enabled, active, TRUE) = TRUE LIMIT 1",
    [normalizedCode]
  );
  if (rows[0]) return normalizePricingRow(rows[0]);
  return ensureDefaultPricingRule(normalizedCode);
}

async function calculateFee(serviceCode, amount) {
  const normalizedServiceCode = normalizeServiceCode(serviceCode);
  const rule = await getPricingRule(serviceCode);
  const baseAmount = roundMoney(amount);
  let fee = Number(rule.flat_fee || 0) + (baseAmount * (Number(rule.percentage_fee || 0) / 100));
  if (!fee && rule.fee_type === "FIXED") fee = Number(rule.fee_value);
  if (!fee && rule.fee_type === "PERCENTAGE") fee = baseAmount * (Number(rule.fee_value) / 100);
  if (Number(rule.minimum_fee) > 0) fee = Math.max(fee, Number(rule.minimum_fee));
  if (Number(rule.maximum_fee) > 0) fee = Math.min(fee, Number(rule.maximum_fee));
  if (normalizedServiceCode === "qr_payment") fee = Math.max(fee, 0.50);
  // A fee is never negative. A negative rule reaching here would debit LESS
  // than the amount while the recipient is credited the full amount, and would
  // "credit" the revenue wallet a negative number — which debits it. TitoPay
  // would fund the difference on every such transaction. The admin side now
  // refuses to store one; this is the second line, because a bad row can also
  // arrive from a migration, a seed or a direct database edit.
  if (!Number.isFinite(fee) || fee < 0) fee = 0;
  fee = roundMoney(fee);
  return {
    serviceCode: rule.service_code,
    serviceName: rule.service_name,
    feeType: rule.fee_type,
    flatFee: Number(rule.flat_fee || 0),
    percentageFee: Number(rule.percentage_fee || 0),
    vatPercentage: Number(rule.vat_percentage || 0),
    amount: baseAmount,
    fee,
    total: roundMoney(baseAmount + fee)
  };
}

async function updatePricingRule(id, payload, actor) {
  await ensurePricingSchema();
  const normalizedPayload = { ...payload };
  if (payload.flatFee !== undefined) normalizedPayload.flat_fee = payload.flatFee;
  if (payload.percentageFee !== undefined) normalizedPayload.percentage_fee = payload.percentageFee;
  if (payload.vat !== undefined) normalizedPayload.vat_percentage = payload.vat;
  if (payload.vatPercentage !== undefined) normalizedPayload.vat_percentage = payload.vatPercentage;
  if (payload.enabled !== undefined) normalizedPayload.active = payload.enabled;
  if (payload.effectiveDate !== undefined) normalizedPayload.effective_date = payload.effectiveDate;
  // Nothing on a pricing rule may be negative or nonsense. Without this an
  // admin sending flatFee: -5 wrote -5 straight to pricing_rules.
  for (const [field, label, ceiling] of [
    ["flat_fee", "Flat fee", 1000000],
    ["percentage_fee", "Percentage fee", 100],
    ["minimum_fee", "Minimum fee", 1000000],
    ["maximum_fee", "Maximum fee", 1000000],
    ["vat_percentage", "VAT percentage", 100]
  ]) {
    if (normalizedPayload[field] === undefined || normalizedPayload[field] === null) continue;
    const value = Number(normalizedPayload[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError(400, `${label} must be zero or more`);
    }
    if (value > ceiling) throw new AppError(400, `${label} is above the allowed maximum of ${ceiling}`);
  }
  {
    const minimumFee = Number(normalizedPayload.minimum_fee || 0);
    const maximumFee = Number(normalizedPayload.maximum_fee || 0);
    if (maximumFee > 0 && minimumFee > maximumFee) {
      throw new AppError(400, "Minimum fee cannot be greater than maximum fee");
    }
  }
  if (normalizedPayload.flat_fee !== undefined || normalizedPayload.percentage_fee !== undefined) {
    const flatFee = Number(normalizedPayload.flat_fee || 0);
    const percentageFee = Number(normalizedPayload.percentage_fee || 0);
    normalizedPayload.fee_type = percentageFee > 0 ? "PERCENTAGE" : flatFee > 0 ? "FIXED" : "FREE";
    normalizedPayload.fee_value = percentageFee > 0 ? percentageFee : flatFee;
    normalizedPayload.enabled = normalizedPayload.active !== undefined ? normalizedPayload.active : true;
  }
  const allowed = ["service_name", "fee_type", "fee_value", "flat_fee", "percentage_fee", "minimum_fee", "maximum_fee", "vat_percentage", "enabled", "effective_date", "active"];
  const fields = Object.entries(normalizedPayload).filter(([key]) => allowed.includes(key));
  if (!fields.length) throw new AppError(400, "No pricing fields supplied");
  const setSql = fields.map(([key], index) => `${key} = $${index + 2}`).join(", ");
  const values = fields.map(([, value]) => value);
  const { rows } = await pool.query(
    `UPDATE pricing_rules
     SET ${setSql}, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, ...values]
  );
  if (!rows[0]) throw new AppError(404, "Pricing rule could not be updated");
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "pricing_rule_updated",
    entityType: "pricing_rule",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: payload
  });
  return normalizePricingRow(rows[0]);
}

module.exports = {
  DEFAULT_PRICING_RULES,
  APPROVED_PRICING_SCHEDULE,
  roundMoney,
  normalizeServiceCode,
  ensureDefaultPricingRule,
  ensureDefaultPricingRules,
  syncApprovedPricingSchedule,
  listPricingRules,
  getPricingRule,
  calculateFee,
  updatePricingRule
};
