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
  await db.query(
    `INSERT INTO audit_logs
      (id, actor_type, actor_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidv4(), actorType, actorId, action, entityType, entityId, ipAddress, userAgent, JSON.stringify(sanitizeMetadata(metadata))]
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

module.exports = { writeAuditLog, listAuditLogs, writeSecurityLog, listSecurityLogs, sanitizeMetadata };
