const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");

const SENSITIVE_METADATA_KEYS = /(password|passcode|pin|otp|token|secret|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_METADATA_KEYS.test(key) ? "[REDACTED]" : sanitizeMetadata(item, depth + 1)
    ])
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AN IDENTIFIER THAT IS NOT A UUID MUST NOT COST US THE AUDIT RECORD.
//
// audit_logs.entity_id is a uuid column, and callers arrive here with whatever
// names the thing they changed: usually a row id, but sometimes a settings key
// ("security_content") or a role slug ("coo"). Postgres rejects those, and
// because the audit write is the LAST step of a handler, the change it
// describes has already been committed. The caller then answers 500 over work
// that actually happened, and the log that existed to record it holds nothing.
//
// That has now been found twice: the security content save, and the RBAC role
// save one route away from it. Both were invisible until something exercised
// the write against a real database. Fixing the two call sites would leave the
// third to be discovered the same way, so it is fixed here instead, where every
// caller passes through.
//
// The identifier is not discarded. A non-UUID goes to the metadata as
// entityKey, so "which role was changed" is still answerable.
function splitEntityId(entityId, metadata) {
  if (entityId === null || entityId === undefined || entityId === "") {
    return { id: null, metadata };
  }
  const text = String(entityId);
  if (UUID_PATTERN.test(text)) return { id: text, metadata };
  return { id: null, metadata: { ...(metadata || {}), entityKey: text } };
}

async function writeAuditLog({
  actorType,
  actorId = null,
  action,
  entityType,
  entityId = null,
  ipAddress = null,
  userAgent = null,
  metadata = {},
  db = pool
}) {
  const entity = splitEntityId(entityId, metadata);
  await db.query(
    `INSERT INTO audit_logs
      (id, actor_type, actor_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidv4(), actorType, actorId, action, entityType, entity.id, ipAddress, userAgent, JSON.stringify(sanitizeMetadata(entity.metadata))]
  );
}

async function listAuditLogs(limit = 250) {
  const { rows } = await pool.query(
    `SELECT *
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function writeSecurityLog({
  actorType = "unknown",
  actorId = null,
  eventType,
  severity = "info",
  ipAddress = null,
  userAgent = null,
  deviceFingerprint = null,
  sessionId = null,
  success = null,
  metadata = {}
}) {
  await pool.query(
    `INSERT INTO security_logs
      (id, actor_type, actor_id, event_type, severity, ip_address, user_agent, device_fingerprint, session_id, success, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      uuidv4(),
      actorType,
      actorId,
      eventType,
      severity,
      ipAddress,
      userAgent,
      deviceFingerprint,
      sessionId,
      success,
      JSON.stringify(sanitizeMetadata(metadata))
    ]
  );
}

async function listSecurityLogs(limit = 250) {
  const { rows } = await pool.query(
    `SELECT *
     FROM security_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { writeAuditLog, listAuditLogs, writeSecurityLog, listSecurityLogs, sanitizeMetadata, splitEntityId };
