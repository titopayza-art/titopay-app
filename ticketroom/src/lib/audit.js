// Append-only, hash-chained audit trail. The table refuses UPDATE/DELETE at the
// database level; the chain makes any out-of-band edit detectable.
const crypto = require("crypto");
const db = require("./db");

const SECRET_KEYS = /pass|pin|token|secret|key|card|cvv|account_?number|activation/i;
function scrub(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
  return out;
}

// jsonb does not preserve key order, so hash a key-sorted serialisation.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function hashRow(prev, row) {
  const canonicalRow = canonical([prev, row.occurred_at, row.actor_id, row.actor_role, row.action, row.entity_type, row.entity_id, row.organiser_id, row.details]);
  return crypto.createHash("sha256").update(canonicalRow).digest("hex");
}

async function write(client, entry) {
  // Serialise chain appends. Held only until this transaction commits.
  await client.query("SELECT pg_advisory_xact_lock(7743001)");
  const last = await client.query("SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prev = last.rows[0]?.row_hash || "GENESIS";
  const row = {
    occurred_at: new Date().toISOString(),
    actor_id: entry.actor?.id || null,
    actor_role: entry.actorRole || entry.actor?.primaryRole || (entry.actor ? "user" : "system"),
    action: entry.action,
    entity_type: entry.entityType || null,
    entity_id: entry.entityId ? String(entry.entityId) : null,
    organiser_id: entry.organiserId || null,
    details: scrub(entry.details || {}),
  };
  await client.query(
    `INSERT INTO audit_log (occurred_at, actor_id, actor_role, action, entity_type, entity_id, organiser_id, ip, details, prev_hash, row_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.occurred_at, row.actor_id, row.actor_role, row.action, row.entity_type, row.entity_id, row.organiser_id, entry.ip || null, row.details, prev, hashRow(prev, row)]
  );
}

// record(clientOrNull, entry): inside the caller's transaction when given one.
async function record(client, entry) {
  if (client) return write(client, entry);
  return db.withTx((c) => write(c, entry));
}

async function verifyChain() {
  const { rows } = await db.query("SELECT * FROM audit_log ORDER BY id");
  let prev = "GENESIS";
  for (const row of rows) {
    const expected = hashRow(prev, { ...row, occurred_at: new Date(row.occurred_at).toISOString() });
    if (row.prev_hash !== prev || row.row_hash !== expected) return { ok: false, brokenAt: row.id, checked: rows.length };
    prev = row.row_hash;
  }
  return { ok: true, checked: rows.length };
}

module.exports = { record, verifyChain, scrub };
