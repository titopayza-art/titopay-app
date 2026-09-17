"use strict";

// Scan-to-Pay environment.
//
// WHAT THIS IS NOT: a second payment engine. TitoPay already has one, in
// src/pos/ — a dynamic-QR system with a state machine that literally contains a
// SCANNED state, a provider adapter base class, eight tables, an idempotency
// guard and a webhook. It debits through the existing wallet. Building a
// parallel ScanToPayService with its own ledger would duplicate all of that.
//
// WHAT THIS IS: the environment around that engine — the feature flag that can
// switch the customer-facing feature off in seconds, the registry that says
// which QR schemes TitoPay can actually accept, and the read-only monitoring
// the Admin Portal needs. It adds no table and moves no money.
//
// The audit that produced this shape also found that Masterpass, SnapScan and
// Zapper do not exist anywhere in the platform — no code, no schema, no config.
// So there are no adapters to preserve, and none are invented here: a scheme
// appears in this registry only once TitoPay holds a real integration with it.

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { getPlatformSetting, setPlatformSetting } = require("./platform-settings-service");

const SETTING_KEY = "scan_to_pay";

// The QR schemes TitoPay can accept, and honestly what state each is in.
//
// `titopay_closed_loop` is the only one live, because it is the only one that
// exists: a TitoPay terminal mints the intent, the QR carries a token, and both
// ends of the payment are TitoPay. Accepting another scheme's QR needs a
// commercial and technical relationship with that scheme — a certification, a
// specification and sandbox credentials — so a scheme is added here when that
// exists and not before. Nothing in this file guesses at a provider's API.
const SCHEMES = {
  titopay_closed_loop: {
    key: "titopay_closed_loop",
    label: "TitoPay QR",
    status: "available",
    dynamic: true,
    static: false,
    description: "A TitoPay terminal creates the payment and the QR carries a single-use token. "
      + "The amount always comes from the server-side intent, never from the QR."
  }
};

// Turned OFF unless something explicitly turns it on.
//
// Two levers, deliberately. SCAN_TO_PAY_ENABLED in the environment is the floor
// — set it false and the feature cannot be switched on from the console at all,
// which is what makes a rollback survive someone toggling a setting back. The
// platform setting is the runtime lever, so the feature can be stopped without
// a redeploy.
function environmentAllows() {
  const raw = String(process.env.SCAN_TO_PAY_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

async function getScanToPayConfig() {
  const { value, updatedAt } = await getPlatformSetting(SETTING_KEY, {});
  const runtimeEnabled = value?.enabled === true;
  const envAllows = environmentAllows();
  return {
    // Both must agree. The environment is the floor; the setting is the switch.
    enabled: envAllows && runtimeEnabled,
    environmentAllows: envAllows,
    runtimeEnabled,
    environment: String(process.env.SCAN_TO_PAY_ENVIRONMENT || "sandbox"),
    schemes: Object.values(SCHEMES),
    updatedAt: updatedAt || null,
    // Says why it is off, so an operator is never left guessing which lever to pull.
    reason: envAllows && runtimeEnabled ? null
      : !envAllows ? "SCAN_TO_PAY_ENABLED is not set to true in the API environment"
        : "Scan to Pay is switched off in Admin settings"
  };
}

async function setScanToPayEnabled(enabled, adminId) {
  const config = await getScanToPayConfig();
  if (enabled && !config.environmentAllows) {
    // Refuse rather than store a setting that will not take effect. A switch
    // that reads "on" while the feature is off is worse than no switch.
    throw new AppError(409,
      "Scan to Pay cannot be switched on here: SCAN_TO_PAY_ENABLED is not true in the API environment.");
  }
  await setPlatformSetting(SETTING_KEY, { enabled: Boolean(enabled) }, adminId);
  return getScanToPayConfig();
}

// Which scheme a scanned payload belongs to, without trusting the payload.
//
// This does no parsing beyond recognising the shape, and deliberately extracts
// no amount, merchant or reference. Those come from the server-side intent when
// the token is resolved — a QR payload is an identifier, never a source of
// financial truth. An unrecognised code is reported as unsupported rather than
// guessed at.
function identifyScheme(payload) {
  const text = String(payload || "").trim();
  if (!text || text.length > 2048) {
    return { supported: false, scheme: null, reason: "That code could not be read." };
  }
  // A TitoPay QR carries the intent token, either bare or in a titopay:// URL.
  const url = text.match(/^titopay:\/\/pay\/([A-Za-z0-9_-]{20,})$/);
  const bare = text.match(/^([A-Za-z0-9_-]{40,})$/);
  const token = url?.[1] || bare?.[1] || null;
  if (token) return { supported: true, scheme: "titopay_closed_loop", token };

  return {
    supported: false,
    scheme: null,
    // The customer-facing wording the brief asks for, and nothing technical.
    reason: "This QR code isn't currently supported by TitoPay."
  };
}

/* ========================================================================== */
/* Monitoring — read-only over the tables the POS engine already writes        */
/* ========================================================================== */

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

async function monitoringOverview({ days = 30 } = {}) {
  const window = Math.min(365, Math.max(1, Number(days) || 30));
  const [totals, providers, failures] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS value
         FROM pos_payment_intents
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY status`, [String(window)]),
    pool.query(
      `SELECT provider,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM pos_payment_intents
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY provider`, [String(window)]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM pos_provider_events
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`, [String(window)])
      .catch(() => ({ rows: [{ n: 0 }] }))
  ]);

  const byStatus = new Map(totals.rows.map((row) => [row.status, row]));
  const count = (status) => Number(byStatus.get(status)?.n || 0);
  const value = (status) => money(byStatus.get(status)?.value || 0);
  const total = totals.rows.reduce((sum, row) => sum + Number(row.n), 0);
  const completed = count("COMPLETED");

  return {
    windowDays: window,
    cards: {
      total,
      completed,
      failed: count("FAILED"),
      pending: count("PENDING") + count("SCANNED") + count("AUTHORIZED") + count("PROCESSING"),
      cancelled: count("CANCELLED"),
      expired: count("EXPIRED"),
      reversed: count("REVERSED") + count("REFUNDED"),
      valueCompleted: value("COMPLETED"),
      successRate: total > 0 ? Math.round((completed / total) * 1000) / 10 : null,
      // Reported as null rather than 0% when there is nothing to divide by,
      // because "0% failure" and "no traffic" are different facts.
      failureRate: total > 0 ? Math.round((count("FAILED") / total) * 1000) / 10 : null,
      providerEvents: Number(failures.rows[0]?.n || 0)
    },
    providers: providers.rows.map((row) => ({
      provider: row.provider,
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      successRate: row.total > 0 ? Math.round((row.completed / row.total) * 1000) / 10 : null
    }))
  };
}

// Recent payments for the Admin table. Deliberately never selects the QR token
// hash, and never joins anything that would expose provider credentials.
async function recentPayments({ status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(String(status).toUpperCase());
    conditions.push(`p.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pos_payment_intents p ${where}`, params);
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));

  const { rows } = await pool.query(
    `SELECT p.payment_id, p.status, p.amount, p.currency, p.merchant_reference,
            p.provider, p.created_at, p.updated_at, p.expires_at,
            p.transaction_reference, p.failure_reason, p.cancellation_reason,
            m.business_name, t.terminal_id AS terminal_code,
            u.username AS customer_username
       FROM pos_payment_intents p
       LEFT JOIN merchants m ON m.id = p.merchant_id
       LEFT JOIN pos_terminals t ON t.id = p.terminal_id
       LEFT JOIN users u ON u.id = p.customer_id
       ${where}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  return {
    total: totalResult.rows[0].n,
    items: rows.map((row) => ({
      paymentId: row.payment_id,
      status: row.status,
      amount: money(row.amount),
      currency: row.currency,
      merchantName: row.business_name || null,
      merchantReference: row.merchant_reference,
      terminalId: row.terminal_code || null,
      provider: row.provider,
      // A username, not an email or a phone number. Monitoring a payment does
      // not require the customer's contact details.
      customer: row.customer_username || null,
      transactionReference: row.transaction_reference || null,
      // Shown so an operator can see WHY a payment failed without opening the
      // provider event log. Both are written by the POS engine, not by us.
      failureReason: row.failure_reason || row.cancellation_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at
    }))
  };
}

module.exports = {
  SETTING_KEY, SCHEMES,
  environmentAllows, getScanToPayConfig, setScanToPayEnabled, identifyScheme,
  monitoringOverview, recentPayments
};
