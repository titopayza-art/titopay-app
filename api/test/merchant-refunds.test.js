"use strict";

// REFUNDING A CUSTOMER.
//
// The Refund customer screen collected everything a refund needs and then met
// "Refund is not enabled for live processing yet", because the service code sat
// in a list of doors whose flows were never built. This file covers the flow
// that replaces that message.
//
// A refund moves real money, so the tests that matter are not the ones showing
// it works. They are the ones showing it cannot be made to do the four things
// a broken refund does:
//
//   give back more than came in;
//   give it back twice;
//   give it to somebody who never paid;
//   quietly take the fee out of what the customer is owed.
//
// Every one of those is a separate test below, and each is written so that
// removing the guard makes it fail rather than merely changing a message.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const refunds = require("../src/services/refund-service");
const { createTransaction } = require("../src/services/transaction-service");
const { getPrimaryWalletForUser, getRevenueWallet } = require("../src/services/wallet-service");

const TAG = "refundtest";
const created = [];

async function seedUser(accountType, balance = 0) {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE)`,
    [id, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`,
      `${TAG}_${suffix}@example.invalid`, `2782${Math.floor(1000000 + Math.random() * 8999999)}`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,$3,'ZAR',$4,'active',$5)`,
    [randomUUID(), id, accountType === "business" ? "business" : "personal",
      String(Math.floor(1000000000 + Math.random() * 8999999999)), balance]);
  created.push(id);
  return { userId: id, accountType, profileLocked: false, fullName: `${TAG} ${suffix}` };
}

const balanceOf = async (userId) =>
  Number((await getPrimaryWalletForUser(userId)).available_balance);

// A real payment from the customer to the business, made the way the app makes
// one. Nothing here fakes a transaction row: the original these refunds point
// at is produced by the live send_money path.
async function customerPaysBusiness(customer, business, amount) {
  const wallet = await getPrimaryWalletForUser(business.userId);
  const result = await createTransaction(customer, {
    serviceCode: "send_money",
    amount,
    recipient: wallet.wallet_number
  });
  return result.reference;
}

// Refusals are asserted on status, code and wording together: the screens
// branch on the code and show the sentence, so a refusal that loses either is
// not doing its job.
async function refuses(fn, { status = 409, code, says }) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert.ok(error, "this should have been refused");
  assert.equal(error.statusCode, status, `expected ${status}, got ${error.statusCode}: ${error.message}`);
  if (code) assert.equal(error.details?.code, code, `code was ${JSON.stringify(error.details)}`);
  if (says) assert.match(error.message, says, `message was: ${error.message}`);
  return error;
}

test.before(async () => {
  await refunds.ensureRefundSchema();
});

test.after(async () => {
  for (const id of created) {
    await pool.query("DELETE FROM merchant_refunds WHERE business_user_id = $1 OR customer_user_id = $1", [id]).catch(() => {});
  }
  for (const id of created) {
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [id]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  await pool.end();
});

/* ============================================== the money, to the cent */

test("A REFUND CREDITS THE CUSTOMER IN FULL AND CHARGES THE FEE TO THE BUSINESS", async () => {
  const customer = await seedUser("personal", 500);
  // A FLOAT, NOT ZERO. A full refund costs the sale price plus the R1
  // processing fee, and the sale only brought in the sale price - so a
  // business cannot refund a sale purely out of that sale's proceeds. That is
  // the approved schedule doing what it says, and it is asserted rather than
  // worked around: seeding zero here is how this test first failed.
  const business = await seedUser("business", 50);
  const reference = await customerPaysBusiness(customer, business, 75);

  const businessBefore = await balanceOf(business.userId);
  const customerBefore = await balanceOf(customer.userId);
  const revenueBefore = Number((await getRevenueWallet()).available_balance);

  const result = await refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund", reason: "Customer return"
  });

  assert.equal(result.amount, 75);
  assert.equal(result.customerReceives, 75, "the customer is owed 75 and receives 75");
  assert.equal(result.fee, 1, "the R1 processing fee comes from the approved schedule");
  assert.equal(result.total, 76, "and the business pays 75 + 1");

  // THE POINT OF THIS TEST. A person owed R75 gets R75 - the fee is never
  // taken out of what they are owed.
  assert.equal(await balanceOf(customer.userId) - customerBefore, 75);
  assert.equal(businessBefore - await balanceOf(business.userId), 76);
  assert.equal(Number((await getRevenueWallet()).available_balance) - revenueBefore, 1);
});

test("the ledger balances: every cent debited is a cent credited", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 50);
  const reference = await customerPaysBusiness(customer, business, 120);
  const result = await refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund"
  });
  const { rows } = await pool.query(
    `SELECT entry_type, SUM(amount)::NUMERIC AS total
       FROM wallet_ledger
      WHERE reference = $1 GROUP BY entry_type`,
    [result.reference]);
  const debit = Number(rows.find((r) => r.entry_type === "debit")?.total || 0);
  const credit = Number(rows.find((r) => r.entry_type === "credit")?.total || 0);
  assert.equal(debit, 121, "business debited amount + fee");
  assert.equal(credit, 121, "customer credited 120 and revenue credited 1");
  assert.equal(debit, credit, "double entry balances");
});

/* ================================================ more than came in */

test("A REFUND CAN NEVER EXCEED THE PAYMENT IT POINTS AT", async () => {
  const customer = await seedUser("personal", 5000);
  const business = await seedUser("business", 5000);
  const reference = await customerPaysBusiness(customer, business, 75);

  const businessBefore = await balanceOf(business.userId);
  await refuses(() => refunds.createRefund(business, {
    originalReference: reference, refundType: "partial_refund", amount: 4000
  }), { code: "exceeds_original", says: /R75\.00, so R4000\.00 is more than you can refund/ });

  assert.equal(await balanceOf(business.userId), businessBefore, "and nothing moved");
});

test("partial refunds accumulate, and the last one can only return what is left", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 200);
  const reference = await customerPaysBusiness(customer, business, 100);

  await refunds.createRefund(business, { originalReference: reference, refundType: "partial_refund", amount: 40 });
  await refunds.createRefund(business, { originalReference: reference, refundType: "partial_refund", amount: 35 });

  const state = await refunds.findRefundablePayment(business.userId, reference);
  assert.equal(state.alreadyRefunded, 75);
  assert.equal(state.refundable, 25, "100 paid, 75 returned, 25 left");

  await refuses(() => refunds.createRefund(business, {
    originalReference: reference, refundType: "partial_refund", amount: 26
  }), { code: "exceeds_original", says: /Only R25\.00 of this payment is left/ });

  // The last 25 goes through, and then there is nothing left at all.
  const last = await refunds.createRefund(business, { originalReference: reference, refundType: "full_refund" });
  assert.equal(last.amount, 25, "a full refund now means the remainder, not the original total");
  await refuses(() => refunds.createRefund(business, {
    originalReference: reference, refundType: "partial_refund", amount: 1
  }), { code: "already_refunded", says: /already been refunded in full/ });
});

test("TWO REFUNDS FIRED AT ONE PAYMENT TOGETHER PRODUCE ONE REFUND", async () => {
  // The cap is read, then written against. Without the lock on the original
  // both of these read "nothing refunded yet" and both would pay out, sending
  // back double what came in. This is the test that proves the lock is real:
  // it fails without it.
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, business, 100);
  const customerBefore = await balanceOf(customer.userId);

  const results = await Promise.allSettled([
    refunds.createRefund(business, { originalReference: reference, refundType: "full_refund" }),
    refunds.createRefund(business, { originalReference: reference, refundType: "full_refund" })
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, `exactly one should succeed, got ${ok.length}`);
  assert.equal(await balanceOf(customer.userId) - customerBefore, 100,
    "the customer got their 100 back once, not twice");
});

test("a repeated request with the same idempotency key refunds once", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, business, 60);
  const customerBefore = await balanceOf(customer.userId);
  const key = `idem-${randomUUID()}`;

  const first = await refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund", idempotencyKey: key });
  const second = await refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund", idempotencyKey: key });

  assert.equal(second.idempotentReplay, true, "the retry is answered, not re-run");
  assert.equal(second.refundId, first.refundId);
  assert.equal(await balanceOf(customer.userId) - customerBefore, 60, "credited once");
});

/* ============================================== somebody who never paid */

test("A BUSINESS CANNOT REFUND A PAYMENT THAT WAS MADE TO SOMEBODY ELSE", async () => {
  const customer = await seedUser("personal", 500);
  const shop = await seedUser("business", 0);
  const stranger = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, shop, 90);

  const strangerBefore = await balanceOf(stranger.userId);
  // Deliberately the SAME refusal as a reference that does not exist, so
  // guessing references tells a stranger nothing about whether they are real.
  await refuses(() => refunds.createRefund(stranger, {
    originalReference: reference, refundType: "full_refund"
  }), { status: 404, code: "original_not_found" });
  assert.equal(await balanceOf(stranger.userId), strangerBefore);
});

test("THE CUSTOMER IS READ OFF THE PAYMENT, NEVER OFF THE FORM", async () => {
  // A refund screen where the customer is typed in is a screen where a typo
  // pays a stranger. The service takes a recipient field and must ignore it.
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 200);
  const outsider = await seedUser("personal", 0);
  const reference = await customerPaysBusiness(customer, business, 50);

  const outsiderBefore = await balanceOf(outsider.userId);
  const customerBefore = await balanceOf(customer.userId);

  await refunds.createRefund(business, {
    originalReference: reference,
    refundType: "full_refund",
    // Every way a caller might try to redirect the money.
    recipient: `${TAG}_outsider`,
    customerUserId: outsider.userId,
    recipientWalletId: (await getPrimaryWalletForUser(outsider.userId)).id
  });

  assert.equal(await balanceOf(outsider.userId), outsiderBefore, "the named outsider got nothing");
  assert.equal(await balanceOf(customer.userId) - customerBefore, 50, "the person who paid got it back");
});

test("a reference that does not exist is refused before anything moves", async () => {
  const business = await seedUser("business", 500);
  const before = await balanceOf(business.userId);
  await refuses(() => refunds.createRefund(business, {
    originalReference: "TX-0000000000-NOPE", refundType: "full_refund"
  }), { status: 404, code: "original_not_found", says: /no payment with that reference/ });
  assert.equal(await balanceOf(business.userId), before);
});

/* ==================================================== balance and locks */

test("a business without the money is told so, and nothing moves", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 0);
  const reference = await customerPaysBusiness(customer, business, 200);
  // Take the sale proceeds back out so the wallet cannot cover the refund.
  await pool.query("UPDATE wallets SET available_balance = 10 WHERE user_id = $1", [business.userId]);

  const customerBefore = await balanceOf(customer.userId);
  await refuses(() => refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund"
  }), { status: 400, code: "insufficient_balance", says: /Nothing was taken/ });
  assert.equal(await balanceOf(customer.userId), customerBefore);
  assert.equal(await balanceOf(business.userId), 10, "the business wallet is untouched");
});

test("a locked profile cannot refund", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, business, 30);
  await refuses(() => refunds.createRefund({ ...business, profileLocked: true }, {
    originalReference: reference, refundType: "full_refund"
  }), { status: 423, says: /Profile is locked/ });
});

/* ========================================================= the preview */

test("the preview prices the refund without moving anything", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, business, 75);
  const before = await balanceOf(business.userId);

  const preview = await refunds.previewRefund(business, {
    originalReference: reference, refundType: "full_refund" });

  assert.equal(preview.amount, 75);
  assert.equal(preview.customerReceives, 75);
  assert.equal(preview.fee, 1);
  assert.equal(preview.total, 76);
  assert.equal(preview.refundable, 75);
  assert.equal(preview.sufficientBalance, true);
  assert.match(preview.customerName, new RegExp(TAG), "the screen can name who is being refunded");
  assert.equal(await balanceOf(business.userId), before, "a preview is read-only");
});

test("the generic transaction endpoint refuses refunds and names the right door", async () => {
  // The fee preview must still work - the screen prices a refund before the
  // business commits to it - but a bare wallet debit can never be a refund.
  const { feePreview } = require("../src/services/transaction-service");
  const priced = await feePreview({ serviceCode: "refund", amount: 75 });
  assert.equal(priced.fee, 1, "pricing a refund is allowed");

  const business = await seedUser("business", 500);
  await refuses(() => createTransaction(business, {
    serviceCode: "refund", amount: 75, recipient: "someone"
  }), { status: 409, code: "USE_REFUND_FLOW", says: /refund flow/ });
});

test("the refund appears on the business's own list with its original", async () => {
  const customer = await seedUser("personal", 500);
  const business = await seedUser("business", 500);
  const reference = await customerPaysBusiness(customer, business, 45);
  await refunds.createRefund(business, {
    originalReference: reference, refundType: "full_refund", reason: "Duplicate payment" });

  const list = await refunds.listRefundsForBusiness(business.userId);
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 45);
  assert.equal(list[0].originalReference, reference);
  assert.equal(list[0].reason, "Duplicate payment");
});
