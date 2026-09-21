"use strict";

// A DUPLICATE WEBHOOK MUST NEVER CREDIT A WALLET TWICE.
//
// A payment provider retries. Peach retries a delivery it did not get a 200
// for, for up to thirty days. So the single most expensive bug a webhook can
// have is crediting the same top-up on every retry, and the single most
// important property to hold under test is that it does not.
//
// The existing contract suite covers the signature and the deduplication. This
// covers what it did not: that a duplicate never reaches PROCESSING at all
// rather than merely being counted, and that the amount, the currency, the
// merchant and the timestamp are each rejected on their own.
//
// Nothing here changes the webhook. It asserts what the implementation already
// does, so that it keeps doing it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";
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

test.after(() => pool.end());

const WEBHOOK_URL = process.env.PEACH_PAYMENTS_WEBHOOK_URL;
const VALID = {
  type: "payment.completed",
  merchantId: "merchant-123",
  entityId: "entity-456",
  amount: "25.00",
  currency: "ZAR",
  transactionId: "txn-safety-1"
};

function signedHeaders(payload, webhookId, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = crypto
    .createHmac("sha256", process.env.PEACH_PAYMENTS_WEBHOOK_SECRET)
    .update(`${timestamp}.${webhookId}.${WEBHOOK_URL}.${payload}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-webhook-signature-algorithm": "HMAC-SHA256",
    "x-webhook-timestamp": timestamp,
    "x-webhook-id": webhookId,
    "x-webhook-signature": signature
  };
}

// A database that records what the webhook path tried to do, so the test can
// assert on the RESERVATION and the PROCESSING separately. Processing is the
// step that would move money.
function stubDatabase() {
  const reserved = new Set();
  const state = { reservations: 0, processed: 0 };
  const original = pool.query;
  pool.query = async (sql, values = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT value FROM platform_settings")) return { rows: [] };
    if (query.startsWith("INSERT INTO platform_settings")) {
      const key = values[0];
      if (reserved.has(key)) return { rowCount: 0, rows: [] };
      reserved.add(key);
      state.reservations += 1;
      return { rowCount: 1, rows: [{ key: "reserved" }] };
    }
    if (query.startsWith("UPDATE platform_settings")) {
      // Only ever reached from processPeachWebhookEvent, which is the step
      // that settles money. If this runs twice for one delivery, a wallet was
      // credited twice.
      state.processed += 1;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected webhook query: ${query}`);
  };
  return { state, restore: () => { pool.query = original; } };
}

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, body, webhookId, timestamp) => {
  const payload = JSON.stringify(body);
  return fetch(`${baseUrl}/v1/webhooks/provider`, {
    method: "POST", headers: signedHeaders(payload, webhookId, timestamp), body: payload
  });
};

test("a valid webhook is accepted and processed exactly once", async () => {
  const db = stubDatabase();
  try {
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, VALID, "wh-valid-1");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.duplicate, false);
      // Processing is scheduled with setImmediate, so let the loop turn.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(db.state.processed, 1, "a valid webhook was not processed");
    });
  } finally { db.restore(); }
});

test("A DUPLICATE WEBHOOK IS NOT PROCESSED A SECOND TIME", async () => {
  // The property that matters most. Peach retries for thirty days.
  const db = stubDatabase();
  try {
    await withServer(async (baseUrl) => {
      const first = await post(baseUrl, VALID, "wh-dupe-1");
      assert.equal((await first.json()).duplicate, false);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Same transaction, different delivery id, as a real retry looks.
      const second = await post(baseUrl, VALID, "wh-dupe-2");
      assert.equal(second.status, 200, "a retry must still be answered 200 or Peach retries forever");
      assert.equal((await second.json()).duplicate, true, "the retry was not recognised as a duplicate");
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(db.state.reservations, 1, "the same payment was reserved twice");
      assert.equal(db.state.processed, 1,
        `the duplicate was processed again: a wallet would have been credited ${db.state.processed} times`);
    });
  } finally { db.restore(); }
});

test("an invalid signature is refused and never reaches the database", async () => {
  const db = stubDatabase();
  try {
    await withServer(async (baseUrl) => {
      const payload = JSON.stringify(VALID);
      const response = await fetch(`${baseUrl}/v1/webhooks/provider`, {
        method: "POST",
        headers: { ...signedHeaders(payload, "wh-bad"), "x-webhook-signature": "0".repeat(64) },
        body: payload
      });
      assert.equal(response.status, 401);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(db.state.reservations, 0, "an unsigned delivery reached the database");
      assert.equal(db.state.processed, 0);
    });
  } finally { db.restore(); }
});

test("a stale timestamp is refused, so a captured delivery cannot be replayed later", async () => {
  const db = stubDatabase();
  try {
    await withServer(async (baseUrl) => {
      const hoursAgo = String(Math.floor(Date.now() / 1000) - 60 * 60 * 6);
      const response = await post(baseUrl, VALID, "wh-stale", hoursAgo);
      assert.equal(response.status, 401);
      assert.equal(db.state.processed, 0);
    });
  } finally { db.restore(); }
});

for (const [label, amount] of [
  ["zero", "0"], ["negative", "-25.00"], ["not a number", "twenty"],
  ["three decimals", "25.001"], ["empty", ""]
]) {
  test(`an amount that is ${label} is refused`, async () => {
    const db = stubDatabase();
    try {
      await withServer(async (baseUrl) => {
        const response = await post(baseUrl, { ...VALID, amount, transactionId: `txn-amt-${label}` }, `wh-amt-${label}`);
        assert.notEqual(response.status, 200, `amount "${amount}" was accepted`);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(db.state.processed, 0, `amount "${amount}" reached processing`);
      });
    } finally { db.restore(); }
  });
}

for (const [label, currency] of [["not a currency", "RAND"], ["two letters", "ZA"], ["empty", ""], ["numeric", "710"]]) {
  test(`a currency that is ${label} is refused`, async () => {
    const db = stubDatabase();
    try {
      await withServer(async (baseUrl) => {
        const response = await post(baseUrl, { ...VALID, currency, transactionId: `txn-cur-${label}` }, `wh-cur-${label}`);
        assert.notEqual(response.status, 200, `currency "${currency}" was accepted`);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(db.state.processed, 0, `currency "${currency}" reached processing`);
      });
    } finally { db.restore(); }
  });
}

test("a delivery for another merchant or another entity is refused", async () => {
  const db = stubDatabase();
  try {
    await withServer(async (baseUrl) => {
      const wrongMerchant = await post(baseUrl, { ...VALID, merchantId: "merchant-999", transactionId: "txn-m" }, "wh-m");
      assert.notEqual(wrongMerchant.status, 200, "a webhook for another merchant was accepted");
      const wrongEntity = await post(baseUrl, { ...VALID, entityId: "entity-999", transactionId: "txn-e" }, "wh-e");
      assert.notEqual(wrongEntity.status, 200, "a webhook for another entity was accepted");
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(db.state.processed, 0);
    });
  } finally { db.restore(); }
});
