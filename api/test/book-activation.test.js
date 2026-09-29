"use strict";

// THE ONLY PLACE BOOK MOVES MONEY.
//
// The thing being proven is not "it charges R250". It is that it charges R250
// EXACTLY ONCE, that the two legs balance, that a refusal leaves the wallet
// untouched, and that the row it writes is visible to the money-integrity
// checks. A booking product that double-charges its own customers on a slow
// connection is worse than one that does not exist.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const activation = require("../src/services/book-activation-service");
const { ensureBookSchema } = require("../src/services/book-schema");
const reference = require("../src/config/book-reference");

const TAG = "bookact";

async function ensureRevenueWallet() {
  const { rows } = await pool.query("SELECT * FROM wallets WHERE kind='revenue' AND user_id IS NULL LIMIT 1");
  if (rows[0]) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1, NULL, 'revenue', 0, 0, 'ZAR') RETURNING *`, [randomUUID()]);
  return created[0];
}

async function seedBusiness({ balance = 1000, accountType = "business", locked = false } = {}) {
  await ensureBookSchema();
  const userId = randomUUID();
  const walletId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',$7)`,
    [userId, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`,
     `${TAG}_${suffix}@example.invalid`, `2782${Math.floor(1000000 + Math.random() * 8999999)}`, locked]
  );
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1,$2,$3,$4,0,'ZAR')`,
    [walletId, userId, accountType === "business" ? "business" : "personal", balance]
  );
  return {
    userId, walletId,
    actor: { userId, accountType, profileLocked: locked }
  };
}

async function cleanup(seed) {
  if (!seed) return;
  await pool.query("DELETE FROM book_activations WHERE business_user_id=$1", [seed.userId]).catch(() => {});
  await pool.query(
    "DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)",
    [seed.userId]).catch(() => {});
  await pool.query(
    "DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)",
    [seed.userId]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id=$1", [seed.userId]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [seed.userId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id=$1", [seed.userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [seed.userId]).catch(() => {});
}

const balanceOf = async (walletId) =>
  Number((await pool.query("SELECT available_balance FROM wallets WHERE id=$1", [walletId])).rows[0].available_balance);

test.before(async () => { await ensureBookSchema(); await ensureRevenueWallet(); });
test.after(async () => { await pool.end(); });

/* --------------------------------------------------------------- the price */

test("the price comes from pricing_rules, not from a constant in the code", async () => {
  const price = await activation.activationPrice();
  assert.equal(price, reference.ACTIVATION_DEFAULT_AMOUNT,
    "the seeded rule should match the documented default");

  // Prove it is genuinely READ rather than returned from the constant: change
  // the rule and the quoted price must follow it.
  await pool.query("UPDATE pricing_rules SET flat_fee=299, fee_value=299 WHERE service_code=$1",
    [activation.SERVICE_CODE]);
  try {
    assert.equal(await activation.activationPrice(), 299,
      "an operator changing the Pricing Engine must change what Book charges");
  } finally {
    await pool.query("UPDATE pricing_rules SET flat_fee=$2, fee_value=$2 WHERE service_code=$1",
      [activation.SERVICE_CODE, reference.ACTIVATION_DEFAULT_AMOUNT]);
  }
});

test("changing the price in the Pricing Engine changes what is actually CHARGED", async () => {
  // The test above only proves the quote function reads the rule. This proves
  // the CHARGE does, which is the thing that matters: a hardcoded price inside
  // activate() would pass every other test in this file while quietly billing a
  // figure no operator can see or change.
  const seed = await seedBusiness({ balance: 1000 });
  try {
    await pool.query("UPDATE pricing_rules SET flat_fee=180, fee_value=180 WHERE service_code=$1",
      [activation.SERVICE_CODE]);
    const result = await activation.activate(seed.actor, {});
    assert.equal(result.activation.amount, 180, "the activation records what was charged");
    assert.equal(await balanceOf(seed.walletId), 820, "the WALLET was debited the operator's price");
    const { rows } = await pool.query("SELECT fee FROM transactions WHERE user_id=$1", [seed.userId]);
    assert.equal(Number(rows[0].fee), 180, "and so was the transaction");
  } finally {
    await pool.query("UPDATE pricing_rules SET flat_fee=$2, fee_value=$2 WHERE service_code=$1",
      [activation.SERVICE_CODE, reference.ACTIVATION_DEFAULT_AMOUNT]);
    await cleanup(seed);
  }
});

/* -------------------------------------------------------------- the charge */

test("activating debits the business once and balances against the revenue wallet", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    const revenue = await ensureRevenueWallet();
    const revenueBefore = await balanceOf(revenue.id);

    const result = await activation.activate(seed.actor, {});
    assert.equal(result.alreadyActive, false);
    assert.equal(result.activation.active, true);
    assert.equal(result.activation.amount, 250);

    assert.equal(await balanceOf(seed.walletId), 750, "the business paid exactly R250");
    assert.equal(await balanceOf(revenue.id), revenueBefore + 250, "TitoPay received exactly R250");

    // The transaction must be visible to money-integrity, which only inspects
    // status='completed'. 'success' would make it invisible to reconciliation.
    const { rows: tx } = await pool.query(
      "SELECT status, amount, fee, total, service_code FROM transactions WHERE user_id=$1", [seed.userId]);
    assert.equal(tx.length, 1, "exactly one transaction row");
    assert.equal(tx[0].status, "completed", "status must be 'completed', never 'success'");
    assert.equal(tx[0].service_code, activation.SERVICE_CODE);
    assert.equal(Number(tx[0].fee), 250, "the whole charge is booked as fee: it is a platform charge");

    // revenue_ledger.fee_collected must equal transactions.fee or every
    // activation is flagged by the integrity checker.
    const { rows: rev } = await pool.query(
      "SELECT fee_collected FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)",
      [seed.userId]);
    assert.equal(Number(rev[0].fee_collected), Number(tx[0].fee));

    // The two legs must net to zero for this transaction, or money-integrity
    // raises a CRITICAL unbalanced_entries alert.
    const { rows: legs } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN entry_type IN ('credit','release') THEN amount
                                WHEN entry_type IN ('debit','reserve') THEN -amount END),0) AS net
       FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)`,
      [seed.userId]);
    assert.ok(Math.abs(Number(legs[0].net)) < 0.01, `the legs must net to zero, got ${legs[0].net}`);
  } finally { await cleanup(seed); }
});

/* ------------------------------------------------- the double charge */

test("two simultaneous activations charge exactly once", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    // Genuinely concurrent, not sequential. This is the two-taps-on-a-slow-
    // connection case and it is the reason the advisory lock and the unique
    // index both exist.
    const [a, b] = await Promise.allSettled([
      activation.activate(seed.actor, {}),
      activation.activate(seed.actor, {})
    ]);

    const succeeded = [a, b].filter((r) => r.status === "fulfilled");
    assert.equal(succeeded.length, 2, "neither attempt should show the business an error");

    const paid = succeeded.filter((r) => r.value.alreadyActive === false).length;
    assert.equal(paid, 1, "exactly one attempt should have taken money");

    assert.equal(await balanceOf(seed.walletId), 750, "the business was charged once, not twice");

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM book_activations WHERE business_user_id=$1", [seed.userId]);
    assert.equal(rows[0].n, 1, "exactly one activation row");

    const { rows: tx } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM transactions WHERE user_id=$1", [seed.userId]);
    assert.equal(tx[0].n, 1, "exactly one transaction");
  } finally { await cleanup(seed); }
});

test("activating again later is free and returns what they already have", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    await activation.activate(seed.actor, {});
    const balanceAfterFirst = await balanceOf(seed.walletId);

    const second = await activation.activate(seed.actor, {});
    assert.equal(second.alreadyActive, true);
    assert.equal(second.activation.active, true);
    assert.equal(await balanceOf(seed.walletId), balanceAfterFirst, "nothing further was taken");
  } finally { await cleanup(seed); }
});

/* ------------------------------------------------------------- refusals */

test("not enough in the wallet refuses cleanly and takes nothing", async () => {
  const seed = await seedBusiness({ balance: 100 });
  try {
    await assert.rejects(
      async () => activation.activate(seed.actor, {}),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /R250\.00.*R100\.00/, "say what it costs and what they have");
        return true;
      }
    );
    assert.equal(await balanceOf(seed.walletId), 100, "the wallet is untouched");
    const { rows } = await pool.query("SELECT COUNT(*)::int n FROM transactions WHERE user_id=$1", [seed.userId]);
    assert.equal(rows[0].n, 0, "a refused payment writes no transaction");
    const { rows: act } = await pool.query(
      "SELECT COUNT(*)::int n FROM book_activations WHERE business_user_id=$1", [seed.userId]);
    assert.equal(act[0].n, 0, "and no activation");
  } finally { await cleanup(seed); }
});

test("a personal account cannot activate a business product", async () => {
  const seed = await seedBusiness({ balance: 1000, accountType: "personal" });
  try {
    await assert.rejects(
      async () => activation.activate(seed.actor, {}),
      (error) => { assert.equal(error.statusCode, 403); return true; }
    );
    assert.equal(await balanceOf(seed.walletId), 1000);
  } finally { await cleanup(seed); }
});

test("a locked profile cannot spend, and gets 423 like every other money path", async () => {
  const seed = await seedBusiness({ balance: 1000, locked: true });
  try {
    await assert.rejects(
      async () => activation.activate(seed.actor, {}),
      (error) => { assert.equal(error.statusCode, 423); return true; }
    );
    assert.equal(await balanceOf(seed.walletId), 1000);
  } finally { await cleanup(seed); }
});

/* ------------------------------------------------------------- the gate */

test("assertActivated is what every Book write goes through", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    await assert.rejects(
      async () => activation.assertActivated(seed.userId),
      (error) => {
        assert.equal(error.statusCode, 402, "402 Payment Required is the honest status");
        assert.equal(error.details?.code || error.code, "BOOK_NOT_ACTIVATED");
        return true;
      }
    );
    await activation.activate(seed.actor, {});
    const row = await activation.assertActivated(seed.userId);
    assert.ok(row, "after paying, the gate opens");
  } finally { await cleanup(seed); }
});

test("the activation is audited after the money moved, not instead of it", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    await activation.activate(seed.actor, {});
    const { rows } = await pool.query(
      "SELECT action, metadata FROM audit_logs WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 1",
      [seed.userId]);
    assert.equal(rows[0].action, "book_business_activated");
    assert.equal(Number(rows[0].metadata.amount), 250);
  } finally { await cleanup(seed); }
});

test("Book writes no ledger of its own: the money lives in TitoPay's tables", async () => {
  const seed = await seedBusiness({ balance: 1000 });
  try {
    await activation.activate(seed.actor, {});
    // The activation row points AT the transaction rather than restating it.
    const { rows } = await pool.query(
      "SELECT transaction_id, amount FROM book_activations WHERE business_user_id=$1", [seed.userId]);
    assert.ok(rows[0].transaction_id, "the activation references the real payment");
    const { rows: tx } = await pool.query("SELECT id FROM transactions WHERE id=$1", [rows[0].transaction_id]);
    assert.equal(tx.length, 1, "and that payment exists in transactions");
  } finally { await cleanup(seed); }
});
