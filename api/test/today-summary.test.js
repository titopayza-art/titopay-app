"use strict";

// The dashboard "Today" card aggregate: today's SETTLED activity in South
// African time, uncapped, by direction. Guards the accuracy fix - the card
// used to sum the 100 most-recent transactions across all time under a
// "Today" label.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "today-test-access-secret-32-bytes-ok!!";
process.env.JWT_REFRESH_SECRET ||= "today-test-refresh-secret-32-bytes-!!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { todaySummaryForUser } = require("../src/services/transaction-service");

async function makeUserWallet() {
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const u = userId.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'personal','Today Test',$2,$3,$4,'x')`,
    [userId, `today_${u}`, `${u}@t.local`, `+2774${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    "INSERT INTO wallets (id, user_id, kind, currency, available_balance, status) VALUES ($1,$2,'personal','ZAR',0,'active')",
    [walletId, userId]
  );
  return { userId, walletId };
}

async function tx({ userId, walletId }, amount, total, direction, status, whenSql) {
  await pool.query(
    `INSERT INTO transactions (id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,created_at)
     VALUES ($1,$2,$3,'wallet_transfer',$4,0,$5,$6,$7,$8, ${whenSql})`,
    [crypto.randomUUID(), userId, walletId, amount, total, status, direction, `R-${crypto.randomBytes(4).toString("hex")}`]
  );
}

async function cleanup(userId) {
  await pool.query("DELETE FROM transactions WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
}

test.after(async () => { await pool.end(); });

test("today summary counts today's completed transactions by direction, uncapped", async () => {
  const acct = await makeUserWallet();
  try {
    await tx(acct, 100, 100, "credit", "completed", "NOW()");
    await tx(acct, 40, 40, "debit", "completed", "NOW()");
    // 150 more small completed credits today -> proves it is NOT capped at 100.
    for (let i = 0; i < 150; i += 1) await tx(acct, 1, 1, "credit", "completed", "NOW()");
    const s = await todaySummaryForUser(acct.userId);
    assert.equal(s.records, 152, "counts every settled transaction today, past 100");
    assert.equal(Number(s.moneyIn), 250, "100 + 150x1");
    assert.equal(Number(s.moneyOut), 40);
  } finally {
    await cleanup(acct.userId);
  }
});

test("today summary excludes failed/pending rows and other days", async () => {
  const acct = await makeUserWallet();
  try {
    await tx(acct, 100, 100, "credit", "completed", "NOW()");
    await tx(acct, 999, 999, "debit", "failed", "NOW()");            // not settled
    await tx(acct, 500, 500, "debit", "processing", "NOW()");        // not settled
    await tx(acct, 700, 700, "credit", "completed", "NOW() - INTERVAL '1 day' - INTERVAL '2 hours'"); // yesterday
    await tx(acct, 300, 300, "credit", "completed", "NOW() + INTERVAL '2 days'");                     // future
    const s = await todaySummaryForUser(acct.userId);
    assert.equal(s.records, 1, "only the one completed transaction dated today");
    assert.equal(Number(s.moneyIn), 100);
    assert.equal(Number(s.moneyOut), 0, "a failed debit must not inflate money out");
  } finally {
    await cleanup(acct.userId);
  }
});

test("today summary is per user", async () => {
  const mine = await makeUserWallet();
  const other = await makeUserWallet();
  try {
    await tx(mine, 100, 100, "credit", "completed", "NOW()");
    await tx(other, 5000, 5000, "credit", "completed", "NOW()");
    const s = await todaySummaryForUser(mine.userId);
    assert.equal(s.records, 1);
    assert.equal(Number(s.moneyIn), 100, "another user's activity never leaks in");
  } finally {
    await cleanup(mine.userId);
    await cleanup(other.userId);
  }
});
