"use strict";

// A TILL SALE IS NOT A PAYMENT UNTIL SOMEBODY PAYS IT.
//
// Reported from a real till: the app said "Sale of R200,00 recorded" the
// moment the payment QR appeared, before the customer had scanned anything.
// It was telling the truth about what the platform did, which is why it was
// worth reporting.
//
// No money was ever fabricated — the whole till path makes zero writes to
// wallet_ledger, transactions or any wallet balance, and this platform derives
// balances from postings. What was wrong was the BUSINESS's books: a row went
// into business_staff_sales at QR-mint time, fed the Sales suite's staff
// performance report, and nothing ever revisited it. A customer who changed
// their mind still counted towards that cashier's totals for ever.
//
// The row is still written when the QR is minted — it is the record of who
// rang up what — but it now says whether the money arrived, and only the paid
// ones are reported as sales.

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
const staff = require("../src/services/business-staff-service");

const ROOT = path.join(__dirname, "..", "..");
const QR_SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "qr-service.js"), "utf8");
const STAFF_SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "business-staff-service.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "pwa", "app.js"), "utf8");

async function makeUser(name) {
  const id = crypto.randomUUID();
  const tag = "till-" + id.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash, email, status)
     VALUES ($1,'personal',$2,$3,'x',$4,'active')`,
    [id, name, tag, tag + "@example.test"]);
  return id;
}

test("a sale rung up on the till does not count until it is paid", async () => {
  await staff.ensureStaffSchema();
  const business = await makeUser("The Business");
  const cashier = await makeUser("Cashier");
  const qrId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO business_staff_sales (id, business_user_id, staff_user_id, staff_name, amount, reference, qr_id, items, status)
       VALUES ($1,$2,$3,'Cashier',200,'SALE-TEST',$4,'[]'::JSONB,'pending')`,
      [saleId, business, cashier, qrId]);

    const before = (await staff.staffSalesTotals(business))[0];
    // THE HEADLINE NUMBER IS PAID SALES. A rung-up-but-unpaid sale inside it is
    // how a till total stops matching the wallet.
    assert.equal(before.salesTotal, 0, "an unpaid sale is not in the cashier's total");
    assert.equal(before.salesCount, 0);
    // But it is visible, not hidden — an abandoned sale has to be findable.
    assert.equal(before.pendingTotal, 200, "it is reported beside the total as pending");
    assert.equal(before.pendingCount, 1);

    assert.equal(await staff.markStaffSalePaid(qrId, null), true, "settlement moves it");
    const after = (await staff.staffSalesTotals(business))[0];
    assert.equal(after.salesTotal, 200, "a paid sale counts");
    assert.equal(after.pendingTotal, 0, "and is no longer pending");

    // A REPLAYED SETTLEMENT MUST NOT DOUBLE-COUNT. The update is scoped to a
    // pending row for that exact QR, so a webhook retry or a duplicated call
    // moves nothing.
    assert.equal(await staff.markStaffSalePaid(qrId, null), false, "a replay moves no row");
    const replayed = (await staff.staffSalesTotals(business))[0];
    assert.equal(replayed.salesTotal, 200, "and the total is unchanged");
  } finally {
    await pool.query("DELETE FROM business_staff_sales WHERE id = $1", [saleId]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[business, cashier]]);
  }
});

test("history is not retold as either paid or unpaid", async () => {
  // Rows written before this column existed: some were paid, some were
  // abandoned, and the platform does not know which. Backfilling them to
  // either answer would put a fabricated number in a revenue report, so they
  // carry their own state and are reported separately.
  assert.match(STAFF_SERVICE, /status = 'legacy'/);
  assert.match(STAFF_SERVICE, /Guessing would put a fabricated number in a revenue report/);
  assert.match(STAFF_SERVICE, /legacyTotal/, "and the report shows them on their own");
});

test("the sale is marked paid where the money actually moves, and cannot break the payment", () => {
  // The hook belongs in qr-service, after the transaction has succeeded —
  // that is the only moment the platform knows a payment settled.
  assert.match(QR_SERVICE, /markStaffSalePaid\(qr\.id, tx\.transactionId\)/);
  const payQr = QR_SERVICE.slice(QR_SERVICE.indexOf("async function payQr"), QR_SERVICE.indexOf("function qrResponse"));
  const settle = payQr.indexOf("createTransaction");
  const mark = payQr.indexOf("markStaffSalePaid");
  assert.ok(settle !== -1 && mark !== -1 && mark > settle,
    "the row is only marked after the money has moved");
  // And it may never fail a settled payment: the money is already gone by
  // then, so a till row that will not update is a reporting problem.
  assert.match(payQr, /markStaffSalePaid\([^)]*\)\s*\n?\s*\.catch\(\(\) => false\)/s);

  // Scoped to a pending row for that QR, which is what makes a replay safe.
  assert.match(STAFF_SERVICE, /WHERE qr_id = \$1 AND status = 'pending'/);
});

test("the till still says nothing has been paid", () => {
  // The cashier is the one person who most needs the difference between rung
  // up and paid, and the old wording told them the opposite.
  assert.doesNotMatch(APP, /Sale of \$\{money\(saleResult\.total\)\} recorded/,
    "the app no longer claims an unpaid sale was recorded");
  assert.match(APP, /QR ready\. Waiting for the customer to pay/);
  assert.match(APP, /It counts towards your till once the customer has paid/);
});

test("the till path still moves no money of its own", async () => {
  // The reassuring half of the original report, pinned so it stays true: a
  // till sale mints a QR and writes a record. Money only ever moves through
  // qr-service settling a real payment.
  for (const file of ["business-staff-service.js", "business-products-service.js"]) {
    const source = fs.readFileSync(path.join(ROOT, "api", "src", "services", file), "utf8");
    assert.doesNotMatch(source, /INSERT INTO wallet_ledger/, `${file} posts nothing to the ledger`);
    assert.doesNotMatch(source, /INSERT INTO transactions/, `${file} creates no transaction`);
    assert.doesNotMatch(source, /UPDATE wallets/, `${file} moves no balance`);
  }
});
