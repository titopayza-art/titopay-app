"use strict";

// PROGRESSIVE KYC/FICA: THREE LEVELS, RISK-BASED, CONFIGURABLE, AUDITABLE.
//
//   Tier 0  Unverified      registration only
//   Tier 1  Basic verified  identity document validated (SA ID, passport or
//                           another approved identity document)
//   Tier 2  Full FICA/KYC   documentary verification; no standing limits
//
// THREE, and only three. Enhanced due diligence is NOT a fourth level and
// must never be described as one: it is a REVIEW that opens on any level,
// triggered automatically by unusual or high-value activity, asking for
// source of funds and, where it applies, beneficial ownership, and putting
// the account in front of the compliance team. An account keeps working, and
// keeps its level, while the review runs.
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
//
// IMPORTANT: no number in DEFAULT_CONFIG is a statutory FICA or SARB
// threshold. They are TitoPay operational limits under its Risk Management
// and Compliance Programme (RMCP), subject to legal and compliance review,
// and every one of them is expected to be set through the admin API.
//
// KYC STATUS and RISK STATUS are separate axes:
//   KYC   tier 0/1/2 - who the customer is (identity assurance)
//   RISK  normal | elevated | high_risk | edd_review - how the account is
//         behaving, driven by monitoring, screening, patterns and manual
//         compliance decisions. A fully verified account can still be under
//         review; a new account can be low risk.
//
// IDENTITY IS NOT ASSUMED SOUTH AFRICAN. Tier 1 accepts any approved
// identity document: an SA ID number, a passport with its issuing country,
// or another approved identity document. Which types are accepted is
// configuration (identity.documentTypes), the document number is stored only
// as a salted hash, and only the fields the applicable compliance framework
// actually needs are collected (data minimisation). Every verification is a
// row in kyc_verifications, so the account carries its verification history.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { BLOCKED_ACCOUNT_STATUSES } = require("../lib/chat-policy");
const { writeAuditLog } = require("./audit-service");
// Identity assurance is asked of a CAPABILITY. Which provider supplies it is
// configuration in src/providers, and no company name appears in this file.
const { verifyIdentity, normalizeVerificationStatus } = require("../providers/kyc-provider");

const DEFAULT_CONFIG = {
  // null means no standing limit for that rail at that level.
  //
  // THREE LEVELS, AND ONLY THREE. Enhanced due diligence is NOT a fourth: it
  // is a review that can open on any level, not a rung anyone climbs to.
  //
  //   Unverified      R25 000 cumulative transaction volume a month
  //   Basic verified  R200 000 cumulative transaction volume a month
  //   Fully verified  no fixed monthly product limit
  //
  // THE MONTHLY FIGURE IS A TRANSACTION-VOLUME LIMIT AND NOTHING ELSE.
  //
  // This is the distinction that is easiest to lose and most expensive to
  // lose: monthlySend and monthlyReceive measure VOLUME MOVED over a calendar
  // month, derived from wallet_ledger. They are not the same thing as, and
  // are deliberately never set from, the four other rails on this object:
  //
  //   singleTransaction  one payment, at the moment it is made
  //   dailySend          a rolling 24 hour window
  //   singleWithdrawal / monthlyWithdraw
  //                      CASH OUT specifically, which is where fraud realises
  //   maxBalance         stored value HELD in the wallet, a float and
  //                      safeguarding question, not a volume one
  //
  // A wallet that moves R200 000 through it in a month is not a wallet that
  // may hold R200 000, and a customer who may move that much over thirty days
  // is not a customer who may move it in one payment. Those four rails keep
  // their own values, set on their own reasoning, and raising a monthly
  // volume limit must never drag them up with it.
  //
  // THE LADDER IS SET ABOVE THE ASSURANCE THE PLATFORM CURRENTLY HOLDS, which
  // is a deliberate business decision, taken with the trade-off stated:
  //
  //   Unverified means NOTHING is known about the customer. No document, no
  //   name checked against anything, no screening hit possible on an identity
  //   that was never given.
  //
  //   Basic verified today proves only that someone entered a well-formed
  //   document number no other account is using. There is no Home Affairs
  //   match, no document image and no liveness check. That changes when a
  //   verification provider is configured behind the KYC capability.
  //
  // What carries the difference in the meantime is everything OTHER than the
  // tier: the per-payment, daily, withdrawal and balance rails below; risk
  // banding, which the engine applies LAST so it narrows every level
  // including the top one; transaction monitoring; screening; ongoing due
  // diligence; and any open compliance review. A level is never on its own a
  // permission to transact.
  //
  // Money sent beyond a recipient's capacity is still held for claim rather
  // than refused, so nobody loses a payment to a limit. Every number here is
  // console-editable without a deploy, versioned and reversible.
  //
  // None of these is a statutory FICA or SARB threshold. They are TitoPay
  // operational limits under its RMCP.
  tiers: {
    0: {
      label: "Unverified",
      description: "Registration only. Verify your identity for higher limits.",
      // MONTHLY TRANSACTION VOLUME.
      monthlyReceive: 25000,
      monthlySend: 25000,
      // THE OTHER RAILS, ON THEIR OWN REASONING. Unchanged by the monthly
      // figure moving, because nothing about them changed: a payment from an
      // account whose holder is unknown is exactly as risky as it was.
      singleTransaction: 2500,
      dailySend: 4000,
      singleWithdrawal: 1000,
      monthlyWithdraw: 3000,
      // Stored value, not volume. An account nobody has identified has no
      // business holding a large float, whatever it is allowed to move.
      maxBalance: 10000
    },
    1: {
      label: "Basic verified",
      description: "Identity verified. Higher monthly transaction limits.",
      // MONTHLY TRANSACTION VOLUME.
      monthlyReceive: 200000,
      monthlySend: 200000,
      // THE OTHER RAILS, ON THEIR OWN REASONING. Per payment stays the
      // deliberate friction: it is the control that costs honest customers
      // the least and fraud the most, and it is the one that does not become
      // safer because a monthly ceiling rose.
      singleTransaction: 10000,
      dailySend: 20000,
      singleWithdrawal: 10000,
      // Set on cash-out reasoning, not inherited: this rail happened to equal
      // the monthly figure under the old ladder, and leaving it there would
      // have carried that coincidence forward as if it meant something.
      monthlyWithdraw: 30000,
      // Stored value, not volume, and deliberately far below the monthly
      // figure: moving R200 000 through a wallet over a month is a different
      // proposition from parking it there.
      maxBalance: 50000
    },
    2: {
      label: "Fully verified",
      description: "Full FICA verification. No fixed monthly transaction limit, with activity subject to ongoing monitoring.",
      // NO FIXED MONTHLY PRODUCT LIMIT. That is not a promise of unrestricted
      // activity and must never be implemented as one. What is removed here
      // is TitoPay's own standing monthly cap. What still applies, on every
      // transaction, at this level exactly as at any other:
      //
      //   - risk banding, applied LAST by the engine, which gives this level
      //     real ceilings the moment an account's risk status is raised (see
      //     DEFAULT_RISK_BANDS in limit-engine.js)
      //   - transaction monitoring: velocity, structuring and pattern checks
      //   - sanctions and designation screening
      //   - enhanced due diligence, which can open on any level
      //   - ongoing customer due diligence review
      //   - account status: a restricted or suspended account transacts
      //     nothing regardless of level
      //   - product rules, which only ever narrow
      //   - whatever the payment or payout provider itself will accept
      monthlyReceive: null,
      monthlySend: null,
      singleTransaction: null,
      dailySend: null,
      singleWithdrawal: null,
      monthlyWithdraw: null,
      maxBalance: null
    }
  },
  // Which identity documents unlock Tier 1, per the approved RMCP. sa_id is
  // validated locally; passport and other approved documents carry an
  // issuing country and date of birth.
  identity: {
    documentTypes: ["sa_id", "passport", "other"]
  },
  // Per-product narrowing, risk bands and earned capacity. The limit engine
  // owns the defaults; anything set here overrides them.
  products: require("./limit-engine").DEFAULT_PRODUCT_LIMITS,
  riskBands: require("./limit-engine").DEFAULT_RISK_BANDS,
  earnedCapacity: require("./limit-engine").DEFAULT_EARNED_CAPACITY,
  // RECEIVING. A payment that only fails because the recipient has no
  // receiving capacity left is held for them to claim by verifying, rather
  // than refused: the money is never lost, the sender is never blocked by
  // someone else's paperwork, and the funds never touch a spendable
  // balance until the recipient is entitled to them. Set enabled to false
  // to refuse instead, per the approved compliance framework.
  receiving: {
    holdForVerification: true,
    // A week is long enough for someone to notice and verify, and short
    // enough that a sender's money is not in limbo for half a month.
    holdDays: 7,
    // Rails where a hold makes sense. Card top-ups and merchant settlement
    // are excluded: those answer to the provider, not to a claim.
    services: ["wallet_transfer", "send_gift", "send_money", "payment_request", "stockvel_contribution"]
  },
  edd: {
    // OPTIONAL value marks. Activity at or past these marks raises an
    // enhanced due diligence flag, but EDD is never only about a number:
    // velocity, structuring patterns, sanctions screening, ongoing CDD and
    // manual compliance decisions all raise it independently of any amount.
    // Set either mark to null to switch that value trigger off entirely.
    singleTransactionReview: 100000,
    monthlyVolumeReview: 500000
  },
  // The app starts prompting the customer to upgrade at this share of any
  // monthly limit, so nobody discovers a limit by hitting it.
  promptAtPercent: 80,
  // Transaction monitoring marks (operational, RMCP-governed, not statutory).
  monitoring: {
    velocityCount24h: 30,
    velocityAmount24h: 150000,
    structuringCount: 5,
    structuringMarginPercent: 10
  },
  // Ongoing customer due diligence: fully verified accounts are re-reviewed
  // on this cycle.
  cdd: { reviewMonths: 24 },
  // Which risk status each signal escalates to. Order of severity:
  // normal < elevated < high_risk < edd_review. A signal type not listed
  // here defaults to "elevated", so new detectors can ship without a code
  // change and compliance can retune any of these without a deploy.
  riskSignals: {
    unusual_activity: "elevated",
    transaction_pattern: "elevated",
    velocity: "elevated",
    sanctions_screening: "high_risk",
    source_of_funds: "edd_review",
    edd_trigger: "edd_review",
    manual: "high_risk",
    // Account and device security signals (fed by the security layer).
    failed_logins: "elevated",
    device_risk: "elevated",
    account_takeover: "high_risk",
    duplicate_account: "high_risk",
    // Payment integrity signals.
    chargeback: "elevated",
    refund_abuse: "elevated",
    money_integrity: "high_risk"
  }
};

const RISK_ORDER = ["normal", "elevated", "high_risk", "edd_review"];
const RISK_STATUSES = new Set(RISK_ORDER);

let schemaReady = null;
function ensureComplianceSchema() {
  schemaReady ||= (async () => {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS basic_verified_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_hash TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS edd_status TEXT NOT NULL DEFAULT 'none'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_status TEXT NOT NULL DEFAULT 'normal'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS cdd_reviewed_at TIMESTAMPTZ");
    // Which document proved the identity, and where it was issued. The
    // document NUMBER never appears here: only the salted hash above.
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_document_type TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_issuing_country TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_nationality TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_date_of_birth DATE");
    // Verification history: one row per completed verification step, hash
    // only, so compliance can see when and how identity was established.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kyc_verifications (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        issuing_country TEXT,
        document_hash TEXT,
        status TEXT NOT NULL DEFAULT 'verified',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS kyc_verifications_user_idx ON kyc_verifications (user_id, created_at DESC)"
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_screening_list (
        id UUID PRIMARY KEY,
        label TEXT NOT NULL,
        name_pattern TEXT,
        id_number_hash TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        added_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
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
    if (stored.identity && typeof stored.identity === "object") merged.identity = { ...merged.identity, ...stored.identity };
    if (stored.products && typeof stored.products === "object") merged.products = { ...merged.products, ...stored.products };
    if (stored.riskBands && typeof stored.riskBands === "object") merged.riskBands = { ...merged.riskBands, ...stored.riskBands };
    if (stored.earnedCapacity && typeof stored.earnedCapacity === "object") merged.earnedCapacity = { ...merged.earnedCapacity, ...stored.earnedCapacity };
    if (stored.receiving && typeof stored.receiving === "object") merged.receiving = { ...merged.receiving, ...stored.receiving };
    if (stored.edd && typeof stored.edd === "object") merged.edd = { ...merged.edd, ...stored.edd };
    if (stored.monitoring && typeof stored.monitoring === "object") merged.monitoring = { ...merged.monitoring, ...stored.monitoring };
    if (stored.cdd && typeof stored.cdd === "object") merged.cdd = { ...merged.cdd, ...stored.cdd };
    if (stored.riskSignals && typeof stored.riskSignals === "object") merged.riskSignals = { ...merged.riskSignals, ...stored.riskSignals };
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

async function saveComplianceConfig(actor, value, { reason = null } = {}) {
  await ensureComplianceSchema();
  const previous = await loadComplianceConfig();
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
  // Versioned, so a change can be reviewed and reversed rather than only
  // overwritten. Restoring writes a new version of its own: history is
  // append-only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compliance_config_versions (
      id UUID PRIMARY KEY,
      config_key TEXT NOT NULL,
      value JSONB NOT NULL,
      reason TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    "INSERT INTO compliance_config_versions (id, config_key, value, reason, created_by) VALUES ($1, 'compliance_tier_limits', $2::JSONB, $3, $4)",
    [crypto.randomUUID(), JSON.stringify(merged), reason, actor?.userId || null]
  ).catch(() => {});
  await writeAuditLog({
    actorType: "admin",
    actorId: actor?.userId || null,
    action: "compliance_limits_updated",
    entityType: "platform_settings",
    entityId: null,
    // Reason, previous value and new value together: the change is
    // reconstructible without reading any other record.
    metadata: { reason, previous, config: merged }
  });
  return merged;
}

async function listComplianceConfigVersions(limit = 50) {
  await ensureComplianceSchema();
  const { rows } = await pool.query(
    `SELECT v.id, v.reason, v.created_at, v.created_by, u.full_name AS created_by_name
     FROM compliance_config_versions v
     LEFT JOIN users u ON u.id = v.created_by
     WHERE v.config_key = 'compliance_tier_limits'
     ORDER BY v.created_at DESC LIMIT $1`, [Math.min(200, Number(limit) || 50)]
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function restoreComplianceConfigVersion(actor, versionId, reason) {
  await ensureComplianceSchema();
  const stated = String(reason || "").trim();
  if (!stated) throw new AppError(400, "State why this version is being restored. It becomes part of the audit record.");
  const { rows } = await pool.query(
    "SELECT value FROM compliance_config_versions WHERE id = $1 AND config_key = 'compliance_tier_limits'", [versionId]);
  if (!rows[0]) throw new AppError(404, "That configuration version was not found.");
  return saveComplianceConfig(actor, rows[0].value, { reason: `restore:${versionId}: ${stated}` });
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
    "SELECT id, full_name, username, account_type, status, fica_status, basic_verified_at, edd_status, risk_status, cdd_reviewed_at, kyc_document_type, kyc_issuing_country FROM users WHERE id = $1",
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

async function dayUsage(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ABS(wl.amount)) FILTER (WHERE wl.entry_type = 'debit'), 0) AS sent,
            COUNT(*) FILTER (WHERE wl.entry_type = 'debit')::INT AS debit_count
     FROM wallet_ledger wl
     JOIN wallets w ON w.id = wl.wallet_id
     WHERE w.user_id = $1 AND wl.created_at >= NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return { sent: Number(rows[0]?.sent || 0), debitCount: Number(rows[0]?.debit_count || 0) };
}

async function walletBalanceOf(userId) {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(available_balance), 0) AS balance FROM wallets WHERE user_id = $1", [userId]);
  return Number(rows[0]?.balance || 0);
}

// The four enforcement doors. Each one asks the limit engine and turns its
// decision into either silence or a refusal that states the remaining
// capacity. A refusal here is a TitoPay product limit, never a legal
// threshold, and the wording never suggests otherwise.
//
// RECEIVING is special: a payment that only fails on the recipient's
// capacity is not the sender's problem to solve, so the transaction rail
// holds it for claim instead (see assertCanReceiveAmount's throw shape and
// pending-credit-service). Blocked accounts are refused outright.
async function assertCanReceiveAmount(recipientUserId, amount, { selfView = false, serviceCode = null } = {}) {
  const user = await loadUserComplianceRow(recipientUserId);
  if (!user) return;
  if (BLOCKED_ACCOUNT_STATUSES.has(String(user.status || "").toLowerCase())) {
    throw new AppError(403, selfView
      ? "Your account cannot receive money at the moment. Contact TitoPay support."
      : "This account cannot receive money at the moment. The recipient should contact TitoPay support.");
  }
  const outcome = await require("./limit-engine").evaluateReceive(recipientUserId, amount, { serviceCode });
  if (outcome.decision === "approve") return;
  // Self view quotes the customer's own capacity. The third-party view
  // never discloses another account's numbers or verification state: what
  // a recipient can receive is their business, not the sender's.
  const error = new AppError(403, selfView
    ? outcome.message
    : "This payment cannot be completed to that account right now. Try a smaller amount, or ask them to check Limits and Verification in their app.");
  error.limitRule = outcome.rule;
  error.limitRemaining = outcome.remaining;
  error.recipientCapacityOnly = true;
  throw error;
}

// Wallet balance cap for credits that do not pass through the transfer rails
// (card top-ups). Checked before the customer is sent to the card page.
async function assertBalanceHeadroom(userId, amount) {
  const outcome = await require("./limit-engine").evaluateBalanceHeadroom(userId, amount);
  if (outcome.decision !== "approve") throw new AppError(403, outcome.message);
}

// Withdrawal limits: per withdrawal and per month.
async function assertCanWithdraw(userId, amount) {
  const outcome = await require("./limit-engine").evaluateWithdrawal(userId, amount);
  if (outcome.decision !== "approve") throw new AppError(403, outcome.message);
}

// Sending: per payment, per day and per month.
async function assertCanSendAmount(userId, amount, { serviceCode = null } = {}) {
  const outcome = await require("./limit-engine").evaluateSend(userId, amount, { serviceCode });
  if (outcome.decision !== "approve") throw new AppError(403, outcome.message);
}

// THE RISK ENGINE. Risk status is a separate axis from KYC: it moves on
// signals, every movement is a compliance_flags row plus an audit log entry,
// and only the compliance team moves it back down.
function riskRank(status) {
  const index = RISK_ORDER.indexOf(String(status || "normal"));
  return index < 0 ? 0 : index;
}

async function setRiskStatus(userId, nextStatus, reason, details = {}, actor = null) {
  if (!RISK_STATUSES.has(nextStatus)) throw new AppError(400, "Unknown risk status.");
  const user = await loadUserComplianceRow(userId);
  if (!user) throw new AppError(404, "Account not found.");
  const current = String(user.risk_status || "normal");
  await pool.query("UPDATE users SET risk_status = $2, edd_status = CASE WHEN $2 = 'edd_review' THEN 'required' WHEN $2 = 'normal' THEN 'cleared' ELSE edd_status END WHERE id = $1",
    [userId, nextStatus]);
  await writeAuditLog({
    actorType: actor ? "admin" : "system",
    actorId: actor?.userId || null,
    action: "risk_status_changed",
    entityType: "user",
    entityId: userId,
    metadata: { from: current, to: nextStatus, reason, ...details }
  });
  return { from: current, to: nextStatus };
}

// A signal escalates risk according to the configured mapping. Downgrades
// never happen here: only a compliance decision lowers risk.
async function recordRiskSignal(userId, signalType, details = {}) {
  const config = await loadComplianceConfig();
  const target = config.riskSignals[signalType] || "elevated";
  const user = await loadUserComplianceRow(userId);
  if (!user) return null;
  const flagId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO compliance_flags (id, user_id, flag_type, details)
     VALUES ($1, $2, $3, $4::JSONB)`,
    [flagId, userId, signalType, JSON.stringify(details)]
  );
  if (riskRank(target) > riskRank(user.risk_status)) {
    await setRiskStatus(userId, target, `signal:${signalType}`, details);
  } else {
    await writeAuditLog({
      actorType: "system", actorId: null, action: "risk_signal_recorded",
      entityType: "compliance_flag", entityId: flagId,
      metadata: { signalType, riskStatus: user.risk_status, ...details }
    });
  }
  // EDD-level signals also tell the customer what is needed. Lower-severity
  // signals stay internal: telling a customer they are "elevated risk" is
  // tipping off, not transparency.
  if (target === "edd_review") {
    const { createNotification } = require("./notification-service");
    await createNotification({
      user: { id: userId, user_type: "customer" },
      channel: "in_app", notificationType: "compliance_edd", provider: "in_app",
      title: "We need a little more information",
      body: "Recent activity on your account needs a routine compliance review. Please send proof of source of funds or income, and for a business the beneficial owner details, to compliance@titopay.co.za or through Support. Your account keeps working while the team reviews.",
      metadata: { clientNotificationId: `edd-${userId}` }
    }).catch(() => {});
  }
  return flagId;
}

// Sanctions and internal designation screening. The list is maintained by
// compliance administrators; a real screening provider can replace the
// matcher without changing anything downstream. Matching is by normalised
// name or by the same salted ID hash Tier 1 stores.
function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

async function screenUser(userId) {
  await ensureComplianceSchema();
  const user = await loadUserComplianceRow(userId);
  if (!user) return { hit: false };
  const { rows: hashRows } = await pool.query("SELECT id_number_hash FROM users WHERE id = $1", [userId]);
  const { rows: list } = await pool.query(
    "SELECT id, label, name_pattern, id_number_hash FROM compliance_screening_list WHERE active = TRUE");
  const name = normalizeName(user.full_name);
  for (const entry of list) {
    const nameHit = entry.name_pattern && name && name.includes(normalizeName(entry.name_pattern));
    const idHit = entry.id_number_hash && hashRows[0]?.id_number_hash === entry.id_number_hash;
    if (nameHit || idHit) {
      await recordRiskSignal(userId, "sanctions_screening", {
        listEntryId: entry.id, listLabel: entry.label, matchedBy: idHit ? "id_number" : "name"
      });
      return { hit: true, entry: entry.label };
    }
  }
  return { hit: false };
}

// The upgrade nudge: a real notification, once per calendar month, when
// usage crosses the configured share of any limit. Nobody discovers a limit
// by hitting it.
async function nudgeBeforeLimits(userId, config, tier, tierConfig) {
  if (tier >= 2) return;
  const usage = await monthUsage(userId);
  const pct = (used, limit) => (limit === null || limit === undefined || Number(limit) <= 0)
    ? 0 : Math.round((used / Number(limit)) * 100);
  const worst = Math.max(pct(usage.received, tierConfig.monthlyReceive), pct(usage.sent, tierConfig.monthlySend));
  if (worst < Number(config.promptAtPercent) || worst >= 100) return;
  const monthKey = new Date().toISOString().slice(0, 7);
  const { createNotification } = require("./notification-service");
  await createNotification({
    user: { id: userId, user_type: "customer" },
    channel: "in_app", notificationType: "compliance_prompt", provider: "in_app",
    title: `You have used ${worst}% of a monthly limit`,
    body: "Upgrade your verification under Limits and Verification, in your wallet card, to keep transacting without interruption. It takes minutes.",
    metadata: { clientNotificationId: `compliance-nudge-${monthKey}-${userId}`, percent: worst }
  }).catch(() => {});
}

// The monitoring pass that runs after every completed transaction. Kept
// under the original name because the transaction rail calls it.
async function reviewForEdd(userId, amount, serviceCode) {
  try {
    const user = await loadUserComplianceRow(userId);
    if (!user) return;
    const config = await loadComplianceConfig();
    const tier = tierForUserRow(user);
    // Monitoring reads the limits the customer ACTUALLY faces, from the one
    // engine, so structuring detection follows a narrowed limit rather than
    // the level's headline number.
    const effective = await require("./limit-engine").capacityFor(userId, { serviceCode });
    const tierConfig = effective?.limits || config.tiers[String(tier)] || {};
    // capacityFor has already asked the ledger for this customer's month and
    // day. Reuse its answer rather than asking twice; fall back to a fresh
    // read only if capacity could not be built at all.
    const usage = effective?.usage
      ? { received: effective.usage.received, sent: effective.usage.sent }
      : await monthUsage(userId);
    const today = effective?.usage
      ? { sent: effective.usage.sentToday, debitCount: effective.usage.debitCount24h }
      : await dayUsage(userId);

    // OPTIONAL value marks raise EDD, once while a review is open. A null
    // mark means no value trigger at all: EDD then rests entirely on risk
    // factors (velocity, structuring, screening, CDD, manual decisions),
    // never on a fixed monetary amount.
    const underReview = riskRank(user.risk_status) >= riskRank("edd_review");
    const single = config.edd.singleTransactionReview === null || config.edd.singleTransactionReview === undefined
      ? NaN : Number(config.edd.singleTransactionReview);
    const monthly = config.edd.monthlyVolumeReview === null || config.edd.monthlyVolumeReview === undefined
      ? NaN : Number(config.edd.monthlyVolumeReview);
    if (!underReview) {
      if (Number.isFinite(single) && Number(amount) >= single) {
        await recordRiskSignal(userId, "edd_trigger", {
          trigger: "single_transaction", amount: Number(amount), serviceCode: serviceCode || null,
          monthReceived: usage.received, monthSent: usage.sent
        });
        await writeAuditLog({ actorType: "system", actorId: null, action: "edd_triggered", entityType: "user", entityId: userId, metadata: { trigger: "single_transaction", amount: Number(amount) } });
        return;
      }
      if (Number.isFinite(monthly) && usage.sent + usage.received >= monthly) {
        await recordRiskSignal(userId, "edd_trigger", {
          trigger: "monthly_volume", amount: Number(amount), serviceCode: serviceCode || null,
          monthReceived: usage.received, monthSent: usage.sent
        });
        await writeAuditLog({ actorType: "system", actorId: null, action: "edd_triggered", entityType: "user", entityId: userId, metadata: { trigger: "monthly_volume", amount: Number(amount) } });
        return;
      }
    }

    // Velocity: unusual burst of debits in 24 hours.
    const mon = config.monitoring || {};
    if (riskRank(user.risk_status) < riskRank("elevated")
        && ((Number.isFinite(Number(mon.velocityCount24h)) && today.debitCount >= Number(mon.velocityCount24h))
         || (Number.isFinite(Number(mon.velocityAmount24h)) && today.sent >= Number(mon.velocityAmount24h)))) {
      await recordRiskSignal(userId, "velocity", {
        debitCount24h: today.debitCount, sent24h: today.sent, serviceCode: serviceCode || null
      });
    }

    // Structuring shape: repeated payments just under the single-payment
    // limit. Only meaningful where a limit exists.
    if (tierConfig.singleTransaction && riskRank(user.risk_status) < riskRank("elevated")) {
      const margin = Number(tierConfig.singleTransaction) * (1 - Number(mon.structuringMarginPercent || 10) / 100);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::INT AS near
         FROM transactions
         WHERE user_id = $1 AND status = 'completed' AND direction = 'debit'
           AND amount >= $2 AND amount <= $3
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [userId, margin, Number(tierConfig.singleTransaction)]
      );
      if (rows[0].near >= Number(mon.structuringCount || 5)) {
        await recordRiskSignal(userId, "transaction_pattern", {
          pattern: "repeated_near_limit", count: rows[0].near, limit: Number(tierConfig.singleTransaction)
        });
      }
    }

    // Ongoing CDD for fully verified accounts, on the configured cycle.
    if (tier === 2) {
      if (!user.cdd_reviewed_at) {
        await pool.query("UPDATE users SET cdd_reviewed_at = NOW() WHERE id = $1 AND cdd_reviewed_at IS NULL", [userId]);
      } else {
        const months = Number(config.cdd.reviewMonths || 24);
        const { rows } = await pool.query(
          `SELECT (cdd_reviewed_at < NOW() - ($2 || ' months')::INTERVAL) AS stale FROM users WHERE id = $1`,
          [userId, String(months)]);
        if (rows[0]?.stale) {
          const { rows: openCdd } = await pool.query(
            "SELECT 1 FROM compliance_flags WHERE user_id = $1 AND flag_type = 'ongoing_cdd' AND status = 'open' LIMIT 1", [userId]);
          if (!openCdd[0]) {
            await recordRiskSignal(userId, "unusual_activity", { pattern: "ongoing_cdd_due", monthsSinceReview: months });
            await pool.query(
              "UPDATE compliance_flags SET flag_type = 'ongoing_cdd' WHERE user_id = $1 AND flag_type = 'unusual_activity' AND details->>'pattern' = 'ongoing_cdd_due' AND status = 'open'",
              [userId]);
          }
        }
      }
    }

    await nudgeBeforeLimits(userId, config, tier, tierConfig);
  } catch (error) {
    console.error("[compliance] monitoring failed", { userId, message: error.message });
  }
}

// TIER 1: A VALIDATED IDENTITY DOCUMENT. Not every customer has an SA ID:
// the flow accepts an SA ID number, a passport with its issuing country, or
// another approved identity document, whichever the configured list allows.
// Whatever the document, the number itself is stored only as a salted hash:
// enough to prove it was captured and detect reuse, never in the clear.

// SA ID: thirteen digits, a real date of birth, and the Luhn check digit
// the ID scheme uses.
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

// ISO 3166-1 alpha-2 codes, for validating a passport's issuing country and
// a customer's nationality. Names live in the app; the API stores codes.
const ISO_COUNTRIES = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" "));

function normalizeCountry(value) {
  const code = String(value || "").trim().toUpperCase();
  return ISO_COUNTRIES.has(code) ? code : null;
}

// Passports and other approved documents: alphanumeric, 5 to 20 characters
// once spaces are removed. Formats differ by country, so this is a sanity
// check, not a national format rule.
function normalizeDocumentNumber(value) {
  const cleaned = String(value || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9-]{5,20}$/.test(cleaned)) return null;
  return cleaned;
}

function validDateOfBirth(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const age = (now - date) / (365.25 * 24 * 3600 * 1000);
  if (age < 13 || age > 120) return null;
  return text;
}

// The one Tier 1 door, whatever the document. Collects only what the
// framework needs: an SA ID carries its own date of birth and issuing
// country, so it asks for nothing else; a passport or other approved
// document needs its issuing country and the holder's date of birth.
async function basicVerify(auth, payload = {}) {
  await ensureComplianceSchema();
  const config = await loadComplianceConfig();
  const allowed = Array.isArray(config.identity?.documentTypes) && config.identity.documentTypes.length
    ? config.identity.documentTypes : ["sa_id", "passport", "other"];
  // Requests from app versions before document selection carry only an SA ID
  // number; they stay valid.
  const documentType = String(payload.documentType || (payload.idNumber ? "sa_id" : "")).toLowerCase();
  if (!allowed.includes(documentType)) {
    throw new AppError(400, "Choose the identity document you want to verify with: South African ID, passport, or another approved identity document.");
  }

  let hash;
  let issuingCountry = null;
  let nationality = null;
  let dateOfBirth = null;
  if (documentType === "sa_id") {
    const problem = validateSaIdNumber(payload.idNumber);
    if (problem) throw new AppError(400, problem);
    const digits = String(payload.idNumber).replace(/\s+/g, "");
    // Same salt as always, so existing hashes and screening entries keep
    // matching.
    hash = crypto.createHash("sha256").update(`titopay-id:${digits}`).digest("hex");
    issuingCountry = "ZA";
  } else {
    const number = normalizeDocumentNumber(payload.documentNumber);
    if (!number) throw new AppError(400, "Enter the document number as it appears on the document, letters and digits only.");
    issuingCountry = normalizeCountry(payload.issuingCountry);
    if (!issuingCountry) throw new AppError(400, "Select the country that issued the document.");
    dateOfBirth = validDateOfBirth(payload.dateOfBirth);
    if (!dateOfBirth) throw new AppError(400, "Enter your date of birth as on the document.");
    nationality = normalizeCountry(payload.nationality) || issuingCountry;
    hash = crypto.createHash("sha256").update(`titopay-doc:${documentType}:${issuingCountry}:${number}`).digest("hex");
  }

  const { rows } = await pool.query(
    "SELECT id FROM users WHERE id_number_hash = $1 AND id <> $2 LIMIT 1",
    [hash, auth.userId]
  );
  if (rows[0]) {
    // Trying to register a document that already anchors another account is
    // a duplicate-account indicator. The attempt is flagged for compliance
    // on the ATTEMPTING account; the holder of the document is untouched.
    await recordRiskSignal(auth.userId, "duplicate_account", {
      trigger: "document_reuse_attempt", documentType, issuingCountry
    }).catch(() => {});
    throw new AppError(409, "This identity document is already linked to another TitoPay account. If that is not you, contact support.");
  }

  // THE ASSURANCE STEP. Everything above is TitoPay's own rule: which document
  // types are accepted, the SA ID checksum, the date of birth, and that no
  // other account already claims this document. What it cannot answer is
  // whether the person is who the document says, and that is the question the
  // KYC CAPABILITY answers.
  //
  // It is asked by capability, never by company: `verifyIdentity`, never
  // `verifyWithSomeVendor`. Today the configured adapter is `internal`, which
  // reports assurance "structural" and confirms nothing against a register —
  // which is the honest description of what has always happened here, and why
  // this level's limits are set where they are. The day a verification
  // provider is contracted, KYC_PROVIDER selects it and this call is unchanged.
  //
  // The document number is passed in memory for the check and is NEVER stored:
  // only the salted hash below is written, exactly as before.
  const outcome = await verifyIdentity({
    userId: auth.userId,
    documentType,
    documentNumber: documentType === "sa_id"
      ? String(payload.idNumber || "").replace(/\s+/g, "")
      : normalizeDocumentNumber(payload.documentNumber),
    issuingCountry,
    nationality,
    dateOfBirth
  });
  const assuranceStatus = normalizeVerificationStatus(outcome && outcome.status);

  // A level is granted on "verified" and on nothing else. Anything else is
  // recorded against the account and leaves the customer where they were,
  // because a rung the assurance does not support is a limit TitoPay cannot
  // price. None of these branches can be reached by the internal adapter; they
  // exist so that wiring a real provider is a configuration change and not a
  // rewrite of this function.
  if (assuranceStatus !== "verified") {
    await pool.query(
      `INSERT INTO kyc_verifications (id, user_id, document_type, issuing_country, document_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), auth.userId, documentType, issuingCountry, hash, assuranceStatus]
    );
    await writeAuditLog({
      actorType: "customer",
      actorId: auth.userId,
      action: "basic_verification_not_completed",
      entityType: "user",
      entityId: auth.userId,
      ipAddress: auth.ipAddress,
      userAgent: auth.userAgent,
      // The provider's own wording never travels: only the TitoPay status.
      metadata: { method: documentType, issuingCountry, status: assuranceStatus }
    });
    if (assuranceStatus === "pending" || assuranceStatus === "review_required") {
      // Customer-safe, and it never says who is checking or what was found.
      return { ...(await complianceStatus(auth)), verificationPending: true };
    }
    throw new AppError(422, assuranceStatus === "rejected"
      ? "We could not verify this document. Check the details against the document and try again, or contact Support."
      : "Verification could not be completed right now. Please try again in a few minutes.");
  }

  await pool.query(
    `UPDATE users SET id_number_hash = $1,
        kyc_document_type = $3,
        kyc_issuing_country = $4,
        kyc_nationality = COALESCE($5, kyc_nationality),
        kyc_date_of_birth = COALESCE($6::DATE, kyc_date_of_birth),
        basic_verified_at = COALESCE(basic_verified_at, NOW())
      WHERE id = $2`,
    [hash, auth.userId, documentType, issuingCountry, nationality, dateOfBirth]
  );
  await pool.query(
    `INSERT INTO kyc_verifications (id, user_id, document_type, issuing_country, document_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'verified')`,
    [crypto.randomUUID(), auth.userId, documentType, issuingCountry, hash]
  );
  await writeAuditLog({
    actorType: "customer",
    actorId: auth.userId,
    action: "basic_verification_completed",
    entityType: "user",
    entityId: auth.userId,
    ipAddress: auth.ipAddress,
    userAgent: auth.userAgent,
    metadata: { method: documentType, issuingCountry }
  });
  await screenUser(auth.userId).catch(() => {});
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
    singleTransaction: t.singleTransaction ?? null,
    dailySend: t.dailySend ?? null,
    singleWithdrawal: t.singleWithdrawal ?? null,
    monthlyWithdraw: t.monthlyWithdraw ?? null,
    maxBalance: t.maxBalance ?? null
  };
}

// THE VERIFICATION STATE MACHINE, derived, never stored as its own column:
// account status, fica_status, EDD and the KYC tier already carry the truth
// between them, and deriving keeps the badge in step with the backend by
// construction. Every state here is customer-safe; internal risk ratings
// (elevated, high risk) never surface.
const VERIFICATION_STATES = {
  unverified: "Verify Identity",
  verification_in_progress: "Verification in Progress",
  basic_verified: "✓ Basic Verified",
  fully_verified: "✓ Fully Verified",
  verification_required: "Verification Required",
  under_review: "Under Review",
  edd_required: "More Info Needed",
  verification_failed: "Verification Failed",
  restricted: "Restricted",
  suspended: "Suspended"
};

function verificationStateFor(user, tier) {
  const accountStatus = String(user.status || "").toLowerCase();
  const fica = String(user.fica_status || "").toLowerCase();
  const edd = String(user.edd_status || "").toLowerCase();
  const risk = String(user.risk_status || "normal").toLowerCase();
  // Suspended is its own customer-status, distinct from other restrictions:
  // activity is paused, not merely limited.
  if (accountStatus === "suspended") return "suspended";
  if (BLOCKED_ACCOUNT_STATUSES.has(accountStatus)) return "restricted";
  if (["rejected", "failed", "declined"].includes(fica)) return "verification_failed";
  if (edd === "under_review" || (risk === "edd_review" && edd !== "required")) return "under_review";
  if (edd === "required") return "edd_required";
  if (["required", "reverify", "reverification_required"].includes(fica)) return "verification_required";
  // "pending" is the registration default, not a submission: it never counts
  // as in progress. In progress means documents are actually with the team.
  if (["submitted", "processing", "in_progress", "review", "under_review", "pending_review", "documents_submitted"].includes(fica)) {
    return "verification_in_progress";
  }
  if (tier === 2) return "fully_verified";
  if (tier === 1) return "basic_verified";
  return "unverified";
}

async function complianceStatus(auth) {
  const user = await loadUserComplianceRow(auth.userId);
  if (!user) throw new AppError(404, "Account not found.");
  const config = await loadComplianceConfig();
  const tier = tierForUserRow(user);
  const usage = await monthUsage(auth.userId);
  const current = shapeTier(config, tier);
  const eddActive = ["required", "under_review"].includes(String(user.edd_status || ""))
    || String(user.risk_status || "") === "edd_review";
  const percentOf = (used, limit) => (limit === null || limit === undefined || Number(limit) <= 0)
    ? 0
    : Math.min(100, Math.round((used / Number(limit)) * 100));
  const receivePercent = percentOf(usage.received, current.monthlyReceive);
  const sendPercent = percentOf(usage.sent, current.monthlySend);
  const promptNeeded = tier < 2 && Math.max(receivePercent, sendPercent) >= Number(config.promptAtPercent);
  const verificationState = verificationStateFor(user, tier);
  return {
    tier,
    label: current.label,
    ficaStatus: String(user.fica_status || "none"),
    eddStatus: String(user.edd_status || "none"),
    eddActive,
    verificationState,
    verificationLabel: VERIFICATION_STATES[verificationState] || "Verification",
    // Which document proved the identity, never the document number itself.
    document: user.kyc_document_type
      ? { type: String(user.kyc_document_type), issuingCountry: user.kyc_issuing_country || null }
      : null,
    // Customer-safe review state only. Internal risk ratings (elevated, high
    // risk) are never shown to the account holder.
    underReview: eddActive,
    disclaimer: "These are TitoPay operational limits under its Risk Management and Compliance Programme, reviewed by the compliance team. They are not statutory FICA amounts.",
    verified: tier === 2,
    usage: { ...usage, receivePercent, sendPercent },
    limits: current,
    tiers: [0, 1, 2].map((level) => shapeTier(config, level)),
    promptAtPercent: Number(config.promptAtPercent),
    promptNeeded,
    nextSteps: tier === 2
      ? (eddActive ? ["Send proof of source of funds or income to compliance@titopay.co.za or through Support."] : [])
      : tier === 1
        ? ["Complete full FICA verification: upload your identity document and proof of address under Profile, FICA verification."]
        : ["Verify your identity below with your South African ID, passport or another approved identity document for instant everyday limits.",
           "Then complete full FICA verification under Profile, FICA verification to remove standing limits."]
  };
}

module.exports = {
  ensureComplianceSchema,
  assertBalanceHeadroom,
  assertCanWithdraw,
  setRiskStatus,
  recordRiskSignal,
  screenUser,
  RISK_ORDER,
  loadComplianceConfig,
  saveComplianceConfig,
  listComplianceConfigVersions,
  restoreComplianceConfigVersion,
  tierForUserRow,
  monthUsage,
  // Shared with the limit engine, which builds every effective limit from
  // these primitives rather than re-deriving usage of its own.
  loadUserComplianceRow,
  dayUsage,
  walletBalanceOf,
  assertCanReceiveAmount,
  assertCanSendAmount,
  reviewForEdd,
  basicVerify,
  complianceStatus,
  validateSaIdNumber,
  verificationStateFor,
  VERIFICATION_STATES,
  DEFAULT_CONFIG
};
