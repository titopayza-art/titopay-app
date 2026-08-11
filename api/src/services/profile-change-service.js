const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

const REQUEST_STATUSES = new Set(["pending", "in_review", "approved", "rejected"]);

let profileChangeSchemaReady = false;

async function ensureProfileChangeSchema(queryable = pool) {
  if (profileChangeSchemaReady && queryable === pool) return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS profile_change_requests (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
      requested_changes JSONB NOT NULL DEFAULT '{}'::JSONB,
      current_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
      support_notes TEXT,
      reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      due_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryable.query("CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status ON profile_change_requests (status, due_at ASC)");
  await queryable.query("CREATE INDEX IF NOT EXISTS idx_profile_change_requests_user ON profile_change_requests (user_id, created_at DESC)");
  if (queryable === pool) profileChangeSchemaReady = true;
}

function normalizeText(value, max = 160) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, max) : "";
}

function normalizeEmail(value) {
  const text = normalizeText(value, 254).toLowerCase();
  if (!text) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new AppError(400, "Enter a valid email address");
  return text;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    if (!/^\+27\d{9}$/.test(`+${digits}`)) throw new AppError(400, "Enter a valid South African +27 cellphone number");
    return `+${digits}`;
  }
  if (/^0\d{9}$/.test(digits)) return `+27${digits.slice(1)}`;
  if (/^27\d{9}$/.test(digits)) return `+${digits}`;
  throw new AppError(400, "Enter a valid South African +27 cellphone number");
}

function normalizeUsername(value) {
  const text = normalizeText(value, 32).replace(/^@/, "").toLowerCase();
  if (!text) return "";
  if (!/^[a-z0-9_]{3,32}$/.test(text)) throw new AppError(400, "Username must be 3 to 32 characters using letters, numbers or underscores");
  return text;
}

function normalizeRequestedChanges(payload = {}, accountType = "personal") {
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(payload, "fullName")) changes.fullName = normalizeText(payload.fullName, 160);
  if (Object.prototype.hasOwnProperty.call(payload, "username")) changes.username = normalizeUsername(payload.username);
  if (Object.prototype.hasOwnProperty.call(payload, "email")) changes.email = normalizeEmail(payload.email);
  if (Object.prototype.hasOwnProperty.call(payload, "phone")) changes.phone = normalizePhone(payload.phone);
  if (accountType === "business" && Object.prototype.hasOwnProperty.call(payload, "businessName")) {
    changes.businessName = normalizeText(payload.businessName, 180);
  }
  Object.keys(changes).forEach((key) => {
    if (!changes[key]) delete changes[key];
  });
  return changes;
}

function snapshotFromRows(user = {}, merchant = {}) {
  return {
    fullName: user.full_name || "",
    username: user.username || "",
    email: user.email || "",
    phone: user.phone || "",
    accountType: user.account_type || "",
    businessName: merchant?.business_name || ""
  };
}

function diffChanges(current, requested) {
  const changed = {};
  Object.entries(requested).forEach(([key, value]) => {
    const currentValue = String(current[key] || "").trim();
    if (String(value || "").trim() !== currentValue) changed[key] = value;
  });
  return changed;
}

async function assertNoDuplicateIdentifiers(changes, userId, queryable = pool) {
  const checks = [];
  if (changes.username) checks.push(["username", changes.username]);
  if (changes.email) checks.push(["email", changes.email]);
  if (changes.phone) checks.push(["phone", changes.phone]);
  for (const [column, value] of checks) {
    const { rows } = await queryable.query(
      `SELECT id FROM users WHERE LOWER(${column}) = LOWER($1) AND id <> $2 LIMIT 1`,
      [value, userId]
    );
    if (rows[0]) throw new AppError(409, `${column === "phone" ? "Cellphone number" : column} already belongs to another TitoPay account`);
  }
}

function publicRequest(row = {}) {
  const requested = row.requested_changes || {};
  const snapshot = row.current_snapshot || {};
  return {
    id: row.id,
    userId: row.user_id,
    accountType: row.account_type,
    status: row.status,
    requestedChanges: requested,
    currentSnapshot: snapshot,
    supportNotes: row.support_notes || "",
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: row.full_name || row.username ? {
      fullName: row.full_name,
      username: row.username,
      email: row.email,
      phone: row.phone,
      businessName: row.business_name
    } : undefined
  };
}

async function createProfileChangeRequest(userId, payload = {}, meta = {}) {
  await ensureProfileChangeSchema();
  const { rows } = await pool.query(
    `SELECT u.*, m.business_name
     FROM users u
     LEFT JOIN merchants m ON m.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user) throw new AppError(404, "User not found");
  const current = snapshotFromRows(user, { business_name: user.business_name });
  const requested = normalizeRequestedChanges(payload, user.account_type);
  const changes = diffChanges(current, requested);
  if (!Object.keys(changes).length) throw new AppError(400, "No profile changes were submitted");
  await assertNoDuplicateIdentifiers(changes, userId);
  const existing = await pool.query(
    `SELECT id FROM profile_change_requests
     WHERE user_id = $1 AND status IN ('pending', 'in_review')
     LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) throw new AppError(409, "A profile update is already waiting for Support approval");
  const id = uuidv4();
  const { rows: inserted } = await pool.query(
    `INSERT INTO profile_change_requests
      (id, user_id, account_type, requested_changes, current_snapshot, due_at)
     VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '72 hours')
     RETURNING *`,
    [id, userId, user.account_type, JSON.stringify(changes), JSON.stringify(current)]
  );
  await safeAudit({
    actorType: "customer",
    actorId: userId,
    action: "profile_change_requested",
    entityType: "profile_change_request",
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(changes), slaHours: 72 }
  });
  return publicRequest(inserted[0]);
}

async function listOwnProfileChangeRequests(userId) {
  await ensureProfileChangeSchema();
  const { rows } = await pool.query(
    `SELECT *
     FROM profile_change_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );
  return rows.map(publicRequest);
}

async function listProfileChangeRequests(status = "") {
  await ensureProfileChangeSchema();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const params = [];
  let where = "";
  if (REQUEST_STATUSES.has(normalizedStatus)) {
    params.push(normalizedStatus);
    where = "WHERE pcr.status = $1";
  }
  const { rows } = await pool.query(
    `SELECT pcr.*, u.full_name, u.username, u.email, u.phone, m.business_name
     FROM profile_change_requests pcr
     JOIN users u ON u.id = pcr.user_id
     LEFT JOIN merchants m ON m.user_id = u.id
     ${where}
     ORDER BY
       CASE WHEN pcr.status IN ('pending', 'in_review') THEN 0 ELSE 1 END,
       pcr.due_at ASC,
       pcr.created_at DESC
     LIMIT 250`,
    params
  );
  return rows.map(publicRequest);
}

async function approveProfileChangeRequest(id, adminId, meta = {}) {
  await ensureProfileChangeSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM profile_change_requests WHERE id = $1 FOR UPDATE", [id]);
    const request = rows[0];
    if (!request) throw new AppError(404, "Profile change request not found");
    if (!["pending", "in_review"].includes(request.status)) throw new AppError(409, "Profile change request is already closed");
    const changes = request.requested_changes || {};
    await assertNoDuplicateIdentifiers(changes, request.user_id, client);
    const sets = [];
    const values = [];
    const addSet = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (changes.fullName) addSet("full_name", changes.fullName);
    if (changes.username) addSet("username", changes.username);
    if (changes.email) addSet("email", changes.email);
    if (changes.phone) addSet("phone", changes.phone);
    if (sets.length) {
      values.push(request.user_id);
      await client.query(`UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length}`, values);
    }
    if (changes.businessName && request.account_type === "business") {
      await client.query(
        `UPDATE merchants SET business_name = $1, updated_at = NOW() WHERE user_id = $2`,
        [changes.businessName, request.user_id]
      );
    }
    const { rows: updated } = await client.query(
      `UPDATE profile_change_requests
       SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), support_notes = COALESCE($3, support_notes), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, adminId, meta.notes || null]
    );
    await client.query("COMMIT");
    await safeAudit({
      actorType: "admin",
      actorId: adminId,
      action: "profile_change_approved",
      entityType: "profile_change_request",
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { userId: request.user_id, fields: Object.keys(changes) }
    });
    return publicRequest(updated[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectProfileChangeRequest(id, adminId, notes = "", meta = {}) {
  await ensureProfileChangeSchema();
  const note = normalizeText(notes, 500);
  const { rows } = await pool.query(
    `UPDATE profile_change_requests
     SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), support_notes = $3, updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'in_review')
     RETURNING *`,
    [id, adminId, note]
  );
  if (!rows[0]) throw new AppError(404, "Open profile change request not found");
  await safeAudit({
    actorType: "admin",
    actorId: adminId,
    action: "profile_change_rejected",
    entityType: "profile_change_request",
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { notes: note ? "provided" : "not_provided" }
  });
  return publicRequest(rows[0]);
}

async function safeAudit(entry) {
  try {
    await writeAuditLog(entry);
  } catch (error) {
    console.error("[profile-change-audit-failed]", {
      action: entry?.action,
      entityId: entry?.entityId,
      message: error.message
    });
  }
}

module.exports = {
  ensureProfileChangeSchema,
  createProfileChangeRequest,
  listOwnProfileChangeRequests,
  listProfileChangeRequests,
  approveProfileChangeRequest,
  rejectProfileChangeRequest
};
