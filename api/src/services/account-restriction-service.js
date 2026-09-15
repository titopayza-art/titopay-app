"use strict";

// RESTRICTING AN ACCOUNT, WITH THE REASON WRITTEN DOWN.
//
// TitoPay has never deleted a customer - account-closure-service.js sets
// users.status = 'closed' and keeps every row, because FICA requires the
// records to survive the relationship. That part was already right.
//
// What was missing was the reason on the enforcement path. A customer who
// asks to close states a reason and an admin records a decision note. An
// account TitoPay restricted itself recorded nothing: users.status became
// 'suspended' and the audit log said "user_suspended". Months later nobody
// could say which suspension was a dormancy sweep and which was a sanctions
// match, which is exactly the question a regulator asks.
//
// So every restriction now writes a row of its own: what state, which
// category, the internal reason in full, a case reference, who did it and
// when. Lifting one writes to the same row rather than erasing it, so the
// history of an account reads as a sequence of decisions rather than as a
// single current value.
//
// TIPPING OFF. Under the Financial Intelligence Centre Act, telling a
// customer they are the subject of a suspicion report is an offence. The
// internal reason therefore never travels to a customer-facing surface: what
// a restricted customer sees is chosen from a fixed map by STATUS, and is the
// same neutral sentence whether the cause was a sanctions match or a clerical
// error. See config/account-status-reference.js.
//
// NOTHING HERE DELETES ANYTHING. There is no purge, no anonymise and no hard
// delete, deliberately, and a test asserts that this file contains no DELETE
// statement at all.

const crypto = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");
const reference = require("../config/account-status-reference");

let schemaReady = null;
async function ensureRestrictionSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_restrictions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        category TEXT NOT NULL,
        -- The full internal reason. Readable by compliance, never by the
        -- customer, and never interpolated into a customer-facing message.
        reason TEXT NOT NULL,
        case_reference TEXT,
        restricted_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        restricted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lifted_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        lifted_at TIMESTAMPTZ,
        lift_reason TEXT,
        -- The status the account held before this restriction, so lifting
        -- puts it back where it was rather than assuming 'active'.
        previous_status TEXT NOT NULL DEFAULT 'active',
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        CONSTRAINT account_restrictions_status_check
          CHECK (status IN ('suspended','blocked','inactive','closed')),
        CONSTRAINT account_restrictions_lift_check
          CHECK ((lifted_at IS NULL) = (lifted_by IS NULL AND lift_reason IS NULL))
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_account_restrictions_user ON account_restrictions (user_id, restricted_at DESC)");
    // One live restriction per account. A second one would make "why is this
    // account suspended" a question with two answers.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_account_restrictions_live
      ON account_restrictions (user_id) WHERE lifted_at IS NULL`);
    // The compliance queue: everything currently in force, oldest first,
    // because the one that has been open longest is the one to look at.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_restrictions_open
      ON account_restrictions (category, restricted_at ASC) WHERE lifted_at IS NULL`);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

// Tests only: forget the schema was ensured so a dropped table can be proven
// to rebuild. Nothing in the running API calls this.
function resetRestrictionSchemaCache() {
  schemaReady = null;
}

/* ------------------------------------------------------------- restricting */

// RESTRICT, NEVER DELETE.
//
// The account keeps every row it had. What changes is users.status, which
// assertActive already refuses to sign in, and every live session is revoked
// so a token issued a minute ago stops working rather than running to its
// seven-day expiry.
async function restrictAccount(admin, userId, payload = {}) {
  await ensureRestrictionSchema();
  if (!admin?.userId) throw new AppError(401, "Admin sign-in required");

  const status = requireEnum(payload.status || "suspended",
    ["suspended", "blocked", "inactive", "closed"], "Account status");
  const category = requireEnum(payload.category || "", reference.RESTRICTION_CATEGORY_KEYS, "Restriction reason");
  // A reason is REQUIRED and is the whole point of this path. An empty one
  // would leave exactly the gap this service exists to close.
  const reason = boundedText(payload.reason, "Reason", { min: 10, max: 4000 });

  // Marking somebody dormant for a sanctions match, or blocked for dormancy,
  // is a mis-keyed action that the next reviewer reads as a finding of fact.
  if (!reference.categoryAllowsStatus(category, status)) {
    const allowed = reference.restrictionCategory(category).statuses.join(", ");
    throw new AppError(400, `"${reference.restrictionCategory(category).label}" applies to: ${allowed}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the row so two admins acting at once cannot both write a live
    // restriction and leave the account with two reasons.
    const { rows: userRows } = await client.query(
      "SELECT id, status FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const user = userRows[0];
    if (!user) throw new AppError(404, "User not found");

    const { rows: open } = await client.query(
      "SELECT id, category FROM account_restrictions WHERE user_id = $1 AND lifted_at IS NULL LIMIT 1", [userId]);
    if (open[0]) {
      throw new AppError(409,
        `This account already has a restriction in force (${reference.restrictionCategory(open[0].category)?.label || open[0].category}). Lift it before applying another.`);
    }

    const id = crypto.randomUUID();
    const { rows } = await client.query(
      `INSERT INTO account_restrictions
        (id, user_id, status, category, reason, case_reference, restricted_by, previous_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, userId, status, category, reason,
        payload.caseReference ? boundedText(payload.caseReference, "Case reference", { min: 0, max: 120 }) : null,
        admin.userId, user.status]
    );
    await client.query("UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1", [userId, status]);
    // A live access token outlives a status change by up to its own lifetime
    // unless the sessions go with it.
    await client.query(
      "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'account_restricted' WHERE user_type = 'customer' AND user_id = $1 AND revoked_at IS NULL",
      [userId]);
    await client.query("COMMIT");

    await Promise.all([
      writeAuditLog({
        actorType: "admin", actorId: admin.userId,
        action: "account_restricted", entityType: "user", entityId: userId,
        ipAddress: admin.ipAddress, userAgent: admin.userAgent,
        metadata: { status, category, caseReference: rows[0].case_reference, previousStatus: user.status }
      }).catch(() => null),
      writeSecurityLog({
        actorType: "admin", actorId: admin.userId,
        eventType: "account_restricted", severity: "warning",
        ipAddress: admin.ipAddress, userAgent: admin.userAgent, success: true,
        metadata: { userId, status, category }
      }).catch(() => null)
    ]);
    return presentForAdmin(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

// LIFTING WRITES TO THE SAME ROW. The restriction is not deleted and not
// hidden - an account that was wrongly suspended for a week should be able to
// show that it was, and when, and who put it right.
async function liftRestriction(admin, userId, payload = {}) {
  await ensureRestrictionSchema();
  if (!admin?.userId) throw new AppError(401, "Admin sign-in required");
  const liftReason = boundedText(payload.reason, "Why it is being lifted", { min: 10, max: 4000 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: open } = await client.query(
      "SELECT * FROM account_restrictions WHERE user_id = $1 AND lifted_at IS NULL FOR UPDATE", [userId]);
    const restriction = open[0];
    if (!restriction) throw new AppError(404, "This account has no restriction in force");

    const { rows } = await client.query(
      `UPDATE account_restrictions
          SET lifted_at = NOW(), lifted_by = $2, lift_reason = $3
        WHERE id = $1 RETURNING *`,
      [restriction.id, admin.userId, liftReason]);
    // Back to where it was, not blindly to active: an account that was
    // 'inactive' before a fraud review should not be promoted by the review
    // ending.
    const restored = reference.isAccountStatus(restriction.previous_status) ? restriction.previous_status : "active";
    await client.query("UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1", [userId, restored]);
    await client.query("COMMIT");

    await writeAuditLog({
      actorType: "admin", actorId: admin.userId,
      action: "account_restriction_lifted", entityType: "user", entityId: userId,
      ipAddress: admin.ipAddress, userAgent: admin.userAgent,
      metadata: { category: restriction.category, restoredStatus: restored, heldForDays: daysBetween(restriction.restricted_at) }
    }).catch(() => null);
    return presentForAdmin(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------ reading it */

// The full history, for compliance staff. Includes the internal reason.
async function restrictionHistory(userId) {
  await ensureRestrictionSchema();
  const { rows } = await pool.query(
    "SELECT * FROM account_restrictions WHERE user_id = $1 ORDER BY restricted_at DESC LIMIT 100", [userId]);
  return rows.map(presentForAdmin);
}

// The compliance queue: what is in force right now, oldest first.
async function openRestrictions({ category = null, limit = 200 } = {}) {
  await ensureRestrictionSchema();
  const { rows } = await pool.query(
    `SELECT r.*, u.full_name, u.username
       FROM account_restrictions r
       JOIN users u ON u.id = r.user_id
      WHERE r.lifted_at IS NULL ${category ? "AND r.category = $2" : ""}
      ORDER BY r.restricted_at ASC
      LIMIT $1`,
    category ? [Math.min(500, limit), category] : [Math.min(500, limit)]);
  return rows.map((row) => ({ ...presentForAdmin(row), fullName: row.full_name, username: row.username }));
}

// WHAT THE CUSTOMER IS TOLD, AND NOTHING MORE.
//
// The sentence is selected by STATUS from a fixed map. The internal reason is
// not passed in, not interpolated, and not reachable from here - which is what
// makes a tipping-off mistake require deleting code rather than forgetting a
// condition. The category travels only when it is one that may be disclosed.
async function customerFacingRestriction(userId) {
  await ensureRestrictionSchema();
  const { rows } = await pool.query(
    `SELECT r.status, r.category, r.restricted_at
       FROM account_restrictions r
      WHERE r.user_id = $1 AND r.lifted_at IS NULL
      LIMIT 1`, [userId]);
  const row = rows[0];
  if (!row) return { restricted: false, message: "" };
  const disclose = reference.mayDiscloseReason(row.category);
  return {
    restricted: true,
    message: reference.customerMessageFor(row.status),
    // Only for categories where there is nothing to tip off. For an AML
    // review, a sanctions match or a law-enforcement instruction this is null
    // and the customer sees the neutral sentence alone.
    reason: disclose ? reference.restrictionCategory(row.category).says : null,
    since: disclose ? row.restricted_at : null
  };
}

/* --------------------------------------------- the path that came before */

// THE LEGACY SUSPEND BUTTON, MADE VISIBLE.
//
// /users/:id/:action has always been able to suspend an account with no
// reason at all, and the admin console still posts it with an empty body.
// Requiring a reason there would have broken that button in the window
// between the API deploying and the console deploying, so it keeps working -
// but it no longer does so silently. A suspension made that way records a
// restriction under the `unspecified` category, which reads as the gap it is
// and puts the account in the compliance queue for somebody to complete.
//
// Best effort on purpose: if this cannot write, the suspension itself must
// still stand. An account left unrestricted because its paperwork failed
// would be the worse outcome.
async function recordUnspecifiedRestriction(admin, userId, status, previousStatus = "active") {
  await ensureRestrictionSchema();
  const { rows } = await pool.query(
    `INSERT INTO account_restrictions
      (id, user_id, status, category, reason, restricted_by, previous_status)
     VALUES ($1,$2,$3,'unspecified',$4,$5,$6)
     ON CONFLICT (user_id) WHERE lifted_at IS NULL DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), userId, status,
      "Applied from the legacy admin action, which does not ask for a reason. Needs review and a proper category.",
      admin?.userId || null, previousStatus]
  );
  return rows[0] ? presentForAdmin(rows[0]) : null;
}

// The matching half: re-activating through the legacy button closes whatever
// restriction was in force, so the queue does not fill with entries for
// accounts that are working normally again.
async function liftAnyOpenRestriction(admin, userId, reason) {
  await ensureRestrictionSchema();
  const { rows } = await pool.query(
    `UPDATE account_restrictions
        SET lifted_at = NOW(), lifted_by = $2, lift_reason = $3
      WHERE user_id = $1 AND lifted_at IS NULL
      RETURNING *`,
    [userId, admin?.userId || null, reason]);
  return rows[0] ? presentForAdmin(rows[0]) : null;
}

/* ---------------------------------------------------------------- helpers */

function daysBetween(from, to = new Date()) {
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000));
}

// Built by hand. A column added later must not appear on any surface by
// accident, and one of these columns is the internal reason.
function presentForAdmin(row) {
  const category = reference.restrictionCategory(row.category);
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    category: row.category,
    categoryLabel: category?.label || row.category,
    disclosable: category?.disclose === true,
    reason: row.reason,
    caseReference: row.case_reference || "",
    restrictedBy: row.restricted_by,
    restrictedAt: row.restricted_at,
    liftedBy: row.lifted_by,
    liftedAt: row.lifted_at,
    liftReason: row.lift_reason || "",
    previousStatus: row.previous_status,
    inForce: !row.lifted_at
  };
}

module.exports = {
  customerFacingRestriction,
  liftAnyOpenRestriction,
  recordUnspecifiedRestriction,
  ensureRestrictionSchema,
  liftRestriction,
  openRestrictions,
  resetRestrictionSchemaCache,
  restrictAccount,
  restrictionHistory
};
