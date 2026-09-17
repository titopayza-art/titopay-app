"use strict";

// The partner sandbox - provisioning and simulation, sandbox deployments only.
//
// The sandbox is a SECOND DEPLOYMENT of this same codebase (TITOPAY_ENV=
// sandbox, its own database) - the pattern the Peach integration established
// with its sandbox/production base URLs. Nothing here is a parallel payment
// engine: every simulator call drives the REAL POS service functions with
// provisioned sandbox principals, so what a vendor integrates against in the
// sandbox is byte-for-byte what production runs.
//
// Isolation is structural, not procedural: a production deployment refuses
// every endpoint in this module (see sandboxEnabled), the refusal is pinned
// by a test, and the sandbox deployment has no production data to leak
// because it has its own database.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { hashPassword } = require("../lib/passwords");
const pos = require("../pos/service");
const partners = require("./partner-service");
const webhooks = require("./webhook-service");
const { issueTokens } = require("./auth-service");

const CUSTOMER_STARTING_BALANCE = 10000;
const SANDBOX_PASSWORD_BYTES = 9;

function sandboxEnabled() {
  // No test-mode special case: the suite exercises the guard by setting
  // TITOPAY_ENV itself, exactly as a deployment would.
  return partners.runtimeEnvironment() === "sandbox";
}

function assertSandbox() {
  if (!sandboxEnabled()) throw new AppError(404, "The sandbox is not available in this environment");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14) || "sandbox";
}

/* ------------------------------------------------------------ provisioning */

async function createUserWithWallet({ accountType, fullName, username, walletKind, balance }) {
  const password = `Sbx-${crypto.randomBytes(SANDBOX_PASSWORD_BYTES).toString("base64url")}`;
  const userId = crypto.randomUUID();
  const email = `${username}@sandbox.titopay.co.za`;
  const phone = `+2779${Math.floor(1000000 + Math.random() * 8999999)}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'fully_verified')`,
    [userId, accountType, fullName, username, email, phone, await hashPassword(password)]
  );
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, user_id, wallet_number, kind, available_balance, reserved_balance)
     VALUES ($1,$2,$3,$4,$5,0)`,
    [walletId, userId, String(Math.floor(100000000 + Math.random() * 899999999)), walletKind, balance]
  );
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  const tokens = await issueTokens({
    user: { ...rows[0], user_type: "customer", role: "customer" },
    scope: "customer",
    deviceName: "TitoPay Sandbox",
    platform: "sandbox",
    userAgent: "sandbox-provisioner",
    ipAddress: "127.0.0.1"
  });
  return { userId, walletId, username, email, password, accessToken: tokens.accessToken };
}

// One call, one complete test business: a business user, an active verified
// merchant, its settlement wallet, and a funded test customer to pay with.
// Everything a vendor needs to run the full payment loop, returned once.
async function createSandboxMerchant(partner, payload = {}, meta = {}) {
  assertSandbox();
  const businessName = String(payload.businessName || "Sandbox Store").trim().slice(0, 80) || "Sandbox Store";
  const tag = `${slug(businessName)}${Date.now().toString(36).slice(-4)}${crypto.randomBytes(2).toString("hex")}`;

  const business = await createUserWithWallet({
    accountType: "business", fullName: businessName,
    username: `sbx_biz_${tag}`, walletKind: "business", balance: 0
  });
  const merchantId = crypto.randomUUID();
  const merchantCode = `TPM-SBX-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,$3,$4,'active','verified')`,
    [merchantId, business.userId, businessName, merchantCode]
  );
  const customer = await createUserWithWallet({
    accountType: "personal", fullName: "Sandbox Customer",
    username: `sbx_cus_${tag}`, walletKind: "personal", balance: CUSTOMER_STARTING_BALANCE
  });
  await partners.recordResource(partner.id, "merchant", merchantId);
  await partners.recordResource(partner.id, "customer", customer.userId);
  return {
    merchant: {
      id: merchantId,
      merchantId: merchantCode,
      businessName,
      login: { username: business.username, password: business.password },
      accessToken: business.accessToken
    },
    testCustomer: {
      id: customer.userId,
      login: { username: customer.username, password: customer.password },
      accessToken: customer.accessToken,
      walletBalance: CUSTOMER_STARTING_BALANCE
    },
    note: "Store these credentials now - the passwords and tokens are shown once."
  };
}

// A real terminal with real HMAC credentials, registered through the same
// registerTerminal the admin console uses in production. The vendor signs
// sandbox requests exactly as they will sign production ones.
async function createSandboxTerminal(partner, payload = {}, meta = {}) {
  assertSandbox();
  const merchantCode = String(payload.merchantId || "").trim();
  if (!merchantCode) throw new AppError(400, "merchantId (the TPM-... code) is required");
  const owned = await partners.partnerResourceIds(partner.id, "merchant");
  const { rows } = await pool.query("SELECT id FROM merchants WHERE merchant_id = $1 LIMIT 1", [merchantCode]);
  if (!rows[0] || !owned.includes(rows[0].id)) {
    throw new AppError(404, "Sandbox merchant not found for this partner");
  }
  const terminalId = String(payload.terminalId || `SBX-TERM-${crypto.randomBytes(3).toString("hex").toUpperCase()}`).trim();
  const result = await pos.registerTerminal(
    { userType: "admin", userId: null },
    {
      merchantId: merchantCode,
      terminalId,
      provider: "OTHER",
      deviceIdentifier: String(payload.deviceIdentifier || "sandbox-device").trim()
    },
    { ipAddress: meta.ipAddress, userAgent: meta.userAgent }
  );
  await partners.recordResource(partner.id, "terminal", result.terminal.id);
  return {
    terminal: result.terminal,
    terminalSecret: result.terminalSecret,
    signing: {
      headers: ["x-titopay-terminal-id", "x-titopay-timestamp", "x-titopay-nonce", "x-titopay-signature"],
      canonical: "timestamp \\n nonce \\n METHOD \\n path \\n sha256hex(body)",
      algorithm: "HMAC-SHA256, hex digest, signature header prefixed sha256="
    },
    note: "The terminal secret is shown once. Signing works exactly as in production."
  };
}

/* --------------------------------------------------------------- simulator */

async function loadIntentByPaymentId(paymentId) {
  const { rows } = await pool.query(
    `SELECT p.*, m.merchant_id AS merchant_code, t.terminal_id AS terminal_code
       FROM pos_payment_intents p
       JOIN merchants m ON m.id = p.merchant_id
       LEFT JOIN pos_terminals t ON t.id = p.terminal_id
      WHERE p.payment_id = $1
      LIMIT 1`,
    [paymentId]
  );
  if (!rows[0]) throw new AppError(404, "POS payment not found");
  return rows[0];
}

async function assertPartnerOwnsIntent(partner, intent) {
  const owned = await partners.partnerResourceIds(partner.id, "merchant");
  if (!owned.includes(intent.merchant_id)) throw new AppError(404, "POS payment not found for this partner");
}

async function sandboxCustomerActorFor(partner) {
  const customers = await partners.partnerResourceIds(partner.id, "customer");
  if (!customers.length) throw new AppError(409, "Provision a sandbox merchant first - it comes with a test customer");
  return { userType: "customer", userId: customers[0], profileLocked: false };
}

// The terminal-shaped context cancelPayment expects, built from the stored
// terminal row - identical to what requireTerminalAuth attaches.
async function terminalContextFor(intent) {
  const { rows } = await pool.query(
    `SELECT t.*, t.merchant_id AS merchant_id_uuid,
            m.merchant_id AS merchant_code, m.business_name,
            m.status AS merchant_status, m.verification_status
       FROM pos_terminals t
       JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1
      LIMIT 1`,
    [intent.terminal_id]
  );
  if (!rows[0]) throw new AppError(404, "Sandbox terminal not found");
  return rows[0];
}

// Drive one payment through the REAL engine to a chosen outcome. The vendor
// created the intent through the signed terminal API and holds its token;
// scan and complete need that token or the intent's paymentId only.
//
// Outcomes and what they exercise:
//   scan         - resolvePaymentIntent (customer app scanning the QR)
//   complete     - resolve if needed, then confirmPayment: REAL sandbox money
//                  moves customer -> merchant, webhooks fire
//   insufficient - a confirm attempt that the engine refuses (the vendor sees
//                  the exact production error shape)
//   expire       - the intent's clock is moved past expiry, then the engine's
//                  own lazy-expiry path writes EXPIRED
//   cancel       - cancelPayment as the terminal
//   refund       - refundOrReverse('refund', ...) after completion
//   reverse      - refundOrReverse('reverse', ...) after completion
async function simulatePayment(partner, paymentId, payload = {}, meta = {}) {
  assertSandbox();
  const outcome = String(payload.outcome || "").trim().toLowerCase();
  const requestId = `sbx-${crypto.randomUUID()}`;
  const intent = await loadIntentByPaymentId(paymentId);
  await assertPartnerOwnsIntent(partner, intent);

  if (outcome === "scan" || outcome === "complete") {
    const token = String(payload.token || "").trim();
    if (intent.status === "PENDING") {
      if (!token) throw new AppError(400, "token (from the payment intent's qrPayload) is required to scan");
      if (sha256(token) !== intent.qr_token_hash) throw new AppError(400, "token does not match this payment");
      const actor = await sandboxCustomerActorFor(partner);
      await pos.resolvePaymentIntent(token, actor, requestId);
      if (outcome === "scan") return { paymentId, status: "SCANNED" };
    }
    if (outcome === "complete") {
      const actor = await sandboxCustomerActorFor(partner);
      const result = await pos.confirmPayment(paymentId, actor, `sbx:${paymentId}:complete`, requestId);
      return { paymentId, status: result.status, receipt: result.receipt || null };
    }
    return { paymentId, status: "SCANNED" };
  }

  if (outcome === "insufficient") {
    const broke = await createUserWithWallet({
      accountType: "personal", fullName: "Sandbox Broke Customer",
      username: `sbx_brk_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
      walletKind: "personal", balance: 0
    });
    await partners.recordResource(partner.id, "customer", broke.userId);
    const token = String(payload.token || "").trim();
    if (intent.status === "PENDING") {
      if (!token) throw new AppError(400, "token is required to scan before the declined confirm");
      await pos.resolvePaymentIntent(token, { userType: "customer", userId: broke.userId }, requestId);
    }
    try {
      await pos.confirmPayment(paymentId, { userType: "customer", userId: broke.userId, profileLocked: false },
        `sbx:${paymentId}:insufficient`, requestId);
      throw new AppError(500, "Sandbox expected the confirm to be refused");
    } catch (error) {
      if (error.statusCode === 400) {
        return { paymentId, status: intent.status === "PENDING" ? "SCANNED" : intent.status, refusedWith: { statusCode: 400, error: error.message } };
      }
      throw error;
    }
  }

  if (outcome === "expire") {
    await pool.query("UPDATE pos_payment_intents SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [intent.id]);
    const terminal = await terminalContextFor(intent);
    // The status read runs the engine's own lazy-expiry, which writes the
    // EXPIRED transition and its event exactly as production would.
    const status = await pos.getPaymentStatus(paymentId, terminal, requestId).catch((error) => {
      if (error.statusCode === 410) return { paymentId, status: "EXPIRED" };
      throw error;
    });
    return { paymentId, status: status.status || "EXPIRED" };
  }

  if (outcome === "cancel") {
    const terminal = await terminalContextFor(intent);
    const result = await pos.cancelPayment(paymentId, terminal, `sbx:${paymentId}:cancel`, requestId);
    return { paymentId, status: result.status };
  }

  if (outcome === "refund" || outcome === "reverse") {
    const merchant = await pool.query("SELECT user_id FROM merchants WHERE id = $1", [intent.merchant_id]);
    const actor = { userType: "customer", userId: merchant.rows[0].user_id };
    const result = await pos.refundOrReverse(outcome, paymentId, actor,
      { amount: payload.amount !== undefined ? payload.amount : intent.amount, reason: "sandbox simulation" },
      `sbx:${paymentId}:${outcome}:${payload.amount || "full"}`, requestId);
    return { paymentId, status: result.status, operation: result.operation, amount: result.amount };
  }

  throw new AppError(400, "outcome must be one of: scan, complete, insufficient, expire, cancel, refund, reverse");
}

/* --------------------------------------------------- webhook event generator */

// Synthetic events for the types a vendor cannot conveniently produce on
// demand (payment.failed needs a provider rail; settlement.completed waits on
// the settlement engine). The event is clearly marked sandbox-synthetic and
// travels through the REAL delivery pipeline - same signing, same retries,
// same delivery log - so verifying it proves the production path.
const GENERATABLE = new Set([
  "payment.created", "payment.scanned", "payment.completed", "payment.failed",
  "payment.cancelled", "payment.expired", "refund.created", "refund.completed",
  "settlement.completed"
]);

async function generateWebhookEvent(partner, payload = {}, meta = {}) {
  assertSandbox();
  const eventType = String(payload.eventType || "").trim();
  if (!GENERATABLE.has(eventType)) {
    throw new AppError(400, `eventType must be one of: ${Array.from(GENERATABLE).join(", ")}`);
  }
  const owned = await partners.partnerResourceIds(partner.id, "merchant");
  if (!owned.length) throw new AppError(409, "Provision a sandbox merchant first");
  const { rows: subs } = await pool.query(
    `SELECT s.*, m.merchant_id AS merchant_code FROM webhook_subscriptions s
      JOIN merchants m ON m.id = s.merchant_id
     WHERE s.merchant_id = ANY($1) AND s.status = 'active'`,
    [owned]
  );
  if (!subs.length) throw new AppError(409, "Create a webhook subscription on a sandbox merchant first");

  const sourceEventId = crypto.randomUUID();
  const now = new Date().toISOString();
  let created = 0;
  for (const subscription of subs) {
    if (subscription.events?.length && !subscription.events.includes(eventType)) continue;
    const envelope = {
      id: `evt_${sha256(`${sourceEventId}:${eventType}`).slice(0, 32)}`,
      type: eventType,
      apiVersion: "v1",
      createdAt: now,
      data: {
        sandboxGenerated: true,
        paymentId: `POSP-SBX-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        merchantId: subscription.merchant_code,
        merchantReference: "SBX-GENERATED",
        amount: Number(payload.amount) > 0 ? Number(payload.amount) : 25.5,
        currency: "ZAR",
        status: eventType.startsWith("refund") ? "REFUNDED" : eventType.split(".")[1].toUpperCase(),
        previousStatus: "SCANNED",
        terminalId: null,
        provider: null,
        occurredAt: now,
        ...(eventType.startsWith("refund")
          ? { refund: { kind: "refund", amount: Number(payload.amount) > 0 ? Number(payload.amount) : 25.5, reference: "SBX-REF" } }
          : {}),
        ...(eventType === "settlement.completed"
          ? { settlement: { batchReference: `SET-SBX-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, net: 100 } }
          : {})
      }
    };
    const inserted = await pool.query(
      `INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, request_payload)
       VALUES ($1,$2,$3,$4::JSONB)
       ON CONFLICT (subscription_id, event_id, event_type) DO NOTHING
       RETURNING id`,
      [subscription.id, sourceEventId, eventType, JSON.stringify(envelope)]
    );
    created += inserted.rowCount;
  }
  // Deliver immediately rather than waiting for the worker's next poll - a
  // vendor watching their endpoint should see the event inside a second.
  const delivered = await webhooks.deliverDueOnce();
  return { eventType, queued: created, ...delivered };
}

// Sweep every sandbox principal a partner provisioned. Deliberately blunt:
// the sandbox is disposable by design.
async function resetSandbox(partner) {
  assertSandbox();
  const merchants = await partners.partnerResourceIds(partner.id, "merchant");
  const customers = await partners.partnerResourceIds(partner.id, "customer");
  for (const merchantId of merchants) {
    await pool.query("DELETE FROM webhook_subscriptions WHERE merchant_id = $1", [merchantId]).catch(() => {});
    await pool.query("DELETE FROM pos_refunds WHERE payment_intent_id IN (SELECT id FROM pos_payment_intents WHERE merchant_id = $1)", [merchantId]).catch(() => {});
    await pool.query("DELETE FROM pos_payment_events WHERE payment_intent_id IN (SELECT id FROM pos_payment_intents WHERE merchant_id = $1)", [merchantId]).catch(() => {});
    await pool.query("DELETE FROM pos_payment_intents WHERE merchant_id = $1", [merchantId]).catch(() => {});
    await pool.query("DELETE FROM pos_terminals WHERE merchant_id = $1", [merchantId]).catch(() => {});
    const owner = await pool.query("DELETE FROM merchants WHERE id = $1 RETURNING user_id", [merchantId]).catch(() => ({ rows: [] }));
    for (const row of owner.rows) {
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [row.user_id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id = $1", [row.user_id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id = $1", [row.user_id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [row.user_id]).catch(() => {});
    }
  }
  for (const customerId of customers) {
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [customerId]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [customerId]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id = $1", [customerId]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [customerId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [customerId]).catch(() => {});
  }
  await pool.query("DELETE FROM api_partner_resources WHERE partner_id = $1", [partner.id]);
  return { cleared: { merchants: merchants.length, customers: customers.length } };
}

module.exports = {
  sandboxEnabled,
  assertSandbox,
  createSandboxMerchant,
  createSandboxTerminal,
  simulatePayment,
  generateWebhookEvent,
  resetSandbox
};
