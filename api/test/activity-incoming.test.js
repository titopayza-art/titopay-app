"use strict";

// MONEY THAT ARRIVED HAS TO APPEAR IN ACTIVITY.
//
// Reported after a gift was sent: the person it was sent to could not find it.
// A peer transfer writes ONE transactions row - the sender's debit - and a
// wallet_ledger credit for the receiver. listTransactionsForUser only read
// transactions, so the receiver's Activity was empty while their balance had
// gone up and the money-flow chart above the list (which already reads the
// ledger) counted it.
//
// The fix is a read, not a new row: manufacturing a transactions row for the
// receiver would have put a money path at risk for a display problem, because
// the ledger credit is keyed to the SENDER's transaction id and
// reverseTransaction finds both legs by that id.
//
// Three things are defended here, and the second and third matter as much as
// the first: nothing is counted twice, and the sender's private metadata does
// not travel with the money.

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const tx = require("../src/services/transaction-service");

let sequence = 0;
async function makeUser(label, balance) {
  const id = uuidv4();
  sequence += 1;
  const stamp = String(Date.now()).slice(-6);
  const tag = `${stamp}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,$2,$3,$4,$5,'personal','active','verified','x')`,
    [id, label, `${label.toLowerCase()}_${tag}`, `${label.toLowerCase()}_${tag}@test.local`,
      `+2782${tag}`.slice(0, 13)]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',$4)`,
    [uuidv4(), id, tag.slice(0, 10), balance]);
  return { id, walletNumber: tag.slice(0, 10) };
}

const actorFor = (id) => ({ userId: id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "test" });

test("THE RECEIVER OF A GIFT CAN FIND IT IN ACTIVITY", async () => {
  const giver = await makeUser("Lerato", 2000);
  const getter = await makeUser("Thuso", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_gift", amount: 500, recipient: getter.walletNumber,
    metadata: { occasion: "Birthday", message: "Happy Birthday !" }
  });

  const activity = await tx.listTransactionsForUser(getter.id);
  assert.equal(activity.length, 1, "the gift must appear - this is what was missing");
  const row = activity[0];
  assert.equal(row.direction, "credit");
  assert.equal(row.service_code, "send_gift");
  assert.equal(Number(row.total), 500, "the figure that actually landed");
  assert.equal(row.status, "completed", "a posted ledger credit is settled money");
  assert.equal(row.wallet_posted, true);
});

test("the gift's occasion, message and sender travel with it", async () => {
  const giver = await makeUser("Naledi", 2000);
  const getter = await makeUser("Sipho", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_gift", amount: 250, recipient: getter.walletNumber,
    metadata: { occasion: "Graduation", message: "So proud of you." }
  });
  const [row] = await tx.listTransactionsForUser(getter.id);
  assert.equal(row.metadata.occasion, "Graduation");
  assert.equal(row.metadata.message, "So proud of you.");
  assert.equal(row.metadata.fromName, "Naledi", "the receiver should be told who sent it");
  assert.equal(row.metadata.incoming, true);
});

test("THE SENDER'S PRIVATE METADATA DOES NOT TRAVEL WITH THE MONEY", async () => {
  // The sender's row carries idempotency keys and the fee split. Handing the
  // whole object to the receiver would leak all of it, so only an explicit
  // allowlist crosses.
  const giver = await makeUser("Kabelo", 2000);
  const getter = await makeUser("Ayanda", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_gift", amount: 120, recipient: getter.walletNumber,
    metadata: { occasion: "Thank You", message: "Thanks!", secretInternalNote: "do not share" }
  });
  const [row] = await tx.listTransactionsForUser(getter.id);
  const keys = Object.keys(row.metadata || {});
  for (const leaked of ["clientIdempotencyKey", "payerFee", "recipientFee", "netAmount", "secretInternalNote"]) {
    assert.ok(!keys.includes(leaked), `${leaked} must not reach the receiver`);
  }
  assert.deepEqual(keys.sort(),
    ["customOccasion", "fromName", "incoming", "message", "note", "occasion"],
    "only the allowlist crosses");
});

test("NOTHING IS COUNTED TWICE - the sender still sees exactly one row", async () => {
  const giver = await makeUser("Zanele", 2000);
  const getter = await makeUser("Bongani", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_money", amount: 300, recipient: getter.walletNumber });

  const senderRows = await tx.listTransactionsForUser(giver.id);
  assert.equal(senderRows.length, 1, "the sender's own transaction must not be duplicated by its own posting");
  assert.equal(senderRows[0].direction, "debit");

  const receiverRows = await tx.listTransactionsForUser(getter.id);
  assert.equal(receiverRows.length, 1);
  assert.equal(receiverRows[0].direction, "credit");
});

test("an ordinary transfer is visible to the receiver too, not only a gift", async () => {
  const giver = await makeUser("Palesa", 2000);
  const getter = await makeUser("Mandla", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_money", amount: 75, recipient: getter.walletNumber });
  const [row] = await tx.listTransactionsForUser(getter.id);
  assert.equal(row.service_code, "send_money");
  assert.equal(Number(row.total), 75);
  assert.equal(row.metadata.fromName, "Palesa");
});

test("both sides are ordered newest first", async () => {
  const giver = await makeUser("Refilwe", 3000);
  const getter = await makeUser("Themba", 0);
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_money", amount: 10, recipient: getter.walletNumber });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await tx.createTransaction(actorFor(giver.id), {
    serviceCode: "send_money", amount: 20, recipient: getter.walletNumber });

  const rows = await tx.listTransactionsForUser(getter.id);
  assert.equal(rows.length, 2);
  assert.ok(new Date(rows[0].created_at) >= new Date(rows[1].created_at), "newest first");
  assert.equal(Number(rows[0].total), 20);
});

test("a wallet with nothing in it still returns an empty list rather than failing", async () => {
  const lonely = await makeUser("Quiet", 0);
  const rows = await tx.listTransactionsForUser(lonely.id);
  assert.deepEqual(rows, []);
});

test.after(async () => { await pool.end().catch(() => null); });
