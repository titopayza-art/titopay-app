"use strict";

// Outbound webhooks - the delivery layer on top of the POS event stream.
//
// The payment engine already records every state transition in
// pos_payment_events, inside the same database transaction as the money
// movement. This service never touches that engine. It does three things:
//
//   1. FAN OUT - walk the event stream from a cursor, translate each row into
//      its public event(s), and write one webhook_deliveries row per matching
//      active subscription. The UNIQUE (subscription_id, event_id, event_type)
//      constraint makes re-running fan-out harmless, so the cursor needs no
//      distributed coordination - an advisory lock merely avoids wasted work.
//
//   2. DELIVER - claim due rows with FOR UPDATE SKIP LOCKED (safe with any
//      number of workers), POST the frozen payload with an HMAC-SHA256
//      signature, and record the outcome on the row.
//
//   3. RETRY - the ladder is immediate, 1m, 5m, 15m, 1h, 6h; after the sixth
//      failed attempt the row is dead and the subscription's consecutive
//      failure count rises. Ten dead deliveries in a row pause the
//      subscription; an endpoint answering 410 disables it outright.
//
// Secrets are AES-256-GCM encrypted under the ONE pinned integration key
// (lib/integration-secret-key) - the same chain the POS terminal store uses,
// so a JWT rotation cannot orphan webhook secrets.

const crypto = require("crypto");
const net = require("net");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { integrationEncryptionKey } = require("../lib/integration-secret-key");
const { writeAuditLog } = require("./audit-service");
const { API_BUILD } = require("../build-info");

// The public event catalogue. settlement.completed is reserved for the
// settlement engine and accepted in subscriptions today so integrators do not
// have to resubscribe when it ships; nothing emits it yet.
const EVENT_TYPES = [
  "payment.created", "payment.scanned", "payment.completed", "payment.failed",
  "payment.cancelled", "payment.expired", "refund.created", "refund.completed",
  "settlement.completed"
];
const STATUS_EVENT = {
  PENDING: "payment.created",
  SCANNED: "payment.scanned",
  COMPLETED: "payment.completed",
  FAILED: "payment.failed",
  CANCELLED: "payment.cancelled",
  EXPIRED: "payment.expired"
};
// Attempt N that fails waits RETRY_DELAY_SECONDS[N] before attempt N+1;
// after MAX_ATTEMPTS the delivery is dead.
const RETRY_DELAY_SECONDS = { 1: 60, 2: 300, 3: 900, 4: 3600, 5: 21600 };
const MAX_ATTEMPTS = 6;
const DELIVERY_TIMEOUT_MS = 10000;
const RESPONSE_BODY_LIMIT = 1024;
const MAX_SUBSCRIPTIONS_PER_MERCHANT = 10;
const PAUSE_AFTER_CONSECUTIVE_DEAD = 10;
const SECRET_OVERLAP_HOURS = 24;
const FANOUT_BATCH = 200;
const CLAIM_BATCH = 10;
const CURSOR_KEY = "webhook_fanout_cursor";
const HEARTBEAT_KEY = "webhook_worker_heartbeat";
const FANOUT_LOCK = "webhook_fanout";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", integrationEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return "";
  const [, iv, tag, encrypted] = text.split(":");
  if (!iv || !tag || !encrypted) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", integrationEncryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch (_error) {
    return "";
  }
}

// A webhook target must be a public HTTPS endpoint. Private, loopback and
// link-local addresses are refused so a subscription can never be aimed at
// TitoPay's own network (SSRF). Tests may allow plain-HTTP loopback targets,
// and ONLY tests - the override is ignored outside NODE_ENV=test.
function privateTargetsAllowed() {
  return process.env.NODE_ENV === "test" && process.env.WEBHOOK_ALLOW_PRIVATE === "1";
}

function assertDeliverableUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch (_error) {
    throw new AppError(400, "Endpoint URL is not a valid URL");
  }
  if (privateTargetsAllowed()) return url.href;
  if (url.protocol !== "https:") throw new AppError(400, "Endpoint URL must use HTTPS");
  if (url.username || url.password) throw new AppError(400, "Endpoint URL must not embed credentials");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new AppError(400, "Endpoint URL must be publicly reachable");
  }
  const ipVersion = net.isIP(host.replace(/^\[|\]$/g, ""));
  if (ipVersion) {
    const bare = host.replace(/^\[|\]$/g, "");
    const privateV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(bare);
    const privateV6 = /^(::1$|f[cd]|fe80:)/i.test(bare);
    if (ipVersion === 4 ? privateV4 : privateV6) throw new AppError(400, "Endpoint URL must be publicly reachable");
  }
  return url.href;
}

function assertEventList(events) {
  const list = Array.isArray(events) ? events.map((item) => String(item).trim()).filter(Boolean) : [];
  for (const eventType of list) {
    if (!EVENT_TYPES.includes(eventType)) throw new AppError(400, `Unknown webhook event type: ${eventType}`);
  }
  return Array.from(new Set(list));
}

/* ------------------------------------------------------------------ schema */

// Repo convention: schema.sql carries the canonical DDL; boot calls this so a
// deployment that only replaces api.zip still gains the tables. Never fatal -
// a failed ensure logs and the API keeps serving (the no-502 rule).
async function ensureWebhookSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      endpoint_url TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      secret_fingerprint TEXT NOT NULL,
      previous_secret_encrypted TEXT,
      previous_secret_expires_at TIMESTAMPTZ,
      events TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (merchant_id, endpoint_url)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
      event_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      request_payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
      attempt_number INTEGER NOT NULL DEFAULT 0,
      attempt_log JSONB NOT NULL DEFAULT '[]'::JSONB,
      response_code INTEGER,
      response_body TEXT,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (subscription_id, event_id, event_type)
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_merchant ON webhook_subscriptions (merchant_id, status)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_retry_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription ON webhook_deliveries (subscription_id, created_at DESC)");
  // First boot: start the cursor at NOW so history is not replayed onto
  // brand-new subscriptions.
  await pool.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, jsonb_build_object('ts', NOW()::TEXT, 'id', '00000000-0000-0000-0000-000000000000'))
     ON CONFLICT (key) DO NOTHING`,
    [CURSOR_KEY]
  );
}

/* ----------------------------------------------------------- subscriptions */

function publicSubscription(row) {
  return {
    id: row.id,
    endpointUrl: row.endpoint_url,
    events: row.events || [],
    description: row.description || "",
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    secretFingerprint: row.secret_fingerprint,
    secretRotationPendingUntil: row.previous_secret_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createSubscription(merchant, payload = {}, actor = {}, meta = {}) {
  const endpointUrl = assertDeliverableUrl(payload.endpointUrl || payload.url);
  const events = assertEventList(payload.events);
  const description = String(payload.description || "").trim().slice(0, 200);
  const count = await pool.query("SELECT COUNT(*)::INT total FROM webhook_subscriptions WHERE merchant_id = $1", [merchant.id]);
  if (count.rows[0].total >= MAX_SUBSCRIPTIONS_PER_MERCHANT) {
    throw new AppError(409, `A merchant can hold at most ${MAX_SUBSCRIPTIONS_PER_MERCHANT} webhook subscriptions`);
  }
  const secret = `whsec_${crypto.randomBytes(32).toString("base64url")}`;
  let row;
  try {
    const result = await pool.query(
      `INSERT INTO webhook_subscriptions
         (merchant_id, endpoint_url, secret_encrypted, secret_fingerprint, events, description, created_by)
       VALUES ($1,$2,$3,$4,$5::TEXT[],$6,$7)
       RETURNING *`,
      [merchant.id, endpointUrl, encryptSecret(secret), sha256(secret).slice(0, 16), events, description || null, actor.userId || null]
    );
    row = result.rows[0];
  } catch (error) {
    if (error.code === "23505") throw new AppError(409, "A subscription for this endpoint already exists");
    throw error;
  }
  await writeAuditLog({
    actorType: actor.userType || "user", actorId: actor.userId || null,
    action: "webhook_subscription_created", entityType: "webhook_subscription", entityId: row.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { merchantId: merchant.merchant_id, endpointUrl, events }
  });
  // The plaintext secret appears exactly once, in this response.
  return { subscription: publicSubscription(row), secret };
}

async function requireOwnedSubscription(merchant, subscriptionId) {
  const { rows } = await pool.query(
    "SELECT * FROM webhook_subscriptions WHERE id = $1 AND merchant_id = $2 LIMIT 1",
    [subscriptionId, merchant.id]
  );
  if (!rows[0]) throw new AppError(404, "Webhook subscription not found");
  return rows[0];
}

async function listSubscriptions(merchant) {
  const { rows } = await pool.query(
    "SELECT * FROM webhook_subscriptions WHERE merchant_id = $1 ORDER BY created_at DESC",
    [merchant.id]
  );
  return rows.map(publicSubscription);
}

async function updateSubscription(merchant, subscriptionId, payload = {}, actor = {}, meta = {}) {
  const existing = await requireOwnedSubscription(merchant, subscriptionId);
  const endpointUrl = payload.endpointUrl !== undefined ? assertDeliverableUrl(payload.endpointUrl) : existing.endpoint_url;
  const events = payload.events !== undefined ? assertEventList(payload.events) : existing.events;
  const description = payload.description !== undefined
    ? String(payload.description || "").trim().slice(0, 200) : existing.description;
  let status = existing.status;
  if (payload.status !== undefined) {
    if (!["active", "paused"].includes(payload.status)) throw new AppError(400, "Status can be set to active or paused");
    status = payload.status;
  }
  const { rows } = await pool.query(
    `UPDATE webhook_subscriptions
        SET endpoint_url = $3, events = $4::TEXT[], description = $5, status = $6,
            consecutive_failures = CASE WHEN $6 = 'active' THEN 0 ELSE consecutive_failures END,
            updated_at = NOW()
      WHERE id = $1 AND merchant_id = $2
      RETURNING *`,
    [subscriptionId, merchant.id, endpointUrl, events, description || null, status]
  );
  await writeAuditLog({
    actorType: actor.userType || "user", actorId: actor.userId || null,
    action: "webhook_subscription_updated", entityType: "webhook_subscription", entityId: subscriptionId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { merchantId: merchant.merchant_id, endpointUrl, events, status }
  });
  return publicSubscription(rows[0]);
}

async function deleteSubscription(merchant, subscriptionId, actor = {}, meta = {}) {
  await requireOwnedSubscription(merchant, subscriptionId);
  await pool.query("DELETE FROM webhook_subscriptions WHERE id = $1 AND merchant_id = $2", [subscriptionId, merchant.id]);
  await writeAuditLog({
    actorType: actor.userType || "user", actorId: actor.userId || null,
    action: "webhook_subscription_deleted", entityType: "webhook_subscription", entityId: subscriptionId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { merchantId: merchant.merchant_id }
  });
  return { deleted: true };
}

// Rotation keeps the old secret valid for a 24-hour overlap. During the
// overlap every delivery carries a second signature made with the old secret,
// so the consumer can switch keys without a single rejected event.
async function rotateSecret(merchant, subscriptionId, actor = {}, meta = {}) {
  const existing = await requireOwnedSubscription(merchant, subscriptionId);
  const secret = `whsec_${crypto.randomBytes(32).toString("base64url")}`;
  const { rows } = await pool.query(
    `UPDATE webhook_subscriptions
        SET previous_secret_encrypted = secret_encrypted,
            previous_secret_expires_at = NOW() + ($3 || ' hours')::INTERVAL,
            secret_encrypted = $4, secret_fingerprint = $5, updated_at = NOW()
      WHERE id = $1 AND merchant_id = $2
      RETURNING *`,
    [subscriptionId, merchant.id, SECRET_OVERLAP_HOURS, encryptSecret(secret), sha256(secret).slice(0, 16)]
  );
  await writeAuditLog({
    actorType: actor.userType || "user", actorId: actor.userId || null,
    action: "webhook_secret_rotated", entityType: "webhook_subscription", entityId: subscriptionId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { merchantId: merchant.merchant_id, previousFingerprint: existing.secret_fingerprint }
  });
  return { subscription: publicSubscription(rows[0]), secret };
}

/* ----------------------------------------------------------------- fan-out */

// Translate one pos_payment_events row into its public event(s). AUTHORIZED
// and PROCESSING are internal steps and stay internal. Refunds settle in one
// database transaction, so refund.created and refund.completed describe the
// same moment - both are emitted (in order) so integrators who listen for
// either name receive it; envelope IDs are derived per type so consumer-side
// dedupe on the ID never drops the second one.
function publicEventsForRow(row) {
  const metadata = row.metadata || {};
  const data = {
    paymentId: row.payment_public_id,
    merchantId: row.merchant_code,
    merchantReference: row.merchant_reference || null,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.new_status,
    previousStatus: row.previous_status,
    terminalId: row.terminal_code || null,
    provider: row.provider || null,
    occurredAt: row.created_at
  };
  if (row.event_type === "payment_refunded" || row.event_type === "payment_reversed") {
    const refund = {
      kind: row.event_type === "payment_reversed" ? "reverse" : "refund",
      amount: metadata.amount !== undefined ? Number(metadata.amount) : Number(row.amount),
      reference: metadata.reference || null
    };
    return ["refund.created", "refund.completed"].map((type) => ({ type, data: { ...data, refund } }));
  }
  const type = STATUS_EVENT[row.new_status];
  if (!type) return [];
  if (type === "payment.completed" && metadata.transactionReference) data.transactionReference = metadata.transactionReference;
  return [{ type, data }];
}

function envelopeFor(eventRowId, publicEvent, createdAt) {
  return {
    id: `evt_${sha256(`${eventRowId}:${publicEvent.type}`).slice(0, 32)}`,
    type: publicEvent.type,
    apiVersion: "v1",
    createdAt: new Date(createdAt).toISOString(),
    data: publicEvent.data
  };
}

function subscriptionWants(subscription, eventType) {
  return !subscription.events?.length || subscription.events.includes(eventType);
}

// Walk the event stream from the stored cursor and write delivery rows. The
// advisory lock only prevents concurrent workers doing the same reads - the
// ON CONFLICT DO NOTHING on the unique key is what guarantees correctness.
async function fanOutOnce() {
  // Advisory session locks live on a CONNECTION, so the lock and its unlock
  // must run on the same client - through the pool they can land on
  // different connections and the lock leaks forever.
  const client = await pool.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) locked", [FANOUT_LOCK]);
    if (!lock.rows[0].locked) {
      return { created: 0, scanned: 0, skippedLock: true };
    }
    const cursorRow = await client.query("SELECT value FROM platform_settings WHERE key = $1", [CURSOR_KEY]);
    const cursor = cursorRow.rows[0]?.value || {};
    const { rows: events } = await client.query(
      `SELECT e.id, e.event_type, e.previous_status, e.new_status, e.created_at, e.metadata,
              p.payment_id AS payment_public_id, p.amount, p.currency, p.merchant_reference, p.provider,
              m.id AS merchant_uuid, m.merchant_id AS merchant_code,
              t.terminal_id AS terminal_code
         FROM pos_payment_events e
         JOIN pos_payment_intents p ON p.id = e.payment_intent_id
         JOIN merchants m ON m.id = p.merchant_id
         LEFT JOIN pos_terminals t ON t.id = e.terminal_id
        WHERE (e.created_at, e.id) > ($1::TIMESTAMPTZ, $2::UUID)
        ORDER BY e.created_at, e.id
        LIMIT $3`,
      [cursor.ts || new Date(0).toISOString(), cursor.id || "00000000-0000-0000-0000-000000000000", FANOUT_BATCH]
    );
    if (!events.length) return { created: 0, scanned: 0 };

    const merchantIds = Array.from(new Set(events.map((row) => row.merchant_uuid)));
    const { rows: subscriptions } = await client.query(
      "SELECT id, merchant_id, events FROM webhook_subscriptions WHERE status = 'active' AND merchant_id = ANY($1)",
      [merchantIds]
    );
    const byMerchant = new Map();
    for (const subscription of subscriptions) {
      if (!byMerchant.has(subscription.merchant_id)) byMerchant.set(subscription.merchant_id, []);
      byMerchant.get(subscription.merchant_id).push(subscription);
    }

    let created = 0;
    for (const row of events) {
      const targets = byMerchant.get(row.merchant_uuid) || [];
      if (targets.length) {
        for (const publicEvent of publicEventsForRow(row)) {
          const envelope = envelopeFor(row.id, publicEvent, row.created_at);
          for (const subscription of targets) {
            if (!subscriptionWants(subscription, publicEvent.type)) continue;
            const inserted = await client.query(
              `INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, request_payload)
               VALUES ($1,$2,$3,$4::JSONB)
               ON CONFLICT (subscription_id, event_id, event_type) DO NOTHING
               RETURNING id`,
              [subscription.id, row.id, publicEvent.type, JSON.stringify(envelope)]
            );
            created += inserted.rowCount;
          }
        }
      }
    }
    const last = events[events.length - 1];
    await client.query(
      `UPDATE platform_settings SET value = jsonb_build_object('ts', $2::TEXT, 'id', $3::TEXT), updated_at = NOW() WHERE key = $1`,
      [CURSOR_KEY, new Date(last.created_at).toISOString(), last.id]
    );
    return { created, scanned: events.length };
  } finally {
    // Release ANY advisory lock this connection holds before returning it to the
    // pool. pg_advisory_unlock_all is bulletproof where unlocking one key was
    // not: the lock acquisition and the "not acquired" early-return now sit
    // INSIDE this try, so the finally always runs, and unlock_all clears the
    // lock even if a re-entrant acquire or an earlier poisoned tick left one on
    // this pooled connection. A session advisory lock that survived a release is
    // exactly what stranded pool connections as "idle" and 500'd every request.
    await client.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    client.release();
  }
}

/* ---------------------------------------------------------------- delivery */

// Signature over exactly what travels: timestamp, event id, and the SHA-256
// of the raw body, HMAC-SHA256 with the subscription secret. The same
// canonical-request idea as POS terminal auth, in the outbound direction.
function signDelivery(secret, timestamp, eventId, body) {
  return crypto.createHmac("sha256", secret)
    .update(`${timestamp}\n${eventId}\n${sha256(body)}`)
    .digest("hex");
}

async function postSigned(subscription, envelope, deliveryId) {
  const body = JSON.stringify(envelope);
  const timestamp = String(Date.now());
  const headers = {
    "content-type": "application/json",
    "user-agent": `TitoPay-Webhooks/${API_BUILD}`,
    "x-titopay-timestamp": timestamp,
    "x-titopay-event-id": envelope.id,
    "x-titopay-event-type": envelope.type,
    "x-titopay-delivery-id": deliveryId,
    "x-titopay-signature": `sha256=${signDelivery(decryptSecret(subscription.secret_encrypted), timestamp, envelope.id, body)}`
  };
  if (subscription.previous_secret_encrypted && subscription.previous_secret_expires_at &&
      new Date(subscription.previous_secret_expires_at).getTime() > Date.now()) {
    const previous = decryptSecret(subscription.previous_secret_encrypted);
    if (previous) headers["x-titopay-signature-previous"] = `sha256=${signDelivery(previous, timestamp, envelope.id, body)}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // redirect: "manual" — SSRF defence. assertDeliverableUrl validated the
    // REGISTERED url (HTTPS, no private/link-local/loopback host), but following
    // a redirect would let a merchant register a clean endpoint that 3xx-redirects
    // to an internal address (169.254.169.254, 127.0.0.1, .internal), bypassing
    // that guard from inside the network. A redirect is treated as a delivery
    // failure instead of being followed.
    const response = await fetch(subscription.endpoint_url, { method: "POST", headers, body, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, statusCode: response.status, body: "Redirect responses are not followed for webhook delivery (SSRF protection). Point the subscription directly at the final HTTPS endpoint." };
    }
    const text = await response.text().catch(() => "");
    return { ok: response.ok, statusCode: response.status, body: text.slice(0, RESPONSE_BODY_LIMIT) };
  } finally {
    clearTimeout(timer);
  }
}

async function recordOutcome(delivery, outcome) {
  const attemptEntry = {
    attempt: delivery.attempt_number,
    at: new Date().toISOString(),
    statusCode: outcome.statusCode || null,
    error: outcome.error || null
  };
  if (outcome.ok) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'delivered', response_code = $2, response_body = $3, last_error = NULL,
              delivered_at = NOW(), attempt_log = attempt_log || $4::JSONB
        WHERE id = $1`,
      [delivery.id, outcome.statusCode, outcome.body || null, JSON.stringify([attemptEntry])]
    );
    await pool.query("UPDATE webhook_subscriptions SET consecutive_failures = 0 WHERE id = $1", [delivery.subscription_id]);
    return "delivered";
  }
  // An endpoint that answers 410 Gone is saying "stop": disable, don't retry.
  if (outcome.statusCode === 410) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'dead', response_code = $2, response_body = $3,
              last_error = 'Endpoint answered 410 Gone', attempt_log = attempt_log || $4::JSONB
        WHERE id = $1`,
      [delivery.id, outcome.statusCode, outcome.body || null, JSON.stringify([attemptEntry])]
    );
    await pool.query("UPDATE webhook_subscriptions SET status = 'disabled', updated_at = NOW() WHERE id = $1", [delivery.subscription_id]);
    return "dead";
  }
  const exhausted = delivery.attempt_number >= MAX_ATTEMPTS;
  if (exhausted) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'dead', response_code = $2, response_body = $3, last_error = $4,
              attempt_log = attempt_log || $5::JSONB
        WHERE id = $1`,
      [delivery.id, outcome.statusCode || null, outcome.body || null,
       outcome.error || `HTTP ${outcome.statusCode}`, JSON.stringify([attemptEntry])]
    );
    const { rows } = await pool.query(
      `UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1, updated_at = NOW()
        WHERE id = $1 RETURNING consecutive_failures`,
      [delivery.subscription_id]
    );
    if (rows[0] && rows[0].consecutive_failures >= PAUSE_AFTER_CONSECUTIVE_DEAD) {
      await pool.query("UPDATE webhook_subscriptions SET status = 'paused' WHERE id = $1 AND status = 'active'", [delivery.subscription_id]);
    }
    return "dead";
  }
  const delaySeconds = RETRY_DELAY_SECONDS[delivery.attempt_number] || 21600;
  await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'failed', response_code = $2, response_body = $3, last_error = $4,
            next_retry_at = NOW() + ($5 || ' seconds')::INTERVAL, attempt_log = attempt_log || $6::JSONB
      WHERE id = $1`,
    [delivery.id, outcome.statusCode || null, outcome.body || null,
     outcome.error || `HTTP ${outcome.statusCode}`, delaySeconds, JSON.stringify([attemptEntry])]
  );
  return "retrying";
}

// Claim due deliveries and post them. FOR UPDATE SKIP LOCKED means any number
// of workers can run this concurrently without double-sending.
async function deliverDueOnce() {
  const client = await pool.connect();
  let claimed;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE webhook_deliveries d
          SET status = 'delivering', attempt_number = d.attempt_number + 1
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE status IN ('pending', 'failed') AND next_retry_at <= NOW()
           ORDER BY next_retry_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING d.*`,
      [CLAIM_BATCH]
    );
    await client.query("COMMIT");
    claimed = result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const counts = { delivered: 0, retrying: 0, dead: 0 };
  for (const delivery of claimed) {
    const { rows } = await pool.query("SELECT * FROM webhook_subscriptions WHERE id = $1", [delivery.subscription_id]);
    const subscription = rows[0];
    if (!subscription || subscription.status === "disabled") {
      await recordOutcome(delivery, { ok: false, statusCode: 410, error: "Subscription no longer active" });
      counts.dead += 1;
      continue;
    }
    let outcome;
    try {
      outcome = await postSigned(subscription, delivery.request_payload, delivery.id);
    } catch (error) {
      outcome = { ok: false, error: error.name === "AbortError" ? `Timed out after ${DELIVERY_TIMEOUT_MS}ms` : String(error.message || error).slice(0, 300) };
    }
    const result = await recordOutcome(delivery, outcome);
    counts[result === "retrying" ? "retrying" : result] += 1;
  }
  return { claimed: claimed.length, ...counts };
}

/* ------------------------------------------------------- replay + listings */

async function listDeliveries(merchant, subscriptionId, { status, limit } = {}) {
  await requireOwnedSubscription(merchant, subscriptionId);
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [subscriptionId];
  let filter = "";
  if (status) {
    if (!["pending", "delivering", "delivered", "failed", "dead"].includes(status)) throw new AppError(400, "Unknown delivery status filter");
    params.push(status);
    filter = "AND status = $2";
  }
  const { rows } = await pool.query(
    `SELECT id, event_id, event_type, status, attempt_number, attempt_log, response_code,
            last_error, delivered_at, next_retry_at, created_at, request_payload
       FROM webhook_deliveries
      WHERE subscription_id = $1 ${filter}
      ORDER BY created_at DESC
      LIMIT ${bounded}`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    eventId: row.request_payload?.id || row.event_id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempt_number,
    attemptLog: row.attempt_log || [],
    responseCode: row.response_code,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at
  }));
}

// Replay re-queues an existing delivery for immediate re-send - the payload
// stays frozen, the attempt history stays on the row. Works on any state,
// which is how a partner recovers after fixing their endpoint.
async function replayDelivery(merchant, subscriptionId, deliveryId, actor = {}, meta = {}) {
  await requireOwnedSubscription(merchant, subscriptionId);
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'pending', next_retry_at = NOW(), last_error = NULL
      WHERE id = $1 AND subscription_id = $2
      RETURNING id, event_type, attempt_number`,
    [deliveryId, subscriptionId]
  );
  if (!rows[0]) throw new AppError(404, "Webhook delivery not found");
  await writeAuditLog({
    actorType: actor.userType || "user", actorId: actor.userId || null,
    action: "webhook_delivery_replayed", entityType: "webhook_delivery", entityId: deliveryId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { merchantId: merchant.merchant_id, subscriptionId, eventType: rows[0].event_type }
  });
  return { id: rows[0].id, status: "pending", attemptsSoFar: rows[0].attempt_number };
}

// A synchronous test ping so an integrator can prove their endpoint and
// signature verification before any real money moves.
async function sendTestEvent(merchant, subscriptionId) {
  const subscription = await requireOwnedSubscription(merchant, subscriptionId);
  const envelope = {
    id: `evt_test_${crypto.randomBytes(8).toString("hex")}`,
    type: "test.ping",
    apiVersion: "v1",
    createdAt: new Date().toISOString(),
    data: { merchantId: merchant.merchant_id, message: "TitoPay webhook test delivery" }
  };
  try {
    const outcome = await postSigned(subscription, envelope, envelope.id);
    return { delivered: outcome.ok, statusCode: outcome.statusCode, responseBody: outcome.body };
  } catch (error) {
    return { delivered: false, error: error.name === "AbortError" ? `Timed out after ${DELIVERY_TIMEOUT_MS}ms` : String(error.message || error).slice(0, 300) };
  }
}

/* ------------------------------------------------------------------ worker */

let workerTimer = null;
let workerStopping = false;

async function heartbeat(extra = {}) {
  await pool.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, $2::JSONB)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), build: API_BUILD, pid: process.pid, ...extra })]
  ).catch(() => {});
}

async function runWorkerTick() {
  const fanned = await fanOutOnce();
  const delivered = await deliverDueOnce();
  if (fanned.created || delivered.claimed) {
    console.info("[webhook-worker] tick", { fannedOut: fanned.created, ...delivered });
  }
  await heartbeat({ fannedOut: fanned.created, ...delivered });
  return { fanned, delivered };
}

// Runs inside the API by default so a deployment that never configures a
// second process still delivers webhooks. A standalone worker
// (src/webhook-worker.js) sets WEBHOOK_WORKER_INLINE=0 on the API to take
// over. Never fatal: a failed tick logs and the next tick tries again.
function startWebhookWorker(intervalMs = Number(process.env.WEBHOOK_WORKER_POLL_MS || 5000)) {
  if (workerTimer) return;
  workerStopping = false;
  const loop = async () => {
    if (workerStopping) return;
    try {
      await runWorkerTick();
    } catch (error) {
      console.error("[webhook-worker] tick failed", { message: error.message, code: error.code });
    } finally {
      if (!workerStopping) workerTimer = setTimeout(loop, intervalMs);
    }
  };
  workerTimer = setTimeout(loop, intervalMs);
}

function stopWebhookWorker() {
  workerStopping = true;
  clearTimeout(workerTimer);
  workerTimer = null;
}

async function workerStatus() {
  const [beat, due, dead] = await Promise.all([
    pool.query("SELECT value FROM platform_settings WHERE key = $1", [HEARTBEAT_KEY]),
    pool.query("SELECT COUNT(*)::INT total FROM webhook_deliveries WHERE status IN ('pending','failed') AND next_retry_at <= NOW()"),
    pool.query("SELECT COUNT(*)::INT total FROM webhook_deliveries WHERE status = 'dead'")
  ]);
  const lastBeat = beat.rows[0]?.value?.at ? new Date(beat.rows[0].value.at).getTime() : 0;
  return {
    status: !lastBeat ? "never_ran" : Date.now() - lastBeat > 120000 ? "stalled" : "ready",
    lastHeartbeat: beat.rows[0]?.value?.at || null,
    due: due.rows[0].total,
    dead: dead.rows[0].total
  };
}

module.exports = {
  EVENT_TYPES,
  ensureWebhookSchema,
  createSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
  rotateSecret,
  listDeliveries,
  replayDelivery,
  sendTestEvent,
  fanOutOnce,
  deliverDueOnce,
  runWorkerTick,
  startWebhookWorker,
  stopWebhookWorker,
  workerStatus,
  signDelivery,
  // exported for tests
  assertDeliverableUrl,
  publicEventsForRow
};
