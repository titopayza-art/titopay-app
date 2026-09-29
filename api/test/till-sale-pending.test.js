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

test("nothing leaves the shelf until the customer has paid", async () => {
  // The half of this that the first fix missed. Ringing up priced the basket
  // AND took the goods off the shelf, so an abandoned sale left the count
  // wrong for ever. Pricing and selling are now two acts, and only the second
  // one happens when money moves.
  await staff.ensureStaffSchema();
  const products = require("../src/services/business-products-service");
  const business = await makeUser("Shop");
  const cashier = await makeUser("Cashier");
  await pool.query("UPDATE users SET account_type = 'business' WHERE id = $1", [business]);
  await pool.query(
    `INSERT INTO business_staff (id, business_user_id, staff_user_id, full_name, role, contact, status)
     VALUES ($1,$2,$3,'Cashier','Cashier','c@example.test','active')`,
    [crypto.randomUUID(), business, cashier]);
  const product = await products.createProduct(business, { name: "Test Shirt", price: 200, trackStock: true, openingStock: 5 });
  const stock = async () => Number((await pool.query(
    "SELECT stock_quantity FROM business_products WHERE id = $1", [product.id])).rows[0].stock_quantity);
  try {
    assert.equal(await stock(), 5);
    const sale = await staff.staffSale(cashier, business, { items: [{ productId: product.id, quantity: 1 }] });
    assert.equal(sale.total, 200, "the QR still carries the right amount");
    assert.equal(await stock(), 5, "ringing up does NOT take the shirt off the shelf");

    await staff.markStaffSalePaid(sale.qr.id, null);
    assert.equal(await stock(), 4, "paying does");
  } finally {
    for (const t of ["business_stock_movements", "business_staff_sales", "business_products", "business_staff"]) {
      await pool.query(`DELETE FROM ${t} WHERE business_user_id = $1`, [business]);
    }
    await pool.query("DELETE FROM qr_codes WHERE user_id = $1", [business]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[business, cashier]]);
  }
});

test("the owner's own till waits for payment too", async () => {
  // THE HALF MOST BUSINESSES ACTUALLY USE. The staff till was fixed first, but
  // the owner's Make a Sale still called /record-sale before the QR was minted,
  // so the same defect survived on the busier path.
  await staff.ensureStaffSchema();
  const products = require("../src/services/business-products-service");
  const owner = await makeUser("Corner Shop");
  const cashier = await makeUser("Cashier");
  await pool.query("UPDATE users SET account_type = 'business' WHERE id = $1", [owner]);
  await pool.query(
    `INSERT INTO business_staff (id, business_user_id, staff_user_id, full_name, role, contact, status)
     VALUES ($1,$2,$3,'Cashier','Cashier','c@example.test','active')`,
    [crypto.randomUUID(), owner, cashier]);
  const product = await products.createProduct(owner, { name: "Bread", price: 25, trackStock: true, openingStock: 10 });
  const stock = async () => Number((await pool.query(
    "SELECT stock_quantity FROM business_products WHERE id = $1", [product.id])).rows[0].stock_quantity);
  try {
    const sale = await staff.ownerTillSale(owner, { items: [{ productId: product.id, quantity: 2 }] });
    assert.equal(sale.total, 50, "the QR carries the basket total");
    assert.equal(await stock(), 10, "ringing up takes nothing off the shelf");

    // THE STAFF LEAGUE TABLE MUST NOT GAIN THE OWNER. That report answers
    // "how are my cashiers doing"; the owner appearing in it would be a new
    // and wrong answer to a report that already exists.
    assert.equal((await staff.staffSalesTotals(owner)).length, 0, "no owner row before");

    assert.equal(await staff.markStaffSalePaid(sale.qr.id, null), true);
    assert.equal(await stock(), 8, "paying does");
    assert.equal((await staff.staffSalesTotals(owner)).length, 0, "and none after");

    // Scoped, not blunt: a real cashier still reports.
    const byStaff = await staff.staffSale(cashier, owner, { items: [{ productId: product.id, quantity: 1 }] });
    await staff.markStaffSalePaid(byStaff.qr.id, null);
    const rows = await staff.staffSalesTotals(owner);
    assert.equal(rows.length, 1, "the cashier still appears");
    assert.equal(rows[0].salesTotal, 25);
  } finally {
    for (const t of ["business_stock_movements", "business_staff_sales", "business_products", "business_staff"]) {
      await pool.query(`DELETE FROM ${t} WHERE business_user_id = $1`, [owner]);
    }
    await pool.query("DELETE FROM qr_codes WHERE user_id = $1", [owner]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[owner, cashier]]);
  }
});

test("only a business account can open a till", () => {
  // The owner endpoint takes no business id from the caller — it uses the
  // authenticated user's own — but it still has to refuse a personal account
  // rather than mint a QR against one.
  assert.match(STAFF_SERVICE, /account_type !== "business"/);
  const routes = fs.readFileSync(path.join(ROOT, "api", "src", "routes", "business-products.routes.js"), "utf8");
  assert.match(routes, /ownerTillSale\(req\.auth\.userId, req\.body \|\| \{\}\)/,
    "the till is opened for the caller, never for an id they supply");
});

test("the owner's till no longer records a sale to mint a QR", () => {
  // The specific line that was reported: recordSaleBasket() ran before
  // generateQr's API call, so the stock moved at QR-mint time.
  assert.doesNotMatch(APP, /recordSaleBasket/, "the record-then-mint path is gone");
  assert.match(APP, /business\/products\/till-sale/, "the till mints through the pending path");
  const generate = APP.slice(APP.indexOf("async function generateQr"), APP.indexOf("async function processQrPayment"));
  assert.doesNotMatch(generate, /products\/record-sale/, "and generateQr records no sale of its own");
  assert.match(generate, /Your stock counts down once the payment lands, not before/,
    "and the screen says so");
});

test("pricing a basket writes nothing at all", () => {
  // The read-only half, kept honest: if priceSale ever writes, the flow is
  // back where it started.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is not a convenience. priceSale
  // carries a comment explaining why it does NOT use the FOR UPDATE loader,
  // and reading that prose as evidence of a write is the same mistake in the
  // other direction — a scanner that a comment can trip is a scanner a
  // comment can also hide a real write from. Only executable code is scanned.
  const source = fs.readFileSync(path.join(ROOT, "api", "src", "services", "business-products-service.js"), "utf8");
  const whole = source.slice(source.indexOf("async function priceSale"), source.indexOf("async function recordSale"));
  assert.ok(whole.includes("SELECT id, name, price"), "the slice is the real priceSale body");
  const price = whole.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // And the strip itself is pinned: it must remove the prose and keep the query.
  assert.ok(!price.includes("FOR UPDATE row lock"), "comments are actually stripped");
  assert.ok(price.includes("SELECT id, name, price"), "and the statement survives the strip");

  for (const write of ["UPDATE ", "INSERT ", "DELETE ", "BEGIN"]) {
    assert.ok(!price.includes(write), `priceSale must not ${write.trim()}`);
  }
  // And it must not borrow the locking loader, which exists to guard a write.
  assert.ok(!price.includes("loadOwnProduct"), "pricing takes no row lock");
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
