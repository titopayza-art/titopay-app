"use strict";

// Partner credentials + sandbox onboarding, tested end to end against the
// real database and the real POS engine. TITOPAY_ENV=sandbox here does what
// it does on a sandbox deployment; one test flips it to production to prove
// the sandbox refuses to exist there.

process.env.NODE_ENV = "test";
process.env.TITOPAY_ENV = "sandbox";
process.env.WEBHOOK_ALLOW_PRIVATE = "1";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "partners-test-access-secret-32-bytes!!";
process.env.JWT_REFRESH_SECRET ||= "partners-test-refresh-secret-32-bytes!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { pool } = require("../src/db/pool");
const partners = require("../src/services/partner-service");
const sandbox = require("../src/services/sandbox-service");
const webhooks = require("../src/services/webhook-service");
const pos = require("../src/pos/service");

const stamp = Date.now().toString(36);
const meta = { ipAddress: "127.0.0.1", userAgent: "node-test" };

async function freshPartner(tag) {
  const result = await partners.registerPartner({
    companyName: `POS Vendor ${tag}`,
    contactName: "Dev Lead",
    email: `vendor_${tag}_${stamp}_${crypto.randomBytes(2).toString("hex")}@example.com`
  }, meta);
  return result;
}

async function terminalContext(terminalDbId) {
  const { rows } = await pool.query(
    `SELECT t.*, t.merchant_id AS merchant_id_uuid,
            m.merchant_id AS merchant_code, m.business_name,
            m.status AS merchant_status, m.verification_status
       FROM pos_terminals t JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1 LIMIT 1`, [terminalDbId]);
  return rows[0];
}

function receiver() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { seen.push({ headers: req.headers, body }); res.statusCode = 200; res.end("ok"); });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ seen, server, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

async function cleanupPartner(partnerId) {
  const fake = { id: partnerId };
  await sandbox.resetSandbox(fake).catch(() => {});
  await pool.query("DELETE FROM api_partners WHERE id = $1", [partnerId]).catch(() => {});
}

test.before(async () => {
  await partners.ensurePartnerSchema();
  await webhooks.ensureWebhookSchema();
});

test("registration is self-service: partner + one-time sandbox key; duplicate email refused", async () => {
  const { partner, sandboxKey } = await freshPartner("reg");
  try {
    assert.equal(partner.status, "pending");
    assert.match(sandboxKey, /^tpk_test_/);
    const stored = await pool.query("SELECT key_hash, key_prefix FROM api_partner_keys WHERE partner_id = $1", [partner.id]);
    assert.equal(stored.rows.length, 1);
    assert.ok(!stored.rows[0].key_hash.includes(sandboxKey.slice(9, 20)), "only the hash is stored");
    assert.equal(stored.rows[0].key_prefix, sandboxKey.slice(0, 12));
    await assert.rejects(() => partners.registerPartner({ companyName: "Again", email: partner.email }, meta), /already exists/);
  } finally {
    await cleanupPartner(partner.id);
  }
});

test("key lifecycle: auth, rotation with 24h grace, revocation, expiry, environment match, suspension", async () => {
  const { partner, sandboxKey } = await freshPartner("keys");
  try {
    const authed = await partners.authenticateKey(sandboxKey);
    assert.equal(authed.partner_id, partner.id);

    // Production keys are gated on approval, then refused by a sandbox runtime.
    await assert.rejects(() => partners.createKey(partner.id, "production", "test", meta), /approved by TitoPay/);
    await partners.adminSetPartnerStatus(partner.id, "approved", { userId: crypto.randomUUID() }, meta);
    const production = await partners.createKey(partner.id, "production", "test", meta);
    assert.match(production.plaintext, /^tpk_live_/);
    await assert.rejects(() => partners.authenticateKey(production.plaintext), /production key.*sandbox|sandbox environment/i);

    // Rotation: fresh key immediately, old key expiring on a 24-hour grace.
    const keys = await partners.listKeys(partner.id);
    const original = keys.find((key) => key.environment === "sandbox");
    const rotated = await partners.rotateKey(partner.id, original.id, "test", meta);
    assert.match(rotated.plaintext, /^tpk_test_/);
    await partners.authenticateKey(rotated.plaintext);
    const graced = (await partners.listKeys(partner.id)).find((key) => key.id === original.id);
    const hours = (new Date(graced.expiresAt).getTime() - Date.now()) / 3600000;
    assert.ok(hours > 23 && hours <= 24, `grace should be ~24h, was ${hours.toFixed(1)}h`);
    await partners.authenticateKey(sandboxKey); // still inside the grace window

    // Forced expiry refuses; revocation refuses.
    await pool.query("UPDATE api_partner_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [original.id]);
    await assert.rejects(() => partners.authenticateKey(sandboxKey), /expired/);
    await partners.revokeKey(partner.id, rotated.key.id, "test", meta);
    await assert.rejects(() => partners.authenticateKey(rotated.plaintext), /not valid/);

    // Suspension kills every remaining key at the next request.
    const replacement = await partners.createKey(partner.id, "sandbox", "test", meta);
    await partners.adminSetPartnerStatus(partner.id, "suspended", { userId: crypto.randomUUID() }, meta);
    await assert.rejects(() => partners.authenticateKey(replacement.plaintext), /suspended/);
  } finally {
    await cleanupPartner(partner.id);
  }
});

test("the sandbox refuses to exist on a production deployment", async () => {
  const { partner } = await freshPartner("guard");
  try {
    process.env.TITOPAY_ENV = "production";
    assert.equal(sandbox.sandboxEnabled(), false);
    await assert.rejects(() => sandbox.createSandboxMerchant(partner, {}, meta), /not available in this environment/);
    await assert.rejects(() => sandbox.simulatePayment(partner, "POSP-X", {}, meta), /not available in this environment/);
  } finally {
    process.env.TITOPAY_ENV = "sandbox";
    await cleanupPartner(partner.id);
  }
});

test("provisioning: one call yields a working merchant, funded customer and signable terminal", async () => {
  const { partner } = await freshPartner("prov");
  try {
    const provisioned = await sandbox.createSandboxMerchant(partner, { businessName: "Sim Cafe" }, meta);
    assert.match(provisioned.merchant.merchantId, /^TPM-SBX-/);
    assert.ok(provisioned.merchant.accessToken.length > 40, "merchant token minted");
    assert.equal(provisioned.testCustomer.walletBalance, 10000);
    const wallet = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [provisioned.testCustomer.id]);
    assert.equal(Number(wallet.rows[0].available_balance), 10000);

    const terminal = await sandbox.createSandboxTerminal(partner, { merchantId: provisioned.merchant.merchantId }, meta);
    assert.ok(terminal.terminalSecret.length > 30, "terminal secret issued once");
    assert.equal(terminal.terminal.status, "active");

    // Another partner cannot provision terminals against this merchant.
    const rival = await freshPartner("rival");
    await assert.rejects(
      () => sandbox.createSandboxTerminal(rival.partner, { merchantId: provisioned.merchant.merchantId }, meta),
      /not found for this partner/);
    await cleanupPartner(rival.partner.id);
  } finally {
    await cleanupPartner(partner.id);
  }
});

test("simulator drives the REAL engine: complete moves sandbox money and fires webhooks; expire, cancel, refund, insufficient all behave", async () => {
  const { partner } = await freshPartner("sim");
  const target = await receiver();
  try {
    const provisioned = await sandbox.createSandboxMerchant(partner, { businessName: "Sim Till" }, meta);
    const terminal = await sandbox.createSandboxTerminal(partner, { merchantId: provisioned.merchant.merchantId }, meta);
    const context = await terminalContext(terminal.terminal.id);
    const merchantRow = (await pool.query("SELECT * FROM merchants WHERE merchant_id = $1", [provisioned.merchant.merchantId])).rows[0];
    await webhooks.createSubscription(merchantRow, { endpointUrl: target.url }, { userId: merchantRow.user_id });

    const intentFor = async (amount, ref) => pos.createPaymentIntent(context, {
      merchantId: provisioned.merchant.merchantId,
      terminalId: terminal.terminal.terminal_id,
      amount, currency: "ZAR", merchantReference: ref
    }, `it:${ref}:${stamp}`, "test-req");

    // COMPLETE: scan + confirm through the real engine - real ledger movement.
    const payIntent = await intentFor(149.5, "SBX-PAY-1");
    const token = payIntent.qrPayload.split("/").pop();
    const completed = await sandbox.simulatePayment(partner, payIntent.paymentId, { outcome: "complete", token }, meta);
    assert.equal(completed.status, "COMPLETED");
    const merchantWallet = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [merchantRow.user_id]);
    assert.equal(Number(merchantWallet.rows[0].available_balance), 149.5, "sandbox money genuinely moved");

    // REFUND (partial) through the real refund path.
    const refunded = await sandbox.simulatePayment(partner, payIntent.paymentId, { outcome: "refund", amount: 49.5 }, meta);
    assert.equal(refunded.amount, 49.5);
    const afterRefund = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [merchantRow.user_id]);
    assert.equal(Number(afterRefund.rows[0].available_balance), 100);

    // EXPIRE via the engine's own lazy-expiry.
    const expireIntent = await intentFor(20, "SBX-EXP-1");
    const expired = await sandbox.simulatePayment(partner, expireIntent.paymentId, { outcome: "expire" }, meta);
    assert.equal(expired.status, "EXPIRED");

    // CANCEL as the terminal.
    const cancelIntent = await intentFor(30, "SBX-CAN-1");
    const cancelled = await sandbox.simulatePayment(partner, cancelIntent.paymentId, { outcome: "cancel" }, meta);
    assert.equal(cancelled.status, "CANCELLED");

    // INSUFFICIENT: the vendor sees the production refusal shape, no money moves.
    const brokeIntent = await intentFor(500, "SBX-BRK-1");
    const brokeToken = brokeIntent.qrPayload.split("/").pop();
    const refused = await sandbox.simulatePayment(partner, brokeIntent.paymentId, { outcome: "insufficient", token: brokeToken }, meta);
    assert.equal(refused.refusedWith.statusCode, 400);
    assert.match(refused.refusedWith.error, /Insufficient balance/);

    // The real webhook pipeline saw all of it.
    await webhooks.fanOutOnce();
    await webhooks.deliverDueOnce();
    const types = target.seen.map((hit) => JSON.parse(hit.body).type);
    for (const expectedType of ["payment.created", "payment.completed", "refund.completed", "payment.expired", "payment.cancelled"]) {
      assert.ok(types.includes(expectedType), `expected a ${expectedType} delivery, saw ${types.join(", ")}`);
    }
  } finally {
    target.server.close();
    await cleanupPartner(partner.id);
  }
});

test("webhook generator produces signed synthetic events for the types the engine cannot mint on demand", async () => {
  const { partner, sandboxKey } = await freshPartner("gen");
  const target = await receiver();
  try {
    const provisioned = await sandbox.createSandboxMerchant(partner, {}, meta);
    const merchantRow = (await pool.query("SELECT * FROM merchants WHERE merchant_id = $1", [provisioned.merchant.merchantId])).rows[0];
    const subscription = await webhooks.createSubscription(merchantRow, { endpointUrl: target.url }, { userId: merchantRow.user_id });

    for (const eventType of ["payment.failed", "settlement.completed"]) {
      const result = await sandbox.generateWebhookEvent(partner, { eventType }, meta);
      assert.equal(result.queued, 1, `${eventType} queued`);
    }
    const bodies = target.seen.map((hit) => JSON.parse(hit.body));
    assert.deepEqual(bodies.map((body) => body.type).sort(), ["payment.failed", "settlement.completed"]);
    assert.ok(bodies.every((body) => body.data.sandboxGenerated === true), "synthetic events say so");

    // The signature on a generated event verifies with the subscription secret
    // by the exact documented recipe - proving the production signing path.
    const hit = target.seen[0];
    const expected = webhooks.signDelivery(subscription.secret,
      hit.headers["x-titopay-timestamp"], hit.headers["x-titopay-event-id"], hit.body);
    assert.equal(hit.headers["x-titopay-signature"].replace(/^sha256=/, ""), expected);

    await assert.rejects(() => sandbox.generateWebhookEvent(partner, { eventType: "payment.imagined" }, meta), /eventType must be one of/);
    assert.ok(sandboxKey); // registration key remains the partner's credential of record
  } finally {
    target.server.close();
    await cleanupPartner(partner.id);
  }
});

test("usage metering counts partner requests and errors through the auth middleware", async () => {
  const { partner, sandboxKey } = await freshPartner("use");
  try {
    const call = (statusCode) => new Promise((resolve, reject) => {
      const listeners = {};
      const req = { get: (name) => (name.toLowerCase() === "x-titopay-api-key" ? sandboxKey : "") };
      const res = { statusCode, on: (event, fn) => { listeners[event] = fn; } };
      partners.requirePartnerKey(req, res, (error) => {
        if (error) return reject(error);
        listeners.finish();
        resolve();
      });
    });
    await call(200);
    await call(200);
    await call(500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const usage = await partners.usageSeries(partner.id, 7);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].requests, 3);
    assert.equal(usage[0].errors, 1);

    const listing = await partners.adminListPartners();
    const mine = listing.find((row) => row.id === partner.id);
    assert.equal(mine.requests30d, 3);
    assert.equal(mine.activeKeys, 1);
  } finally {
    await cleanupPartner(partner.id);
  }
});

test("reset sweeps everything a partner provisioned", async () => {
  const { partner } = await freshPartner("rst");
  try {
    const provisioned = await sandbox.createSandboxMerchant(partner, {}, meta);
    await sandbox.createSandboxTerminal(partner, { merchantId: provisioned.merchant.merchantId }, meta);
    const swept = await sandbox.resetSandbox(partner);
    assert.equal(swept.cleared.merchants, 1);
    const merchants = await pool.query("SELECT 1 FROM merchants WHERE merchant_id = $1", [provisioned.merchant.merchantId]);
    assert.equal(merchants.rows.length, 0);
    const resources = await partners.partnerResourceIds(partner.id, "merchant");
    assert.equal(resources.length, 0);
  } finally {
    await cleanupPartner(partner.id);
  }
});
