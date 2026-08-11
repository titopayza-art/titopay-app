"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "pos-test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "pos-test-refresh-secret-with-sufficient-length";
process.env.APP_ORIGIN = "https://app.titopay.co.za";
process.env.POS_PROVIDER_WEBHOOK_SECRET = "pos-provider-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { TRANSITIONS, money, confirmPayment } = require("../src/pos/service");
const {
  canonicalRequest,
  encryptTerminalSecret,
  decryptTerminalSecret,
  safeEqual,
  sha256
} = require("../src/pos/security");
const { providerAdapter } = require("../src/pos/providers");

test.after(() => pool.end());

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("POS money validation is decimal-safe and limited to two fractional digits", () => {
  assert.equal(money("10.25"), 1025);
  assert.throws(() => money("10.251"), /invalid/);
  assert.throws(() => money("-1"), /invalid/);
  assert.throws(() => money("0"), /supported range/);
});

test("POS state machine allows the required success path", () => {
  assert.equal(TRANSITIONS.PENDING.has("SCANNED"), true);
  assert.equal(TRANSITIONS.SCANNED.has("AUTHORIZED"), true);
  assert.equal(TRANSITIONS.AUTHORIZED.has("PROCESSING"), true);
  assert.equal(TRANSITIONS.PROCESSING.has("COMPLETED"), true);
});

test("POS final states cannot transition back into payment processing", () => {
  for (const status of ["FAILED", "CANCELLED", "EXPIRED", "REVERSED", "REFUNDED"]) {
    assert.equal(TRANSITIONS[status].size, 0);
  }
});

test("terminal credentials are authenticated-encrypted and recoverable only with server secrets", () => {
  const secret = "terminal-secret-that-is-never-stored-in-plaintext";
  const encrypted = encryptTerminalSecret(secret);
  assert.match(encrypted, /^enc:/);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(decryptTerminalSecret(encrypted), secret);
});

test("terminal signatures bind timestamp, nonce, method, route and exact body hash", () => {
  const body = Buffer.from('{"amount":"12.00"}');
  const request = {
    method: "POST",
    originalUrl: "/v1/pos/payment-intents?ignored=true",
    rawBody: body
  };
  const canonical = canonicalRequest(request, "123", "nonce-123456");
  assert.equal(canonical, `123\nnonce-123456\nPOST\n/v1/pos/payment-intents\n${sha256(body)}`);
  const signature = crypto.createHmac("sha256", "secret").update(canonical).digest("hex");
  assert.equal(safeEqual(signature, signature), true);
  assert.equal(safeEqual(signature, `${signature}0`), false);
});

test("bank adapters fail closed until an official acquiring-bank contract exists", async () => {
  const provider = providerAdapter("STANDARD_BANK");
  const createResult = await provider.createPaymentRequest({});
  const statusResult = await provider.notifyPaymentStatus({});
  assert.equal(createResult.supported, false);
  assert.equal(statusResult.supported, false);
  assert.match(createResult.reason, /Awaiting official acquiring-bank/);
});

test("POS schema is additive and uses the existing financial transaction tables", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8");
  for (const table of [
    "pos_terminals", "pos_request_nonces", "pos_payment_intents",
    "pos_payment_events", "pos_idempotency_keys", "pos_refunds",
    "pos_provider_events", "pos_provider_nonces"
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /transaction_id UUID REFERENCES transactions\(id\)/);
  assert.match(schema, /service_code, service_name/);
  assert.match(schema, /'pos_qr'/);
  assert.doesNotMatch(schema, /qr_token\s+TEXT/);
});

test("creating an intent without terminal authentication returns 401, not JWT challenge", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/pos/payment-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: "M1", terminalId: "T1", amount: "1.00", currency: "ZAR" })
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.match(body.error, /Terminal authentication required/);
    assert.doesNotMatch(body.error, /Bearer/);
  });
});

test("customer resolve and confirmation remain protected by the existing JWT middleware", async () => {
  await withServer(async (baseUrl) => {
    for (const request of [
      fetch(`${baseUrl}/v1/pos/payment-intents/resolve/fake-token`),
      fetch(`${baseUrl}/v1/pos/payment-intents/TP_POS_FAKE/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ]) {
      const response = await request;
      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /Bearer token required/);
    }
  });
});

test("terminal registration and refund operations are not public", async () => {
  await withServer(async (baseUrl) => {
    for (const route of ["terminals/register", "payment-intents/TP_POS_FAKE/refund"]) {
      const response = await fetch(`${baseUrl}/v1/pos/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(response.status, 401);
    }
  });
});

test("POS provider webhook is public but rejects an invalid signature with 401", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/webhooks/pos-provider`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titopay-timestamp": String(Date.now()),
        "x-titopay-nonce": "provider-nonce-1234",
        "x-titopay-signature": "bad"
      },
      body: JSON.stringify({ id: "event-1", type: "payment.updated" })
    });
    assert.equal(response.status, 401);
  });
});

test("valid POS provider deliveries are persisted and duplicates acknowledge safely", async () => {
  const originalQuery = pool.query;
  let nonceReserved = false;
  let eventReserved = false;
  const adminManagedSecret = "admin-managed-pos-provider-secret";
  const integrationKey = crypto
    .createHash("sha256")
    .update(process.env.JWT_REFRESH_SECRET)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", integrationKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(adminManagedSecret, "utf8"),
    cipher.final()
  ]);
  const storedSecret = `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT value FROM platform_settings")) {
      return {
        rows: [{
          value: {
            enabled: true,
            secrets: { webhookSecretEncrypted: storedSecret }
          }
        }]
      };
    }
    if (query.startsWith("INSERT INTO pos_provider_nonces")) {
      if (nonceReserved) {
        const duplicate = new Error("duplicate");
        duplicate.code = "23505";
        throw duplicate;
      }
      nonceReserved = true;
      return { rowCount: 1, rows: [] };
    }
    if (query.startsWith("INSERT INTO pos_provider_events")) {
      if (eventReserved) return { rowCount: 0, rows: [] };
      eventReserved = true;
      return { rowCount: 1, rows: [{ id: "stored" }] };
    }
    throw new Error(`Unexpected POS webhook query: ${query}`);
  };
  const raw = JSON.stringify({ id: "provider-event-1", provider: "OTHER", type: "payment.updated" });

  try {
    await withServer(async (baseUrl) => {
      const timestamp = String(Date.now());
      const nonce = "provider-nonce-valid-123";
      const canonical = `${timestamp}\n${nonce}\nPOST\n/v1/webhooks/pos-provider\n${sha256(Buffer.from(raw))}`;
      const signature = crypto.createHmac("sha256", adminManagedSecret).update(canonical).digest("hex");
      const response = await fetch(`${baseUrl}/v1/webhooks/pos-provider`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-titopay-timestamp": timestamp,
          "x-titopay-nonce": nonce,
          "x-titopay-signature": signature
        },
        body: raw
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, duplicate: false, eventId: "provider-event-1" });
    });
  } finally {
    pool.query = originalQuery;
  }
});

test("Admin Integration Centre exposes secure POS configuration and safe webhook monitoring", () => {
  const adminRoutes = fs.readFileSync(path.join(__dirname, "../src/routes/admin.routes.js"), "utf8");
  assert.match(adminRoutes, /pos_provider:\s*\{/);
  assert.match(adminRoutes, /fields:\s*\[[^\]]*webhookSecret[^\]]*callbackUrl/);
  assert.match(adminRoutes, /FROM pos_provider_events/);
  assert.match(adminRoutes, /WHERE key LIKE 'peach_webhook_%'/);
  assert.match(adminRoutes, /retryable:\s*false/);
  assert.doesNotMatch(adminRoutes, /SELECT event_id, provider, event_type, payload/);
});

test("payment confirmation creates the transaction before both atomic ledger movements", async () => {
  const originalConnect = pool.connect;
  const operations = [];
  const client = {
    release() {},
    async query(sql) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      operations.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}] };
      if (query.startsWith("SELECT request_hash, response FROM pos_idempotency_keys")) return { rows: [] };
      if (query.includes("FROM pos_payment_intents p") && query.includes("FOR UPDATE OF p")) {
        return { rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          payment_id: "TP_POS_TEST",
          merchant_id: "22222222-2222-4222-8222-222222222222",
          terminal_id: "33333333-3333-4333-8333-333333333333",
          terminal_code: "TERM-1",
          merchant_user_id: "44444444-4444-4444-8444-444444444444",
          business_name: "Test Merchant",
          amount: "10.00",
          currency: "ZAR",
          merchant_reference: "ORDER-1",
          provider: "OTHER",
          status: "SCANNED",
          expires_at: new Date(Date.now() + 60000),
          created_at: new Date()
        }] };
      }
      if (query.includes("FROM users u") && query.includes("FOR UPDATE OF w")) {
        return { rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          account_status: "active",
          status: "active",
          profile_locked: false,
          available_balance: "50.00"
        }] };
      }
      if (query.includes("FROM merchants m") && query.includes("Merchant settlement") === false && query.includes("FOR UPDATE OF w")) {
        return { rows: [{
          id: "66666666-6666-4666-8666-666666666666",
          status: "active",
          available_balance: "20.00"
        }] };
      }
      if (query.startsWith("UPDATE wallets") && query.includes("available_balance = available_balance -")) {
        return { rows: [{ available_balance: "40.00" }] };
      }
      if (query.startsWith("UPDATE wallets") && query.includes("available_balance = available_balance +")) {
        return { rows: [{ available_balance: "30.00" }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  pool.connect = async () => client;
  try {
    const result = await confirmPayment(
      "TP_POS_TEST",
      { userType: "customer", userId: "77777777-7777-4777-8777-777777777777", profileLocked: false },
      "confirm-test-key",
      "request-test"
    );
    assert.equal(result.status, "COMPLETED");
    const transactionInsert = operations.findIndex((query) => query.startsWith("INSERT INTO transactions"));
    const firstWalletUpdate = operations.findIndex((query) => query.startsWith("UPDATE wallets"));
    assert.ok(transactionInsert >= 0);
    assert.ok(firstWalletUpdate > transactionInsert);
    assert.equal(operations.filter((query) => query.startsWith("INSERT INTO wallet_ledger")).length, 2);
    assert.equal(operations.at(-1), "COMMIT");
  } finally {
    pool.connect = originalConnect;
  }
});
