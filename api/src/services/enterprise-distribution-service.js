"use strict";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { calculateFee, ensureDefaultPricingRule } = require("./pricing-service");
const { createNotification, deliverSms, markNotification } = require("./notification-service");

const APPROVED_STATUSES = new Set(["approved", "verified", "complete"]);
const APPLICATION_ACTIONS = new Map([
  ["approve", "approved"],
  ["reject", "rejected"],
  ["suspend", "suspended"],
  ["revoke", "revoked"],
  ["review", "under_review"]
]);

const DISTRIBUTION_TYPES = [
  "student_allowance",
  "accommodation",
  "living_allowance",
  "transport",
  "books",
  "meals",
  "payroll",
  "salary",
  "bonus",
  "commission",
  "vendor_payment",
  "scholarship",
  "grant",
  "rental",
  "landlord",
  "insurance",
  "refund",
  "emergency_relief",
  "custom"
];

let schemaReadyPromise = null;

function cleanText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function money(value) {
  const normalized = String(value || 0).replace(/[^0-9.-]/g, "");
  const amount = Number(normalized || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function normalizeDistributionType(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return DISTRIBUTION_TYPES.includes(normalized) ? normalized : "custom";
}

function orgCode() {
  return `EBD${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function normalizeRow(row = {}) {
  return {
    uniqueBeneficiaryId: cleanText(row.uniqueBeneficiaryId || row.unique_beneficiary_id || row.beneficiaryId || row.beneficiary_id, 120),
    beneficiaryNumber: cleanText(row.beneficiaryNumber || row.beneficiary_number || row.studentNumber || row.employeeNumber || row.tenantNumber, 120),
    firstName: cleanText(row.firstName || row.first_name || row.name, 120),
    surname: cleanText(row.surname || row.lastName || row.last_name, 120),
    idNumber: cleanText(row.idNumber || row.id_number, 40),
    passportNumber: cleanText(row.passportNumber || row.passport_number, 60),
    phone: cleanText(row.phone || row.phoneNumber || row.mobile || row.cellphone, 40),
    email: cleanText(row.email, 160).toLowerCase(),
    walletNumber: cleanText(row.walletNumber || row.wallet_number || row.walletId || row.wallet_id, 30),
    bankName: cleanText(row.bankName || row.bank_name, 120),
    branchCode: cleanText(row.branchCode || row.branch_code, 20),
    accountNumber: cleanText(row.accountNumber || row.account_number, 40),
    accountType: cleanText(row.accountType || row.account_type, 40),
    preferredPaymentMethod: cleanText(row.preferredPaymentMethod || row.preferred_payment_method || "wallet", 40).toLowerCase(),
    amount: money(row.amount),
    currency: cleanText(row.currency || "ZAR", 10).toUpperCase(),
    reference: cleanText(row.reference, 120),
    description: cleanText(row.description, 240),
    raw: row
  };
}

function parseCsv(csvText = "") {
  const lines = String(csvText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return headers.reduce((row, header, index) => {
      row[header] = values[index] ? values[index].trim() : "";
      return row;
    }, {});
  });
}

async function ensureEnterpriseDistributionSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS enterprise_distribution_applications (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
          organisation_name TEXT NOT NULL,
          registration_number TEXT,
          institution_type TEXT,
          funding_purpose TEXT,
          expected_monthly_volume NUMERIC(18,2) NOT NULL DEFAULT 0,
          expected_beneficiaries INTEGER NOT NULL DEFAULT 0,
          funding_source TEXT,
          bank_verification JSONB NOT NULL DEFAULT '{}'::JSONB,
          compliance_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
          supporting_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
          risk_assessment JSONB NOT NULL DEFAULT '{}'::JSONB,
          status TEXT NOT NULL DEFAULT 'submitted',
          admin_note TEXT,
          reviewed_by UUID,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_eda_user_status ON enterprise_distribution_applications (user_id, status);
        CREATE INDEX IF NOT EXISTS idx_eda_status_created ON enterprise_distribution_applications (status, created_at DESC);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_organisations (
          id UUID PRIMARY KEY,
          application_id UUID REFERENCES enterprise_distribution_applications(id) ON DELETE SET NULL,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
          organisation_code TEXT NOT NULL UNIQUE,
          organisation_name TEXT NOT NULL,
          registration_number TEXT,
          institution_type TEXT,
          licence_status TEXT NOT NULL DEFAULT 'active',
          status TEXT NOT NULL DEFAULT 'active',
          risk_rating TEXT NOT NULL DEFAULT 'medium',
          approved_by UUID,
          approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          suspended_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          settings JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edo_user_active ON enterprise_distribution_organisations (user_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_edo_status ON enterprise_distribution_organisations (status, licence_status);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_beneficiaries (
          id UUID PRIMARY KEY,
          organisation_id UUID NOT NULL REFERENCES enterprise_distribution_organisations(id) ON DELETE CASCADE,
          unique_beneficiary_id TEXT,
          beneficiary_number TEXT,
          first_name TEXT,
          surname TEXT,
          id_number TEXT,
          passport_number TEXT,
          phone TEXT,
          email TEXT,
          wallet_number TEXT,
          bank_name TEXT,
          branch_code TEXT,
          account_number TEXT,
          account_type TEXT,
          preferred_payment_method TEXT NOT NULL DEFAULT 'wallet',
          status TEXT NOT NULL DEFAULT 'active',
          risk_score NUMERIC(8,2) NOT NULL DEFAULT 0,
          notes TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edb_org_unique_beneficiary ON enterprise_distribution_beneficiaries (organisation_id, unique_beneficiary_id) WHERE unique_beneficiary_id IS NOT NULL AND unique_beneficiary_id <> '';
        CREATE INDEX IF NOT EXISTS idx_edb_search ON enterprise_distribution_beneficiaries (organisation_id, status, created_at DESC);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_batches (
          id UUID PRIMARY KEY,
          organisation_id UUID NOT NULL REFERENCES enterprise_distribution_organisations(id) ON DELETE CASCADE,
          funding_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
          batch_reference TEXT NOT NULL UNIQUE,
          batch_name TEXT NOT NULL,
          distribution_type TEXT NOT NULL DEFAULT 'custom',
          funding_source TEXT,
          funding_period TEXT,
          payment_date DATE,
          currency TEXT NOT NULL DEFAULT 'ZAR',
          status TEXT NOT NULL DEFAULT 'draft',
          expected_total NUMERIC(18,2) NOT NULL DEFAULT 0,
          valid_total NUMERIC(18,2) NOT NULL DEFAULT 0,
          invalid_total NUMERIC(18,2) NOT NULL DEFAULT 0,
          fee_total NUMERIC(18,2) NOT NULL DEFAULT 0,
          locked_total NUMERIC(18,2) NOT NULL DEFAULT 0,
          total_rows INTEGER NOT NULL DEFAULT 0,
          valid_rows INTEGER NOT NULL DEFAULT 0,
          invalid_rows INTEGER NOT NULL DEFAULT 0,
          processed_rows INTEGER NOT NULL DEFAULT 0,
          failed_rows INTEGER NOT NULL DEFAULT 0,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          released_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
          released_at TIMESTAMPTZ,
          processing_started_at TIMESTAMPTZ,
          processing_completed_at TIMESTAMPTZ,
          approval_chain JSONB NOT NULL DEFAULT '[]'::JSONB,
          validation_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS funding_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS fee_total NUMERIC(18,2) NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS locked_total NUMERIC(18,2) NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS processed_rows INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS failed_rows INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS released_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
        ALTER TABLE enterprise_distribution_batches ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS idx_edbatch_org_status ON enterprise_distribution_batches (organisation_id, status, created_at DESC);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_batch_items (
          id UUID PRIMARY KEY,
          batch_id UUID NOT NULL REFERENCES enterprise_distribution_batches(id) ON DELETE CASCADE,
          beneficiary_id UUID REFERENCES enterprise_distribution_beneficiaries(id) ON DELETE SET NULL,
          recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
          row_number INTEGER NOT NULL,
          unique_beneficiary_id TEXT,
          beneficiary_number TEXT,
          beneficiary_name TEXT,
          phone TEXT,
          email TEXT,
          wallet_number TEXT,
          preferred_payment_method TEXT NOT NULL DEFAULT 'wallet',
          amount NUMERIC(18,2) NOT NULL DEFAULT 0,
          fee NUMERIC(18,2) NOT NULL DEFAULT 0,
          total NUMERIC(18,2) NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'ZAR',
          reference TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'valid',
          validation_errors JSONB NOT NULL DEFAULT '[]'::JSONB,
          provider_response JSONB NOT NULL DEFAULT '{}'::JSONB,
          delivery_status TEXT NOT NULL DEFAULT 'queued',
          raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS fee NUMERIC(18,2) NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS total NUMERIC(18,2) NOT NULL DEFAULT 0;
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS provider_response JSONB NOT NULL DEFAULT '{}'::JSONB;
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'queued';
        ALTER TABLE enterprise_distribution_batch_items ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS idx_editem_batch_status ON enterprise_distribution_batch_items (batch_id, status);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_payouts (
          id UUID PRIMARY KEY,
          organisation_id UUID NOT NULL REFERENCES enterprise_distribution_organisations(id) ON DELETE CASCADE,
          batch_id UUID NOT NULL REFERENCES enterprise_distribution_batches(id) ON DELETE CASCADE,
          item_id UUID NOT NULL REFERENCES enterprise_distribution_batch_items(id) ON DELETE CASCADE,
          transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
          recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          payout_reference TEXT NOT NULL UNIQUE,
          payment_method TEXT NOT NULL,
          amount NUMERIC(18,2) NOT NULL DEFAULT 0,
          fee NUMERIC(18,2) NOT NULL DEFAULT 0,
          total NUMERIC(18,2) NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          provider TEXT,
          provider_response JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_edpayout_batch_status ON enterprise_distribution_payouts (batch_id, status, created_at DESC);

        CREATE TABLE IF NOT EXISTS enterprise_distribution_audit_logs (
          id UUID PRIMARY KEY,
          organisation_id UUID REFERENCES enterprise_distribution_organisations(id) ON DELETE SET NULL,
          actor_type TEXT NOT NULL,
          actor_id UUID,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id UUID,
          previous_value JSONB,
          new_value JSONB,
          reason TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_edaudit_org_created ON enterprise_distribution_audit_logs (organisation_id, created_at DESC);
      `);
      await ensureDefaultPricingRule("bulk_distribution_batch_fee");
      await ensureDefaultPricingRule("bulk_distribution_wallet_payout");
      await ensureDefaultPricingRule("bulk_distribution_bank_payout");
      await ensureDefaultPricingRule("bulk_distribution_failed_item_fee");
      await ensureDefaultPricingRule("bulk_distribution_reversal_fee");
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

async function audit({ organisationId = null, actorType = "customer", actorId = null, action, targetType = null, targetId = null, previousValue = null, newValue = null, reason = "", ipAddress = null, userAgent = null }) {
  await pool.query(
    `INSERT INTO enterprise_distribution_audit_logs
      (id, organisation_id, actor_type, actor_id, action, target_type, target_id, previous_value, new_value, reason, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB,$9::JSONB,$10,$11,$12)`,
    [uuidv4(), organisationId, actorType, actorId, action, targetType, targetId, previousValue ? JSON.stringify(previousValue) : null, newValue ? JSON.stringify(newValue) : null, reason, ipAddress, userAgent]
  ).catch((error) => console.error("[enterprise-distribution-audit-failed]", { action, message: error.message }));
}

function payoutReference(prefix = "EBDP") {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function loadBusinessWalletForUpdate(client, userId) {
  const { rows } = await client.query(
    `SELECT *
     FROM wallets
     WHERE user_id = $1 AND kind IN ('business', 'merchant', 'personal') AND status = 'active'
     ORDER BY CASE WHEN kind = 'business' THEN 0 WHEN kind = 'merchant' THEN 1 ELSE 2 END, created_at ASC
     LIMIT 1
     FOR UPDATE`,
    [userId]
  );
  return rows[0] || null;
}

async function loadRevenueWalletForUpdate(client) {
  const { rows } = await client.query(
    `SELECT *
     FROM wallets
     WHERE user_id IS NULL AND kind = 'revenue' AND status = 'active'
     LIMIT 1
     FOR UPDATE`
  );
  return rows[0] || null;
}

async function calculateItemFunding(item = {}) {
  const serviceCode = "bulk_distribution_wallet_payout";
  const fee = await calculateFee(serviceCode, Number(item.amount || 0));
  return {
    serviceCode,
    amount: money(item.amount),
    fee: money(fee.fee || 0),
    total: money(Number(item.amount || 0) + Number(fee.fee || 0))
  };
}

async function notifyPayoutRecipient({ itemId, user, amount, reference, organisationName }) {
  if (!user?.id) return;
  const title = "TitoPay payment received";
  const body = `You received R${money(amount).toFixed(2)} from ${organisationName}. Reference: ${reference}.`;
  const metadata = { purpose: "enterprise_distribution_payout", itemId, reference };
  const notificationId = await createNotification({
    user: { ...user, user_type: "customer" },
    channel: "in_app",
    notificationType: "enterprise_distribution_payout",
    title,
    body,
    provider: "titopay",
    metadata
  });
  await markNotification(notificationId, "sent", null, { deliveredInApp: true });
  if (user.phone) {
    const smsNotificationId = await createNotification({
      user: { ...user, user_type: "customer" },
      channel: "sms",
      notificationType: "enterprise_distribution_payout",
      title,
      body,
      provider: "sms",
      metadata
    });
    try {
      const result = await deliverSms({ to: user.phone, body, metadata });
      await markNotification(smsNotificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
      await pool.query("UPDATE enterprise_distribution_batch_items SET delivery_status = 'sent' WHERE id = $1", [itemId]);
    } catch (error) {
      await markNotification(smsNotificationId, "failed", null, { error: error.message });
      await pool.query("UPDATE enterprise_distribution_batch_items SET delivery_status = 'failed' WHERE id = $1", [itemId]);
    }
  }
}

async function businessSnapshot(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.account_type, u.full_name, u.username, u.email, u.phone, u.status AS user_status,
            u.profile_locked, u.fica_status, m.id AS merchant_uuid, m.business_name, m.merchant_id,
            m.status AS merchant_status, m.verification_status AS merchant_verification_status,
            w.id AS wallet_id, w.wallet_number, w.status AS wallet_status
     FROM users u
     LEFT JOIN merchants m ON m.user_id = u.id
     LEFT JOIN wallets w ON w.user_id = u.id AND w.kind = 'business'
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function activeOrganisationForUser(userId) {
  await ensureEnterpriseDistributionSchema();
  const { rows } = await pool.query(
    `SELECT * FROM enterprise_distribution_organisations
     WHERE user_id = $1 AND status = 'active' AND licence_status = 'active'
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getEligibility(userId) {
  await ensureEnterpriseDistributionSchema();
  const business = await businessSnapshot(userId);
  if (!business) throw new AppError(404, "TitoPay account not found");
  const organisation = await activeOrganisationForUser(userId);
  const blockers = [];
  if (business.account_type !== "business") blockers.push("Only approved TitoPay Business accounts can use Bulk Distribution.");
  if (business.user_status !== "active") blockers.push("Business account must be active.");
  if (business.profile_locked) blockers.push("Business profile is locked.");
  if (!APPROVED_STATUSES.has(String(business.fica_status || "").toLowerCase())) blockers.push("Business FICA must be approved.");
  if (!business.merchant_uuid) blockers.push("Merchant profile is required.");
  if (business.merchant_uuid && business.merchant_status !== "active") blockers.push("Merchant profile must be active.");
  if (business.merchant_uuid && !APPROVED_STATUSES.has(String(business.merchant_verification_status || "").toLowerCase())) blockers.push("Merchant verification must be approved.");
  if (!business.wallet_id || business.wallet_status !== "active") blockers.push("Active business wallet is required.");
  if (!organisation) blockers.push("Enterprise Bulk Distribution licence is not active.");

  return {
    eligible: blockers.length === 0,
    approved: Boolean(organisation),
    blockers,
    organisation,
    business
  };
}

async function submitApplication(userId, payload = {}, meta = {}) {
  await ensureEnterpriseDistributionSchema();
  const business = await businessSnapshot(userId);
  if (!business) throw new AppError(404, "TitoPay account not found");
  if (business.account_type !== "business") throw new AppError(403, "Only TitoPay Business accounts can apply for Bulk Distribution");
  const organisationName = boundedText(payload.organisationName || payload.organisation_name || business.business_name || business.full_name, "Organisation name", { min: 2, max: 180 });
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO enterprise_distribution_applications
      (id, user_id, merchant_id, organisation_name, registration_number, institution_type, funding_purpose,
       expected_monthly_volume, expected_beneficiaries, funding_source, bank_verification, compliance_documents,
       supporting_documents, risk_assessment, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12::JSONB,$13::JSONB,$14::JSONB,'submitted')
     RETURNING *`,
    [
      id,
      userId,
      business.merchant_uuid || null,
      organisationName,
      cleanText(payload.registrationNumber || payload.registration_number, 80),
      cleanText(payload.institutionType || payload.institution_type, 80),
      cleanText(payload.fundingPurpose || payload.funding_purpose, 500),
      money(payload.expectedMonthlyVolume || payload.expected_monthly_volume),
      Math.max(0, Number(payload.expectedBeneficiaries || payload.expected_beneficiaries || 0)),
      cleanText(payload.fundingSource || payload.funding_source, 120),
      JSON.stringify(payload.bankVerification || payload.bank_verification || {}),
      JSON.stringify(payload.complianceDocuments || payload.compliance_documents || []),
      JSON.stringify(payload.supportingDocuments || payload.supporting_documents || []),
      JSON.stringify(payload.riskAssessment || payload.risk_assessment || {})
    ]
  );
  await audit({ actorId: userId, action: "enterprise_distribution_application_submitted", targetType: "application", targetId: id, newValue: rows[0], ...meta });
  return rows[0];
}

async function listApplications(status = "") {
  await ensureEnterpriseDistributionSchema();
  const values = [];
  let where = "";
  if (status) {
    values.push(cleanText(status, 40));
    where = "WHERE a.status = $1";
  }
  const { rows } = await pool.query(
    `SELECT a.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, m.business_name
     FROM enterprise_distribution_applications a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN merchants m ON m.id = a.merchant_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT 300`,
    values
  );
  return rows;
}

async function listOrganisations() {
  await ensureEnterpriseDistributionSchema();
  const { rows } = await pool.query(
    `SELECT o.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, m.business_name
     FROM enterprise_distribution_organisations o
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN merchants m ON m.id = o.merchant_id
     ORDER BY o.created_at DESC
     LIMIT 300`
  );
  return rows;
}

async function transitionApplication(applicationId, payload = {}, actor, meta = {}) {
  await ensureEnterpriseDistributionSchema();
  const action = cleanText(payload.action || "review", 40).toLowerCase();
  const nextStatus = APPLICATION_ACTIONS.get(action);
  if (!nextStatus) throw new AppError(400, "Unsupported application action");
  const note = cleanText(payload.note || payload.reason, 1000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: appRows } = await client.query("SELECT * FROM enterprise_distribution_applications WHERE id = $1 FOR UPDATE", [applicationId]);
    const application = appRows[0];
    if (!application) throw new AppError(404, "Application not found");
    const { rows: updatedRows } = await client.query(
      `UPDATE enterprise_distribution_applications
       SET status = $2, admin_note = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [applicationId, nextStatus, note, actor.userId || null]
    );
    let organisation = null;
    if (nextStatus === "approved") {
      const { rows: orgRows } = await client.query(
        `INSERT INTO enterprise_distribution_organisations
          (id, application_id, user_id, merchant_id, organisation_code, organisation_name, registration_number, institution_type, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) WHERE status = 'active'
         DO UPDATE SET licence_status = 'active', revoked_at = NULL, suspended_at = NULL, updated_at = NOW()
         RETURNING *`,
        [uuidv4(), application.id, application.user_id, application.merchant_id, orgCode(), application.organisation_name, application.registration_number, application.institution_type, actor.userId || null]
      );
      organisation = orgRows[0];
    }
    if (["suspended", "revoked"].includes(nextStatus)) {
      const { rows: orgRows } = await client.query(
        `UPDATE enterprise_distribution_organisations
         SET licence_status = $2, status = CASE WHEN $2 = 'revoked' THEN 'revoked' ELSE status END,
             suspended_at = CASE WHEN $2 = 'suspended' THEN NOW() ELSE suspended_at END,
             revoked_at = CASE WHEN $2 = 'revoked' THEN NOW() ELSE revoked_at END,
             updated_at = NOW()
         WHERE application_id = $1 OR user_id = (SELECT user_id FROM enterprise_distribution_applications WHERE id = $1)
         RETURNING *`,
        [applicationId, nextStatus]
      );
      organisation = orgRows[0] || null;
    }
    await client.query("COMMIT");
    await audit({ organisationId: organisation?.id || null, actorType: "admin", actorId: actor.userId, action: `enterprise_distribution_application_${action}`, targetType: "application", targetId: applicationId, previousValue: application, newValue: updatedRows[0], reason: note, ...meta });
    return { application: updatedRows[0], organisation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireOrganisation(userId) {
  const organisation = await activeOrganisationForUser(userId);
  if (!organisation) throw new AppError(403, "Enterprise Bulk Distribution is not active for this organisation");
  return organisation;
}

async function listBeneficiaries(userId, search = "") {
  const organisation = await requireOrganisation(userId);
  const values = [organisation.id];
  let where = "WHERE organisation_id = $1";
  if (search) {
    values.push(`%${String(search).toLowerCase()}%`);
    where += ` AND LOWER(CONCAT_WS(' ', unique_beneficiary_id, beneficiary_number, first_name, surname, phone, email, wallet_number)) LIKE $2`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM enterprise_distribution_beneficiaries ${where} ORDER BY created_at DESC LIMIT 500`,
    values
  );
  return { organisation, items: rows };
}

async function upsertBeneficiary(userId, payload = {}, meta = {}) {
  const organisation = await requireOrganisation(userId);
  const row = normalizeRow(payload);
  if (!row.uniqueBeneficiaryId && !row.beneficiaryNumber) throw new AppError(400, "Unique beneficiary ID or beneficiary number is required");
  if (!row.firstName && !row.surname) throw new AppError(400, "Beneficiary name is required");
  const id = payload.id || uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO enterprise_distribution_beneficiaries
      (id, organisation_id, unique_beneficiary_id, beneficiary_number, first_name, surname, id_number, passport_number,
       phone, email, wallet_number, bank_name, branch_code, account_number, account_type, preferred_payment_method, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::JSONB)
     ON CONFLICT (organisation_id, unique_beneficiary_id) WHERE unique_beneficiary_id IS NOT NULL AND unique_beneficiary_id <> ''
     DO UPDATE SET beneficiary_number = EXCLUDED.beneficiary_number, first_name = EXCLUDED.first_name, surname = EXCLUDED.surname,
       id_number = EXCLUDED.id_number, passport_number = EXCLUDED.passport_number, phone = EXCLUDED.phone, email = EXCLUDED.email,
       wallet_number = EXCLUDED.wallet_number, bank_name = EXCLUDED.bank_name, branch_code = EXCLUDED.branch_code,
       account_number = EXCLUDED.account_number, account_type = EXCLUDED.account_type,
       preferred_payment_method = EXCLUDED.preferred_payment_method, metadata = EXCLUDED.metadata, updated_at = NOW()
     RETURNING *`,
    [id, organisation.id, row.uniqueBeneficiaryId, row.beneficiaryNumber, row.firstName, row.surname, row.idNumber, row.passportNumber, row.phone, row.email, row.walletNumber, row.bankName, row.branchCode, row.accountNumber, row.accountType, row.preferredPaymentMethod, JSON.stringify(row.raw || {})]
  );
  await audit({ organisationId: organisation.id, actorId: userId, action: "enterprise_distribution_beneficiary_saved", targetType: "beneficiary", targetId: rows[0].id, newValue: rows[0], ...meta });
  return rows[0];
}

async function validateRows(rows = [], organisationId) {
  const seen = new Set();
  const normalizedRows = rows.map(normalizeRow);
  const walletNumbers = normalizedRows.map((row) => row.walletNumber).filter(Boolean);
  const walletSet = new Set();
  if (walletNumbers.length) {
    const { rows: walletRows } = await pool.query(
      // kind <> 'system': a TitoKids child wallet must not validate as a
      // disbursement recipient, even one carrying a legacy number. Money
      // reaches a child through the TitoKids flow or not at all.
      "SELECT wallet_number FROM wallets WHERE wallet_number = ANY($1::TEXT[]) AND status = 'active' AND kind <> 'system'", [walletNumbers]);
    walletRows.forEach((row) => walletSet.add(String(row.wallet_number)));
  }
  return normalizedRows.map((row, index) => {
    const errors = [];
    const identity = row.uniqueBeneficiaryId || row.beneficiaryNumber || row.walletNumber || row.phone || row.email;
    if (!identity) errors.push("Beneficiary identifier is required");
    if (identity && seen.has(identity)) errors.push("Duplicate beneficiary in this batch");
    if (identity) seen.add(identity);
    if (row.amount <= 0) errors.push("Amount must be greater than zero");
    if (row.currency !== "ZAR") errors.push("Only ZAR is supported in Phase 1");
    if (!["wallet", "bank", "voucher", "virtual_card"].includes(row.preferredPaymentMethod)) errors.push("Preferred payment method is invalid");
    if (row.preferredPaymentMethod === "wallet" && !row.walletNumber) errors.push("Wallet number is required for wallet payouts");
    if (row.preferredPaymentMethod === "wallet" && row.walletNumber && !walletSet.has(row.walletNumber)) errors.push("Active TitoPay wallet was not found");
    if (row.preferredPaymentMethod === "bank" && (!row.bankName || !row.branchCode || !row.accountNumber)) errors.push("Bank details are required for bank payouts");
    return { rowNumber: index + 1, row, errors, status: errors.length ? "invalid" : "valid" };
  });
}

async function createBatch(userId, payload = {}, meta = {}) {
  const organisation = await requireOrganisation(userId);
  const rows = Array.isArray(payload.rows) ? payload.rows : parseCsv(payload.csv || payload.csvText || "");
  if (!rows.length) throw new AppError(400, "At least one beneficiary row is required");
  if (rows.length > 100000) throw new AppError(400, "Batch exceeds the 100,000 row Phase 1 limit");
  const batchId = uuidv4();
  const batchReference = `EBD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const validation = await validateRows(rows, organisation.id);
  const validItems = validation.filter((item) => item.status === "valid");
  const invalidItems = validation.filter((item) => item.status === "invalid");
  const expectedTotal = money(validation.reduce((sum, item) => sum + item.row.amount, 0));
  const validTotal = money(validItems.reduce((sum, item) => sum + item.row.amount, 0));
  const status = invalidItems.length ? "draft_validation_failed" : "draft_validated";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: batchRows } = await client.query(
      `INSERT INTO enterprise_distribution_batches
        (id, organisation_id, batch_reference, batch_name, distribution_type, funding_source, funding_period, payment_date,
         currency, status, expected_total, valid_total, invalid_total, total_rows, valid_rows, invalid_rows, created_by, validation_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::JSONB)
       RETURNING *`,
      [
        batchId,
        organisation.id,
        batchReference,
        boundedText(payload.batchName || payload.batch_name || "Bulk distribution batch", "Batch name", { min: 2, max: 180 }),
        normalizeDistributionType(payload.distributionType || payload.distribution_type),
        cleanText(payload.fundingSource || payload.funding_source, 120),
        cleanText(payload.fundingPeriod || payload.funding_period, 80),
        payload.paymentDate || payload.payment_date || null,
        "ZAR",
        status,
        expectedTotal,
        validTotal,
        money(expectedTotal - validTotal),
        validation.length,
        validItems.length,
        invalidItems.length,
        userId,
        JSON.stringify({ invalidRows: invalidItems.length, validRows: validItems.length, phase: 1 })
      ]
    );
    for (const item of validation) {
      await client.query(
        `INSERT INTO enterprise_distribution_batch_items
          (id, batch_id, row_number, unique_beneficiary_id, beneficiary_number, beneficiary_name, phone, email, wallet_number,
           preferred_payment_method, amount, currency, reference, description, status, validation_errors, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::JSONB,$17::JSONB)`,
        [
          uuidv4(),
          batchId,
          item.rowNumber,
          item.row.uniqueBeneficiaryId,
          item.row.beneficiaryNumber,
          `${item.row.firstName} ${item.row.surname}`.trim(),
          item.row.phone,
          item.row.email,
          item.row.walletNumber,
          item.row.preferredPaymentMethod,
          item.row.amount,
          item.row.currency,
          item.row.reference,
          item.row.description,
          item.status,
          JSON.stringify(item.errors),
          JSON.stringify(item.row.raw || {})
        ]
      );
    }
    await client.query("COMMIT");
    await audit({ organisationId: organisation.id, actorId: userId, action: "enterprise_distribution_batch_created", targetType: "batch", targetId: batchId, newValue: batchRows[0], ...meta });
    return { batch: batchRows[0], validationReport: validation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockBatchFunding(userId, batchId, meta = {}) {
  const organisation = await requireOrganisation(userId);
  const client = await pool.connect();
  const fundingTransactionId = uuidv4();
  const reference = payoutReference("EBDF");
  try {
    await client.query("BEGIN");
    const { rows: batchRows } = await client.query(
      `SELECT *
       FROM enterprise_distribution_batches
       WHERE id = $1 AND organisation_id = $2
       FOR UPDATE`,
      [batchId, organisation.id]
    );
    const batch = batchRows[0];
    if (!batch) throw new AppError(404, "Batch not found");
    if (batch.status === "funding_locked") {
      await client.query("COMMIT");
      return batch;
    }
    if (batch.status !== "draft_validated") {
      throw new AppError(409, "Only validated draft batches can be funded");
    }
    const { rows: allItems } = await client.query(
      `SELECT *
       FROM enterprise_distribution_batch_items
       WHERE batch_id = $1 AND status = 'valid'
       ORDER BY row_number ASC
       FOR UPDATE`,
      [batchId]
    );
    const items = allItems.filter((item) => item.preferred_payment_method === "wallet");
    const payoutServiceItems = allItems.filter((item) => item.preferred_payment_method !== "wallet");
    if (payoutServiceItems.length) {
      await client.query(
        `UPDATE enterprise_distribution_batch_items
         SET status = 'payout_service_required',
             fee = 0,
             total = amount,
             provider_response = $2::JSONB,
             processed_at = NOW()
         WHERE batch_id = $1
           AND status = 'valid'
           AND preferred_payment_method <> 'wallet'`,
        [batchId, JSON.stringify({ message: "Use TitoPay Withdraw/Payouts for non-wallet beneficiary payouts." })]
      );
    }
    if (!items.length) throw new AppError(400, "No valid TitoPay wallet payout rows found. Use the existing TitoPay Withdraw/Payout service for bank payouts.");

    let feeTotal = 0;
    let payoutTotal = 0;
    for (const item of items) {
      const funding = await calculateItemFunding(item);
      feeTotal = money(feeTotal + funding.fee);
      payoutTotal = money(payoutTotal + funding.amount);
      await client.query(
        `UPDATE enterprise_distribution_batch_items
         SET fee = $2, total = $3
         WHERE id = $1`,
        [item.id, funding.fee, funding.total]
      );
    }
    const batchFee = await calculateFee("bulk_distribution_batch_fee", payoutTotal);
    feeTotal = money(feeTotal + Number(batchFee.fee || 0));
    const lockedTotal = money(payoutTotal + feeTotal);

    const businessWallet = await loadBusinessWalletForUpdate(client, organisation.user_id);
    if (!businessWallet) throw new AppError(404, "Business wallet not found");
    if (Number(businessWallet.available_balance || 0) < lockedTotal) throw new AppError(400, "Insufficient business wallet balance to lock this batch");
    const { rows: walletRows } = await client.query(
      `UPDATE wallets
       SET available_balance = available_balance - $2,
           reserved_balance = reserved_balance + $2,
           updated_at = NOW()
       WHERE id = $1 AND available_balance >= $2
       RETURNING available_balance, reserved_balance`,
      [businessWallet.id, lockedTotal]
    );
    if (!walletRows[0]) throw new AppError(400, "Insufficient business wallet balance to lock this batch");

    await client.query(
      `INSERT INTO transactions
        (id, user_id, wallet_id, merchant_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,$4,'bulk_distribution_batch_fee',$5,$6,$7,'reserved','debit',$8,$9,$10::JSONB)`,
      [
        fundingTransactionId,
        organisation.user_id,
        businessWallet.id,
        organisation.merchant_id || null,
        payoutTotal,
        feeTotal,
        lockedTotal,
        reference,
        batch.batch_reference,
        JSON.stringify({ batchId, organisationId: organisation.id, phase: 2, fundingLock: true })
      ]
    );
    await client.query(
      `INSERT INTO wallet_ledger
        (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'reserve',$4,$5,$6,$7::JSONB)`,
      [uuidv4(), businessWallet.id, fundingTransactionId, lockedTotal, walletRows[0].available_balance, reference, JSON.stringify({ batchId, organisationId: organisation.id })]
    );
    const { rows: updatedRows } = await client.query(
      `UPDATE enterprise_distribution_batches
       SET status = 'funding_locked',
           funding_transaction_id = $2,
           fee_total = $3,
           locked_total = $4,
           validation_summary = validation_summary || $5::JSONB,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [batchId, fundingTransactionId, feeTotal, lockedTotal, JSON.stringify({ batchFee: Number(batchFee.fee || 0), fundedAt: new Date().toISOString() })]
    );
    await client.query("COMMIT");
    await audit({ organisationId: organisation.id, actorId: userId, action: "enterprise_distribution_batch_funding_locked", targetType: "batch", targetId: batchId, newValue: updatedRows[0], ...meta });
    return updatedRows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function releaseBatch(batchId, actor, meta = {}) {
  await ensureEnterpriseDistributionSchema();
  const client = await pool.connect();
  const notifications = [];
  let releasedBatch = null;
  try {
    await client.query("BEGIN");
    const { rows: batchRows } = await client.query(
      `SELECT b.*, o.user_id AS business_user_id, o.merchant_id, o.organisation_name, o.id AS organisation_id
       FROM enterprise_distribution_batches b
       JOIN enterprise_distribution_organisations o ON o.id = b.organisation_id
       WHERE b.id = $1
       FOR UPDATE`,
      [batchId]
    );
    const batch = batchRows[0];
    if (!batch) throw new AppError(404, "Batch not found");
    if (batch.status === "completed") {
      await client.query("COMMIT");
      return batch;
    }
    if (batch.status !== "funding_locked") {
      throw new AppError(409, "Batch funding must be locked before release");
    }

    const businessWallet = await loadBusinessWalletForUpdate(client, batch.business_user_id);
    if (!businessWallet) throw new AppError(404, "Business wallet not found");
    const revenueWallet = Number(batch.fee_total || 0) > 0 ? await loadRevenueWalletForUpdate(client) : null;
    if (Number(batch.fee_total || 0) > 0 && !revenueWallet) throw new AppError(500, "TitoPay revenue wallet is not configured");
    const batchFee = money(batch.validation_summary?.batchFee || 0);

    const { rows: items } = await client.query(
      `SELECT *
       FROM enterprise_distribution_batch_items
       WHERE batch_id = $1 AND status = 'valid'
       ORDER BY row_number ASC
       FOR UPDATE`,
      [batchId]
    );
    let processed = 0;
    let failed = 0;
    let providerPending = 0;
    let reservedReleased = 0;
    let feesCollected = 0;

    for (const item of items) {
      const funding = await calculateItemFunding(item);
      const total = money(Number(item.total || 0) || funding.total);
      const fee = money(Number(item.fee || 0) || funding.fee);
      const txId = uuidv4();
      const payoutRef = payoutReference();
      if (item.preferred_payment_method !== "wallet") {
        providerPending += 1;
        await client.query(
          `UPDATE wallets
           SET reserved_balance = reserved_balance - $2,
               available_balance = available_balance + $2,
               updated_at = NOW()
           WHERE id = $1 AND reserved_balance >= $2`,
          [businessWallet.id, total]
        );
        await client.query(
          `INSERT INTO wallet_ledger
            (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
           VALUES ($1,$2,$3,'release',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
          [uuidv4(), businessWallet.id, batch.funding_transaction_id, total, payoutRef, JSON.stringify({ batchId, itemId: item.id, reason: "use_existing_titopay_payout_service" })]
        );
        await client.query(
          `UPDATE enterprise_distribution_batch_items
           SET status = 'payout_service_required',
               fee = $2,
               total = $3,
               provider_response = $4::JSONB,
               processed_at = NOW()
           WHERE id = $1`,
          [item.id, 0, item.amount, JSON.stringify({ message: "Use TitoPay Withdraw/Payouts for this beneficiary." })]
        );
        continue;
      }

      const { rows: recipientRows } = await client.query(
        `SELECT w.*, u.id AS recipient_user_id, u.full_name, u.phone, u.email
         FROM wallets w
         JOIN users u ON u.id = w.user_id
         WHERE w.wallet_number = $1 AND w.status = 'active'
           AND w.kind <> 'system'
         ORDER BY w.created_at ASC
         LIMIT 1
         FOR UPDATE OF w`,
        [item.wallet_number]
      );
      const recipient = recipientRows[0];
      if (!recipient) {
        failed += 1;
        await client.query(
          `UPDATE wallets
           SET reserved_balance = reserved_balance - $2,
               available_balance = available_balance + $2,
               updated_at = NOW()
           WHERE id = $1 AND reserved_balance >= $2`,
          [businessWallet.id, total]
        );
        await client.query(
          `INSERT INTO wallet_ledger
            (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
           VALUES ($1,$2,$3,'release',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
          [uuidv4(), businessWallet.id, batch.funding_transaction_id, total, payoutRef, JSON.stringify({ batchId, itemId: item.id, reason: "recipient_wallet_unavailable" })]
        );
        await client.query(
          `UPDATE enterprise_distribution_batch_items
           SET status = 'failed',
               validation_errors = validation_errors || $2::JSONB,
               processed_at = NOW()
           WHERE id = $1`,
          [item.id, JSON.stringify(["Recipient TitoPay wallet is no longer active"])]
        );
        continue;
      }

      await client.query(
        `INSERT INTO transactions
          (id, user_id, wallet_id, merchant_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
         VALUES ($1,$2,$3,$4,'bulk_distribution_wallet_payout',$5,$6,$7,'completed','debit',$8,$9,$10::JSONB)`,
        [
          txId,
          batch.business_user_id,
          businessWallet.id,
          batch.merchant_id || null,
          item.amount,
          fee,
          total,
          payoutRef,
          item.wallet_number,
          JSON.stringify({ batchId, itemId: item.id, organisationId: batch.organisation_id, recipientUserId: recipient.recipient_user_id })
        ]
      );
      await client.query(
        `UPDATE wallets
         SET reserved_balance = reserved_balance - $2,
             updated_at = NOW()
         WHERE id = $1 AND reserved_balance >= $2
         RETURNING available_balance, reserved_balance`,
        [businessWallet.id, total]
      );
      await client.query(
        `INSERT INTO wallet_ledger
          (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
         VALUES ($1,$2,$3,'release',$4,$5,$6,$7::JSONB)`,
        [uuidv4(), businessWallet.id, txId, total, businessWallet.available_balance, payoutRef, JSON.stringify({ batchId, itemId: item.id })]
      );
      await client.query(
        `UPDATE wallets
         SET available_balance = available_balance + $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING available_balance`,
        [recipient.id, item.amount]
      );
      await client.query(
        `INSERT INTO wallet_ledger
          (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
         VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
        [uuidv4(), recipient.id, txId, item.amount, payoutRef, JSON.stringify({ batchId, itemId: item.id, fromOrganisationId: batch.organisation_id })]
      );
      if (fee > 0) {
        await client.query(
          `UPDATE wallets
           SET available_balance = available_balance + $2,
               updated_at = NOW()
           WHERE id = $1`,
          [revenueWallet.id, fee]
        );
        await client.query(
          `INSERT INTO wallet_ledger
            (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
           VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
          [uuidv4(), revenueWallet.id, txId, fee, payoutRef, JSON.stringify({ batchId, itemId: item.id, source: "bulk_distribution_fee" })]
        );
        await client.query(
          `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,'bulk_distribution_wallet_payout',$3,$4)`,
          [uuidv4(), txId, fee, revenueWallet.id]
        );
        feesCollected = money(feesCollected + fee);
      }
      await client.query(
        `INSERT INTO enterprise_distribution_payouts
          (id, organisation_id, batch_id, item_id, transaction_id, recipient_user_id, payout_reference, payment_method, amount, fee, total, status, provider, provider_response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'wallet',$8,$9,$10,'paid','titopay_wallet',$11::JSONB)`,
        [uuidv4(), batch.organisation_id, batchId, item.id, txId, recipient.recipient_user_id, payoutRef, item.amount, fee, total, JSON.stringify({ walletNumber: item.wallet_number })]
      );
      await client.query(
        `UPDATE enterprise_distribution_batch_items
         SET status = 'paid',
             transaction_id = $2,
             recipient_user_id = $3,
             fee = $4,
             total = $5,
             provider_response = $6::JSONB,
             processed_at = NOW()
         WHERE id = $1`,
        [item.id, txId, recipient.recipient_user_id, fee, total, JSON.stringify({ provider: "titopay_wallet", payoutReference: payoutRef })]
      );
      processed += 1;
      reservedReleased = money(reservedReleased + total);
      notifications.push({
        itemId: item.id,
        user: { id: recipient.recipient_user_id, full_name: recipient.full_name, phone: recipient.phone, email: recipient.email },
        amount: item.amount,
        reference: payoutRef,
        organisationName: batch.organisation_name
      });
    }

    if (batchFee > 0 && revenueWallet) {
      await client.query(
        `UPDATE wallets
         SET reserved_balance = reserved_balance - $2,
             updated_at = NOW()
         WHERE id = $1 AND reserved_balance >= $2`,
        [businessWallet.id, batchFee]
      );
      await client.query(
        `INSERT INTO wallet_ledger
          (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
         VALUES ($1,$2,$3,'release',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
        [uuidv4(), businessWallet.id, batch.funding_transaction_id, batchFee, batch.batch_reference, JSON.stringify({ batchId, source: "bulk_distribution_batch_fee" })]
      );
      await client.query(
        `UPDATE wallets
         SET available_balance = available_balance + $2,
             updated_at = NOW()
         WHERE id = $1`,
        [revenueWallet.id, batchFee]
      );
      await client.query(
        `INSERT INTO wallet_ledger
          (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
         VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::JSONB)`,
        [uuidv4(), revenueWallet.id, batch.funding_transaction_id, batchFee, batch.batch_reference, JSON.stringify({ batchId, source: "bulk_distribution_batch_fee" })]
      );
      await client.query(
        `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,'bulk_distribution_batch_fee',$3,$4)`,
        [uuidv4(), batch.funding_transaction_id, batchFee, revenueWallet.id]
      );
      feesCollected = money(feesCollected + batchFee);
      reservedReleased = money(reservedReleased + batchFee);
    }

    const nextStatus = providerPending > 0
      ? (processed > 0 ? "partially_released" : "provider_pending")
      : failed > 0
        ? (processed > 0 ? "partially_failed" : "failed")
        : "completed";
    const finalStatus = nextStatus === "provider_pending" ? "payout_service_required" : nextStatus;
    const { rows: updatedBatchRows } = await client.query(
      `UPDATE enterprise_distribution_batches
       SET status = $2,
           processed_rows = processed_rows + $3,
           failed_rows = failed_rows + $4,
           released_by = $5,
           released_at = COALESCE(released_at, NOW()),
           processing_started_at = COALESCE(processing_started_at, NOW()),
           processing_completed_at = CASE WHEN $2 IN ('completed','failed','partially_failed','partially_released','payout_service_required') THEN NOW() ELSE processing_completed_at END,
           validation_summary = validation_summary || $6::JSONB,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [batchId, finalStatus, processed, failed, actor.userId || null, JSON.stringify({ phase2: { processed, failed, payoutServiceRequired: providerPending, feesCollected, releasedAt: new Date().toISOString() } })]
    );
    releasedBatch = updatedBatchRows[0];
    await client.query("UPDATE transactions SET status = $2, updated_at = NOW() WHERE id = $1", [batch.funding_transaction_id, finalStatus === "completed" ? "completed" : "processing"]);
    await client.query("COMMIT");
    await audit({ organisationId: batch.organisation_id, actorType: "admin", actorId: actor.userId, action: "enterprise_distribution_batch_released", targetType: "batch", targetId: batchId, newValue: releasedBatch, ...meta });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  for (const notification of notifications) {
    await notifyPayoutRecipient(notification).catch((error) => console.error("[enterprise-distribution-notification-failed]", { itemId: notification.itemId, error: error.message }));
  }
  return releasedBatch;
}

async function listBatches(userId) {
  const organisation = await requireOrganisation(userId);
  const { rows } = await pool.query(
    "SELECT * FROM enterprise_distribution_batches WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT 300",
    [organisation.id]
  );
  return { organisation, items: rows };
}

async function listAllBatches() {
  await ensureEnterpriseDistributionSchema();
  const { rows } = await pool.query(
    `SELECT b.*, o.organisation_name, o.organisation_code, u.full_name AS owner_name, u.email AS owner_email
     FROM enterprise_distribution_batches b
     JOIN enterprise_distribution_organisations o ON o.id = b.organisation_id
     LEFT JOIN users u ON u.id = o.user_id
     ORDER BY b.created_at DESC
     LIMIT 300`
  );
  return rows;
}

async function listPayouts(status = "") {
  await ensureEnterpriseDistributionSchema();
  const values = [];
  let where = "";
  if (status) {
    values.push(cleanText(status, 60));
    where = "WHERE p.status = $1";
  }
  const { rows } = await pool.query(
    `SELECT p.*, b.batch_reference, b.batch_name, o.organisation_name, u.full_name AS recipient_name, u.phone AS recipient_phone
     FROM enterprise_distribution_payouts p
     JOIN enterprise_distribution_batches b ON b.id = p.batch_id
     JOIN enterprise_distribution_organisations o ON o.id = p.organisation_id
     LEFT JOIN users u ON u.id = p.recipient_user_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT 500`,
    values
  );
  return rows;
}

async function listAuditLogs(limit = 250) {
  await ensureEnterpriseDistributionSchema();
  const { rows } = await pool.query(
    `SELECT a.*, o.organisation_name
     FROM enterprise_distribution_audit_logs a
     LEFT JOIN enterprise_distribution_organisations o ON o.id = a.organisation_id
     ORDER BY a.created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 250, 1), 500)]
  );
  return rows;
}

async function adminReport() {
  await ensureEnterpriseDistributionSchema();
  const [batchStatus, payoutStatus, totals, auditCount] = await Promise.all([
    pool.query("SELECT status, COUNT(*)::INT AS count FROM enterprise_distribution_batches GROUP BY status ORDER BY status"),
    pool.query("SELECT status, COUNT(*)::INT AS count FROM enterprise_distribution_payouts GROUP BY status ORDER BY status"),
    pool.query(
      `SELECT
         COALESCE(SUM(valid_total),0)::NUMERIC AS validated_total,
         COALESCE(SUM(locked_total),0)::NUMERIC AS locked_total,
         COALESCE(SUM(fee_total),0)::NUMERIC AS fee_total,
         COALESCE(SUM(processed_rows),0)::INT AS processed_rows,
         COALESCE(SUM(failed_rows),0)::INT AS failed_rows
       FROM enterprise_distribution_batches`
    ),
    pool.query("SELECT COUNT(*)::INT AS count FROM enterprise_distribution_audit_logs")
  ]);
  return {
    batchesByStatus: batchStatus.rows,
    payoutsByStatus: payoutStatus.rows,
    totals: totals.rows[0] || {},
    auditLogs: auditCount.rows[0]?.count || 0
  };
}

async function adminOverview() {
  await ensureEnterpriseDistributionSchema();
  const [applications, organisations, batches] = await Promise.all([
    pool.query("SELECT status, COUNT(*)::INT AS count FROM enterprise_distribution_applications GROUP BY status"),
    pool.query("SELECT status, licence_status, COUNT(*)::INT AS count FROM enterprise_distribution_organisations GROUP BY status, licence_status"),
    pool.query("SELECT status, COUNT(*)::INT AS count, COALESCE(SUM(expected_total),0)::NUMERIC AS total FROM enterprise_distribution_batches GROUP BY status")
  ]);
  return { applications: applications.rows, organisations: organisations.rows, batches: batches.rows };
}

module.exports = {
  DISTRIBUTION_TYPES,
  ensureEnterpriseDistributionSchema,
  getEligibility,
  submitApplication,
  listApplications,
  listOrganisations,
  transitionApplication,
  listBeneficiaries,
  upsertBeneficiary,
  createBatch,
  lockBatchFunding,
  releaseBatch,
  listBatches,
  listAllBatches,
  listPayouts,
  listAuditLogs,
  adminReport,
  adminOverview
};
