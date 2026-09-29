"use strict";

// POS partner credentials - the vendor-level identity layer.
//
// A partner is an organisation (Android POS ISV, Flash/Kazang-class
// aggregator, merchant ERP). Registration is self-service and immediately
// yields a SANDBOX key, because the whole point of the sandbox is that no
// TitoPay engineer is in the loop. Production keys exist only for partners an
// admin has approved, and a suspended partner's keys all stop working at the
// next request.
//
// Keys are bearer credentials: tpk_test_... / tpk_live_..., stored ONLY as
// SHA-256 hashes (there is nothing to decrypt and therefore nothing to
// steal at rest); the plaintext appears exactly once, in the response that
// created it. Every authenticated partner request is metered into
// api_partner_usage, which powers the partner dashboard and the admin view.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

const KEY_BYTES = 32;
const MAX_ACTIVE_KEYS_PER_ENV = 5;
const ROTATION_GRACE_HOURS = 24;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Which environment this PROCESS is. The sandbox is a second deployment of
// the same codebase with TITOPAY_ENV=sandbox (the pattern the Peach
// integration already established); everything else is production.
function runtimeEnvironment() {
  return String(process.env.TITOPAY_ENV || "").trim().toLowerCase() === "sandbox" ? "sandbox" : "production";
}

function keyEnvironmentPrefix(environment) {
  return environment === "sandbox" ? "tpk_test_" : "tpk_live_";
}

function mintKey(environment) {
  const plaintext = `${keyEnvironmentPrefix(environment)}${crypto.randomBytes(KEY_BYTES).toString("base64url")}`;
  return { plaintext, hash: sha256(plaintext), prefix: plaintext.slice(0, 12) };
}

async function ensurePartnerSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_partners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_partner_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES api_partners(id) ON DELETE CASCADE,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_api_partner_keys_partner ON api_partner_keys (partner_id, status)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_partner_usage (
      partner_id UUID NOT NULL REFERENCES api_partners(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (partner_id, day)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_partner_resources (
      partner_id UUID NOT NULL REFERENCES api_partners(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('merchant', 'terminal', 'customer')),
      resource_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (partner_id, resource_type, resource_id)
    )`);
}

/* ------------------------------------------------------------ registration */

function publicPartner(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name || "",
    email: row.email,
    status: row.status,
    createdAt: row.created_at
  };
}

function publicKey(row) {
  return {
    id: row.id,
    environment: row.environment,
    keyPrefix: row.key_prefix,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

// Self-service. The partner starts 'pending' - the sandbox works immediately,
// production waits for an admin's approval. Returns the first sandbox key.
async function registerPartner(payload = {}, meta = {}) {
  const companyName = String(payload.companyName || "").trim().slice(0, 120);
  const contactName = String(payload.contactName || "").trim().slice(0, 120);
  const email = String(payload.email || "").trim().toLowerCase().slice(0, 200);
  if (companyName.length < 2) throw new AppError(400, "Company name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, "A valid contact email is required");
  let partner;
  try {
    const { rows } = await pool.query(
      `INSERT INTO api_partners (company_name, contact_name, email) VALUES ($1,$2,$3) RETURNING *`,
      [companyName, contactName || null, email]
    );
    partner = rows[0];
  } catch (error) {
    if (error.code === "23505") throw new AppError(409, "A partner account already exists for this email");
    throw error;
  }
  const key = mintKey("sandbox");
  await pool.query(
    `INSERT INTO api_partner_keys (partner_id, environment, key_prefix, key_hash, created_by)
     VALUES ($1,'sandbox',$2,$3,'self_service')`,
    [partner.id, key.prefix, key.hash]
  );
  await writeAuditLog({
    actorType: "partner", actorId: partner.id,
    action: "partner_registered", entityType: "api_partner", entityId: partner.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { companyName, email }
  });
  return { partner: publicPartner(partner), sandboxKey: key.plaintext };
}

/* -------------------------------------------------------------------- auth */

// Bearer authentication for partner-level calls. Accepts X-TitoPay-Api-Key or
// Authorization: Bearer tpk_..., verifies by hash lookup, and refuses keys
// that are revoked, expired, from the wrong environment, or whose partner is
// suspended. Every authenticated request is metered on response finish.
async function authenticateKey(plaintext) {
  const value = String(plaintext || "").trim();
  if (!value.startsWith("tpk_")) throw new AppError(401, "Partner API key required");
  const { rows } = await pool.query(
    `SELECT k.*, p.status AS partner_status, p.company_name, p.email
       FROM api_partner_keys k
       JOIN api_partners p ON p.id = k.partner_id
      WHERE k.key_hash = $1
      LIMIT 1`,
    [sha256(value)]
  );
  const key = rows[0];
  if (!key || key.status !== "active") throw new AppError(401, "Partner API key is not valid");
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    throw new AppError(401, "Partner API key has expired");
  }
  if (key.environment !== runtimeEnvironment()) {
    throw new AppError(401, `This is a ${key.environment} key; this endpoint serves the ${runtimeEnvironment()} environment`);
  }
  if (key.partner_status === "suspended") throw new AppError(403, "This partner account is suspended");
  pool.query("UPDATE api_partner_keys SET last_used_at = NOW() WHERE id = $1", [key.id]).catch(() => {});
  return key;
}

function requirePartnerKey(req, res, next) {
  const header = req.get("x-titopay-api-key") ||
    String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  authenticateKey(header)
    .then((key) => {
      req.partner = {
        id: key.partner_id,
        companyName: key.company_name,
        status: key.partner_status,
        keyId: key.id,
        environment: key.environment
      };
      res.on("finish", () => {
        pool.query(
          `INSERT INTO api_partner_usage (partner_id, day, requests, errors)
           VALUES ($1, CURRENT_DATE, 1, $2)
           ON CONFLICT (partner_id, day)
           DO UPDATE SET requests = api_partner_usage.requests + 1,
                         errors = api_partner_usage.errors + $2`,
          [key.partner_id, res.statusCode >= 400 ? 1 : 0]
        ).catch(() => {});
      });
      next();
    })
    .catch(next);
}

/* -------------------------------------------------------------------- keys */

async function listKeys(partnerId) {
  const { rows } = await pool.query(
    "SELECT * FROM api_partner_keys WHERE partner_id = $1 ORDER BY created_at DESC",
    [partnerId]
  );
  return rows.map(publicKey);
}

async function requirePartner(partnerId) {
  const { rows } = await pool.query("SELECT * FROM api_partners WHERE id = $1 LIMIT 1", [partnerId]);
  if (!rows[0]) throw new AppError(404, "Partner not found");
  return rows[0];
}

async function createKey(partnerId, environment, actorLabel, meta = {}) {
  if (!["sandbox", "production"].includes(environment)) throw new AppError(400, "Environment must be sandbox or production");
  const partner = await requirePartner(partnerId);
  if (partner.status === "suspended") throw new AppError(403, "This partner account is suspended");
  if (environment === "production" && partner.status !== "approved") {
    throw new AppError(403, "Production keys are issued once the partner is approved by TitoPay");
  }
  const active = await pool.query(
    "SELECT COUNT(*)::INT total FROM api_partner_keys WHERE partner_id = $1 AND environment = $2 AND status = 'active'",
    [partnerId, environment]
  );
  if (active.rows[0].total >= MAX_ACTIVE_KEYS_PER_ENV) {
    throw new AppError(409, `A partner can hold at most ${MAX_ACTIVE_KEYS_PER_ENV} active ${environment} keys`);
  }
  const key = mintKey(environment);
  const { rows } = await pool.query(
    `INSERT INTO api_partner_keys (partner_id, environment, key_prefix, key_hash, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [partnerId, environment, key.prefix, key.hash, actorLabel]
  );
  await writeAuditLog({
    actorType: "partner", actorId: partnerId,
    action: "partner_key_created", entityType: "api_partner_key", entityId: rows[0].id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { environment, keyPrefix: key.prefix, createdBy: actorLabel }
  });
  return { key: publicKey(rows[0]), plaintext: key.plaintext };
}

// Rotation = a fresh key now, the old one expiring after a 24-hour grace so
// deployed devices can switch without an outage window.
async function rotateKey(partnerId, keyId, actorLabel, meta = {}) {
  const { rows } = await pool.query(
    "SELECT * FROM api_partner_keys WHERE id = $1 AND partner_id = $2 AND status = 'active' LIMIT 1",
    [keyId, partnerId]
  );
  if (!rows[0]) throw new AppError(404, "Active API key not found");
  const replacement = await createKey(partnerId, rows[0].environment, actorLabel, meta);
  await pool.query(
    `UPDATE api_partner_keys SET expires_at = NOW() + ($2 || ' hours')::INTERVAL WHERE id = $1 AND expires_at IS NULL`,
    [keyId, ROTATION_GRACE_HOURS]
  );
  await writeAuditLog({
    actorType: "partner", actorId: partnerId,
    action: "partner_key_rotated", entityType: "api_partner_key", entityId: keyId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { replacementKeyId: replacement.key.id, graceHours: ROTATION_GRACE_HOURS }
  });
  return { ...replacement, retiringKeyId: keyId, retiringKeyExpiresInHours: ROTATION_GRACE_HOURS };
}

async function revokeKey(partnerId, keyId, actorLabel, meta = {}) {
  const { rows } = await pool.query(
    `UPDATE api_partner_keys SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND partner_id = $2 AND status = 'active'
      RETURNING *`,
    [keyId, partnerId]
  );
  if (!rows[0]) throw new AppError(404, "Active API key not found");
  await writeAuditLog({
    actorType: "partner", actorId: partnerId,
    action: "partner_key_revoked", entityType: "api_partner_key", entityId: keyId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { revokedBy: actorLabel }
  });
  return publicKey(rows[0]);
}

/* ---------------------------------------------------- resources + usage */

async function recordResource(partnerId, resourceType, resourceId) {
  await pool.query(
    `INSERT INTO api_partner_resources (partner_id, resource_type, resource_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [partnerId, resourceType, resourceId]
  );
}

async function partnerResourceIds(partnerId, resourceType) {
  const { rows } = await pool.query(
    "SELECT resource_id FROM api_partner_resources WHERE partner_id = $1 AND resource_type = $2",
    [partnerId, resourceType]
  );
  return rows.map((row) => row.resource_id);
}

async function usageSeries(partnerId, days = 30) {
  const bounded = Math.min(Math.max(Number(days) || 30, 1), 90);
  const { rows } = await pool.query(
    `SELECT day, requests, errors FROM api_partner_usage
      WHERE partner_id = $1 AND day > CURRENT_DATE - $2::INT
      ORDER BY day`,
    [partnerId, bounded]
  );
  return rows;
}

// The Stripe-style dashboard numbers: API usage, webhook delivery health and
// terminal activity, all scoped to what THIS partner provisioned.
async function partnerOverview(partnerId) {
  const merchants = await partnerResourceIds(partnerId, "merchant");
  const [usage, webhooks, terminals] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(requests),0)::INT requests, COALESCE(SUM(errors),0)::INT errors
         FROM api_partner_usage WHERE partner_id = $1 AND day > CURRENT_DATE - 30`,
      [partnerId]
    ),
    merchants.length ? pool.query(
      `SELECT COUNT(*)::INT total,
              COUNT(*) FILTER (WHERE d.status = 'delivered')::INT delivered,
              COUNT(*) FILTER (WHERE d.status = 'dead')::INT dead,
              COUNT(*) FILTER (WHERE d.status IN ('pending','failed'))::INT in_flight
         FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.subscription_id
        WHERE s.merchant_id = ANY($1)`,
      [merchants]
    ) : { rows: [{ total: 0, delivered: 0, dead: 0, in_flight: 0 }] },
    merchants.length ? pool.query(
      `SELECT COUNT(DISTINCT t.id)::INT terminals,
              COUNT(p.id)::INT payments,
              COUNT(p.id) FILTER (WHERE p.status = 'COMPLETED')::INT completed,
              COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'COMPLETED'), 0)::NUMERIC completed_amount
         FROM pos_terminals t
         LEFT JOIN pos_payment_intents p ON p.terminal_id = t.id
        WHERE t.merchant_id = ANY($1)`,
      [merchants]
    ) : { rows: [{ terminals: 0, payments: 0, completed: 0, completed_amount: 0 }] }
  ]);
  return {
    environment: runtimeEnvironment(),
    last30Days: usage.rows[0],
    webhookDeliveries: webhooks.rows[0],
    terminalActivity: {
      terminals: terminals.rows[0].terminals,
      payments: terminals.rows[0].payments,
      completed: terminals.rows[0].completed,
      completedAmount: Number(terminals.rows[0].completed_amount)
    }
  };
}

/* ------------------------------------------------------------------- admin */

async function adminListPartners() {
  const { rows } = await pool.query(`
    SELECT p.*,
           (SELECT COUNT(*)::INT FROM api_partner_keys k WHERE k.partner_id = p.id AND k.status = 'active') active_keys,
           (SELECT COALESCE(SUM(u.requests),0)::INT FROM api_partner_usage u
             WHERE u.partner_id = p.id AND u.day > CURRENT_DATE - 30) requests_30d,
           (SELECT COALESCE(SUM(u.errors),0)::INT FROM api_partner_usage u
             WHERE u.partner_id = p.id AND u.day > CURRENT_DATE - 30) errors_30d
      FROM api_partners p
     ORDER BY p.created_at DESC`);
  return rows.map((row) => ({
    ...publicPartner(row),
    activeKeys: row.active_keys,
    requests30d: row.requests_30d,
    errors30d: row.errors_30d
  }));
}

async function adminSetPartnerStatus(partnerId, status, actor, meta = {}) {
  if (!["approved", "suspended", "pending"].includes(status)) throw new AppError(400, "Unknown partner status");
  const { rows } = await pool.query(
    "UPDATE api_partners SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [partnerId, status]
  );
  if (!rows[0]) throw new AppError(404, "Partner not found");
  await writeAuditLog({
    actorType: "admin", actorId: actor.userId,
    action: `partner_${status}`, entityType: "api_partner", entityId: partnerId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { companyName: rows[0].company_name }
  });
  return publicPartner(rows[0]);
}

module.exports = {
  runtimeEnvironment,
  ensurePartnerSchema,
  registerPartner,
  requirePartnerKey,
  authenticateKey,
  listKeys,
  createKey,
  rotateKey,
  revokeKey,
  recordResource,
  partnerResourceIds,
  usageSeries,
  partnerOverview,
  adminListPartners,
  adminSetPartnerStatus,
  requirePartner
};
