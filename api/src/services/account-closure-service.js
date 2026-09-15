const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");

// A customer asks for their TitoPay account/profile to be closed; an admin
// decides. Deliberately NOT self-service deletion: money must be settled first,
// FICA records must be retained, and a wrong click must be recoverable. The
// shape (runtime-ensured schema, pending -> decided workflow, support-desk
// review) mirrors profile_change_requests, the proven pipeline beside it.
//
// Approval sets users.status = 'closed' and revokes every session: sign-in is
// refused by assertActive and live tokens die at the next request's status
// re-check. No row is deleted — closure is containment plus record retention,
// and an admin can reopen a mistakenly closed account by setting the status
// back to active.

let closureSchemaReady = false;

async function ensureClosureSchema(queryable = pool) {
  if (closureSchemaReady && queryable === pool) return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS account_closure_requests (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
      reason TEXT,
      balance_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
      decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      decision_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS idx_account_closure_requests_status ON account_closure_requests (status, created_at ASC)"
  );
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS idx_account_closure_requests_user ON account_closure_requests (user_id, created_at DESC)"
  );
  // One open request per customer, enforced by the database rather than a
  // read-then-insert that two taps could race.
  await queryable.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_account_closure_requests_one_pending
     ON account_closure_requests (user_id) WHERE status = 'pending'`
  );
  if (queryable === pool) closureSchemaReady = true;
}

function publicRequest(row = {}) {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason || "",
    decisionNote: row.decision_note || "",
    requestedAt: row.created_at,
    decidedAt: row.decided_at || null
  };
}

async function spendableBalance(userId, queryable = pool) {
  const { rows } = await queryable.query(
    `SELECT COALESCE(SUM(available_balance), 0) AS available,
            COALESCE(SUM(reserved_balance), 0) AS reserved
     FROM wallets
     WHERE user_id = $1 AND kind <> 'system'`,
    [userId]
  );
  return {
    available: Number(rows[0]?.available || 0),
    reserved: Number(rows[0]?.reserved || 0)
  };
}

async function createClosureRequest(userId, payload = {}, meta = {}) {
  await ensureClosureSchema();
  const { rows: userRows } = await pool.query(
    "SELECT id, status, full_name, username FROM users WHERE id = $1 LIMIT 1",
    [userId]
  );
  if (!userRows[0]) throw new AppError(404, "Account not found");
  const balances = await spendableBalance(userId);
  const reason = String(payload.reason || "").trim().slice(0, 500);
  const id = uuidv4();
  try {
    await pool.query(
      `INSERT INTO account_closure_requests (id, user_id, reason, balance_snapshot)
       VALUES ($1, $2, $3, $4::JSONB)`,
      [id, userId, reason || null, JSON.stringify(balances)]
    );
  } catch (error) {
    // The partial unique index answers the double-submit: surface it as the
    // friendly state it is, not a database error.
    if (String(error.code) === "23505") {
      throw new AppError(409, "You already have a closure request waiting for review. Our team will be in touch.");
    }
    throw error;
  }
  await writeAuditLog({
    actorType: "customer",
    actorId: userId,
    action: "account_closure_requested",
    entityType: "account_closure_request",
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { balances, hasReason: Boolean(reason) }
  }).catch(() => {});
  await writeSecurityLog({
    actorType: "customer",
    actorId: userId,
    eventType: "account_closure_requested",
    severity: "info",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { requestId: id }
  }).catch(() => {});
  const { rows } = await pool.query("SELECT * FROM account_closure_requests WHERE id = $1", [id]);
  return publicRequest(rows[0]);
}

async function getOwnClosureRequest(userId) {
  await ensureClosureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM account_closure_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] ? publicRequest(rows[0]) : null;
}

async function cancelOwnClosureRequest(userId, meta = {}) {
  await ensureClosureSchema();
  // Atomic: only a still-pending request can be withdrawn, and only once.
  const { rows } = await pool.query(
    `UPDATE account_closure_requests
     SET status = 'cancelled', updated_at = NOW()
     WHERE user_id = $1 AND status = 'pending'
     RETURNING *`,
    [userId]
  );
  if (!rows[0]) throw new AppError(404, "You have no closure request waiting for review.");
  await writeAuditLog({
    actorType: "customer",
    actorId: userId,
    action: "account_closure_cancelled",
    entityType: "account_closure_request",
    entityId: rows[0].id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent
  }).catch(() => {});
  return publicRequest(rows[0]);
}

async function listClosureRequests(status = "") {
  await ensureClosureSchema();
  const wanted = String(status || "").trim().toLowerCase();
  const filter = ["pending", "approved", "declined", "cancelled"].includes(wanted) ? wanted : null;
  const { rows } = await pool.query(
    `SELECT r.*,
            u.full_name, u.username, u.email, u.phone, u.account_type, u.status AS user_status,
            COALESCE((SELECT SUM(w.available_balance) FROM wallets w WHERE w.user_id = u.id AND w.kind <> 'system'), 0) AS live_available,
            COALESCE((SELECT SUM(w.reserved_balance) FROM wallets w WHERE w.user_id = u.id AND w.kind <> 'system'), 0) AS live_reserved
     FROM account_closure_requests r
     JOIN users u ON u.id = r.user_id
     WHERE ($1::TEXT IS NULL OR r.status = $1)
     ORDER BY (r.status = 'pending') DESC, r.created_at ASC
     LIMIT 200`,
    [filter]
  );
  return rows.map((row) => ({
    ...publicRequest(row),
    user: {
      id: row.user_id,
      fullName: row.full_name,
      username: row.username,
      email: row.email,
      phone: row.phone,
      accountType: row.account_type,
      status: row.user_status
    },
    balances: {
      available: Number(row.live_available || 0),
      reserved: Number(row.live_reserved || 0)
    }
  }));
}

async function approveClosureRequest(id, adminId, meta = {}) {
  await ensureClosureSchema();
  const client = await pool.connect();
  let approved;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM account_closure_requests WHERE id = $1 FOR UPDATE",
      [id]
    );
    const request = rows[0];
    if (!request) throw new AppError(404, "Closure request not found");
    if (request.status !== "pending") throw new AppError(409, `That request was already ${request.status}`);
    // MONEY BEFORE CLOSURE. A wallet holding funds must be settled (withdrawn,
    // transferred or adjusted through the existing admin tools) before the
    // profile closes — closing over a balance strands the customer's money.
    const balances = await spendableBalance(request.user_id, client);
    if (balances.available > 0 || balances.reserved > 0) {
      throw new AppError(409,
        `This customer still holds R${balances.available.toFixed(2)} available`
        + (balances.reserved > 0 ? ` and R${balances.reserved.toFixed(2)} reserved` : "")
        + ". Settle the wallet to zero before approving the closure.");
    }
    await client.query("UPDATE users SET status = 'closed', updated_at = NOW() WHERE id = $1", [request.user_id]);
    await client.query(
      `UPDATE sessions
       SET revoked_at = NOW(), revoked_reason = 'account_closed'
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [request.user_id]
    );
    const { rows: updated } = await client.query(
      `UPDATE account_closure_requests
       SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, adminId, String(meta.note || "").trim().slice(0, 500) || null]
    );
    approved = updated[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await writeAuditLog({
    actorType: "admin",
    actorId: adminId,
    action: "account_closure_approved",
    entityType: "account_closure_request",
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { userId: approved.user_id }
  }).catch(() => {});
  await writeSecurityLog({
    actorType: "admin",
    actorId: adminId,
    eventType: "account_closed",
    severity: "warning",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { userId: approved.user_id, requestId: id }
  }).catch(() => {});
  return publicRequest(approved);
}

async function declineClosureRequest(id, adminId, note = "", meta = {}) {
  await ensureClosureSchema();
  const decisionNote = String(note || "").trim().slice(0, 500);
  if (!decisionNote) throw new AppError(400, "A short note to the customer is required when declining");
  // Atomic pending-only decision, same rule as every other decide-once flow.
  const { rows } = await pool.query(
    `UPDATE account_closure_requests
     SET status = 'declined', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, adminId, decisionNote]
  );
  if (!rows[0]) throw new AppError(409, "That request was already decided");
  await writeAuditLog({
    actorType: "admin",
    actorId: adminId,
    action: "account_closure_declined",
    entityType: "account_closure_request",
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { userId: rows[0].user_id }
  }).catch(() => {});
  return publicRequest(rows[0]);
}

module.exports = {
  ensureClosureSchema,
  createClosureRequest,
  getOwnClosureRequest,
  cancelOwnClosureRequest,
  listClosureRequests,
  approveClosureRequest,
  declineClosureRequest
};
