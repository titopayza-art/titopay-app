"use strict";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");

// DUAL AUTHORISATION FOR THE TWO ADMIN ACTIONS THAT MOVE OR RE-PRICE
// CUSTOMER MONEY.
//
// The internal readiness report and the August 2026 regulatory audit both
// list the same control gap: a single authorised admin could reverse a
// customer transaction or rewrite the limit framework alone. This service
// closes it. A gated action is captured as a REQUEST; a SECOND, DIFFERENT
// administrator approves it, and only the approval executes it. The
// requester can cancel their own request but can never approve it - refused
// in code and by a database CHECK, so no session bug can self-approve.
//
// What is gated, and how much:
//   transaction_reversal  when the transaction's total >= reversalMinAmount
//                         (configurable; default R1,000 - below that the
//                         existing single-admin path with a reason and an
//                         integrity alert continues unchanged)
//   limit_change          always, while limitChanges stays true (default)
//   pricing_change        a change to a PROTECTED fee rule (the settlement
//                         fee, pos_settlement), while settlementFeeChanges
//                         stays true (default). The settlement fee is skimmed
//                         from every merchant payout, so re-pricing it moves
//                         money exactly as a limit change does; every OTHER
//                         pricing rule keeps its existing single-super-admin
//                         path unchanged.
//
// Execution happens through the SAME services that own these actions today
// (reverseTransaction, saveComplianceConfig) - this file adds a second pair
// of eyes, never a second code path for money. The decide-once conditional
// UPDATE pattern used across the platform applies here too, so two admins
// approving simultaneously execute exactly once.
//
// Config lives in platform_settings under "dual_auth_config":
//   { "reversalMinAmount": 1000, "limitChanges": true }
// Setting reversalMinAmount to 0 gates every reversal. An installation with
// a single administrator should create a second admin account in Staff
// Management - that is the point of the control, not a defect in it.

const DUAL_AUTH_CONFIG_KEY = "dual_auth_config";
const DEFAULT_CONFIG = { reversalMinAmount: 1000, limitChanges: true, settlementFeeChanges: true };
const ACTION_TYPES = new Set(["transaction_reversal", "limit_change", "pricing_change"]);
// Fee rules whose re-pricing directly re-prices money already owed to
// merchants. Kept deliberately narrow: only the settlement fee is gated, so
// routine pricing edits (QR fees, service fees) are untouched.
const PROTECTED_FEE_CODES = new Set(["pos_settlement"]);

let dualAuthSchemaReady = false;

async function ensureDualAuthSchema(queryable = pool) {
  if (dualAuthSchemaReady && queryable === pool) return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS admin_dual_auth_requests (
      id UUID PRIMARY KEY,
      action_type TEXT NOT NULL CHECK (action_type IN ('transaction_reversal', 'limit_change', 'pricing_change')),
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      summary TEXT NOT NULL,
      amount NUMERIC(18,2),
      requested_by UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'executed', 'declined', 'cancelled', 'failed')),
      decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      decision_note TEXT,
      executed_at TIMESTAMPTZ,
      execution_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT dual_auth_second_admin CHECK (decided_by IS NULL OR status = 'cancelled' OR decided_by <> requested_by)
    )
  `);
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_dual_auth_status ON admin_dual_auth_requests (status, created_at DESC)"
  );
  // A table created before build 100 carries the two-value CHECK. Widen it to
  // admit 'pricing_change' in one transactional DO block (existing rows are
  // all in the old set, so the re-validation always passes), and NEVER let it
  // be fatal - if the widening cannot happen, pricing dual-auth simply stays
  // unavailable while every existing action keeps working.
  try {
    await queryable.query(`
      DO $$
      BEGIN
        ALTER TABLE admin_dual_auth_requests
          DROP CONSTRAINT IF EXISTS admin_dual_auth_requests_action_type_check;
        ALTER TABLE admin_dual_auth_requests
          ADD CONSTRAINT admin_dual_auth_requests_action_type_check
          CHECK (action_type IN ('transaction_reversal', 'limit_change', 'pricing_change'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  } catch (error) {
    console.error("[dual-auth] could not widen action_type CHECK to include pricing_change", { message: error.message });
  }
  if (queryable === pool) dualAuthSchemaReady = true;
}

async function getDualAuthConfig() {
  await ensureDualAuthSchema();
  try {
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1", [DUAL_AUTH_CONFIG_KEY]);
    const stored = rows[0]?.value || {};
    const minAmount = Number(stored.reversalMinAmount);
    return {
      reversalMinAmount: Number.isFinite(minAmount) && minAmount >= 0 ? minAmount : DEFAULT_CONFIG.reversalMinAmount,
      limitChanges: stored.limitChanges === undefined ? DEFAULT_CONFIG.limitChanges : Boolean(stored.limitChanges),
      settlementFeeChanges: stored.settlementFeeChanges === undefined ? DEFAULT_CONFIG.settlementFeeChanges : Boolean(stored.settlementFeeChanges)
    };
  } catch {
    // Config must never make the gate undecidable: unreadable settings mean
    // the conservative defaults apply.
    return { ...DEFAULT_CONFIG };
  }
}

async function requiresReversalDualAuth(amount) {
  const config = await getDualAuthConfig();
  return Number(amount || 0) >= config.reversalMinAmount;
}

async function requiresLimitChangeDualAuth() {
  const config = await getDualAuthConfig();
  return config.limitChanges;
}

// True only for a protected fee rule while the control is enabled. A
// non-protected service code (every routine pricing rule) returns false, so
// its update path is completely unchanged.
async function requiresPricingChangeDualAuth(serviceCode) {
  if (!PROTECTED_FEE_CODES.has(String(serviceCode || "").trim().toLowerCase())) return false;
  const config = await getDualAuthConfig();
  return config.settlementFeeChanges;
}

function publicRequest(row = {}) {
  return {
    id: row.id,
    actionType: row.action_type,
    summary: row.summary,
    amount: row.amount == null ? null : Number(row.amount),
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name || "",
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || "",
    decisionNote: row.decision_note || "",
    executionError: row.execution_error || "",
    createdAt: row.created_at,
    decidedAt: row.decided_at || null
  };
}

async function createRequest({ actionType, payload = {}, summary, amount = null, adminId, meta = {} }) {
  await ensureDualAuthSchema();
  if (!ACTION_TYPES.has(actionType)) throw new AppError(400, "Unknown dual-authorisation action");
  const text = String(summary || "").trim().slice(0, 300);
  if (!text) throw new AppError(400, "A summary of the requested action is required");
  const { rows } = await pool.query(
    `INSERT INTO admin_dual_auth_requests (id, action_type, payload, summary, amount, requested_by)
     VALUES ($1, $2, $3::JSONB, $4, $5, $6) RETURNING *`,
    [uuidv4(), actionType, JSON.stringify(payload), text, amount, adminId]
  );
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "dual_auth_requested", entityType: "dual_auth_request", entityId: rows[0].id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { actionType, summary: text, amount }
  });
  return publicRequest(rows[0]);
}

async function listRequests({ status = "pending", limit = 50 } = {}) {
  await ensureDualAuthSchema();
  const params = [Math.min(200, Math.max(1, Number(limit) || 50))];
  const where = [];
  if (status && status !== "all") { params.push(status); where.push(`r.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT r.*, requester.full_name AS requested_by_name, decider.full_name AS decided_by_name
       FROM admin_dual_auth_requests r
       LEFT JOIN admin_users requester ON requester.id = r.requested_by
       LEFT JOIN admin_users decider ON decider.id = r.decided_by
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.created_at DESC LIMIT $1`,
    params
  );
  return rows.map(publicRequest);
}

// Execution goes through the services that own these actions. Lazy requires,
// matching the codebase convention, and each executor receives the APPROVER
// as the acting admin - the record then shows requester and approver as two
// different people, which is the whole point.
async function executeAction(row, approverId) {
  const payload = row.payload || {};
  if (row.action_type === "transaction_reversal") {
    const { reverseTransaction } = require("./transaction-service");
    const transaction = await reverseTransaction(payload.transactionId, { userId: approverId });
    await require("./money-integrity-service").raiseAlert({
      alertType: "manual_reversal", severity: "info",
      fingerprint: `manual_reversal:${payload.transactionId}`,
      userId: transaction?.user_id || null, transactionId: payload.transactionId,
      details: {
        reason: payload.reason || "not stated",
        requestedBy: row.requested_by, approvedBy: approverId, dualAuthRequestId: row.id
      }
    }).catch(() => {});
    return { transactionId: payload.transactionId };
  }
  if (row.action_type === "limit_change") {
    const compliance = require("./compliance-service");
    await compliance.saveComplianceConfig({ userId: approverId }, payload.config || {}, {
      reason: `${payload.reason || "not stated"} (requested by another admin; dual-auth ${row.id})`
    });
    return { applied: true };
  }
  if (row.action_type === "pricing_change") {
    // The same updatePricingRule the route would have called directly - the
    // approver is the acting admin, so the audit record shows two people.
    const { updatePricingRule } = require("./pricing-service");
    const updated = await updatePricingRule(payload.pricingRuleId, payload.pricingPayload || {}, {
      userType: "admin", userId: approverId
    });
    return { pricingRuleId: payload.pricingRuleId, serviceCode: payload.serviceCode || updated.service_code };
  }
  throw new AppError(400, "Unknown dual-authorisation action");
}

async function approveRequest(requestId, adminId, meta = {}) {
  await ensureDualAuthSchema();
  const { rows: pendingRows } = await pool.query(
    "SELECT * FROM admin_dual_auth_requests WHERE id = $1", [requestId]);
  const pending = pendingRows[0];
  if (!pending) throw new AppError(404, "Approval request not found");
  if (pending.requested_by === adminId) {
    throw new AppError(403, "A different administrator must approve this request - you raised it.");
  }
  // Decide-once: claiming the request and recording the approver happens in
  // one conditional UPDATE, so two simultaneous approvers execute once.
  const { rows } = await pool.query(
    `UPDATE admin_dual_auth_requests
        SET decided_by = $2, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND requested_by <> $2
      RETURNING *`,
    [requestId, adminId]
  );
  if (!rows[0]) throw new AppError(409, "This request has already been decided.");
  const claimed = rows[0];
  let result = null;
  try {
    result = await executeAction(claimed, adminId);
    await pool.query(
      "UPDATE admin_dual_auth_requests SET status = 'executed', executed_at = NOW(), updated_at = NOW() WHERE id = $1",
      [requestId]);
  } catch (error) {
    await pool.query(
      "UPDATE admin_dual_auth_requests SET status = 'failed', execution_error = $2, updated_at = NOW() WHERE id = $1",
      [requestId, String(error.message || error).slice(0, 300)]).catch(() => {});
    await writeSecurityLog({
      actorType: "admin", actorId: adminId, eventType: "dual_auth_execution_failed", severity: "warning",
      description: `Dual-auth request ${requestId} approved but execution failed: ${String(error.message || error).slice(0, 200)}`
    }).catch(() => {});
    throw error;
  }
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "dual_auth_approved_and_executed", entityType: "dual_auth_request", entityId: requestId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { actionType: claimed.action_type, requestedBy: claimed.requested_by, summary: claimed.summary }
  });
  return { request: publicRequest({ ...claimed, status: "executed" }), result };
}

async function declineRequest(requestId, adminId, note, meta = {}) {
  await ensureDualAuthSchema();
  const text = String(note || "").trim().slice(0, 300);
  if (!text) throw new AppError(400, "State why this request is declined - it becomes part of the record.");
  const { rows } = await pool.query(
    `UPDATE admin_dual_auth_requests
        SET status = 'declined', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND requested_by <> $2
      RETURNING *`,
    [requestId, adminId, text]
  );
  if (!rows[0]) throw new AppError(409, "This request is not yours to decline, or has already been decided.");
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "dual_auth_declined", entityType: "dual_auth_request", entityId: requestId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { note: text, requestedBy: rows[0].requested_by }
  });
  return publicRequest(rows[0]);
}

async function cancelRequest(requestId, adminId, meta = {}) {
  await ensureDualAuthSchema();
  const { rows } = await pool.query(
    `UPDATE admin_dual_auth_requests
        SET status = 'cancelled', decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND requested_by = $2
      RETURNING *`,
    [requestId, adminId]
  );
  if (!rows[0]) throw new AppError(409, "Only the requester can cancel, and only while the request is pending.");
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "dual_auth_cancelled", entityType: "dual_auth_request", entityId: requestId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { summary: rows[0].summary }
  });
  return publicRequest(rows[0]);
}

module.exports = {
  ensureDualAuthSchema,
  getDualAuthConfig,
  requiresReversalDualAuth,
  requiresLimitChangeDualAuth,
  requiresPricingChangeDualAuth,
  createRequest,
  listRequests,
  approveRequest,
  declineRequest,
  cancelRequest
};
