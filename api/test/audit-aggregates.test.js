"use strict";

// Guards the "over-claiming total" audit fixes: figures that must be computed
// over the WHOLE window in SQL, never summed over a capped display list, and
// spend windows that must roll on the South African calendar, not UTC.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "audit-test-access-secret-32-bytes-ok!!";
process.env.JWT_REFRESH_SECRET ||= "audit-test-refresh-secret-32-bytes-!!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const businessSales = require("../src/services/business-sales-service");
const { statementForUser } = require("../src/services/transaction-service");
const titokids = require("../src/services/titokids-service");

async function makeUser(accountType) {
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const u = userId.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,$2,'Audit Test',$3,$4,$5,'x')`,
    [userId, accountType, `aud_${u}`, `${u}@t.local`, `+2774${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    "INSERT INTO wallets (id, user_id, kind, currency, available_balance, status) VALUES ($1,$2,$3,'ZAR',0,'active')",
    [walletId, userId, accountType === "business" ? "business" : "personal"]
  );
  return { userId, walletId };
}

async function tx(acct, { serviceCode = "wallet_transfer", amount, direction = "credit", status = "completed", whenSql = "NOW()" }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO transactions (id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,created_at)
     VALUES ($1,$2,$3,$4,$5,0,$5,$6,$7,$8, ${whenSql})`,
    [id, acct.userId, acct.walletId, serviceCode, amount, status, direction, `R-${crypto.randomBytes(4).toString("hex")}`]
  );
  return id;
}

async function creditLedger(acct, transactionId, amount, whenSql = "NOW()") {
  await pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, created_at)
     VALUES ($1,$2,$3,'credit',$4,0,$5, ${whenSql})`,
    [crypto.randomUUID(), acct.walletId, transactionId, amount, `L-${crypto.randomBytes(4).toString("hex")}`]
  );
}

async function debitLedger(acct, amount, whenSql) {
  await pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, created_at)
     VALUES ($1,$2,NULL,'debit',$3,0,$4, ${whenSql})`,
    [crypto.randomUUID(), acct.walletId, amount, `L-${crypto.randomBytes(4).toString("hex")}`]
  );
}

async function cleanup(userId) {
  await pool.query("DELETE FROM wallet_ledger wl USING wallets w WHERE wl.wallet_id = w.id AND w.user_id = $1", [userId]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
}

test.after(async () => { await pool.end(); });

test("business sales totals are computed over the full window, not the capped list", async () => {
  const acct = await makeUser("business");
  try {
    // 600 QR sales of R10 each (> the old 500-row ledger cap AND the 2000 summary cap is irrelevant here).
    for (let i = 0; i < 600; i += 1) {
      const id = await tx(acct, { serviceCode: "qr_payment", amount: 10 });
      await creditLedger(acct, id, 10);
    }
    // One non-sale credit (a top-up) that must land in otherIn, never in sales.
    const topupId = await tx(acct, { serviceCode: "wallet_top_up", amount: 5000 });
    await creditLedger(acct, topupId, 5000);

    const ledger = await businessSales.salesLedger(acct.userId, {});
    assert.equal(ledger.totals.salesCount, 600, "every sale counts, past the 500-row display cap");
    assert.equal(Number(ledger.totals.sales), 6000, "600 x R10, uncapped");
    assert.equal(Number(ledger.totals.otherIn), 5000, "the top-up is other-in, not a sale");
    assert.ok(ledger.items.length <= 500, "the display list itself stays capped");

    const summary = await businessSales.salesSummary(acct.userId, {});
    assert.equal(summary.count, 600, "summary count uncapped");
    assert.equal(Number(summary.total), 6000, "summary total uncapped");
    assert.equal(Number(summary.otherIn), 5000);
    assert.equal(Number(summary.average), 10);
    assert.ok(summary.perChannel.qr && Number(summary.perChannel.qr.total) === 6000, "QR channel carries the full total");
  } finally {
    await cleanup(acct.userId);
  }
});

test("statement totals cover the whole period even when the row list is capped semantics", async () => {
  const acct = await makeUser("personal");
  try {
    for (let i = 0; i < 150; i += 1) await tx(acct, { amount: 10, direction: "credit" });
    await tx(acct, { amount: 40, direction: "debit" });
    await tx(acct, { amount: 100, direction: "credit", whenSql: "NOW() - INTERVAL '40 days'" });

    const all = await statementForUser(acct.userId, {});
    assert.equal(all.totalCount, 152, "all rows counted, past the old 100 cap");
    assert.equal(Number(all.totals.moneyIn), 1600, "150x10 + 100");
    assert.equal(Number(all.totals.moneyOut), 40);

    // A single-day window excludes the 40-days-ago credit.
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const windowed = await statementForUser(acct.userId, { from: iso, to: iso });
    assert.equal(windowed.totalCount, 151, "only today's rows");
    assert.equal(Number(windowed.totals.moneyIn), 1500, "the older credit is outside the window");
  } finally {
    await cleanup(acct.userId);
  }
});

test("titokids spend windows roll on the SA calendar day, not UTC midnight", async () => {
  const acct = await makeUser("personal");
  try {
    // A debit at the exact start of the SA day must count toward today; one a
    // second earlier must not. A bare UTC date_trunc would put the SA-day-start
    // debit two hours into "yesterday" and drop it.
    await debitLedger(acct, 100, "(DATE_TRUNC('day', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')");
    await debitLedger(acct, 55, "(DATE_TRUNC('day', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg') - INTERVAL '1 second'");

    const spent = await titokids.spentInWindows(acct.walletId);
    assert.equal(Number(spent.day), 100, "the SA-day-start debit counts today; the one before it does not");
    // Both fall within the current SA month (unless run in the first second of a
    // month, which the -1s row would push to the previous month); assert the
    // in-day one is always in the month total.
    assert.ok(Number(spent.month) >= 100, "the day's debit is inside the SA month too");
  } finally {
    await cleanup(acct.userId);
  }
});
