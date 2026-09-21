"use strict";

// ENHANCED VETTING: WHAT FICA DOES NOT ANSWER.
//
// FICA answers "is this person who they say they are". It is an identity
// check, and it is not a background check - somebody can be perfectly
// identified and still be unsuitable to be alone with a child or to hold the
// keys to an empty house.
//
// So a profession marked `enhanced` in the TitoPro catalogue - a cleaner, a
// tutor, a locksmith - needs cleared checks on file before it can be listed,
// on top of the FICA verification every professional needs.
//
// THIS FILE IS THE MECHANISM, NOT THE POLICY. It records that a check was
// cleared, by whom, against what evidence, and until when; it refuses a
// listing without one; and it takes a listing down when one expires. WHICH
// checks are required and HOW LONG a clearance stays good for live in
// config/titopro-reference.js, marked as defaults, because that is a decision
// for the business and its compliance advisers rather than for this code.
//
// A CLEARANCE IS RECORDED, NEVER THE DOCUMENT. What is stored is a reference
// number, a decision and a date. TitoPay does not need a scan of somebody's
// police clearance certificate sitting in its database to know that an
// officer looked at one, and holding that image is a data-protection
// liability with nothing to gain against it.

const crypto = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { writeAuditLog } = require("./audit-service");
const reference = require("../config/titopro-reference");

const CHECK_STATUSES = Object.freeze(["pending", "cleared", "failed"]);

let schemaReady = null;
async function ensureVettingSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS titopro_vetting_checks (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        -- The certificate or case number an officer read. Not the document.
        evidence_reference TEXT,
        decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        decided_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT titopro_vetting_status_check CHECK (status IN ('pending','cleared','failed')),
        -- A cleared check must say who cleared it and when it stops counting.
        -- A clearance with no expiry is a clearance nobody ever revisits.
        CONSTRAINT titopro_vetting_cleared_is_dated
          CHECK (status <> 'cleared' OR (decided_at IS NOT NULL AND expires_at IS NOT NULL))
      )
    `);
    // One live record per person per check type. A second would make "is this
    // cleaner cleared" a question with two answers.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_vetting_current
      ON titopro_vetting_checks (user_id, check_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_vetting_expiring
      ON titopro_vetting_checks (expires_at) WHERE status = 'cleared'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_vetting_queue
      ON titopro_vetting_checks (status, created_at ASC) WHERE status = 'pending'`);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function resetVettingSchemaCache() {
  schemaReady = null;
}

/* ----------------------------------------------------------- the decision */

// A compliance officer records that they looked at something. There is no
// self-service path here on purpose: a professional cannot clear themselves.
async function recordCheck(admin, userId, payload = {}) {
  await ensureVettingSchema();
  if (!admin?.userId) throw new AppError(401, "Admin sign-in required");

  const checkType = requireEnum(payload.checkType || "", reference.VETTING_CHECK_KEYS, "Check type");
  const status = requireEnum(payload.status || "", CHECK_STATUSES, "Check outcome");
  const definition = reference.vettingCheck(checkType);

  // A decision needs evidence and a note; a pending record is just a marker
  // that somebody has started, so it needs neither.
  let evidence = null;
  let note = null;
  let expiresAt = null;
  if (status !== "pending") {
    evidence = boundedText(payload.evidenceReference, "Certificate or case number", { min: 3, max: 120 });
    note = boundedText(payload.note, "What was checked", { min: 10, max: 2000 });
  }
  if (status === "cleared") {
    // The validity period is policy, read from config so the figure in force
    // is visible rather than buried here.
    const days = Number(payload.validDays || definition.validDays);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new AppError(400, "A clearance must be valid for between 1 and 3650 days");
    }
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  }

  const { rows } = await pool.query(
    `INSERT INTO titopro_vetting_checks
      (id, user_id, check_type, status, evidence_reference, decided_by, decided_at, expires_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,${status === "pending" ? "NULL" : "NOW()"},$7,$8)
     ON CONFLICT (user_id, check_type) DO UPDATE SET
       status = EXCLUDED.status,
       evidence_reference = EXCLUDED.evidence_reference,
       decided_by = EXCLUDED.decided_by,
       decided_at = EXCLUDED.decided_at,
       expires_at = EXCLUDED.expires_at,
       note = EXCLUDED.note,
       updated_at = NOW()
     RETURNING *`,
    [crypto.randomUUID(), userId, checkType, status, evidence, admin.userId, expiresAt, note]
  );

  await writeAuditLog({
    actorType: "admin", actorId: admin.userId,
    action: `titopro_vetting_${status}`, entityType: "titopro_vetting", entityId: rows[0].id,
    ipAddress: admin.ipAddress, userAgent: admin.userAgent,
    metadata: { userId, checkType, expiresAt }
  }).catch(() => null);

  // A failed or withdrawn check must take down anything it was holding up.
  if (status !== "cleared") {
    await require("./titopro-profile-service")
      .enforceVerificationStillHolds(userId, { reason: "A required background check is no longer cleared." })
      .catch(() => null);
  }
  return present(rows[0]);
}

/* -------------------------------------------------------------- the gate */

// WHICH CHECKS THIS PERSON HAS CLEARED AND NOT LET EXPIRE.
//
// Expiry is evaluated against the clock at read time rather than by a sweep,
// so a clearance that lapsed overnight is already not counting the next time
// anybody asks - there is no window in which a stale row is treated as good
// because a scheduled job has not run yet.
async function clearedChecks(userId) {
  await ensureVettingSchema();
  const { rows } = await pool.query(
    `SELECT check_type FROM titopro_vetting_checks
      WHERE user_id = $1 AND status = 'cleared' AND expires_at > NOW()`, [userId]);
  return rows.map((row) => row.check_type);
}

// What is missing before these professions may be listed. Returns the
// shortfall rather than a bare false, because somebody refused has to be told
// what to go and get.
async function vettingShortfall(userId, professions = []) {
  const required = new Set();
  for (const key of professions) {
    for (const check of reference.requiredChecksFor(key)) required.add(check);
  }
  if (!required.size) return { satisfied: true, missing: [], required: [] };

  const cleared = new Set(await clearedChecks(userId));
  const missing = [...required].filter((check) => !cleared.has(check));
  return {
    satisfied: missing.length === 0,
    required: [...required],
    missing,
    missingLabels: missing.map((check) => reference.vettingCheck(check)?.label || check)
  };
}

/* ------------------------------------------------------------- read paths */

async function checksForUser(userId) {
  await ensureVettingSchema();
  const { rows } = await pool.query(
    "SELECT * FROM titopro_vetting_checks WHERE user_id = $1 ORDER BY check_type", [userId]);
  return rows.map(present);
}

// The compliance queue: checks somebody has started and nobody has decided.
async function pendingChecks({ limit = 200 } = {}) {
  await ensureVettingSchema();
  const { rows } = await pool.query(
    `SELECT v.*, u.full_name, u.username
       FROM titopro_vetting_checks v
       JOIN users u ON u.id = v.user_id
      WHERE v.status = 'pending'
      ORDER BY v.created_at ASC LIMIT $1`, [Math.min(500, limit)]);
  return rows.map((row) => ({ ...present(row), fullName: row.full_name, username: row.username }));
}

// Clearances running out, so somebody can be asked for a new certificate
// before their listing drops rather than after.
async function expiringSoon({ withinDays = 30 } = {}) {
  await ensureVettingSchema();
  const { rows } = await pool.query(
    `SELECT v.*, u.full_name FROM titopro_vetting_checks v
       JOIN users u ON u.id = v.user_id
      WHERE v.status = 'cleared' AND v.expires_at > NOW()
        AND v.expires_at < NOW() + ($1 || ' days')::interval
      ORDER BY v.expires_at ASC LIMIT 200`, [String(Math.max(1, withinDays))]);
  return rows.map((row) => ({ ...present(row), fullName: row.full_name }));
}

function present(row) {
  const definition = reference.vettingCheck(row.check_type);
  const expired = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  return {
    id: row.id,
    userId: row.user_id,
    checkType: row.check_type,
    checkLabel: definition?.label || row.check_type,
    requires: definition?.says || "",
    status: row.status,
    // A row can say 'cleared' and still not count. Reported as its own field
    // so no caller has to remember to compare the date itself.
    inForce: row.status === "cleared" && !expired,
    expired,
    evidenceReference: row.evidence_reference || "",
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    note: row.note || ""
  };
}

module.exports = {
  CHECK_STATUSES,
  checksForUser,
  clearedChecks,
  ensureVettingSchema,
  expiringSoon,
  pendingChecks,
  recordCheck,
  resetVettingSchemaCache,
  vettingShortfall
};
