"use strict";

// WHAT A CUSTOMER PAYS FOR SOMETHING TITOPAY SELLS ITSELF.
//
// Every other service moves money to somebody: `amount` is what the recipient
// gets, and the schedule fee is TitoPay's cut on top. A Business Document PDF
// has no recipient. The customer app still had to fill the required `amount`
// in, so it sent the price — and the server charged its own 2.50 fee on top,
// making a PDF advertised at R2.50 cost R5.00.
//
// The 2.50 "principal" was not even collected: the app named
// "TitoPay Revenue Wallet" as the recipient, which matches no username, email
// or wallet number, so resolveRecipientWallet returned null and nothing was
// credited with it. Debited from the customer, credited to nobody.
//
// The service is not in the live allow-list, so no customer has been charged
// either figure. This pins the price before it ever can be.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/pool");
const transactions = require("../src/services/transaction-service");

const SERVICE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");

// The pricing schedule, answered from the stub rather than the database, so the
// test states the price it is asserting instead of depending on a seeded row.
function withPricing(flatFee, run) {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    // getPricingRule bootstraps the table before reading it.
    if (/^(CREATE|ALTER|UPDATE|INSERT|DO)\b/i.test(query)) return { rows: [] };
    if (/FROM pricing_rules/i.test(query)) {
      return { rows: [{
        service_code: "business_document_pdf",
        service_name: "Business Document PDF",
        fee_type: "FIXED",
        fee_value: flatFee,
        flat_fee: flatFee,
        percentage_fee: 0,
        minimum_fee: 0,
        maximum_fee: 0,
        vat_percentage: 0
      }] };
    }
    return { rows: [] };
  };
  return Promise.resolve(run()).finally(() => { pool.query = originalQuery; });
}

test("a Business Document PDF costs the schedule fee, once", async () => {
  await withPricing(2.5, async () => {
    const preview = await transactions.feePreview({
      service: "business_document_pdf", amount: 2.5, recipient: "TitoPay Revenue Wallet"
    });
    assert.equal(preview.fee, 2.5, "the fee is the schedule fee");
    assert.equal(preview.amount, 0, "there is no principal — nobody is being paid");
    assert.equal(preview.total, 2.5, "R2.50 is advertised, so R2.50 is charged");
  });
});

test("the customer app cannot name its own price", async () => {
  await withPricing(2.5, async () => {
    // Every one of these is a tampered client. All must cost the same.
    for (const amount of [0.01, 2.5, 1000, -5, 0, "abc", null, undefined]) {
      const preview = await transactions.feePreview({
        service: "business_document_pdf", amount, recipient: "TitoPay Revenue Wallet"
      });
      assert.equal(preview.total, 2.5, `amount ${JSON.stringify(amount)} still costs R2.50`);
      assert.equal(preview.amount, 0);
    }
  });
});

test("a percentage-priced fee-only service still cannot be priced by the client", async () => {
  // The flat-fee case is defended twice over — calculateFee ignores the amount
  // for a FIXED rule — so it cannot show whether discarding the client amount
  // actually works. A percentage rule can: if the request body reached
  // calculateFee, the caller would be choosing the percentage base, and
  // therefore the price.
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (/^(CREATE|ALTER|UPDATE|INSERT|DO)\b/i.test(query)) return { rows: [] };
    if (/FROM pricing_rules/i.test(query)) {
      return { rows: [{
        service_code: "business_document_pdf", service_name: "Business Document PDF",
        fee_type: "PERCENTAGE", fee_value: 10, flat_fee: 0, percentage_fee: 10,
        minimum_fee: 0, maximum_fee: 0, vat_percentage: 0
      }] };
    }
    return { rows: [] };
  };
  try {
    for (const amount of [0.01, 2.5, 1000, 1e9]) {
      const preview = await transactions.feePreview({ service: "business_document_pdf", amount });
      assert.equal(preview.amount, 0);
      assert.equal(preview.total, 0,
        `amount ${amount} must not become the percentage base for a fee-only service`);
    }
    // And nothing the caller can send produces NaN.
    for (const amount of [undefined, null, "abc", NaN]) {
      const preview = await transactions.feePreview({ service: "business_document_pdf", amount });
      assert.ok(Number.isFinite(preview.total), `amount ${JSON.stringify(amount)} produced ${preview.total}`);
    }
  } finally {
    pool.query = originalQuery;
  }
});

test("no recipient is resolved or credited for something bought from TitoPay", () => {
  // Asserted on the source because the alternative is a full ledger fixture,
  // and the property is structural: the resolve call must be skipped, not
  // merely return null for one particular string.
  assert.match(SERVICE_SOURCE,
    /const recipientWallet = feeOnly \? null : await resolveRecipientWallet\(payload\.recipient\)/,
    "a fee-only service must not resolve a recipient at all");
});

test("the debit follows the preview, not the request body", () => {
  assert.match(SERVICE_SOURCE, /const chargedAmount = roundMoney\(preview\.amount\)/,
    "the recorded amount must come from the priced preview");
  assert.match(SERVICE_SOURCE, /const debitTotal = payload\.merchantReceivesFee \? chargedAmount : preview\.total/);
  // The raw request amount may only be used to ASK for a price, never to charge.
  // Scoped to everything after the price is known; `payload.amount` appearing
  // there would mean the body reached the ledger behind the preview's back.
  const afterPricing = SERVICE_SOURCE
    .slice(SERVICE_SOURCE.indexOf("const chargedAmount = roundMoney(preview.amount)"));
  const untilEnd = afterPricing.slice(0, afterPricing.indexOf("\n}\n"));
  assert.doesNotMatch(untilEnd, /payload\.amount/,
    "after the preview, nothing may read the request-body amount");
  // And the request body is read exactly once, in the guarded line that asks
  // for the price — where a fee-only service discards it.
  assert.match(SERVICE_SOURCE, /const amount = feeOnly \? 0 : roundMoney\(payload\.amount\)/);
});

test("the fee-only list is exactly what it claims, and everything else is untouched", async () => {
  const set = SERVICE_SOURCE.match(/const FEE_ONLY_SERVICES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "FEE_ONLY_SERVICES must exist");
  const codes = [...set[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(codes, ["business_document_pdf"],
    "widening this set changes what customers are charged — do it deliberately");

  // A service that is NOT fee-only keeps the old arithmetic exactly.
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (/FROM pricing_rules/i.test(query)) {
      return { rows: [{
        service_code: "send_money", service_name: "Send Money", fee_type: "FIXED",
        fee_value: 1.5, flat_fee: 1.5, percentage_fee: 0,
        minimum_fee: 0, maximum_fee: 0, vat_percentage: 0
      }] };
    }
    if (/FROM platform_settings|service_catalogue|FROM services/i.test(query)) return { rows: [] };
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    const preview = await transactions.feePreview({ service: "send_money", amount: 100 });
    assert.equal(preview.amount, 100, "a real transfer still carries its principal");
    assert.equal(preview.fee, 1.5);
    assert.equal(preview.total, 101.5, "fee on top of the amount, unchanged");
  } finally {
    pool.query = originalQuery;
  }
});

test("a service that still needs an amount still refuses one that is missing", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [] });
  try {
    await assert.rejects(
      transactions.feePreview({ service: "send_money", amount: 0 }),
      (error) => error.statusCode === 400 && /amount must be greater than zero/.test(error.message)
    );
    await assert.rejects(
      transactions.feePreview({ service: "send_money" }),
      (error) => error.statusCode === 400
    );
  } finally {
    pool.query = originalQuery;
  }
});

test("the customer app sends no amount and no recipient for a PDF", () => {
  const app = fs.readFileSync(require("./pwa-path").pwaFile("app.js"), "utf8");
  const fn = app.match(/async function confirmBusinessDocumentPdfDownload\(\)[\s\S]*?\n\}/);
  assert.ok(fn, "confirmBusinessDocumentPdfDownload must exist");
  assert.doesNotMatch(fn[0], /amount:/, "the app must not name a price");
  assert.doesNotMatch(fn[0], /recipient:/, "a purchase from TitoPay has no recipient");
  assert.match(fn[0], /Idempotency-Key/, "a paid action needs an idempotency key");
  assert.match(fn[0], /idempotencyKey/, "and it must reach the body the server reads");
});
