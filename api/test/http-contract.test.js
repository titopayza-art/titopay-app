"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";
process.env.APP_ORIGIN = "https://app.titopay.co.za";
process.env.PEACH_PAYMENTS_WEBHOOK_SECRET = "test-peach-webhook-secret";
process.env.PEACH_PAYMENTS_MERCHANT_ID = "merchant-123";
process.env.PEACH_PAYMENTS_ENTITY_ID = "entity-456";
process.env.PEACH_PAYMENTS_WEBHOOK_URL = "https://api.titopay.co.za/v1/webhooks/provider";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");

test.after(() => pool.end());

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Peach webhook GET is public, returns 405, and does not expose a file", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/webhooks/provider`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.deepEqual(await response.json(), { ok: false, error: "Method Not Allowed" });
  });
});

test("API browser icon is public and serves only the bundled icon", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/favicon.ico`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/x-icon/);
    assert.ok(body.length > 0);
    assert.doesNotMatch(body.toString("utf8"), /Bearer token required/);
  });
});

test("POS provider webhook GET is public and returns 405", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/webhooks/pos-provider`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.deepEqual(await response.json(), { ok: false, error: "Method Not Allowed" });
  });
});

test("unsigned Peach webhook fails with 401 before database access", async () => {
  const originalQuery = pool.query;
  let databaseCalls = 0;
  pool.query = async () => {
    databaseCalls += 1;
    throw new Error("database must not be reached for an unsigned webhook");
  };
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/webhooks/provider`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.error, "Webhook signature is invalid");
      assert.equal(databaseCalls, 0);
    });
  } finally {
    pool.query = originalQuery;
  }
});

test("Peach webhook POST is public, rejects bad signatures, and deduplicates valid deliveries", async () => {
  const originalQuery = pool.query;
  const reservedKeys = new Set();
  let processed = 0;
  pool.query = async (sql, values = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT value FROM platform_settings")) return { rows: [] };
    if (query.startsWith("INSERT INTO platform_settings")) {
      const key = values[0];
      if (reservedKeys.has(key)) return { rowCount: 0, rows: [] };
      reservedKeys.add(key);
      return { rowCount: 1, rows: [{ key: "reserved" }] };
    }
    if (query.startsWith("UPDATE platform_settings")) {
      processed += 1;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected webhook query: ${query}`);
  };

  const payloads = [JSON.stringify({
    type: "payment.updated",
    merchantId: "merchant-123",
    entityId: "entity-456",
    amount: "25.00",
    currency: "ZAR",
    transactionId: "txn-123"
  }), JSON.stringify({
    type: "payment.completed",
    merchantId: "merchant-123",
    entityId: "entity-456",
    amount: "25.00",
    currency: "ZAR",
    transactionId: "txn-123"
  })];
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookUrl = process.env.PEACH_PAYMENTS_WEBHOOK_URL;
  function signedHeaders(payload, webhookId) {
    const signature = crypto
      .createHmac("sha256", process.env.PEACH_PAYMENTS_WEBHOOK_SECRET)
      .update(`${timestamp}.${webhookId}.${webhookUrl}.${payload}`)
      .digest("hex");
    return {
      "content-type": "application/json",
      "x-webhook-signature-algorithm": "HMAC-SHA256",
      "x-webhook-timestamp": timestamp,
      "x-webhook-id": webhookId,
      "x-webhook-signature": signature
    };
  }

  try {
    await withServer(async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/v1/webhooks/provider`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature-algorithm": "HMAC-SHA256",
          "x-webhook-timestamp": timestamp,
          "x-webhook-id": "webhook-invalid",
          "x-webhook-signature": "bad"
        },
        body: payloads[0]
      });
      assert.equal(invalid.status, 401);
      assert.equal((await invalid.json()).error, "Webhook signature is invalid");
      assert.equal(reservedKeys.size, 0);

      const wrongMerchantPayload = JSON.stringify({
        type: "payment.completed",
        merchantId: "attacker-merchant",
        entityId: "entity-456",
        amount: "25.00",
        currency: "ZAR",
        transactionId: "txn-untrusted"
      });
      const wrongMerchant = await fetch(`${baseUrl}/v1/webhooks/provider`, {
        method: "POST",
        headers: signedHeaders(wrongMerchantPayload, "webhook-wrong-merchant"),
        body: wrongMerchantPayload
      });
      assert.equal(wrongMerchant.status, 400);
      assert.equal(reservedKeys.size, 0);

      for (const [index, duplicate] of [false, true].entries()) {
        const payload = payloads[index];
        const response = await fetch(`${baseUrl}/v1/webhooks/provider`, {
          method: "POST",
          headers: signedHeaders(payload, `webhook-${index + 1}`),
          body: payload
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.duplicate, duplicate);
      }

      const formPayload = [
        "merchantId=merchant-123",
        "authentication.entityId=entity-456",
        "amount=10.00",
        "currency=ZAR",
        "id=txn-form-1",
        "type=payment.completed"
      ].join("&");
      const formResponse = await fetch(`${baseUrl}/v1/webhooks/provider`, {
        method: "POST",
        headers: {
          ...signedHeaders(formPayload, "webhook-form-1"),
          "content-type": "application/x-www-form-urlencoded"
        },
        body: formPayload
      });
      assert.equal(formResponse.status, 200);
      assert.equal((await formResponse.json()).duplicate, false);

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(processed, 2);
    });
  } finally {
    pool.query = originalQuery;
  }
});

test("chat endpoints require JWT and never expose a stack trace", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/threads`, {
      headers: { Origin: "https://app.titopay.co.za" }
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.titopay.co.za");
    assert.equal(body.ok, false);
    assert.equal("stack" in body, false);
  });
});

test("CORS does not authorize an unknown web origin", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/threads`, {
      headers: { Origin: "https://attacker.example" }
    });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("Chat Monitor endpoint requires an authenticated admin session", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/chat-monitor/overview`);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
    assert.equal("stack" in body, false);
  });
});

test("Super Admin receives a privacy-safe Chat Monitor payload", async () => {
  const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const jti = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const token = signAccessToken({
    sub: adminId,
    sid: sessionId,
    jti,
    typ: "admin",
    role: "super_admin",
    scope: "admin"
  });
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.includes("FROM sessions s")) {
      return { rows: [{
        id: sessionId,
        user_id: adminId,
        user_type: "admin",
        access_jti: jti,
        last_activity_at: new Date(),
        expires_at: new Date(Date.now() + 60000)
      }] };
    }
    if (query.startsWith("SELECT * FROM admin_users")) {
      return { rows: [{
        id: adminId,
        role: "super_admin",
        status: "active",
        email: "admin@titopay.test",
        username: "superadmin"
      }] };
    }
    if (query.startsWith("UPDATE sessions SET last_activity_at")) return { rows: [] };
    if (query.includes("COUNT(*) FILTER (WHERE status = 'active')")) {
      return { rows: [{ active: 2, active_recently: 1, blocked: 0, total: 2 }] };
    }
    return { rows: [] };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/admin/chat-monitor/overview`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.metrics.activeConversations, 2);
      assert.equal(body.metrics.onlineUsers, 0);
      assert.deepEqual(body.conversations, []);
      assert.equal(JSON.stringify(body).includes("body"), false);
    });
  } finally {
    pool.query = originalQuery;
  }
});
