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
      singleTransaction: 2500,
      dailySend: 4000,
      singleWithdrawal: 1000,
      monthlyWithdraw: 3000,
      maxBalance: 25000
    },
    1: {
      label: "Basic verified",
      description: "SA ID verified. Everyday wallet limits.",
      monthlyReceive: 50000,
      monthlySend: 50000,
      singleTransaction: 25000,
      dailySend: 20000,
      singleWithdrawal: 10000,
      monthlyWithdraw: 40000,
      maxBalance: 100000
    },
    2: {
      label: "Fully verified",
      description: "Full FICA verification for higher balances, larger payments and withdrawals. Activity stays subject to ongoing monitoring.",
      monthlyReceive: null,
      monthlySend: null,
      singleTransaction: null,
      dailySend: null,
      singleWithdrawal: null,
      monthlyWithdraw: null,
      maxBalance: null
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
  // normal < elevated < high_risk < edd_review.
  riskSignals: {
    unusual_activity: "elevated",
    transaction_pattern: "elevated",
    velocity: "elevated",
    sanctions_screening: "high_risk",
    source_of_funds: "edd_review",
    edd_trigger: "edd_review",
    manual: "high_risk"
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
    "SELECT id, full_name, username, account_type, status, fica_status, basic_verified_at, edd_status, risk_status, cdd_reviewed_at FROM users WHERE id = $1",
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
  const maxBalance = config.tiers[String(tier)]?.maxBalance;
  if (maxBalance !== null && maxBalance !== undefined) {
    const balance = await walletBalanceOf(recipientUserId);
    if (balance + Number(amount || 0) > Number(maxBalance)) {
      throw new AppError(403, selfView
        ? `Your wallet can hold up to R${Number(maxBalance).toFixed(2)} at its current verification level. Raise the limit under Limits and Verification.`
        : `This recipient's wallet can hold up to R${Number(maxBalance).toFixed(2)} at its current verification level, and this payment would go past that.`);
    }
  }
}

// Wallet balance cap for credits that do not pass through the transfer rails
// (card top-ups). Checked before the customer is sent to the card page.
async function assertBalanceHeadroom(userId, amount) {
  const user = await loadUserComplianceRow(userId);
  if (!user) return;
  const config = await loadComplianceConfig();
  const maxBalance = config.tiers[String(tierForUserRow(user))]?.maxBalance;
  if (maxBalance === null || maxBalance === undefined) return;
  const balance = await walletBalanceOf(userId);
  if (balance + Number(amount || 0) > Number(maxBalance)) {
    throw new AppError(403,
      `Your wallet can hold up to R${Number(maxBalance).toFixed(2)} at its current verification level, and this top up would go past that. Raise the limit under Limits and Verification.`);
  }
}

// Withdrawal limits for the actor's tier: per withdrawal and per month.
async function assertCanWithdraw(userId, amount) {
  const user = await loadUserComplianceRow(userId);
  if (!user) return;
  const config = await loadComplianceConfig();
  const tier = tierForUserRow(user);
  const tierConfig = config.tiers[String(tier)] || {};
  const value = Number(amount || 0);
  if (tierConfig.singleWithdrawal !== null && tierConfig.singleWithdrawal !== undefined
      && value > Number(tierConfig.singleWithdrawal)) {
    throw new AppError(403,
      `A single withdrawal at your verification level can be up to R${Number(tierConfig.singleWithdrawal).toFixed(2)}. ${upgradeSentence(tier)}`);
  }
  if (tierConfig.monthlyWithdraw !== null && tierConfig.monthlyWithdraw !== undefined) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(ABS(wl.amount)), 0) AS withdrawn
       FROM wallet_ledger wl
       JOIN wallets w ON w.id = wl.wallet_id
       JOIN transactions t ON t.id = wl.transaction_id
       WHERE w.user_id = $1 AND wl.entry_type = 'debit'
         AND t.service_code IN ('withdraw', 'withdraw_money_to_bank', 'bank_withdrawal', 'payouts', 'business_payout', 'merchant_payout')
         AND wl.created_at >= DATE_TRUNC('month', NOW())`,
      [userId]
    );
    if (Number(rows[0].withdrawn) + value > Number(tierConfig.monthlyWithdraw)) {
      throw new AppError(403,
        `You have withdrawn R${Number(rows[0].withdrawn).toFixed(2)} this month, and your verification level allows up to R${Number(tierConfig.monthlyWithdraw).toFixed(2)}. ${upgradeSentence(tier)}`);
    }
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
  if (tierConfig.dailySend !== null && tierConfig.dailySend !== undefined) {
    const today = await dayUsage(userId);
    if (today.sent + value > Number(tierConfig.dailySend)) {
      throw new AppError(403,
        `You have sent R${today.sent.toFixed(2)} in the last 24 hours, and your verification level allows up to R${Number(tierConfig.dailySend).toFixed(2)} a day. ${upgradeSentence(tier)}`);
    }
  }
  if (tierConfig.monthlySend !== null && tierConfig.monthlySend !== undefined) {
    const usage = await monthUsage(userId);
    if (usage.sent + value > Number(tierConfig.monthlySend)) {
      throw new AppError(403,
        `You have sent R${usage.sent.toFixed(2)} this month, and your verification level allows up to R${Number(tierConfig.monthlySend).toFixed(2)}. ${upgradeSentence(tier)}`);
    }
  }
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
    const tierConfig = config.tiers[String(tier)] || {};
    const usage = await monthUsage(userId);
    const today = await dayUsage(userId);

    // High-value marks raise EDD, once while a review is open.
    const underReview = riskRank(user.risk_status) >= riskRank("edd_review");
    const single = Number(config.edd.singleTransactionReview);
    const monthly = Number(config.edd.monthlyVolumeReview);
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
  const eddActive = ["required", "under_review"].includes(String(user.edd_status || ""))
    || String(user.risk_status || "") === "edd_review";
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
        ? ["Complete full FICA verification: upload your ID document and proof of address under Profile, FICA verification."]
        : ["Verify your SA ID number below for instant everyday limits.",
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
