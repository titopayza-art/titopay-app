"use strict";

// PROGRESSIVE KYC/FICA: FOUR LEVELS, RISK-BASED, CONFIGURABLE, AUDITABLE.
//
//   Tier 0  Unverified      registration only; tight transaction limits
//   Tier 1  Basic verified  SA ID number validated; everyday limits
//   Tier 2  Full FICA/KYC   documentary verification; no standing limits
//   EDD     Enhanced due diligence, triggered automatically by unusual or
//           high-value activity; asks for source of funds and, where it
//           applies, beneficial ownership, and puts the account in front of
//           the compliance team
//
// Nothing here is hard-coded policy. The numbers below are DEFAULTS, and the
// live values come from platform_settings key "compliance_tier_limits",
// editable through the admin API with every change audit-logged. Enforcement
// reads the merged config on every decision, so a changed limit applies
// immediately, and usage is derived from the wallet ledger itself, never a
// separate tally.
//
// FICA (Act 38 of 2001) allows a risk-based approach: lighter measures for
// low-value products and full verification plus ongoing due diligence as
// value and risk rise. This module implements that shape; the actual numbers
// are the accountable institution's own risk framework, set in config.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { BLOCKED_ACCOUNT_STATUSES } = require("../lib/chat-policy");
const { writeAuditLog } = require("./audit-service");

const DEFAULT_CONFIG = {
  // null means no standing limit at that tier.
  tiers: {
    0: {
      label: "Unverified",
      description: "Registration only. Verify your identity to transact freely.",
      monthlyReceive: 5000,
      monthlySend: 5000,
      singleTransaction: 2500
    },
    1: {
      label: "Basic verified",
      description: "SA ID verified. Everyday wallet limits.",
      monthlyReceive: 50000,
      monthlySend: 50000,
      singleTransaction: 25000
    },
    2: {
      label: "Fully verified",
      description: "Full FICA verification. No standing limits, subject to ongoing monitoring.",
      monthlyReceive: null,
      monthlySend: null,
      singleTransaction: null
    }
  },
  edd: {
    // Activity at or past these marks raises an enhanced due diligence flag
    // for the compliance team and asks the customer for source of funds.
    singleTransactionReview: 100000,
    monthlyVolumeReview: 500000
  },
  // The app starts prompting the customer to upgrade at this share of any
  // monthly limit, so nobody discovers a limit by hitting it.
  promptAtPercent: 80
};

let schemaReady = null;
function ensureComplianceSchema() {
  schemaReady ||= (async () => {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS basic_verified_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_hash TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS edd_status TEXT NOT NULL DEFAULT 'none'");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_flags (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        flag_type TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by UUID,
        resolution_note TEXT
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS compliance_flags_open_idx ON compliance_flags (status, created_at DESC)"
    );
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

function mergeConfig(stored) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (stored && typeof stored === "object") {
    for (const key of ["0", "1", "2"]) {
      if (stored.tiers?.[key] && typeof stored.tiers[key] === "object") {
        merged.tiers[key] = { ...merged.tiers[key], ...stored.tiers[key] };
      }
    }
    if (stored.edd && typeof stored.edd === "object") merged.edd = { ...merged.edd, ...stored.edd };
    if (Number.isFinite(Number(stored.promptAtPercent))) merged.promptAtPercent = Number(stored.promptAtPercent);
  }
  return merged;
}

async function loadComplianceConfig() {
  await ensureComplianceSchema();
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'compliance_tier_limits' LIMIT 1"
  ).catch(() => ({ rows: [] }));
  return mergeConfig(rows[0]?.value);
}

async function saveComplianceConfig(actor, value) {
  await ensureComplianceSchema();
  const merged = mergeConfig(value);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::JSONB,
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ('compliance_tier_limits', $1::JSONB, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(merged)]
  );
  await writeAuditLog({
    actorType: "admin",
    actorId: actor?.userId || null,
    action: "compliance_limits_updated",
    entityType: "platform_settings",
    entityId: null,
    metadata: { config: merged }
  });
  return merged;
}

const VERIFIED_FICA = new Set(["verified", "approved", "complete", "completed"]);

function tierForUserRow(user) {
  if (!user) return 0;
  if (VERIFIED_FICA.has(String(user.fica_status || "").toLowerCase())) return 2;
  if (user.basic_verified_at) return 1;
  return 0;
}

async function loadUserComplianceRow(userId) {
  await ensureComplianceSchema();
  const { rows } = await pool.query(
    "SELECT id, full_name, username, account_type, status, fica_status, basic_verified_at, edd_status FROM users WHERE id = $1",
    [userId]
  );
  return rows[0] || null;
}

// Usage from the ledger itself: what actually moved this calendar month.
async function monthUsage(userId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(ABS(wl.amount)) FILTER (WHERE wl.entry_type = 'credit'), 0) AS received,
       COALESCE(SUM(ABS(wl.amount)) FILTER (WHERE wl.entry_type = 'debit'), 0) AS sent
     FROM wallet_ledger wl
     JOIN wallets w ON w.id = wl.wallet_id
     WHERE w.user_id = $1 AND wl.created_at >= DATE_TRUNC('month', NOW())`,
    [userId]
  );
  return { received: Number(rows[0]?.received || 0), sent: Number(rows[0]?.sent || 0) };
}

function upgradeSentence(tier) {
  return tier === 0
    ? "Verifying your SA ID under Limits and Verification takes two minutes and raises your limits."
    : "Completing full FICA verification under Limits and Verification removes standing limits.";
}

// Receiving: refused only when the payment would pass the recipient's
// monthly receive limit for their tier. Tier 2 has no standing limit.
async function assertCanReceiveAmount(recipientUserId, amount, { selfView = false } = {}) {
  const user = await loadUserComplianceRow(recipientUserId);
  if (!user) return;
  if (BLOCKED_ACCOUNT_STATUSES.has(String(user.status || "").toLowerCase())) {
    throw new AppError(403, selfView
      ? "Your account cannot receive money at the moment. Contact TitoPay support."
      : "This account cannot receive money at the moment. The recipient should contact TitoPay support.");
  }
  const config = await loadComplianceConfig();
  const tier = tierForUserRow(user);
  const limit = config.tiers[String(tier)]?.monthlyReceive;
  if (limit === null || limit === undefined) return;
  const usage = await monthUsage(recipientUserId);
  if (usage.received + Number(amount || 0) > Number(limit)) {
    throw new AppError(403, selfView
      ? `Your account can receive up to R${Number(limit).toFixed(2)} a month at its current verification level, and this request would go past that. Raise your limits under Limits and Verification.`
      : `This recipient's account can receive up to R${Number(limit).toFixed(2)} a month at its current verification level, and this payment would go past that. They can raise the limit under Limits and Verification in their app.`);
  }
}

// Sending: single-transaction and monthly-send limits for the actor's tier.
async function assertCanSendAmount(userId, amount) {
  const user = await loadUserComplianceRow(userId);
  if (!user) return;
  const config = await loadComplianceConfig();
  const tier = tierForUserRow(user);
  const tierConfig = config.tiers[String(tier)] || {};
  const value = Number(amount || 0);
  if (tierConfig.singleTransaction !== null && tierConfig.singleTransaction !== undefined
      && value > Number(tierConfig.singleTransaction)) {
    throw new AppError(403,
      `A single payment at your verification level can be up to R${Number(tierConfig.singleTransaction).toFixed(2)}. ${upgradeSentence(tier)}`);
  }
  if (tierConfig.monthlySend !== null && tierConfig.monthlySend !== undefined) {
    const usage = await monthUsage(userId);
    if (usage.sent + value > Number(tierConfig.monthlySend)) {
      throw new AppError(403,
        `You have sent R${usage.sent.toFixed(2)} this month, and your verification level allows up to R${Number(tierConfig.monthlySend).toFixed(2)}. ${upgradeSentence(tier)}`);
    }
  }
}

// EDD: raised automatically, never silently. The flag is the audit record,
// the customer is told what is needed, and the compliance team resolves it.
async function reviewForEdd(userId, amount, serviceCode) {
  try {
    const user = await loadUserComplianceRow(userId);
    if (!user || String(user.edd_status) === "required" || String(user.edd_status) === "under_review") return;
    const config = await loadComplianceConfig();
    const usage = await monthUsage(userId);
    const single = Number(config.edd.singleTransactionReview);
    const monthly = Number(config.edd.monthlyVolumeReview);
    const bigSingle = Number.isFinite(single) && Number(amount) >= single;
    const bigMonth = Number.isFinite(monthly) && usage.sent + usage.received >= monthly;
    if (!bigSingle && !bigMonth) return;
    await pool.query("UPDATE users SET edd_status = 'required' WHERE id = $1", [userId]);
    await pool.query(
      `INSERT INTO compliance_flags (id, user_id, flag_type, details)
       VALUES ($1, $2, 'enhanced_due_diligence', $3::JSONB)`,
      [crypto.randomUUID(), userId, JSON.stringify({
        trigger: bigSingle ? "single_transaction" : "monthly_volume",
        amount: Number(amount),
        monthReceived: usage.received,
        monthSent: usage.sent,
        serviceCode: serviceCode || null
      })]
    );
    await writeAuditLog({
      actorType: "system",
      actorId: null,
      action: "edd_triggered",
      entityType: "user",
      entityId: userId,
      metadata: { trigger: bigSingle ? "single_transaction" : "monthly_volume", amount: Number(amount) }
    });
    const { createNotification } = require("./notification-service");
    await createNotification({
      user: { id: userId, user_type: "customer" },
      channel: "in_app", notificationType: "compliance_edd", provider: "in_app",
      title: "We need a little more information",
      body: "Recent activity on your account needs a routine compliance review. Please send proof of source of funds or income, and for a business the beneficial owner details, to compliance@titopay.co.za or through Support. Your account keeps working while the team reviews.",
      metadata: { clientNotificationId: `edd-${userId}` }
    }).catch(() => {});
  } catch (error) {
    console.error("[compliance] edd review failed", { userId, message: error.message });
  }
}

// Tier 1: a validated SA ID number. Thirteen digits, a real date of birth,
// and the Luhn check digit the ID scheme uses. The number itself is stored
// only as a salted hash: enough to prove it was captured and detect reuse,
// never the number in the clear.
function validateSaIdNumber(idNumber) {
  const digits = String(idNumber || "").replace(/\s+/g, "");
  if (!/^\d{13}$/.test(digits)) return "An SA ID number has 13 digits.";
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return "That ID number's date of birth is not valid.";
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    let digit = Number(digits[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  if (sum % 10 !== 0) return "That ID number's check digit does not match. Check for a typing mistake.";
  return null;
}

async function basicVerify(auth, payload = {}) {
  await ensureComplianceSchema();
  const problem = validateSaIdNumber(payload.idNumber);
  if (problem) throw new AppError(400, problem);
  const digits = String(payload.idNumber).replace(/\s+/g, "");
  const hash = crypto.createHash("sha256").update(`titopay-id:${digits}`).digest("hex");
  const { rows } = await pool.query(
    "SELECT id FROM users WHERE id_number_hash = $1 AND id <> $2 LIMIT 1",
    [hash, auth.userId]
  );
  if (rows[0]) throw new AppError(409, "This ID number is already linked to another TitoPay account. If that is not you, contact support.");
  await pool.query(
    "UPDATE users SET id_number_hash = $1, basic_verified_at = COALESCE(basic_verified_at, NOW()) WHERE id = $2",
    [hash, auth.userId]
  );
  await writeAuditLog({
    actorType: "customer",
    actorId: auth.userId,
    action: "basic_verification_completed",
    entityType: "user",
    entityId: auth.userId,
    ipAddress: auth.ipAddress,
    userAgent: auth.userAgent,
    metadata: { method: "sa_id_number" }
  });
  return complianceStatus(auth);
}

function shapeTier(config, tier) {
  const t = config.tiers[String(tier)] || {};
  return {
    tier,
    label: t.label,
    description: t.description,
    monthlyReceive: t.monthlyReceive ?? null,
    monthlySend: t.monthlySend ?? null,
    singleTransaction: t.singleTransaction ?? null
  };
}

async function complianceStatus(auth) {
  const user = await loadUserComplianceRow(auth.userId);
  if (!user) throw new AppError(404, "Account not found.");
  const config = await loadComplianceConfig();
  const tier = tierForUserRow(user);
  const usage = await monthUsage(auth.userId);
  const current = shapeTier(config, tier);
  const eddActive = ["required", "under_review"].includes(String(user.edd_status || ""));
  const percentOf = (used, limit) => (limit === null || limit === undefined || Number(limit) <= 0)
    ? 0
    : Math.min(100, Math.round((used / Number(limit)) * 100));
  const receivePercent = percentOf(usage.received, current.monthlyReceive);
  const sendPercent = percentOf(usage.sent, current.monthlySend);
  const promptNeeded = tier < 2 && Math.max(receivePercent, sendPercent) >= Number(config.promptAtPercent);
  return {
    tier,
    label: current.label,
    ficaStatus: String(user.fica_status || "none"),
    eddStatus: String(user.edd_status || "none"),
    eddActive,
    verified: tier === 2,
    usage: { ...usage, receivePercent, sendPercent },
    limits: current,
    tiers: [0, 1, 2].map((level) => shapeTier(config, level)),
    promptAtPercent: Number(config.promptAtPercent),
    promptNeeded,
    nextSteps: tier === 2
      ? (eddActive ? ["Send proof of source of funds or income to compliance@titopay.co.za or through Support."] : [])
      : tier === 1
        ? ["Complete full FICA verification: upload your ID document and proof of address under Profile, FICA verification."]
        : ["Verify your SA ID number below for instant everyday limits.",
           "Then complete full FICA verification under Profile, FICA verification to remove standing limits."]
  };
}

module.exports = {
  ensureComplianceSchema,
  loadComplianceConfig,
  saveComplianceConfig,
  tierForUserRow,
  monthUsage,
  assertCanReceiveAmount,
  assertCanSendAmount,
  reviewForEdd,
  basicVerify,
  complianceStatus,
  validateSaIdNumber,
  DEFAULT_CONFIG
};
