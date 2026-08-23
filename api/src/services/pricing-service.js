const { pool } = require("../db/pool");
const { v4: uuidv4 } = require("uuid");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");

const APPROVED_PRICING_SCHEDULE = [
  // THE APPROVED TITOPAY PRICING SCHEDULE.
  //
  // Tuple order is [serviceCode, serviceName, flatFee, minimumFee, percentageFee, maximumFee]
  // - a flat fee:            ["code", "Name", 5]
  // - a percentage:          ["code", "Name", 0, 0, 1.5]
  // - a percentage, capped:  ["code", "Name", 0, 0, 1.5, 10]
  // - free:                  ["code", "Name"]
  //
  // Several codes are ALIASES of one product (a withdrawal is submitted as
  // withdraw, bank_transfer and withdraw_money_to_bank depending on the caller).
  // Aliases carry identical numbers so the fee cannot depend on which entry
  // point was used. Nothing is ever removed from this list: transactions
  // .service_code is a foreign key into pricing_rules ON DELETE RESTRICT, so a
  // deleted rule would orphan historical transactions.

  // -- WALLET AND MONEY MOVEMENT ------------------------------------------
  ["personal_wallet", "Personal Wallet"],
  ["monthly_wallet_fee", "Monthly Wallet Fee"],
  ["wallet_top_up", "Wallet Top Up", 5],
  ["top_up", "Wallet Top Up", 5],
  ["receive_money", "Receive Money"],
  ["send_money", "Send Money"],
  ["wallet_transfer", "Wallet Transfer"],
  ["withdraw_money_to_bank", "Withdraw Money to Bank", 10],
  ["withdraw", "Withdraw Money to Bank", 10],
  ["bank_transfer", "Withdraw Money to Bank", 10],
  ["bank_withdrawal", "Bank Withdrawal", 10],
  ["cash_withdrawal", "Withdraw Cash", 10],
  ["withdraw_cash", "Withdraw Cash", 10],
  ["payment_request", "Payment Request", 1],
  ["request_money", "Payment Request", 1],
  ["bill_split", "Bill Split", 2],
  ["send_gift", "Send Gift", 3],
  ["tip", "Tip"],

  // -- QR PAYMENTS ---------------------------------------------------------
  // The customer pays a flat R0.50 whatever the sale; the percentage sits on
  // the business side, where the sale is being earned from.
  ["qr_payment", "QR Pay", 0.50],
  ["qr_pay", "QR Pay", 0.50],
  ["customer_qr_payment", "Customer QR Payment", 0.50],
  ["merchant_qr", "Merchant QR Payments", 0, 0, 1.5],
  ["merchant_qr_payment", "Merchant QR Payments", 0, 0, 1.5],
  ["event_tag", "Event Tag Payment", 1],

  // -- AIRTIME, DATA AND UTILITIES -----------------------------------------
  ["airtime", "Airtime", 1],
  ["data", "Data", 1],
  ["airtime_data", "Airtime & Data", 1],
  ["electricity", "Electricity", 5],
  ["voucher", "Voucher", 3],
  ["vouchers", "Vouchers", 3],
  ["pay_bills", "Pay Bills", 5],
  ["bill_payments", "Bill Payments", 5],

  // -- STOKVEL -------------------------------------------------------------
  ["stockvel", "Stokvel", 0, 0, 1.5, 10],
  ["stockvel_contribution", "Stokvel Contribution", 0, 0, 1.5, 10],

  // -- BUSINESS AND MERCHANT -----------------------------------------------
  ["business_wallet", "Business Wallet"],
  ["business_registration", "Business Registration"],
  ["business_profile", "Business Profile"],
  ["receive_payments", "Receive Payments"],
  ["make_a_sale", "Make a Sale", 0, 0, 1.5],
  ["business_payout", "Business Payout", 0, 0, 1.5],
  ["payouts", "Business Payout", 0, 0, 1.5],
  ["merchant_payout", "Business Payout", 0, 0, 1.5],
  ["merchant_payouts", "Business Payouts", 0, 0, 1.5],
  ["refund_processing", "Refund Processing", 1],
  ["refund", "Refund Processing", 1],
  ["business_statement_pdf", "Business Statement PDF", 0.50],
  ["business_document_pdf", "Business Document PDF", 2.50],
  ["invoice_creation", "Invoice Creation", 2.50],
  ["invoice_pdf", "Invoice PDF", 2.50],
  ["invoice", "Invoice Creation", 2.50],
  ["quote_creation", "Quote Creation", 2.50],
  ["quote_pdf", "Quote PDF", 2.50],
  ["quote", "Quote Creation", 2.50],
  ["pro_forma_creation", "Pro Forma Creation", 2.50],
  ["proforma_invoice_pdf", "Proforma Invoice PDF", 2.50],
  ["proforma_invoice", "Pro Forma Creation", 2.50],
  // TitoPay Book: the once-off charge that unlocks booking for a business.
  // The price lives here, not in Book's code, so the Pricing Engine and the
  // customer can never show two different figures.
  ["book_business_activation", "TitoPay Book Activation", 250],
  ["book", "TitoPay Book Activation", 250],

  // -- BULK DISTRIBUTION ---------------------------------------------------
  ["bulk_distribution_fee", "Bulk Distribution Fee", 0, 0, 3],
  ["bulk_distribution_batch_fee", "Bulk Distribution Fee", 0, 0, 3],
  ["enterprise_distribution", "Bulk Distribution Fee", 0, 0, 3],
  ["bulk_distribution_wallet_payout", "Bulk Distribution Wallet Payout"],
  ["bulk_distribution_bank_payout", "Bulk Distribution Bank Payout", 0, 0, 1.5],
  ["bulk_distribution_failed_item_fee", "Bulk Distribution Failed Item Fee", 1],
  ["bulk_distribution_reversal_fee", "Bulk Distribution Reversal Fee", 1],

  // -- EVENTS AND TICKETING ------------------------------------------------
  ["ticket_purchase", "Ticket Purchase"],
  ["ticket_sales", "Ticket Sales"],
  ["tickets", "Ticket Purchase"],
  ["ticket_buyer_service_fee", "Ticket Buyer Service Fee", 10],
  ["ticket_business_commission", "Ticket Business Commission", 0, 0, 10],
  ["ticketing", "Ticket Business Commission", 0, 0, 10],
  ["ticket_refund_processing", "Ticket Refund Processing", 1],
  ["ticket_refund", "Ticket Refund", 1],
  ["ticket_scanning", "Ticket Scanning"],
  ["ticket_staff_access", "Ticket Staff Access"],
  ["business_ticketing_staff", "Ticket Staff Access"],
  ["business_staff", "Staff"],
  ["event_marketing_sms", "Event Marketing SMS", 0.60],

  // -- MARKETPLACE ---------------------------------------------------------
  ["marketplace", "Marketplace"],
  ["marketplace_seller_commission", "Marketplace Seller Commission", 0, 0, 10],
  ["marketplace_commission", "Marketplace Commission", 0, 0, 10],
  ["marketplace_buyer_service_fee", "Marketplace Buyer Service Fee", 5],
  ["seller_payout", "Seller Payout", 0, 0, 1.5],
  ["marketplace_refund_processing", "Marketplace Refund Processing", 1],

  // -- RECORDS AND DOCUMENTS ------------------------------------------------
  ["statement_pdf", "Statement PDF", 0.50],
  ["statements", "Statements", 0.50],
  ["email_statement", "Email Statement", 0.50],
  ["transactions", "Transactions"],
  ["transaction_history", "Transaction History"],
  ["learn", "Learn"],
  ["rewards", "Rewards"],

  // -- VERIFICATION AND SECURITY --------------------------------------------
  ["fica", "FICA Verification"],
  ["kyc", "KYC Verification"],
  ["personal_kyc", "Personal KYC Verification", 30],
  ["business_kyc", "Business KYC Verification", 60],
  ["profile_security", "Profile & Security"],
  ["in_app_notifications", "In-App Notifications"],
  ["email_notifications", "Email Notifications"],
  ["email_otp", "Email OTP"],
  ["otp_sms", "OTP SMS"],
  ["security_sms", "Security SMS"],
  ["optional_sms_notifications", "Optional SMS Notifications", 0.30],

  // -- FUTURE SERVICES -------------------------------------------------------
  ["future_services", "Future Services"],
  ["card_payments", "Card Payments", 0, 0, 1.9],
  ["card_topups", "Card Top-ups", 0, 0, 2],
  ["cash_services", "Cash Services", 10],
  ["gift_cards", "Gift Cards", 3]
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

// By primary key, for callers that hold a rule id (the pricing update route,
// which needs the service_code to decide whether a change is dual-auth
// gated). Returns null when the id is unknown - never invents a default,
// because the caller is about to act on an existing row.
async function getPricingRuleById(id) {
  await ensurePricingSchema();
  const { rows } = await pool.query("SELECT * FROM pricing_rules WHERE id = $1 LIMIT 1", [id]);
  return rows[0] ? normalizePricingRow(rows[0]) : null;
}

// THE NEW QR PRICING, PUSHED ONCE TO A DATABASE THAT ALREADY HAS THE OLD ROWS.
//
// The schedule above is a DEFAULT: syncApprovedPricingSchedule only runs from
// db:init, which also overwrites every other fee an operator has set, so it is
// not a way to ship a price change. This is, and it is the same mechanism the
// service copy fixups use: applied once, recorded in platform_settings, and
// never applied again — so an operator who tunes these afterwards keeps their
// numbers.
//
//   customer   a flat R1.50, whatever the sale
//   merchant   R1.50 + 1.5% of the sale, uncapped
//
// The guard on the OLD values means a rate somebody has already changed by hand
// is left exactly as they set it. Each side lists EVERY value TitoPay itself
// has ever put there — the original flat R0.50 and 1.7%, and the R1.50 + 1%
// capped at R10 and 1.5% that build 49 carried — so a database sitting on
// either of them converges, and one an operator has tuned does not.
const QR_PRICING_FIXUP_KEY = "pricing_fixup_qr_flat_customer_2026_08";
const QR_PRICING_FIXUP = [
  {
    codes: ["qr_payment", "qr_pay", "customer_qr_payment"],
    flat: 1.50, percentage: 0, minimum: 0, maximum: 0,
    was: [[0.50, 0], [1.50, 1]]
  },
  {
    codes: ["merchant_qr", "merchant_qr_payment"],
    flat: 1.50, percentage: 1.5, minimum: 0, maximum: 0,
    was: [[0, 1.7], [0, 1.5]]
  }
];
async function applyQrPricingFixupOnce() {
  try {
    await ensurePricingSchema();
    const applied = await pool.query("SELECT 1 FROM platform_settings WHERE key = $1 LIMIT 1", [QR_PRICING_FIXUP_KEY]);
    if (applied.rows.length) return;
    let changed = 0;
    for (const entry of QR_PRICING_FIXUP) {
      // fee_type and fee_value are derived exactly as syncApprovedPricingSchedule
      // derives them, so a rule written by this path and a rule written by that
      // one cannot disagree about the same fee.
      const { rowCount } = await pool.query(
        `UPDATE pricing_rules
            SET fee_type = $2, fee_value = $3, flat_fee = $4, percentage_fee = $5,
                minimum_fee = $6, maximum_fee = $7, enabled = TRUE, active = TRUE, updated_at = NOW()
          WHERE service_code = ANY($1::TEXT[])
            AND EXISTS (
              SELECT 1 FROM unnest($8::NUMERIC[], $9::NUMERIC[]) AS was(flat, percentage)
               WHERE ROUND(flat_fee::NUMERIC, 2) = ROUND(was.flat, 2)
                 AND ROUND(percentage_fee::NUMERIC, 4) = ROUND(was.percentage, 4)
            )`,
        [entry.codes,
          entry.percentage > 0 ? "PERCENTAGE" : entry.flat > 0 ? "FIXED" : "FREE",
          entry.percentage > 0 ? entry.percentage : entry.flat,
          entry.flat, entry.percentage, entry.minimum, entry.maximum,
          entry.was.map((pair) => pair[0]), entry.was.map((pair) => pair[1])]
      );
      changed += rowCount;
    }
    await pool.query(
      "INSERT INTO platform_settings (key, value) VALUES ($1, $2::JSONB) ON CONFLICT (key) DO NOTHING",
      [QR_PRICING_FIXUP_KEY, JSON.stringify({ appliedAt: new Date().toISOString(), rowsChanged: changed })]
    );
    if (changed) console.info("[pricing] QR pricing updated", { rowsChanged: changed });
  } catch (error) {
    console.error("[pricing] could not apply the QR pricing update", { message: error.message });
  }
}

// THE APPROVED SCHEDULE, PUSHED ONCE TO A DATABASE THAT ALREADY HAS ROWS.
//
// Editing APPROVED_PRICING_SCHEDULE on its own changes nothing on a running
// installation: syncApprovedPricingSchedule is reached only from db:init, and
// listPricingRules' ensureDefaultPricingRule deliberately COALESCEs to whatever
// the database already holds. So a live wallet keeps charging yesterday's fee.
// This carries the schedule across, using the same one-shot mechanism as the QR
// fixup above: applied once, recorded in platform_settings, never applied again.
//
// It differs from that fixup in one deliberate way. The QR fixup was guarded on
// the specific old values, so a rate an operator had tuned by hand survived.
// This one is UNCONDITIONAL, because it is not a correction to one rate - it is
// the adoption of a whole approved schedule, which supersedes earlier tuning by
// definition. Anything an operator changes AFTER it runs is safe: the key is
// recorded, so a later boot will not undo their work. Shipping a further price
// change means a new key, not editing this one.
const APPROVED_SCHEDULE_FIXUP_KEY = "pricing_schedule_2026_08_approved";
async function applyApprovedScheduleFixupOnce() {
  try {
    await ensurePricingSchema();
    const applied = await pool.query(
      "SELECT 1 FROM platform_settings WHERE key = $1 LIMIT 1",
      [APPROVED_SCHEDULE_FIXUP_KEY]
    );
    if (applied.rows.length) return { skipped: true };

    let written = 0;
    for (const rule of APPROVED_PRICING_SCHEDULE) {
      // fee_type and fee_value are derived exactly as syncApprovedPricingSchedule
      // derives them, so a rule written by this path and one written by that path
      // cannot disagree about the same fee.
      const feeType = rule.percentageFee > 0 ? "PERCENTAGE" : rule.flatFee > 0 ? "FIXED" : "FREE";
      const feeValue = rule.percentageFee > 0 ? rule.percentageFee : rule.flatFee;
      const { rowCount } = await pool.query(
        `INSERT INTO pricing_rules
          (id, service_code, service_name, fee_type, fee_value, flat_fee, percentage_fee,
           minimum_fee, maximum_fee, vat_percentage, enabled, active, effective_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, TRUE, TRUE, CURRENT_DATE)
         ON CONFLICT (service_code)
         DO UPDATE SET
           service_name    = EXCLUDED.service_name,
           fee_type        = EXCLUDED.fee_type,
           fee_value       = EXCLUDED.fee_value,
           flat_fee        = EXCLUDED.flat_fee,
           percentage_fee  = EXCLUDED.percentage_fee,
           minimum_fee     = EXCLUDED.minimum_fee,
           maximum_fee     = EXCLUDED.maximum_fee,
           vat_percentage  = 0,
           enabled         = TRUE,
           active          = TRUE,
           updated_at      = NOW()`,
        [uuidv4(), rule.serviceCode, rule.serviceName, feeType, feeValue,
          rule.flatFee, rule.percentageFee, rule.minimumFee, rule.maximumFee]
      );
      written += rowCount;
    }

    await pool.query(
      "INSERT INTO platform_settings (key, value) VALUES ($1, $2::JSONB) ON CONFLICT (key) DO NOTHING",
      [APPROVED_SCHEDULE_FIXUP_KEY,
        JSON.stringify({ appliedAt: new Date().toISOString(), rulesWritten: written })]
    );
    console.info("[pricing] approved schedule applied", { rulesWritten: written });
    return { skipped: false, rulesWritten: written };
  } catch (error) {
    console.error("[pricing] could not apply the approved schedule", { message: error.message });
    return { skipped: false, error: error.message };
  }
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
  // A hardcoded R0.50 floor for qr_payment used to sit here. It was written when
  // the QR fee WAS R0.50 and it silently overrode anything an operator
  // configured below that. The schedule now carries a flat R1.50 on the
  // customer side, and a floor belongs in minimum_fee where an admin can see
  // and change it.
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
  applyQrPricingFixupOnce,
  applyApprovedScheduleFixupOnce,
  APPROVED_SCHEDULE_FIXUP_KEY,
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
