"use strict";

// MONEY THAT ARRIVES SHORT HAS TO SAY WHY.
//
// A merchant paid R10.00 through a QR code is credited R9.85 - the merchant
// side of the approved QR schedule is 1.5%, and that charge is intended. What
// was NOT intended is that the merchant could not see it: the incoming half of
// listTransactionsForUser reported `0::NUMERIC AS fee` for every arrival, so
// the transaction read "+R9.85" beside "Fee R0.00" and the R10.00 it was taken
// from appeared nowhere. Fifteen cents that cannot be seen cannot be
// reconciled.
//
// These tests pin the three figures that have to add up on an arrival: what
// the payment was for, what was withheld, and what landed.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const { createTransaction, listTransactionsForUser } = require("../src/services/transaction-service");
const { getPrimaryWalletForUser } = require("../src/services/wallet-service");

const TAG = "incfee";
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
  // userType is what writeAuditLog records the actor as; a real req.auth
  // carries it, so a test actor must too or the audit line is skipped.
  return { userId: id, userType: "customer", accountType, profileLocked: false };
}

const arrivalFor = async (userId) =>
  (await listTransactionsForUser(userId)).find((row) => row.direction === "credit");

test.after(async () => {
  for (const id of created) {
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [id]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  await pool.end();
});

test("A MERCHANT CHARGED ON A QR PAYMENT CAN SEE THE CHARGE", async () => {
  const customer = await seedUser("personal", 500);
  const merchant = await seedUser("business", 0);
  const wallet = await getPrimaryWalletForUser(merchant.userId);

  // Exactly what qr-service passes: the merchant side of the schedule, 1.5%.
  await createTransaction(customer, {
    serviceCode: "qr_payment", amount: 10, recipient: wallet.wallet_number,
    merchantReceivesFee: false, recipientFee: 0.15,
    metadata: { qrId: randomUUID() }
  });

  const credited = Number((await getPrimaryWalletForUser(merchant.userId)).available_balance);
  assert.equal(credited, 9.85, "the merchant really is credited 9.85 of a 10.00 payment");

  const arrival = await arrivalFor(merchant.userId);
  assert.ok(arrival, "the arrival is on the merchant's activity");
  assert.equal(Number(arrival.fee), 0.15, "and it reports the 15c that was withheld");
  assert.equal(Number(arrival.gross_amount), 10, "alongside the 10.00 it came out of");
  assert.equal(Number(arrival.posted_amount), 9.85, "and the 9.85 that landed");
  // The three figures the screen shows must reconcile, which is the entire
  // point: a merchant should be able to add them up.
  assert.equal(
    Number(arrival.gross_amount) - Number(arrival.fee), Number(arrival.posted_amount),
    "gross - fee = what landed");
});

test("the headline figure is still what landed, not what was paid", async () => {
  // total drives the amount at the top of the transaction and the row in
  // Activity. Reporting the gross there would tell a merchant they received
  // more than they did.
  const customer = await seedUser("personal", 500);
  const merchant = await seedUser("business", 0);
  const wallet = await getPrimaryWalletForUser(merchant.userId);
  await createTransaction(customer, {
    serviceCode: "qr_payment", amount: 40, recipient: wallet.wallet_number,
    merchantReceivesFee: false, recipientFee: 0.6, metadata: { qrId: randomUUID() }
  });
  const arrival = await arrivalFor(merchant.userId);
  assert.equal(Number(arrival.total), 39.4, "total is the credited figure");
  assert.equal(Number(arrival.amount), 39.4, "and so is amount");
  assert.equal(Number(arrival.fee), 0.6);
});

test("a transfer that credits in full reports no fee and no shortfall", async () => {
  const sender = await seedUser("personal", 500);
  const receiver = await seedUser("personal", 0);
  const wallet = await getPrimaryWalletForUser(receiver.userId);
  await createTransaction(sender, {
    serviceCode: "send_money", amount: 50, recipient: wallet.wallet_number
  });
  const arrival = await arrivalFor(receiver.userId);
  assert.equal(Number(arrival.fee), 0, "nothing was withheld from the receiver");
  assert.equal(Number(arrival.gross_amount), 50);
  assert.equal(Number(arrival.posted_amount), 50, "they got all of it");
});

test("THE SENDER'S OWN FEE IS NEVER REPORTED AS THE RECEIVER'S", async () => {
  // send_money charges the SENDER. That fee has nothing to do with the person
  // receiving, and showing it on their arrival would tell them they were
  // charged something they were not.
  const sender = await seedUser("personal", 500);
  const receiver = await seedUser("personal", 0);
  const wallet = await getPrimaryWalletForUser(receiver.userId);
  const sent = await createTransaction(sender, {
    serviceCode: "send_money", amount: 50, recipient: wallet.wallet_number
  });
  const arrival = await arrivalFor(receiver.userId);
  assert.equal(Number(arrival.fee), 0,
    `the receiver is charged nothing even though the sender paid ${sent.fee}`);
});
