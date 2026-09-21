"use strict";

// THE FOUR RULES A VAS PURCHASE HAS TO OBEY.
//
// Asked to make Airtime & Data, Electricity, Voucher and Pay Bills available in
// the app instead of showing SOON. They were held back by three independent
// layers, and only the first was a status:
//
//   1. the catalogue gate         tiles served as coming_soon
//   2. transaction-service        a hard-coded 503 on the fee preview
//   3. the VAS adapter            declares canPurchase: false, and there was
//                                 no purchase route, no purchase function and
//                                 nothing anywhere calling purchaseAirtime
//
// Flipping (1) alone would have walked a customer through a three-step form to
// a 503 — worse than SOON, and the comment on that list records that this
// exact "payment glitch" had already happened once.
//
// So the rail was built instead. Layer 2 now ASKS the capability rather than
// keeping a list, layer 1 already did, and this file is layer 3: the money
// safety a VAS purchase needs, driven against a real database with a fake
// adapter standing in for a supplier TitoPay has not contracted yet.
//
// Nothing here is live. Both shipped adapters still declare canPurchase: false
// and purchaseVas refuses before touching a wallet, so these services are still
// served as coming soon. What has changed is that wiring a real adapter is now
// one function rather than a subsystem — and the day it is wired, all three
// layers open together off the same declaration.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { pool } = require("../src/db/pool");
const vasProvider = require("../src/providers/vas-provider");
const vas = require("../src/services/vas-purchase-service");
const transactions = require("../src/services/transaction-service");

const ROOT = path.join(__dirname, "..", "..");
const TX_SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "transaction-service.js"), "utf8");
const VAS_SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "vas-purchase-service.js"), "utf8");

// ---- a supplier that does what the test tells it to -----------------------
//
// The adapter is replaced, never the shipped file: these tests must not be
// able to make the real thing look capable.
const realCanPurchase = vasProvider.vasCanPurchase;
const realPurchaseAirtime = vasProvider.purchaseAirtime;

function withSupplier(behaviour) {
  vasProvider.vasCanPurchase = () => true;
  vasProvider.purchaseAirtime = behaviour;
}
function restoreSupplier() {
  vasProvider.vasCanPurchase = realCanPurchase;
  vasProvider.purchaseAirtime = realPurchaseAirtime;
}

async function makeFundedUser(balance = 500) {
  const id = crypto.randomUUID();
  const tag = "vas-" + id.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash, email, status)
     VALUES ($1,'personal','VAS Tester',$2,'x',$3,'active')`,
    [id, tag, tag + "@example.test"]);
  const walletId = crypto.randomUUID();
  // kind is NOT NULL and constrained to personal/business/merchant/revenue/
  // system. 'personal' is a customer's own wallet; the service deliberately
  // excludes kind = 'system' so TitoKids custody wallets can never be picked
  // up as one.
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance, status)
     VALUES ($1,$2,'personal','ZAR',$3,'active')`,
    [walletId, id, balance]);
  return { userId: id, walletId };
}

async function balanceOf(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return Number(rows[0].available_balance);
}

async function cleanup(userId) {
  await pool.query("DELETE FROM vas_purchases WHERE user_id = $1", [userId]).catch(() => null);
  await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)", [userId]).catch(() => null);
  await pool.query("DELETE FROM transactions WHERE user_id = $1", [userId]).catch(() => null);
  await pool.query("DELETE FROM wallets WHERE user_id = $1", [userId]).catch(() => null);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => null);
}

test("nothing is live: an uncontracted rail refuses before any wallet is touched", async () => {
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  try {
    assert.equal(realCanPurchase(), false, "the shipped adapter still cannot purchase");
    await assert.rejects(
      () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
      (error) => error.statusCode === 503);
    assert.equal(await balanceOf(walletId), 500, "and the wallet is untouched");
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM vas_purchases WHERE user_id = $1", [userId]);
    assert.equal(rows[0].n, 0, "no purchase row is written either");
  } finally {
    await cleanup(userId);
  }
});

test("RULE 1: a replayed purchase returns the original and never buys twice", async () => {
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  let calls = 0;
  withSupplier(async () => { calls += 1; return { token: `PIN-${calls}` }; });
  try {
    const key = crypto.randomUUID();
    const request = { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: key };
    const first = await vas.purchaseVas({ userId }, request);
    const afterFirst = await balanceOf(walletId);

    const replay = await vas.purchaseVas({ userId }, request);
    assert.equal(calls, 1, "the supplier was contacted exactly once");
    assert.equal(replay.id, first.id, "the replay returns the original purchase");
    assert.equal(replay.idempotentReplay, true, "and says so");
    assert.equal(await balanceOf(walletId), afterFirst, "and the wallet moved only once");

    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM vas_purchases WHERE user_id = $1", [userId]);
    assert.equal(rows[0].n, 1, "one purchase row, not two");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("RULE 1: two identical purchases in flight together still buy once", async () => {
  // The fast-path check cannot catch this — both requests miss it. Only the
  // advisory lock and the unique index can, which is why both exist.
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  let calls = 0;
  withSupplier(async () => { calls += 1; await new Promise((r) => setTimeout(r, 40)); return { token: `PIN-${calls}` }; });
  try {
    const request = { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() };
    const [a, b] = await Promise.allSettled([
      vas.purchaseVas({ userId }, request),
      vas.purchaseVas({ userId }, request)
    ]);
    const settled = [a, b].filter((r) => r.status === "fulfilled").map((r) => r.value);
    assert.ok(settled.length >= 1, "at least one request succeeds");
    assert.equal(calls, 1, "the supplier was contacted exactly once");
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM vas_purchases WHERE user_id = $1", [userId]);
    assert.equal(rows[0].n, 1, "and exactly one purchase exists");
    assert.equal(await balanceOf(walletId), 500 - Number(settled[0].total), "debited once");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("RULE 2: the token is stored before the customer is shown it", async () => {
  await vas.ensureVasSchema();
  const { userId } = await makeFundedUser(500);
  withSupplier(async () => ({ token: "AIRTIME-PIN-12345" }));
  try {
    const result = await vas.purchaseVas({ userId }, {
      serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID()
    });
    assert.equal(result.token, "AIRTIME-PIN-12345", "the customer gets the token");
    assert.equal(result.status, "delivered");

    const { rows } = await pool.query("SELECT token_ciphertext, token_issued_at FROM vas_purchases WHERE id = $1", [result.id]);
    assert.ok(rows[0].token_ciphertext, "it was persisted");
    assert.ok(rows[0].token_issued_at, "with the moment it was issued");
    // AND NOT IN THE CLEAR. A redeemable token sitting readable in the database
    // is money anyone with a backup can spend.
    assert.ok(!rows[0].token_ciphertext.includes("AIRTIME-PIN-12345"), "and encrypted at rest");
    assert.match(rows[0].token_ciphertext, /^enc:/);
    assert.equal(vas.decryptToken(rows[0].token_ciphertext), "AIRTIME-PIN-12345", "and readable back");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("RULE 2: a token is never in a list response, only in the one that asked", () => {
  const list = VAS_SERVICE.slice(VAS_SERVICE.indexOf("async function listPurchases"),
    VAS_SERVICE.indexOf("async function listPurchasesNeedingReview"));
  assert.ok(!list.includes("decryptToken"), "listPurchases must not decrypt tokens");
  assert.match(list, /No tokens in a list/);
});

test("RULE 3: an unknown outcome does NOT return the money and does NOT retry", async () => {
  // The most expensive mistake available here. A timeout does not prove the
  // supplier issued nothing — refunding it pays for a token the customer may
  // already hold, and retrying it buys a second one.
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  let calls = 0;
  withSupplier(async () => {
    calls += 1;
    const error = new Error("socket hang up");
    error.status = 504;
    throw error;
  });
  try {
    await assert.rejects(
      () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
      (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.details.code, "VAS_DELIVERY_UNCERTAIN");
        assert.match(error.message, /Do not try again/);
        return true;
      });
    assert.equal(calls, 1, "it was not retried");

    const { rows } = await pool.query("SELECT status, requires_review, total FROM vas_purchases WHERE user_id = $1", [userId]);
    // Read the debited total off the row rather than hard-coding it: airtime
    // carries a fee, so the wallet is down amount + fee, not amount.
    assert.equal(await balanceOf(walletId), 500 - Number(rows[0].total), "the money is HELD, not returned");
    assert.ok(Number(rows[0].total) > 50, "and the fee was part of what was held");
    assert.equal(rows[0].status, "unknown", "and the purchase says it is unknown");
    assert.equal(rows[0].requires_review, true, "flagged for a human to reconcile");

    // And it is findable by the reconciliation path, which is the whole point
    // of not resolving it automatically.
    const review = await vas.listPurchasesNeedingReview();
    assert.ok(review.some((r) => r.user_id === userId), "it appears in the review queue");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("RULE 3: a 429 and a 408 are also unknown, not refusals", async () => {
  await vas.ensureVasSchema();
  for (const status of [408, 429, 500, 503]) {
    const { userId, walletId } = await makeFundedUser(500);
    withSupplier(async () => { const e = new Error("busy"); e.status = status; throw e; });
    try {
      await assert.rejects(
        () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
        (error) => error.details.code === "VAS_DELIVERY_UNCERTAIN");
      const { rows } = await pool.query("SELECT total FROM vas_purchases WHERE user_id = $1", [userId]);
      assert.equal(await balanceOf(walletId), 500 - Number(rows[0].total), `${status} must not refund`);
    } finally {
      restoreSupplier();
      await cleanup(userId);
    }
  }
});

test("RULE 4: a refusal the supplier actually gave returns the money, exactly once", async () => {
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  withSupplier(async () => { const e = new Error("invalid msisdn"); e.status = 400; throw e; });
  try {
    await assert.rejects(
      () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
      (error) => {
        assert.equal(error.details.code, "VAS_REJECTED");
        assert.match(error.message, /returned to your wallet/);
        return true;
      });
    assert.equal(await balanceOf(walletId), 500, "the money is back");

    const { rows } = await pool.query("SELECT id, status FROM vas_purchases WHERE user_id = $1", [userId]);
    assert.equal(rows[0].status, "reversed");

    // EXACTLY ONCE. A retry, a poll and a reconciliation job can all reach the
    // release; a second credit would be TitoPay paying the customer to be
    // refused.
    await vas.releasePurchaseFunds(rows[0].id, "REPLAY");
    await vas.releasePurchaseFunds(rows[0].id, "REPLAY");
    assert.equal(await balanceOf(walletId), 500, "and a replayed release credits nothing");

    const { rows: credits } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM wallet_ledger
        WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1) AND entry_type = 'credit'`,
      [userId]);
    assert.equal(credits[0].n, 1, "one credit posting, not three");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("a refusal reads the same whichever error shape the adapter raises", () => {
  // The bug this pins: isDefiniteRejection read only `status`, but AppError —
  // the error type every adapter in this codebase raises — carries
  // `statusCode`. So a flat 400 refusal from the supplier looked status-less,
  // status-less means unknown, and unknown holds the money for reconciliation
  // instead of returning it. It failed in the SAFE direction, which is exactly
  // why nobody would have noticed until a customer asked where their money was.
  const { AppError } = require("../src/lib/errors");
  const plain = Object.assign(new Error("bad msisdn"), { status: 400 });
  const app = new AppError(400, "bad msisdn");
  assert.equal(vas.isDefiniteRejection(plain), true, "plain Error with status");
  assert.equal(vas.isDefiniteRejection(app), true, "AppError with statusCode");

  // And the retryable ones stay unknown in both shapes.
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(vas.isDefiniteRejection(Object.assign(new Error("x"), { status })), false, `plain ${status}`);
    assert.equal(vas.isDefiniteRejection(new AppError(status, "x")), false, `AppError ${status}`);
  }
  // No status at all is unknown, never a refusal — a network error that never
  // reached the supplier must not return money.
  assert.equal(vas.isDefiniteRejection(new Error("ECONNRESET")), false);
});

test("an AppError refusal from the adapter really does return the money", async () => {
  // The behaviour behind the unit test above, driven end to end.
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(500);
  const { AppError } = require("../src/lib/errors");
  withSupplier(async () => { throw new AppError(400, "That number is not valid"); });
  try {
    await assert.rejects(
      () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
      (error) => error.details.code === "VAS_REJECTED");
    assert.equal(await balanceOf(walletId), 500, "the money came back");
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

test("a purchase that cannot be afforded never reaches the supplier", async () => {
  await vas.ensureVasSchema();
  const { userId, walletId } = await makeFundedUser(10);
  let calls = 0;
  withSupplier(async () => { calls += 1; return { token: "PIN" }; });
  try {
    await assert.rejects(
      () => vas.purchaseVas({ userId }, { serviceCode: "airtime", amount: 50, recipient: "0821234567", idempotencyKey: crypto.randomUUID() }),
      (error) => error.details?.code === "INSUFFICIENT_BALANCE");
    assert.equal(calls, 0, "the supplier was never contacted");
    assert.equal(await balanceOf(walletId), 10);
  } finally {
    restoreSupplier();
    await cleanup(userId);
  }
});

/* ---- the other two layers ---------------------------------------------- */

test("layer 2 asks the capability instead of keeping a list", () => {
  // It used to be flat entries in PROVIDER_DEPENDENT_SERVICES: true when
  // written, but a hard-coded fact about a supplier that somebody would have
  // had to find and edit on the day a contract went live.
  assert.match(TX_SERVICE, /require\("\.\.\/lib\/vas-services"\)/);
  assert.match(TX_SERVICE, /require\("\.\.\/providers\/vas-provider"\)\.vasCanPurchase\(\)/);
  const dependent = TX_SERVICE.slice(TX_SERVICE.indexOf("const PROVIDER_DEPENDENT_SERVICES"),
    TX_SERVICE.indexOf("function splitRecipientList"));
  for (const code of ['"airtime"', '"electricity"', '"voucher"', '"pay_bills"']) {
    assert.ok(!dependent.includes(code), `${code} must no longer be hard-coded in the list`);
  }
});

test("EVERY spelling of a VAS service is gated, not just the plain ones", async () => {
  // THE DEAD TRANSACTION THIS CLOSES. The catalogue gate knew the alias codes
  // the app actually uses — "airtime-and-data" is the real service_code behind
  // the Airtime & Data tile — and the transaction engine kept its own copy of
  // the list that did not. So the tile was correctly held at "coming soon"
  // while the engine would have accepted airtime_and_data straight through to
  // a bare wallet debit: money out, nothing delivered, and no supplier
  // contracted to deliver it. An endpoint does not care what a tile says.
  const { VAS_SERVICE_CODES, isVasService } = require("../src/lib/vas-services");
  for (const code of VAS_SERVICE_CODES) {
    // Both spellings, because the catalogue stores hyphens and the engine
    // normalizes to underscores.
    assert.ok(isVasService(code), `${code} must be a VAS service`);
    assert.ok(isVasService(code.replace(/-/g, "_")), `${code} underscored must be too`);
    await assert.rejects(() => transactions.feePreview({ service: code.replace(/-/g, "_"), amount: 50 }),
      (error) => /not enabled for live processing yet/.test(error.message),
      `${code} must be refused at the fee preview`);
  }
});

test("the three places that gate VAS all read the one list", () => {
  // The bug was two copies drifting. A third copy would do it again.
  const CATALOGUE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "service-management-service.js"), "utf8");
  for (const [name, source] of [["transaction-service", TX_SERVICE],
    ["service-management-service", CATALOGUE], ["vas-purchase-service", VAS_SERVICE]]) {
    assert.match(source, /require\("\.\.\/lib\/vas-services"\)/, `${name} must read the shared list`);
    assert.ok(!/const VAS_SERVICES = new Set\(\[/.test(source), `${name} must not keep its own copy`);
  }
});

test("layer 2 still refuses today, because the adapter still cannot buy", async () => {
  assert.equal(realCanPurchase(), false);
  for (const code of ["airtime", "data", "electricity", "voucher", "pay_bills"]) {
    await assert.rejects(() => transactions.feePreview({ service: code, amount: 50 }),
      (error) => /not enabled for live processing yet/.test(error.message),
      `${code} must still be refused at the fee preview`);
  }
});

test("a VAS purchase can never be a bare wallet debit, contracted or not", () => {
  // The refusal on the generic debit path is unconditional on purpose. Whether
  // a supplier is contracted has no bearing on whether that endpoint is the
  // right door, and a guard that relaxes on someone else's configuration is a
  // guard that will one day be open when it should not be.
  const live = TX_SERVICE.slice(TX_SERVICE.indexOf("async function assertLiveTransactionSupported"),
    TX_SERVICE.indexOf("async function feePreview"));
  const block = live.slice(live.indexOf("if (isVasService(normalizedServiceCode))"));
  assert.ok(block.includes("USE_VAS_PURCHASE_FLOW"), "it points at the purchase flow");
  assert.ok(!block.includes("vasCanPurchase"), "and does not ask the capability");
  assert.match(block, /\/v1\/vas\/purchase/);
});

test("the bare debit path refuses every VAS spelling, even with a contracted supplier", async () => {
  // The behaviour behind the structural test above, driven for real — and for
  // the alias codes specifically, because those were the ones that used to slip
  // through into a wallet debit.
  const { VAS_SERVICE_CODES } = require("../src/lib/vas-services");
  const realVasCanPurchase = vasProvider.vasCanPurchase;
  vasProvider.vasCanPurchase = () => true;
  const { userId, walletId } = await makeFundedUser(500);
  try {
    for (const code of VAS_SERVICE_CODES) {
      await assert.rejects(
        () => transactions.createTransaction({ userId }, { service: code.replace(/-/g, "_"), amount: 50, recipient: "0821234567" }),
        (error) => error.details?.code === "USE_VAS_PURCHASE_FLOW",
        `${code} must be sent to the purchase flow, never debited here`);
    }
    assert.equal(await balanceOf(walletId), 500, "and not one cent moved");
  } finally {
    vasProvider.vasCanPurchase = realVasCanPurchase;
    await cleanup(userId);
  }
});

test("the supplier is reached through the capability, never by name", () => {
  // The seam rule. Core reads what an adapter declares; it does not know who
  // the adapter is.
  for (const vendor of ["flash", "Flash", "FLASH"]) {
    assert.ok(!VAS_SERVICE.includes(vendor), `vas-purchase-service must not name ${vendor}`);
  }
  assert.match(VAS_SERVICE, /async function purchaseThroughProvider/);
  assert.match(VAS_SERVICE, /require\("\.\.\/providers\/vas-provider"\)/);
});

test("the purchase rail moves money only through the wallet service", () => {
  // No hand-rolled balance arithmetic: every movement goes through
  // applyWalletMovement, which is what keeps the ledger and the balance in step.
  assert.ok(!VAS_SERVICE.includes("UPDATE wallets SET available_balance"),
    "no direct balance write");
  assert.match(VAS_SERVICE, /walletService\.applyWalletMovement/);
  const credits = VAS_SERVICE.match(/entryType: "credit"/g) || [];
  assert.equal(credits.length, 1, "exactly one place gives money back");
});
