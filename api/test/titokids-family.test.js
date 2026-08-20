"use strict";

// A PARENT MAY HAVE MORE THAN ONE CHILD, AND NOTHING OUTSIDE TITOKIDS MAY
// TOUCH A CHILD'S MONEY.
//
// Until 20 August 2026 a parent could add exactly one child: every child is a
// kind 'system' wallet under the parent, and idx_wallets_user_kind enforced
// UNIQUE (user_id, kind) across ALL kinds, so the second child's wallet was a
// duplicate-key 500, observed live. Fixing the index exposed two adjacent
// leaks: the wallet-number backfills numbered child wallets (created
// unnumbered BY DESIGN), and once numbered a child wallet resolved as a
// transfer recipient - money into a child's pocket around the allowance flow,
// its notifications and its limits.
//
// These are the first tests this service has ever had. They run against the
// real database through the real service functions.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "titokids-test-access-secret-with-length!";
process.env.JWT_REFRESH_SECRET ||= "titokids-test-refresh-secret-with-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const kids = require("../src/services/titokids-service");
const { listWalletsForUser, getPrimaryWalletForUser } = require("../src/services/wallet-service");
const { ensureWalletNumbersForAllWallets } = require("../src/lib/wallet-id");
const { createTransaction } = require("../src/services/transaction-service");

const API = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(API, ...p), "utf8");

const stamp = Date.now().toString(36);
const uid = () => crypto.randomUUID();

const parentId = uid();
const friendId = uid();
const createdUserIds = [parentId, friendId];

async function makeUser(id, username, fullName) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash)
     VALUES ($1, 'personal', $2, $3, '$2a$10$titokidstestnotarealhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')`,
    [id, fullName, username]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1, $2, $3, 'personal', 'ZAR', 0, 0, 'active')`,
    [uid(), String(1000000000 + Math.floor(Math.random() * 899999999)), id]
  );
}

test.before(async () => {
  await makeUser(parentId, `tk_parent_${stamp}`, "TitoKids Test Parent");
  await makeUser(friendId, `tk_friend_${stamp}`, "TitoKids Test Friend");
  await pool.query("UPDATE wallets SET available_balance = 500 WHERE user_id = $1 AND kind = 'personal'", [parentId]);
});

test.after(async () => {
  // Children first: titokids_children.wallet_id RESTRICTs wallet deletion, so
  // the rows must be gone before the user-cascade reaches the wallets.
  await pool.query("DELETE FROM titokids_children WHERE parent_user_id = $1", [parentId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
  await pool.end();
});

let childA;
let childB;

/* ------------------------------------------------- more than one child */

test("a parent can add a second and third child, each with their own wallet", async () => {
  childA = await kids.addChild(parentId, { fullName: "First Child", dateOfBirth: "2014-03-01" });
  // THE BUG: this call was a duplicate-key 500, every time, for every parent.
  childB = await kids.addChild(parentId, { fullName: "Second Child", dateOfBirth: "2016-07-15" });
  const childC = await kids.addChild(parentId, { fullName: "Third Child" });
  assert.ok(childA.id && childB.id && childC.id);

  const { rows } = await pool.query(
    "SELECT wallet_id FROM titokids_children WHERE parent_user_id = $1 AND status = 'active'", [parentId]);
  assert.equal(rows.length, 3, "three children, three rows");
  assert.equal(new Set(rows.map((r) => r.wallet_id)).size, 3, "three DISTINCT wallets");
});

test("child wallets are unnumbered, which is what keeps them unreachable", async () => {
  const { rows } = await pool.query(
    "SELECT wallet_number FROM wallets WHERE user_id = $1 AND kind = 'system'", [parentId]);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.wallet_number, null);
});

test("uniqueness still stands for every non-system wallet kind", async () => {
  // The index went PARTIAL, not away. A second personal wallet for the same
  // user must still be impossible, or every balance lookup in the codebase
  // that assumes one is undermined.
  await assert.rejects(
    pool.query(
      `INSERT INTO wallets (id, user_id, kind, currency, available_balance, reserved_balance, status)
       VALUES ($1, $2, 'personal', 'ZAR', 0, 0, 'active')`,
      [uid(), parentId]
    ),
    (error) => error.code === "23505",
    "a duplicate personal wallet must still be a unique violation"
  );
});

/* ----------------------------------------------------- money movement */

test("funding two children debits the parent once each and double-writes the ledger", async () => {
  const before = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);

  const fundA = await kids.fundChild(parentId, childA.id, { amount: 40, note: "lunch money" });
  const fundB = await kids.fundChild(parentId, childB.id, { amount: 25 });
  assert.equal(fundA.balance, 40);
  assert.equal(fundB.balance, 25);

  const after = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);
  assert.equal(before - after, 65, "the parent paid exactly what the children received");

  const { rows: ledger } = await pool.query(
    `SELECT entry_type, COUNT(*) c FROM wallet_ledger
      WHERE metadata->>'titokids' = 'true' AND reference LIKE 'TKID-%'
        AND wallet_id IN (SELECT wallet_id FROM titokids_children WHERE parent_user_id = $1)
      GROUP BY entry_type`, [parentId]);
  const credits = Number(ledger.find((r) => r.entry_type === "credit")?.c || 0);
  assert.ok(credits >= 2, "each funding wrote a credit leg on the child wallet");
});

test("funding beyond the parent's balance is refused with nothing moved", async () => {
  const before = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);
  await assert.rejects(
    kids.fundChild(parentId, childA.id, { amount: 5000 }),
    /Not enough in your wallet/
  );
  const after = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);
  assert.equal(before, after, "a refused funding must not move a cent");
});

test("a child's spend reaches the recipient, and a daily limit stops the next one", async () => {
  const paid = await kids.payForChild(parentId, childA.id, {
    amount: 15, recipient: `tk_friend_${stamp}`, category: "food", note: "tuck shop"
  });
  assert.equal(paid.balance, 25, "40 funded minus 15 spent");
  const friendBalance = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [friendId])).rows[0].available_balance);
  assert.equal(friendBalance, 15, "the recipient actually received it");

  await kids.setLimits(parentId, childA.id, { dailyLimit: 20 });
  await assert.rejects(
    kids.payForChild(parentId, childA.id, { amount: 10, recipient: `tk_friend_${stamp}` }),
    /past the daily R20\.00 limit/,
    "15 already spent today; 10 more crosses the R20 cap"
  );
  // The parent is the authority: an explicit override pays, and is recorded.
  const overridden = await kids.payForChild(parentId, childA.id, {
    amount: 10, recipient: `tk_friend_${stamp}`, allowOverLimit: true
  });
  assert.equal(overridden.balance, 15);
});

test("a switched-off category never pays, even under the limit", async () => {
  await kids.setLimits(parentId, childA.id, { categories: { entertainment: false } });
  await assert.rejects(
    kids.payForChild(parentId, childA.id, { amount: 1, recipient: `tk_friend_${stamp}`, category: "entertainment", allowOverLimit: true }),
    /switched off for this child/
  );
});

/* --------------------------------------- the child wallets stay invisible */

test("the parent's wallet list and primary wallet never include a child wallet", async () => {
  const list = await listWalletsForUser(parentId);
  assert.ok(list.length >= 1);
  assert.ok(list.every((w) => w.kind !== "system"),
    "a parent with three children must not see three mystery wallets");
  const primary = await getPrimaryWalletForUser(parentId);
  assert.equal(primary.kind, "personal");
});

test("the number backfill skips child wallets", async () => {
  await ensureWalletNumbersForAllWallets(pool);
  const { rows } = await pool.query(
    "SELECT wallet_number FROM wallets WHERE user_id = $1 AND kind = 'system'", [parentId]);
  for (const row of rows) assert.equal(row.wallet_number, null,
    "the backfill numbered child wallets before it learned to skip them; it must never again");
});

test("even a legacy-numbered child wallet cannot receive a transfer", async () => {
  // Production child wallets WERE numbered by the old backfills. Simulate that
  // state and prove the recipient resolver still refuses to land money there.
  const legacyNumber = String(2000000000 + Math.floor(Math.random() * 899999999));
  await pool.query(
    `UPDATE wallets SET wallet_number = $2 WHERE id =
       (SELECT wallet_id FROM titokids_children WHERE id = $1)`, [childA.id, legacyNumber]);

  const actor = { userId: parentId, userType: "customer", accountType: "personal", profileLocked: false, ipAddress: "127.0.0.1", userAgent: "titokids-test" };
  await assert.rejects(
    createTransaction(actor, { serviceCode: "send_money", amount: 5, recipient: legacyNumber, reference: "into the child wallet" }),
    /not yet registered|could not find the wallet/,
    "a child wallet must never resolve as a destination; the refusal lands at the earliest gate, where the number matches no registered recipient at all"
  );
  // Control: the same sender, the same service, a real recipient - works. So
  // the refusal above is about the child wallet, not a broken send path.
  const control = await createTransaction(actor, { serviceCode: "send_money", amount: 5, recipient: `tk_friend_${stamp}`, reference: "control send" });
  assert.ok(control.transaction?.transactionId || control.transactionId);

  await pool.query(
    `UPDATE wallets SET wallet_number = NULL WHERE id =
       (SELECT wallet_id FROM titokids_children WHERE id = $1)`, [childA.id]);
});

/* ------------------------------------------- the migration and its copies */

test("the sibling-wallets migration strips legacy numbers and is idempotent", async () => {
  const sql = read("src", "db", "migrations", "20260820_titokids_sibling_wallets.up.sql");
  // Give one child wallet a legacy number, then run the migration TWICE.
  await pool.query(
    `UPDATE wallets SET wallet_number = '3999999999' WHERE id =
       (SELECT wallet_id FROM titokids_children WHERE id = $1)`, [childB.id]);
  await pool.query(sql);
  await pool.query(sql);
  const { rows } = await pool.query(
    "SELECT wallet_number FROM wallets WHERE user_id = $1 AND kind = 'system'", [parentId]);
  for (const row of rows) assert.equal(row.wallet_number, null);

  const { rows: idx } = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_wallets_user_kind_ex_system'");
  assert.match(idx[0].indexdef, /WHERE \(kind <> 'system'::text\)/, "the rebuilt index is partial");
  const { rows: old } = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_wallets_user_kind'");
  assert.equal(old.length, 0, "the legacy full index is gone");
});

test("the platform system wallet keeps its number through all of this", async () => {
  const { rows } = await pool.query(
    "SELECT wallet_number FROM wallets WHERE kind = 'system' AND user_id IS NULL");
  for (const row of rows) {
    assert.ok(row.wallet_number, "the platform wallet is numbered on purpose and must stay so");
  }
});

test("the three-copy rule holds: migration, schema.sql and the ensure function agree", () => {
  const migration = read("src", "db", "migrations", "20260820_titokids_sibling_wallets.up.sql");
  const schema = read("src", "db", "schema.sql");
  const ensure = read("src", "services", "titokids-service.js");
  for (const [name, source] of [["migration", migration], ["schema.sql", schema], ["ensure", ensure]]) {
    assert.match(source, /DROP INDEX IF EXISTS idx_wallets_user_kind/, `${name} drops the legacy index`);
    assert.match(source, /idx_wallets_user_kind_ex_system[\s\S]{0,120}WHERE kind <> 'system'/,
      `${name} creates the partial replacement`);
  }
  // And both backfills skip child wallets.
  assert.match(read("src", "lib", "wallet-id.js"), /AND NOT \(kind = 'system' AND user_id IS NOT NULL\)/);
  assert.match(schema, /AND NOT \(kind = 'system' AND user_id IS NOT NULL\)/);
});

test("the merchant wallet upsert names the partial index's predicate", () => {
  // ON CONFLICT (user_id, kind) matched the OLD full index. Against the
  // partial one it is an error, so merchant creation would break the moment
  // the index changed - unless the conflict target carries the predicate.
  assert.match(read("src", "services", "merchant-service.js"),
    /ON CONFLICT \(user_id, kind\) WHERE kind <> 'system' DO NOTHING/);
});
