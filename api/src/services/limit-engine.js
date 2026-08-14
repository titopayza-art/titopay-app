"use strict";

// THE TITOPAY LIMIT ENGINE.
//
// One place decides what a customer may move, and everything else asks it.
// A limit is never a stand-in for knowing who someone is: verification,
// risk, behaviour and product each contribute, and the answer is a decision
// with the remaining capacity attached, so the app can tell a customer what
// they CAN do rather than only what they cannot.
//
// An effective limit is built in this order, and the order matters:
//
//   1. VERIFICATION   the customer's level sets the baseline capability.
//   2. PRODUCT        a product may cap tighter than the baseline (a gift
//                     is not a merchant settlement). Product rules only
//                     ever narrow, never widen, so a new product cannot
//                     accidentally open the platform up.
//   3. EARNED         a customer with account age and a clean record earns
//                     additional capacity, up to a configured ceiling. This
//                     is what stops legitimate regulars living against a
//                     wall they never asked for.
//   4. RISK           risk is applied LAST and always wins. An elevated or
//                     high risk account is narrowed regardless of how
//                     verified it is or how long it has been here, and a
//                     level with no fixed limit gains one.
//
// None of the numbers here are statutory FICA or SARB thresholds. They are
// TitoPay operational limits under its Risk Management and Compliance
// Programme, set through the admin console, versioned and reversible.
//
// The engine decides; it never moves money and never writes to a wallet.

const { pool } = require("../db/pool");

// Product profiles narrow the baseline for a specific rail. Anything not
// listed simply inherits the customer's level. Configurable: the shape is
// { serviceCode: { singleTransaction, dailySend, monthlySend, monthlyReceive } }.
const DEFAULT_PRODUCT_LIMITS = {
  // A gift is a spontaneous, low-friction rail, so a single gift is capped
  // tighter than a considered transfer even for verified customers.
  send_gift: { singleTransaction: 5000 },
  // Scanned payments happen in seconds, in public, often on a borrowed
  // screen. The per-payment cap is the control that matters here.
  qr_payment: { singleTransaction: 10000 }
};

// How risk narrows capability. `multiplier` scales any fixed limit;
// `ceilings` apply where the level itself has no fixed limit, so a fully
// verified account under review still has a boundary.
const DEFAULT_RISK_BANDS = {
  normal: { multiplier: 1 },
  elevated: {
    multiplier: 0.5,
    ceilings: { singleTransaction: 25000, dailySend: 50000, monthlySend: 100000, monthlyReceive: 100000 }
  },
  high_risk: {
    multiplier: 0.2,
    ceilings: { singleTransaction: 5000, dailySend: 10000, monthlySend: 20000, monthlyReceive: 20000, singleWithdrawal: 5000, monthlyWithdraw: 10000 }
  },
  edd_review: {
    multiplier: 0.5,
    ceilings: { singleTransaction: 25000, dailySend: 50000, monthlySend: 100000, monthlyReceive: 100000 }
  }
};

// Capacity a customer earns by simply being a good customer: an account
// that has been here a while, has moved real money to real people without
// incident, and carries no open compliance flag.
//
// COUNTED CAREFULLY, because a raw transaction count is farmable: two
// accounts pushing a rand back and forth ten times would earn an uplift.
// So the count is of DISTINCT COUNTERPARTIES, each payment must clear a
// minimum value, and payments to the customer's own other wallets do not
// count at all.
const DEFAULT_EARNED_CAPACITY = {
  enabled: true,
  minAccountAgeDays: 60,
  minDistinctCounterparties: 5,
  minTransactionValue: 50,
  multiplier: 1.5,
  // Never earned by an unverified account: capability follows identity
  // first, behaviour second.
  minTier: 1
};

const LIMIT_KEYS = ["monthlyReceive", "monthlySend", "singleTransaction", "dailySend",
  "singleWithdrawal", "monthlyWithdraw", "maxBalance"];

const WITHDRAWAL_SERVICE_CODES = ["withdraw", "withdraw_money_to_bank", "bank_withdrawal",
  "payouts", "business_payout", "merchant_payout"];

function isFixed(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function narrower(current, candidate) {
  if (!isFixed(candidate)) return current;
  if (!isFixed(current)) return Number(candidate);
  return Math.min(Number(current), Number(candidate));
}

// Builds the effective limit set for one customer on one rail, and reports
// how it was reached so the console and the audit trail can show the
// reasoning rather than a bare number.
function buildEffectiveLimits({ config, tier, riskStatus, serviceCode, earned }) {
  const baseline = config.tiers?.[String(tier)] || {};
  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = isFixed(baseline[key]) ? Number(baseline[key]) : null;

  // 2. Product profiles narrow only.
  const products = config.products || DEFAULT_PRODUCT_LIMITS;
  const product = serviceCode ? products[serviceCode] : null;
  if (product) {
    for (const key of LIMIT_KEYS) limits[key] = narrower(limits[key], product[key]);
  }

  // 3. Earned capacity lifts fixed limits, never creates one where the
  //    level already has none, and never applies to withdrawal ceilings
  //    (cash out is where fraud realises, so it stays where verification
  //    put it).
  const earnedMultiplier = earned?.applies ? Number(earned.multiplier) : 1;
  if (earnedMultiplier > 1) {
    for (const key of ["monthlyReceive", "monthlySend", "singleTransaction", "dailySend", "maxBalance"]) {
      if (isFixed(limits[key])) limits[key] = Math.round(Number(limits[key]) * earnedMultiplier);
    }
  }

  // 4. Risk narrows last and always wins.
  const bands = config.riskBands || DEFAULT_RISK_BANDS;
  const band = bands[String(riskStatus || "normal")] || bands.normal || { multiplier: 1 };
  const multiplier = Number(band.multiplier);
  if (Number.isFinite(multiplier) && multiplier < 1) {
    for (const key of LIMIT_KEYS) {
      if (isFixed(limits[key])) limits[key] = Math.round(Number(limits[key]) * multiplier);
    }
  }
  if (band.ceilings) {
    for (const key of LIMIT_KEYS) limits[key] = narrower(limits[key], band.ceilings[key]);
  }

  return {
    limits,
    basis: {
      tier,
      riskStatus: String(riskStatus || "normal"),
      riskMultiplier: Number.isFinite(multiplier) ? multiplier : 1,
      product: product ? serviceCode : null,
      earnedApplied: earnedMultiplier > 1,
      earnedMultiplier
    }
  };
}

// Has this customer earned extra capacity? Account age, a real history of
// completed movements, and nothing open against them.
async function earnedStanding(userId, config, tier) {
  const rules = { ...DEFAULT_EARNED_CAPACITY, ...(config.earnedCapacity || {}) };
  if (!rules.enabled || tier < Number(rules.minTier ?? 1)) return { applies: false, multiplier: 1, rules };
  const { rows } = await pool.query(
    `SELECT
       (SELECT created_at FROM users WHERE id = $1) AS created_at,
       (SELECT COUNT(DISTINCT t.metadata->>'recipientWalletId')::INT
          FROM transactions t
         WHERE t.user_id = $1
           AND t.status = 'completed'
           AND t.direction = 'debit'
           AND t.amount >= $2
           AND t.metadata->>'recipientWalletId' IS NOT NULL
           -- Paying yourself proves nothing, so a wallet this customer
           -- also owns is not a counterparty.
           AND t.metadata->>'recipientWalletId' NOT IN (
             SELECT w.id::TEXT FROM wallets w WHERE w.user_id = $1
           )) AS counterparties,
       (SELECT COUNT(*)::INT FROM compliance_flags WHERE user_id = $1 AND status = 'open') AS open_flags`,
    [userId, Number(rules.minTransactionValue) || 0]
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row || !row.created_at) return { applies: false, multiplier: 1, rules };
  const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86400000;
  const counterparties = Number(row.counterparties || 0);
  const applies = ageDays >= Number(rules.minAccountAgeDays)
    && counterparties >= Number(rules.minDistinctCounterparties)
    && Number(row.open_flags) === 0;
  return { applies, multiplier: applies ? Number(rules.multiplier) : 1, rules, ageDays, counterparties };
}

async function monthlyWithdrawn(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ABS(wl.amount)), 0) AS withdrawn
     FROM wallet_ledger wl
     JOIN wallets w ON w.id = wl.wallet_id
     JOIN transactions t ON t.id = wl.transaction_id
     WHERE w.user_id = $1 AND wl.entry_type = 'debit'
       AND t.service_code = ANY($2::TEXT[])
       AND wl.created_at >= DATE_TRUNC('month', NOW())`,
    [userId, WITHDRAWAL_SERVICE_CODES]
  );
  return Number(rows[0]?.withdrawn || 0);
}

// THE CAPACITY SNAPSHOT: what this customer can still do right now. This is
// what the app shows, and what every refusal quotes, so a customer always
// learns the number that matters instead of a policy statement.
async function capacityFor(userId, { serviceCode = null, includeWithdrawal = false } = {}) {
  const compliance = require("./compliance-service");
  const user = await compliance.loadUserComplianceRow(userId);
  if (!user) return null;
  const config = await compliance.loadComplianceConfig();
  const tier = compliance.tierForUserRow(user);
  const earned = await earnedStanding(userId, config, tier);
  const { limits, basis } = buildEffectiveLimits({
    config, tier, riskStatus: user.risk_status, serviceCode, earned
  });
  const [usage, today, balance] = await Promise.all([
    compliance.monthUsage(userId),
    compliance.dayUsage(userId),
    compliance.walletBalanceOf(userId)
  ]);
  const withdrawn = includeWithdrawal ? await monthlyWithdrawn(userId) : null;
  const left = (limit, used) => (isFixed(limit) ? Math.max(0, Number(limit) - Number(used)) : null);
  return {
    limits,
    basis,
    usage: { received: usage.received, sent: usage.sent, sentToday: today.sent, balance, withdrawnThisMonth: withdrawn },
    remaining: {
      monthlyReceive: left(limits.monthlyReceive, usage.received),
      monthlySend: left(limits.monthlySend, usage.sent),
      dailySend: left(limits.dailySend, today.sent),
      singleTransaction: isFixed(limits.singleTransaction) ? Number(limits.singleTransaction) : null,
      walletBalance: left(limits.maxBalance, balance),
      monthlyWithdraw: withdrawn === null ? null : left(limits.monthlyWithdraw, withdrawn),
      singleWithdrawal: isFixed(limits.singleWithdrawal) ? Number(limits.singleWithdrawal) : null
    }
  };
}

const rand = (value) => `R${Number(value).toFixed(2)}`;

function upgradeHint(tier) {
  return tier >= 2
    ? "Contact Support if you need a review of your current wallet limits."
    : "Open Limits and Verification in your wallet to raise your limits.";
}

// THE DECISION. Amount alone never decides anything: the decision carries
// the reason, the remaining capacity and what would change it, and the
// caller turns that into a refusal, a pending hold or a clean approval.
function decideAgainst({ amount, capacity, tier, checks }) {
  const value = Number(amount || 0);
  for (const check of checks) {
    const limit = capacity.limits[check.key];
    if (!isFixed(limit)) continue;
    const remaining = check.remaining;
    if (remaining !== null && value > remaining) {
      return {
        decision: "decline",
        rule: check.key,
        limit: Number(limit),
        remaining,
        message: check.message(remaining, Number(limit), tier)
      };
    }
  }
  return { decision: "approve" };
}

async function evaluateSend(userId, amount, { serviceCode = null } = {}) {
  const capacity = await capacityFor(userId, { serviceCode });
  if (!capacity) return { decision: "approve" };
  const tier = capacity.basis.tier;
  const outcome = decideAgainst({
    amount, capacity, tier,
    checks: [
      {
        key: "singleTransaction",
        remaining: capacity.remaining.singleTransaction,
        message: (remaining) => `The most you can send in one payment right now is ${rand(remaining)}. ${upgradeHint(tier)}`
      },
      {
        key: "dailySend",
        remaining: capacity.remaining.dailySend,
        message: (remaining) => `You have ${rand(remaining)} of today's sending capacity left. It refreshes over the next 24 hours. ${upgradeHint(tier)}`
      },
      {
        key: "monthlySend",
        remaining: capacity.remaining.monthlySend,
        message: (remaining) => `You have ${rand(remaining)} of this month's sending capacity left. ${upgradeHint(tier)}`
      }
    ]
  });
  return { ...outcome, capacity };
}

async function evaluateReceive(userId, amount, { serviceCode = null } = {}) {
  const capacity = await capacityFor(userId, { serviceCode });
  if (!capacity) return { decision: "approve" };
  const tier = capacity.basis.tier;
  const outcome = decideAgainst({
    amount, capacity, tier,
    checks: [
      {
        key: "monthlyReceive",
        remaining: capacity.remaining.monthlyReceive,
        message: (remaining) => `You have ${rand(remaining)} of this month's receiving capacity left. ${upgradeHint(tier)}`
      },
      {
        key: "maxBalance",
        remaining: capacity.remaining.walletBalance,
        message: (remaining) => `Your wallet can hold ${rand(remaining)} more right now. ${upgradeHint(tier)}`
      }
    ]
  });
  return { ...outcome, capacity };
}

async function evaluateWithdrawal(userId, amount) {
  const capacity = await capacityFor(userId, { includeWithdrawal: true });
  if (!capacity) return { decision: "approve" };
  const tier = capacity.basis.tier;
  const outcome = decideAgainst({
    amount, capacity, tier,
    checks: [
      {
        key: "singleWithdrawal",
        remaining: capacity.remaining.singleWithdrawal,
        message: (remaining) => `The most you can withdraw at once right now is ${rand(remaining)}. ${upgradeHint(tier)}`
      },
      {
        key: "monthlyWithdraw",
        remaining: capacity.remaining.monthlyWithdraw,
        message: (remaining) => `You have ${rand(remaining)} of this month's withdrawal capacity left. ${upgradeHint(tier)}`
      }
    ]
  });
  return { ...outcome, capacity };
}

async function evaluateBalanceHeadroom(userId, amount) {
  const capacity = await capacityFor(userId);
  if (!capacity) return { decision: "approve" };
  const tier = capacity.basis.tier;
  const outcome = decideAgainst({
    amount, capacity, tier,
    checks: [
      {
        key: "maxBalance",
        remaining: capacity.remaining.walletBalance,
        message: (remaining) => `Your wallet can hold ${rand(remaining)} more right now. ${upgradeHint(tier)}`
      }
    ]
  });
  return { ...outcome, capacity };
}

module.exports = {
  capacityFor,
  evaluateSend,
  evaluateReceive,
  evaluateWithdrawal,
  evaluateBalanceHeadroom,
  buildEffectiveLimits,
  earnedStanding,
  DEFAULT_PRODUCT_LIMITS,
  DEFAULT_RISK_BANDS,
  DEFAULT_EARNED_CAPACITY,
  LIMIT_KEYS,
  WITHDRAWAL_SERVICE_CODES
};
