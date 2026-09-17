"use strict";

// Outbound webhooks, tested against the real database and a real local HTTP
// receiver. WEBHOOK_ALLOW_PRIVATE lets these tests aim deliveries at
// 127.0.0.1; the override is honoured only under NODE_ENV=test, and a test
// below proves production-style URLs are still screened.

process.env.NODE_ENV = "test";
process.env.WEBHOOK_ALLOW_PRIVATE = "1";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "webhooks-test-access-secret-32-bytes!!";
process.env.JWT_REFRESH_SECRET ||= "webhooks-test-refresh-secret-32-bytes!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { pool } = require("../src/db/pool");
const webhooks = require("../src/services/webhook-service");

const stamp = Date.now().toString(36);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function makeMerchant(tag) {
  const userId = crypto.randomUUID();
  const username = `wh_${tag}_${stamp}_${crypto.randomBytes(2).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'business','Webhook Test',$2,$3,$4,'x')`,
    [userId, username, `${username}@t.local`, `+2773${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  const merchantId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,'Webhook Cafe',$3,'active','verified')`,
    [merchantId, userId, `WHM${stamp}${crypto.randomBytes(2).toString("hex")}`.toUpperCase().slice(0, 18)]
  );
  const terminalId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO pos_terminals (id, terminal_id, merchant_id, provider, device_identifier, status, credential_encrypted, credential_fingerprint)
     VALUES ($1,$2,$3,'OTHER','test-device','active','enc:x:y:z','testfinger')`,
    [terminalId, `WHT-${stamp}-${crypto.randomBytes(3).toString("hex")}`, merchantId]
  );
  const { rows } = await pool.query("SELECT * FROM merchants WHERE id = $1", [merchantId]);
  return { user: userId, merchant: rows[0], terminalId };
}

// A synthetic intent + event row pair, written the way the POS engine writes
// them. Fan-out reads tables, so this exercises the identical path without
// needing a signed terminal request.
async function makeIntentEvent(owner, { status = "COMPLETED", eventType = "payment_completed", metadata = {} } = {}) {
  const merchant = owner.merchant;
  const intentId = crypto.randomUUID();
  const paymentId = `POSP-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  await pool.query(
    `INSERT INTO pos_payment_intents
       (id, payment_id, merchant_id, terminal_id, amount, currency, merchant_reference, qr_token_hash, status, expires_at, provider)
     VALUES ($1,$2,$3,$4,25.50,'ZAR','TILL-7',$5,$6,NOW() + INTERVAL '2 minutes','OTHER')`,
    [intentId, paymentId, merchant.id, owner.terminalId, sha256(crypto.randomUUID()), status]
  );
  const { rows } = await pool.query(
    `INSERT INTO pos_payment_events
       (payment_intent_id, event_type, previous_status, new_status, actor_type, metadata)
     VALUES ($1,$2,'SCANNED',$3,'system',$4::JSONB)
     RETURNING id, created_at`,
    [intentId, eventType, status, JSON.stringify(metadata)]
  );
  return { intentId, paymentId, eventId: rows[0].id };
}

function receiver(handlerFor) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const record = { headers: req.headers, body };
      seen.push(record);
      const behaviour = handlerFor(record, seen.length);
      res.statusCode = behaviour.statusCode || 200;
      res.end(behaviour.body || "ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ seen, server, url: `http://127.0.0.1:${server.address().port}/hook` });
    });
  });
}

async function cleanup(merchants) {
  for (const { user, merchant } of merchants) {
    await pool.query("DELETE FROM webhook_subscriptions WHERE merchant_id = $1", [merchant.id]).catch(() => {});
    await pool.query("DELETE FROM pos_payment_events WHERE payment_intent_id IN (SELECT id FROM pos_payment_intents WHERE merchant_id = $1)", [merchant.id]).catch(() => {});
    await pool.query("DELETE FROM pos_payment_intents WHERE merchant_id = $1", [merchant.id]).catch(() => {});
    await pool.query("DELETE FROM pos_terminals WHERE merchant_id = $1", [merchant.id]).catch(() => {});
    await pool.query("DELETE FROM merchants WHERE id = $1", [merchant.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [user]).catch(() => {});
  }
}


// The fan-out cursor persists in the shared test database, and other suites
// (the settlement engine drives the REAL POS engine) leave a backlog of
// events behind it. Production's worker loops until it catches up; a test
// calls fanOutOnce once, so start each suite at the tip of the stream.
async function fastForwardFanOutCursor() {
  const { rows } = await pool.query(
    "SELECT id, created_at FROM pos_payment_events ORDER BY created_at DESC, id DESC LIMIT 1");
  if (!rows[0]) return;
  await pool.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ('webhook_fanout_cursor', jsonb_build_object('ts', $1::TEXT, 'id', $2::TEXT))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date(rows[0].created_at).toISOString(), rows[0].id]
  );
}

test.before(async () => {
  await webhooks.ensureWebhookSchema();
  await fastForwardFanOutCursor();
});

test("endpoint URLs are screened: https only, no private targets, no credentials", () => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  assert.throws(() => webhooks.assertDeliverableUrl("http://example.com/hook"), /HTTPS/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://localhost/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://127.0.0.1/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://10.0.0.8/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://192.168.1.10/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://172.16.4.4/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://internal.local/hook"), /publicly reachable/);
  assert.throws(() => webhooks.assertDeliverableUrl("https://user:pass@example.com/hook"), /credentials/);
  assert.throws(() => webhooks.assertDeliverableUrl("not a url"), /valid URL/);
  assert.equal(webhooks.assertDeliverableUrl("https://pos.example.com/hooks/titopay"), "https://pos.example.com/hooks/titopay");
  process.env.WEBHOOK_ALLOW_PRIVATE = "1";
});

test("subscription lifecycle: create shows the secret once, list masks it, update and delete work", async () => {
  const owner = await makeMerchant("crud");
  try {
    const created = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: "https://pos.example.com/hooks", events: ["payment.completed"] }, { userId: owner.user });
    assert.match(created.secret, /^whsec_/);
    assert.equal(created.subscription.status, "active");

    const stored = await pool.query("SELECT secret_encrypted FROM webhook_subscriptions WHERE id = $1", [created.subscription.id]);
    assert.match(stored.rows[0].secret_encrypted, /^enc:/, "the secret is encrypted at rest");
    assert.ok(!stored.rows[0].secret_encrypted.includes(created.secret.slice(6, 20)));

    const listed = await webhooks.listSubscriptions(owner.merchant);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secretFingerprint.length, 16);
    assert.ok(!JSON.stringify(listed).includes("whsec_"), "listing never leaks a secret");

    await assert.rejects(() => webhooks.createSubscription(owner.merchant,
      { endpointUrl: "https://pos.example.com/hooks" }, { userId: owner.user }), /already exists/);

    const updated = await webhooks.updateSubscription(owner.merchant, created.subscription.id,
      { events: [], status: "paused", description: "till 7" }, { userId: owner.user });
    assert.equal(updated.status, "paused");
    assert.deepEqual(updated.events, []);

    await assert.rejects(() => webhooks.updateSubscription(owner.merchant, created.subscription.id,
      { events: ["payment.borrowed"] }, {}), /Unknown webhook event/);

    const removed = await webhooks.deleteSubscription(owner.merchant, created.subscription.id, { userId: owner.user });
    assert.equal(removed.deleted, true);
    assert.equal((await webhooks.listSubscriptions(owner.merchant)).length, 0);
  } finally {
    await cleanup([owner]);
  }
});

test("merchant isolation: one merchant can never read or change another's subscription", async () => {
  const alpha = await makeMerchant("iso1");
  const beta = await makeMerchant("iso2");
  try {
    const created = await webhooks.createSubscription(alpha.merchant,
      { endpointUrl: "https://alpha.example.com/hooks" }, { userId: alpha.user });
    await assert.rejects(() => webhooks.updateSubscription(beta.merchant, created.subscription.id, {}, {}), /not found/);
    await assert.rejects(() => webhooks.rotateSecret(beta.merchant, created.subscription.id, {}), /not found/);
    await assert.rejects(() => webhooks.listDeliveries(beta.merchant, created.subscription.id, {}), /not found/);
    await assert.rejects(() => webhooks.deleteSubscription(beta.merchant, created.subscription.id, {}), /not found/);
  } finally {
    await cleanup([alpha, beta]);
  }
});

test("fan-out translates the event stream, honours filters, and re-running creates nothing twice", async () => {
  const owner = await makeMerchant("fan");
  try {
    const wantAll = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: "https://all.example.com/hooks", events: [] }, { userId: owner.user });
    const wantRefunds = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: "https://refunds.example.com/hooks", events: ["refund.completed"] }, { userId: owner.user });

    await makeIntentEvent(owner, { status: "COMPLETED", eventType: "payment_completed", metadata: { transactionReference: "TX-1" } });
    await makeIntentEvent(owner, { status: "REFUNDED", eventType: "payment_refunded", metadata: { amount: 25.5, reference: "POS-REF-1" } });

    const first = await webhooks.fanOutOnce();
    assert.ok(first.created >= 4, `expected >=4 deliveries, created ${first.created}`);

    const again = await webhooks.fanOutOnce();
    assert.equal(again.created, 0, "re-running fan-out must be a no-op");

    const allRows = await webhooks.listDeliveries(owner.merchant, wantAll.subscription.id, {});
    const types = allRows.map((row) => row.eventType).sort();
    assert.deepEqual(types, ["payment.completed", "refund.completed", "refund.created"]);
    const completed = allRows.find((row) => row.eventType === "payment.completed");
    assert.equal(completed.status, "pending");

    const refundRows = await webhooks.listDeliveries(owner.merchant, wantRefunds.subscription.id, {});
    assert.deepEqual(refundRows.map((row) => row.eventType), ["refund.completed"],
      "the filtered subscription receives only what it asked for");

    // refund.created and refund.completed come from one source event and must
    // carry DIFFERENT envelope ids, or consumer-side dedupe drops one.
    const refundIds = allRows.filter((row) => row.eventType.startsWith("refund.")).map((row) => row.eventId);
    assert.equal(new Set(refundIds).size, 2);
  } finally {
    await cleanup([owner]);
  }
});

test("delivery signs correctly, marks delivered, and a rotated secret keeps verifying via the previous signature", async () => {
  const owner = await makeMerchant("sign");
  const target = await receiver(() => ({ statusCode: 200 }));
  try {
    const created = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: target.url, events: ["payment.completed"] }, { userId: owner.user });
    const firstSecret = created.secret;
    await makeIntentEvent(owner, {});
    await webhooks.fanOutOnce();
    let outcome = await webhooks.deliverDueOnce();
    assert.equal(outcome.delivered, 1);

    const hit = target.seen[0];
    const body = hit.body;
    const timestamp = hit.headers["x-titopay-timestamp"];
    const eventId = hit.headers["x-titopay-event-id"];
    assert.match(hit.headers["x-titopay-signature"], /^sha256=/);
    const expected = webhooks.signDelivery(firstSecret, timestamp, eventId, body);
    const received = hit.headers["x-titopay-signature"].replace(/^sha256=/, "");
    assert.ok(crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received)),
      "the signature verifies with the documented recipe");
    assert.equal(JSON.parse(body).type, "payment.completed");
    assert.equal(JSON.parse(body).data.currency, "ZAR");

    // Rotate, deliver another event: the primary signature uses the NEW
    // secret and the previous-signature header still verifies with the old.
    const rotated = await webhooks.rotateSecret(owner.merchant, created.subscription.id, { userId: owner.user });
    await makeIntentEvent(owner, {});
    await webhooks.fanOutOnce();
    outcome = await webhooks.deliverDueOnce();
    assert.equal(outcome.delivered, 1);
    const second = target.seen[1];
    const primary = second.headers["x-titopay-signature"].replace(/^sha256=/, "");
    const secondary = String(second.headers["x-titopay-signature-previous"] || "").replace(/^sha256=/, "");
    assert.equal(primary, webhooks.signDelivery(rotated.secret, second.headers["x-titopay-timestamp"], second.headers["x-titopay-event-id"], second.body));
    assert.equal(secondary, webhooks.signDelivery(firstSecret, second.headers["x-titopay-timestamp"], second.headers["x-titopay-event-id"], second.body));

    const rows = await webhooks.listDeliveries(owner.merchant, created.subscription.id, { status: "delivered" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].responseCode, 200);
  } finally {
    target.server.close();
    await cleanup([owner]);
  }
});

test("failures walk the retry ladder to the dead-letter state, and replay revives them", async () => {
  const owner = await makeMerchant("retry");
  // Six failing attempts exhaust the ladder; the seventh call (the replay)
  // finds the endpoint fixed.
  const target = await receiver((_record, count) => (count <= 6 ? { statusCode: 500, body: "boom" } : { statusCode: 200 }));
  try {
    const created = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: target.url }, { userId: owner.user });
    await makeIntentEvent(owner, {});
    await webhooks.fanOutOnce();

    // Attempt 1 fails: status failed, next retry ~60s out, attempt log grows.
    let outcome = await webhooks.deliverDueOnce();
    assert.equal(outcome.retrying, 1);
    let [row] = await webhooks.listDeliveries(owner.merchant, created.subscription.id, {});
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(row.responseCode, 500);
    const wait = (new Date(row.nextRetryAt).getTime() - Date.now()) / 1000;
    assert.ok(wait > 50 && wait < 70, `first retry should be ~60s out, was ${Math.round(wait)}s`);

    // Force each retry due and exhaust the ladder: 6 attempts then dead.
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      await pool.query("UPDATE webhook_deliveries SET next_retry_at = NOW() WHERE subscription_id = $1", [created.subscription.id]);
      outcome = await webhooks.deliverDueOnce();
    }
    [row] = await webhooks.listDeliveries(owner.merchant, created.subscription.id, {});
    assert.equal(row.status, "dead");
    assert.equal(row.attempts, 6);
    assert.equal(row.attemptLog.length, 6, "every attempt is recorded on the row");

    const failures = await pool.query("SELECT consecutive_failures FROM webhook_subscriptions WHERE id = $1", [created.subscription.id]);
    assert.equal(failures.rows[0].consecutive_failures, 1);

    // Replay: the same frozen payload goes out again and now succeeds.
    const replayed = await webhooks.replayDelivery(owner.merchant, created.subscription.id, row.id, { userId: owner.user });
    assert.equal(replayed.status, "pending");
    outcome = await webhooks.deliverDueOnce();
    assert.equal(outcome.delivered, 1);
    [row] = await webhooks.listDeliveries(owner.merchant, created.subscription.id, {});
    assert.equal(row.status, "delivered");
    const reset = await pool.query("SELECT consecutive_failures FROM webhook_subscriptions WHERE id = $1", [created.subscription.id]);
    assert.equal(reset.rows[0].consecutive_failures, 0, "a delivery resets the failure streak");
  } finally {
    target.server.close();
    await cleanup([owner]);
  }
});

test("an endpoint answering 410 Gone disables its subscription outright", async () => {
  const owner = await makeMerchant("gone");
  const target = await receiver(() => ({ statusCode: 410 }));
  try {
    const created = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: target.url }, { userId: owner.user });
    await makeIntentEvent(owner, {});
    await webhooks.fanOutOnce();
    const outcome = await webhooks.deliverDueOnce();
    assert.equal(outcome.dead, 1);
    const { rows } = await pool.query("SELECT status FROM webhook_subscriptions WHERE id = $1", [created.subscription.id]);
    assert.equal(rows[0].status, "disabled");
  } finally {
    target.server.close();
    await cleanup([owner]);
  }
});

test("a paused subscription receives no fan-out and internal transitions never leak", async () => {
  const owner = await makeMerchant("quiet");
  try {
    const created = await webhooks.createSubscription(owner.merchant,
      { endpointUrl: "https://paused.example.com/hooks" }, { userId: owner.user });
    await webhooks.updateSubscription(owner.merchant, created.subscription.id, { status: "paused" }, {});
    await makeIntentEvent(owner, {});
    // AUTHORIZED and PROCESSING are internal steps: no public event.
    await makeIntentEvent(owner, { status: "AUTHORIZED", eventType: "authorized" });
    await webhooks.fanOutOnce();
    const rows = await webhooks.listDeliveries(owner.merchant, created.subscription.id, {});
    assert.equal(rows.length, 0);
    assert.deepEqual(webhooks.publicEventsForRow({ event_type: "authorized", new_status: "AUTHORIZED", metadata: {} }), []);
  } finally {
    await cleanup([owner]);
  }
});
