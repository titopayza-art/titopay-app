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

/* ------------------------------- the platform's limits reach into TitoKids */

// A CHILD WALLET WAS A WAY AROUND A CUSTOMER'S OWN SENDING LIMITS.
//
// Every other rail asks the limit engine before money leaves the account
// holder's control - transfers, withdrawals, VAS, payment requests, admin
// adjustments. TitoKids asked it zero times. So: fund a child (no ceiling but
// your own balance, because nothing has left the household yet), then pay
// anybody at all out of the child wallet, with only TitoKids' own caps in the
// way - and those default to none and take an allowOverLimit override.
//
// payForChild now charges the parent's send capacity and checks the
// recipient's receive capacity, exactly as an ordinary transfer does.
test("the platform's own send limit now stops a payment out of a child wallet", async () => {
  await pool.query("UPDATE wallets SET available_balance = 8000 WHERE user_id = $1 AND kind = 'personal'", [parentId]);
  const child = await kids.addChild(parentId, { fullName: "Limit Probe Child" });
  // Enough to cover the R2 600 attempt, and no more: funding is a debit on the
  // parent too, so an oversized float here would eat the daily capacity the
  // control payment below needs and the test would pass for the wrong reason.
  await kids.fundChild(parentId, child.id, { amount: 2700 });

  const childBefore = await kids.getChild(parentId, child.id);
  const friendBefore = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [friendId])).rows[0].available_balance);

  // R2 600 is over the R2 500 single-payment ceiling an unverified account
  // carries, and TitoKids' own limits are wide open on this child - so before
  // the fix this went through and the money reached the friend's wallet.
  const rejected = await kids.payForChild(parentId, child.id, {
    amount: 2600, recipient: `tk_friend_${stamp}`, category: "other"
  }).then(() => null, (error) => error);
  assert.ok(rejected, "an unverified parent must not push R2 600 out of a child wallet");
  assert.equal(rejected.statusCode || rejected.status, 403);
  assert.match(String(rejected.message), /one payment|capacity/i);

  const childAfter = await kids.getChild(parentId, child.id);
  const friendAfter = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [friendId])).rows[0].available_balance);
  assert.equal(childAfter.balance, childBefore.balance, "a refused payment must not move a cent");
  assert.equal(friendAfter, friendBefore, "and must not reach the recipient");

  // Control: under the ceiling, the same call still pays. The guard is about
  // the amount, not about TitoKids payments in general.
  const paid = await kids.payForChild(parentId, child.id, {
    amount: 100, recipient: `tk_friend_${stamp}`, category: "other"
  });
  assert.equal(paid.amount, 100);
  await pool.query("DELETE FROM titokids_children WHERE id = $1", [child.id]);
});

test("the service actually calls the limit engine - not just a comment about it", () => {
  // The audit finding was countable: zero calls in the whole file. This keeps
  // it countable, so a refactor that drops the guard fails here rather than in
  // production.
  const source = read("src", "services", "titokids-service.js");
  assert.match(source, /assertCanSendAmount\(/, "the parent's send capacity is charged");
  assert.match(source, /assertCanReceiveAmount\(/, "the recipient's receive capacity is checked");
});

/* ------------------------------------------------- money can come back out */

// UNTIL NOW IT COULD NOT.
//
// Money went into a child wallet and the only way out was to pay a third
// party. updateChild refuses to remove a child while the balance is non-zero
// and told the parent to "move it back" - naming an action the app did not
// have. The undocumented escape was to notice that payForChild takes any
// TitoPay account and pay yourself, which records your own money as a payment
// out and is not something a customer would ever find.
let returnChild;

test("a parent can move money back out of a child wallet, to the cent", async () => {
  await pool.query("UPDATE wallets SET available_balance = 8000 WHERE user_id = $1 AND kind = 'personal'", [parentId]);
  returnChild = await kids.addChild(parentId, { fullName: "Return Probe Child" });
  await kids.fundChild(parentId, returnChild.id, { amount: 120.55 });

  const parentBefore = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);

  const moved = await kids.returnFromChild(parentId, returnChild.id, { amount: 20.55, note: "too much" });
  assert.equal(moved.amount, 20.55);
  assert.equal(moved.balance, 100, "the child keeps the rest");

  const parentAfter = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [parentId])).rows[0].available_balance);
  assert.equal(Math.round((parentAfter - parentBefore) * 100) / 100, 20.55,
    "the parent received exactly what the child lost");

  // Both legs, one reference - the same shape funding writes, so the two
  // halves reconcile against each other.
  const { rows: legs } = await pool.query(
    `SELECT entry_type, amount, wallet_id FROM wallet_ledger
      WHERE reference = $1 ORDER BY entry_type`, [moved.reference]);
  assert.equal(legs.length, 2, "a debit on the child and a credit on the parent");
  assert.equal(legs[0].entry_type, "credit");
  assert.equal(legs[1].entry_type, "debit");
  assert.equal(Number(legs[0].amount), Number(legs[1].amount));

  // And it reads as a credit on the parent's statement, because that is what
  // it is: their own money coming home, not a payment they received.
  const { rows: tx } = await pool.query(
    "SELECT user_id, direction, amount FROM transactions WHERE reference = $1", [moved.reference]);
  assert.equal(tx.length, 1);
  assert.equal(tx[0].user_id, parentId);
  assert.equal(tx[0].direction, "credit");
});

test("a return cannot take more than the wallet holds", async () => {
  const before = (await kids.getChild(parentId, returnChild.id)).balance;
  await assert.rejects(
    kids.returnFromChild(parentId, returnChild.id, { amount: before + 1 }),
    /holds R100\.00/
  );
  assert.equal((await kids.getChild(parentId, returnChild.id)).balance, before, "nothing moved");
});

test("an empty request means all of it, which is what makes a child removable", async () => {
  // The real reason this matters. Asking a parent to retype the balance to the
  // cent is how an off-by-one-cent leftover leaves a child that cannot be
  // removed - and before this function existed, EVERY balance did.
  const emptied = await kids.returnFromChild(parentId, returnChild.id, {});
  assert.equal(emptied.amount, 100);
  assert.equal(emptied.balance, 0);

  const removed = await kids.updateChild(parentId, returnChild.id, { status: "removed" });
  assert.equal(removed.status, "removed", "the wallet is empty, so the child can go");
});

test("nothing left to move back is refused, not silently accepted as zero", async () => {
  const child = await kids.addChild(parentId, { fullName: "Empty Probe Child" });
  await assert.rejects(kids.returnFromChild(parentId, child.id, {}), /nothing in this wallet/);
  await pool.query("DELETE FROM titokids_children WHERE id = $1", [child.id]);
});

test("a co-parent may fund and pay, but may not pull the money into their own wallet", async () => {
  // A co-parent's reach is deliberately wide: funding spends their OWN money
  // and paying leaves it with a merchant. Moving the balance into a personal
  // wallet is the one thing that ends the arrangement's money, and it belongs
  // to the person whose wallet it came from - the same rule removal follows.
  const coParentId = uid();
  createdUserIds.push(coParentId);
  await makeUser(coParentId, `tk_coparent_${stamp}`, "TitoKids Co-Parent");
  await pool.query("UPDATE wallets SET available_balance = 300 WHERE user_id = $1", [coParentId]);

  const child = await kids.addChild(parentId, { fullName: "Shared Child" });
  const invited = await kids.inviteGuardian(parentId, child.id, { contact: `tk_coparent_${stamp}` });
  await kids.respondToGuardianInvite(coParentId, invited.guardian.id, true);

  // The co-parent really does have day-to-day reach.
  const funded = await kids.fundChild(coParentId, child.id, { amount: 50 });
  assert.equal(funded.balance, 50);

  await assert.rejects(
    kids.returnFromChild(coParentId, child.id, {}),
    /Only the parent who set up this TitoKids wallet/
  );
  assert.equal((await kids.getChild(parentId, child.id)).balance, 50, "the refusal moved nothing");

  // The owner can, and the money lands in the OWNER's wallet - which is also
  // the honest answer to "whose R50 was that": the co-parent gave it to the
  // child, and the child's wallet belongs to the owner.
  const moved = await kids.returnFromChild(parentId, child.id, {});
  assert.equal(moved.amount, 50);
  await pool.query("DELETE FROM titokids_children WHERE id = $1", [child.id]);
});

test("a stranger cannot move money out of somebody else's child wallet", async () => {
  const child = await kids.addChild(parentId, { fullName: "Stranger Probe Child" });
  await kids.fundChild(parentId, child.id, { amount: 10 });
  await assert.rejects(kids.returnFromChild(friendId, child.id, {}), /Child not found/);
  assert.equal((await kids.getChild(parentId, child.id)).balance, 10);
  await kids.returnFromChild(parentId, child.id, {});
  await pool.query("DELETE FROM titokids_children WHERE id = $1", [child.id]);
});

test("the route the app calls is wired to the function that exists", () => {
  // The removal message told parents to move the money back. It named an
  // action with no function, no route and no button behind it. All three now
  // exist, and this fails if any one of them is dropped.
  assert.match(read("src", "routes", "titokids.routes.js"), /children\/:id\/return[\s\S]{0,200}returnFromChild/);
  assert.match(read("src", "services", "titokids-service.js"), /module\.exports[\s\S]*returnFromChild/);
  assert.match(read("..", "pwa", "app.js"), /titokids-return:/);
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

test("every wallet-number credit path refuses child wallets, not just the main resolver", () => {
  // Found by reviewing what else credits a wallet looked up by number:
  // enterprise distribution's batch release. A child wallet number there now
  // behaves exactly like an unknown number - the item fails cleanly and the
  // money releases back to the business wallet - instead of landing in a
  // child's pocket around the TitoKids flow.
  const dist = read("src", "services", "enterprise-distribution-service.js");
  const guarded = (dist.match(/AND (?:w\.)?kind <> 'system'/g) || []).length;
  assert.ok(guarded >= 2,
    `both the batch validation lookup and the release credit query must carry the filter (found ${guarded})`);
});

test("the merchant wallet upsert names the partial index's predicate", () => {
  // ON CONFLICT (user_id, kind) matched the OLD full index. Against the
  // partial one it is an error, so merchant creation would break the moment
  // the index changed - unless the conflict target carries the predicate.
  assert.match(read("src", "services", "merchant-service.js"),
    /ON CONFLICT \(user_id, kind\) WHERE kind <> 'system' DO NOTHING/);
});
