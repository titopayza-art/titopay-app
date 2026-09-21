"use strict";

// Functional guards for the production-readiness sweep fixes:
//  - reverseTransaction refuses externally-settled service codes (money-loss bug)
//  - statement totals count only settled (completed) money

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "readiness-test-access-secret-32-bytes!!";
process.env.JWT_REFRESH_SECRET ||= "readiness-test-refresh-secret-32-byte!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { reverseTransaction, statementForUser } = require("../src/services/transaction-service");

async function makeUserWallet() {
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const u = userId.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'personal','Readiness Test',$2,$3,$4,'x')`,
    [userId, `rdy_${u}`, `${u}@t.local`, `+2774${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    "INSERT INTO wallets (id, user_id, kind, currency, available_balance, status) VALUES ($1,$2,'personal','ZAR',100000,'active')",
    [walletId, userId]
  );
  return { userId, walletId };
}

async function tx(acct, { serviceCode, amount, direction = "debit", status = "completed", whenSql = "NOW()" }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO transactions (id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,created_at)
     VALUES ($1,$2,$3,$4,$5,0,$5,$6,$7,$8, ${whenSql})`,
    [id, acct.userId, acct.walletId, serviceCode, amount, status, direction, `R-${crypto.randomBytes(4).toString("hex")}`]
  );
  return id;
}

async function ledger(acct, transactionId, entryType, amount) {
  await pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference)
     VALUES ($1,$2,$3,$4,$5,0,$6)`,
    [crypto.randomUUID(), acct.walletId, transactionId, entryType, amount, `L-${crypto.randomBytes(4).toString("hex")}`]
  );
}

async function cleanup(userId) {
  await pool.query("DELETE FROM wallet_ledger wl USING wallets w WHERE wl.wallet_id = w.id AND w.user_id = $1", [userId]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
}

test.after(async () => { await pool.end(); });

test("reverseTransaction refuses a completed bank withdrawal (would double-pay)", async () => {
  const acct = await makeUserWallet();
  try {
    const id = await tx(acct, { serviceCode: "withdraw", amount: 5000, direction: "debit", status: "completed" });
    await ledger(acct, id, "debit", 5000); // customer debited; money already went to their bank
    await assert.rejects(
      () => reverseTransaction(id, { userId: crypto.randomUUID(), userType: "admin" }),
      (err) => {
        assert.equal(err.statusCode, 409, "a withdrawal reversal is refused, not silently double-paid");
        return true;
      }
    );
    // The transaction must be untouched (still completed, not reversed).
    const { rows } = await pool.query("SELECT status FROM transactions WHERE id=$1", [id]);
    assert.equal(rows[0].status, "completed");
  } finally {
    await cleanup(acct.userId);
  }
});

test("reverseTransaction still reverses a wallet-internal transfer", async () => {
  const acct = await makeUserWallet();
  try {
    const id = await tx(acct, { serviceCode: "wallet_transfer", amount: 200, direction: "debit", status: "completed" });
    await ledger(acct, id, "debit", 200);
    const result = await reverseTransaction(id, { userId: crypto.randomUUID(), userType: "admin" });
    assert.ok(result, "an internal transfer can still be reversed");
    const { rows } = await pool.query("SELECT status FROM transactions WHERE id=$1", [id]);
    assert.equal(rows[0].status, "reversed");
  } finally {
    await cleanup(acct.userId);
  }
});

test("statement money-in/out totals count only completed transactions", async () => {
  const acct = await makeUserWallet();
  try {
    await tx(acct, { serviceCode: "wallet_transfer", amount: 100, direction: "credit", status: "completed" });
    await tx(acct, { serviceCode: "wallet_transfer", amount: 999, direction: "debit", status: "failed" });
    await tx(acct, { serviceCode: "withdraw", amount: 500, direction: "debit", status: "reversed" });
    const s = await statementForUser(acct.userId, {});
    assert.equal(s.totalCount, 3, "every row is still listed, whatever its status");
    assert.equal(Number(s.totals.moneyIn), 100, "only the completed credit counts as money in");
    assert.equal(Number(s.totals.moneyOut), 0, "a failed and a reversed debit never inflate money out");
  } finally {
    await cleanup(acct.userId);
  }
});
