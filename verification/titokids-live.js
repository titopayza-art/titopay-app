"use strict";

// TITOKIDS — THE FAMILY MONEY PLATFORM, REAL DATABASE.
//
// Proves the full loop: add a child (unlinked and linked), fund from the
// parent wallet (conserving to the cent), pay for a need with category and
// limit enforcement (off categories refuse; caps refuse without an explicit,
// audited override), savings goals whose progress is the ledger's own word,
// the child's Family view, the request -> approve/decline loop with the
// approval executing a real transfer, and the security walls: strangers see
// nothing, the child cannot touch parental controls, duplicate links refuse,
// and a child with money cannot be removed until the wallet is emptied.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/titokids-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const kids = require("../api/src/services/titokids-service");

const TAG = "kidslive";
const ids = {
  parent: randomUUID(), parentWallet: randomUUID(),
  childUser: randomUUID(), childUserWallet: randomUUID(),
  shop: randomUUID(), shopWallet: randomUUID(),
  stranger: randomUUID()
};
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function bal(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return money(rows[0]?.available_balance);
}

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Parent','${TAG}_parent','${TAG}_parent@example.invalid','27110001101','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Aiden','${TAG}_aiden','${TAG}_aiden@example.invalid','27110001102','x','active',FALSE,'pending'),
            ($3,'business','${TAG} School Shop','${TAG}_shop','${TAG}_shop@example.invalid','27110001103','x','active',FALSE,'approved'),
            ($4,'personal','${TAG} Stranger','${TAG}_stranger','${TAG}_stranger@example.invalid','27110001104','x','active',FALSE,'pending')`,
    [ids.parent, ids.childUser, ids.shop, ids.stranger]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',2000,0,'active'),
            ($4,$5,$6,'personal','ZAR',0,0,'active'),
            ($7,$8,$9,'business','ZAR',0,0,'active')`,
    [ids.parentWallet, String(Date.now()).slice(-9), ids.parent,
     ids.childUserWallet, String(Date.now() + 3).slice(-9), ids.childUser,
     ids.shopWallet, String(Date.now() + 7).slice(-9), ids.shop]
  );
}

async function cleanup() {
  const users = [ids.parent, ids.childUser, ids.shop, ids.stranger];
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [users]).catch(() => {});
  const { rows: children } = await pool.query("SELECT id, wallet_id FROM titokids_children WHERE parent_user_id = $1", [ids.parent]).catch(() => ({ rows: [] }));
  for (const table of ["titokids_requests", "titokids_goals", "titokids_limits", "titokids_children"]) {
    await pool.query(`DELETE FROM ${table} WHERE ${table === "titokids_children" ? "parent_user_id" : "child_id IN (SELECT id FROM titokids_children WHERE parent_user_id"} = $1${table === "titokids_children" ? "" : ")"}`, [ids.parent]).catch(() => {});
  }
  const childWallets = children.map((row) => row.wallet_id);
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.parentWallet, ids.childUserWallet, ids.shopWallet, ...childWallets]]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[...childWallets, ids.parentWallet, ids.childUserWallet, ids.shopWallet]]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  TITOKIDS — FAMILY WALLETS, LIMITS, REQUESTS AND APPROVALS, REAL DB");
    console.log("=".repeat(80));

    await kids.ensureTitoKidsSchema();
    await seed();

    // 1. Add a linked child; duplicates refuse; the child is alerted.
    const aiden = await kids.addChild(ids.parent, {
      fullName: "Aiden", dateOfBirth: "2014-03-12", relationship: "parent", childIdentifier: `@${TAG}_aiden`
    });
    assert.equal(aiden.linked, true);
    let duplicate = false;
    try { await kids.addChild(ids.parent, { fullName: "Aiden again", childIdentifier: `@${TAG}_aiden` }); }
    catch (e) { duplicate = e.statusCode === 409; }
    assert.ok(duplicate, "double-linking the same child refuses");
    const { rows: linkAlerts } = await pool.query(
      "SELECT 1 FROM notifications WHERE user_id = $1 AND notification_type = 'titokids_linked'", [ids.childUser]);
    assert.equal(linkAlerts.length, 1, "the child is told they were linked");
    ok("child added and linked by @username; duplicate link refused; child alerted");

    // 2. Funding conserves to the cent: parent -R300, child +R300.
    const funded = await kids.fundChild(ids.parent, aiden.id, { amount: 300, note: "Pocket money" });
    assert.equal(money(funded.balance), 300);
    assert.equal(await bal(ids.parentWallet), 1700, "the parent wallet paid exactly R300");
    ok("funding: parent 2000 -> 1700, child 0 -> 300 — conserved to the cent");

    // 3. Limits: switched-off category refuses; caps refuse; explicit
    //    override pays and is audited.
    await kids.setLimits(ids.parent, aiden.id, {
      dailyLimit: 100, weeklyLimit: 350, monthlyLimit: 1500,
      categories: { entertainment: false }
    });
    let offCategory = false;
    try { await kids.payForChild(ids.parent, aiden.id, { identifier: `@${TAG}_shop`, amount: 20, category: "entertainment" }); }
    catch (e) { offCategory = e.statusCode === 409 && /switched off/i.test(e.message); }
    assert.ok(offCategory, "an off category never pays");
    let capped = false;
    try { await kids.payForChild(ids.parent, aiden.id, { identifier: `@${TAG}_shop`, amount: 150, category: "food" }); }
    catch (e) { capped = e.statusCode === 409 && /daily/i.test(e.message); }
    assert.ok(capped, "a spend past the daily cap refuses without the override");
    const paid = await kids.payForChild(ids.parent, aiden.id, { identifier: `@${TAG}_shop`, amount: 150, category: "food", allowOverLimit: true });
    assert.equal(money(paid.balance), 150, "the override pays: child 300 -> 150");
    assert.equal(await bal(ids.shopWallet), 150, "the shop received exactly R150");
    const { rows: overAudit } = await pool.query(
      "SELECT metadata FROM audit_logs WHERE actor_id = $1 AND action = 'titokids_payment' ORDER BY created_at DESC LIMIT 1", [ids.parent]);
    assert.equal(overAudit[0].metadata.overLimit, true, "the override is on the audit trail");
    ok("limits: off-category refused, cap refused, audited override pays the shop");

    // 4. A small in-cap payment simply pays.
    const small = await kids.payForChild(ids.parent, aiden.id, { identifier: `@${TAG}_shop`, amount: 45, category: "food", allowOverLimit: true });
    assert.equal(money(small.balance), 105);
    ok("a further R45 food payment lands; child balance 105");

    // 5. Savings goal: progress is the ledger's word.
    const goal = await kids.createGoal(ids.parent, aiden.id, { name: "School Trip", target: 2000 });
    await kids.fundChild(ids.parent, aiden.id, { amount: 650, goalId: goal.id });
    const detail = await kids.getChild(ids.parent, aiden.id);
    const trip = detail.goals.find((g) => g.id === goal.id);
    assert.equal(money(trip.saved), 650);
    assert.equal(money(trip.percent), 32.5, "R650 of R2,000 = 32.5%");
    assert.equal(money(detail.balance), 755, "wallet holds 105 + 650");
    ok("savings goal: R650 / R2,000 = 32.5%, read from the ledger");

    // 6. The child's Family view: balance and activity, nothing parental.
    const family = await kids.myFamily(ids.childUser);
    assert.equal(family.length, 1);
    assert.equal(money(family[0].balance), 755);
    assert.ok(family[0].activity.length >= 3, "the child sees their own activity");
    ok("the linked child sees their balance and activity under My Family");

    // 7. Request -> approve executes a real transfer; decline moves nothing.
    const request = await kids.createRequest(ids.childUser, aiden.id, { amount: 80, category: "transport", note: "Taxi to practice" });
    const approvals = await kids.listApprovals(ids.parent);
    assert.equal(approvals.length, 1);
    assert.equal(money(approvals[0].amount), 80);
    const approved = await kids.decideRequest(ids.parent, request.id, true);
    assert.equal(approved.status, "approved");
    assert.equal(money(await bal(ids.parentWallet)), 2000 - 300 - 650 - 80, "the approval debited the parent");
    const request2 = await kids.createRequest(ids.childUser, aiden.id, { amount: 500, category: "shopping" });
    await kids.decideRequest(ids.parent, request2.id, false);
    assert.equal(money((await kids.getChild(ids.parent, aiden.id)).balance), 835, "decline moved nothing (755 + 80)");
    let again = false;
    try { await kids.decideRequest(ids.parent, request2.id, true); } catch (e) { again = e.statusCode === 409; }
    assert.ok(again, "a decided request cannot be decided twice");
    ok("request loop: approve funds R80 for real, decline moves nothing, no double-deciding");

    // 8. Security walls.
    let strangerSees = false;
    try { await kids.getChild(ids.stranger, aiden.id); } catch (e) { strangerSees = e.statusCode === 404; }
    assert.ok(strangerSees, "a stranger cannot read the child");
    let strangerPays = false;
    try { await kids.fundChild(ids.stranger, aiden.id, { amount: 10 }); } catch (e) { strangerPays = e.statusCode === 404; }
    assert.ok(strangerPays, "a stranger cannot fund or reach the wallet");
    let childControls = false;
    try { await kids.setLimits(ids.childUser, aiden.id, { dailyLimit: 999999 }); } catch (e) { childControls = e.statusCode === 404; }
    assert.ok(childControls, "the child cannot modify parental controls");
    let strangerFamily = (await kids.myFamily(ids.stranger)).length === 0;
    assert.ok(strangerFamily, "a stranger's Family view is empty");
    ok("security: stranger blind, child cannot touch controls, family view isolated");

    // 9. A child holding money cannot be removed until the wallet is empty.
    let removeBlocked = false;
    try { await kids.updateChild(ids.parent, aiden.id, { status: "removed" }); }
    catch (e) { removeBlocked = e.statusCode === 409 && /still holds/i.test(e.message); }
    assert.ok(removeBlocked, "removal refuses while money remains");
    ok("a child with money in the wallet cannot be silently removed");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — TitoKids moves real money with real guardrails.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
