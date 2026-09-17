"use strict";

// STOKVEL — GROUPS, CHAT AND MINUTES, REAL DATABASE.
//
// Proves the group layer end to end: a draft is saved and later activated;
// members join with the invite code (drafts refuse joiners); the balance is
// read from the SAME transactions the wallet recorded — never a parallel
// tally; withdrawals cannot exceed the balance and cannot be self-approved;
// the group chat is members-only; organisers pin decisions; and closing a
// meeting compiles minutes carrying attendance, decisions, contributions and
// the balance — then emails them to every member.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/stockvel-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const svc = require("../api/src/services/stockvel-service");
const { ensureEmailSchema } = require("../api/src/services/email-centre-service");

const TAG = "svlive";
const ids = { chair: randomUUID(), member: randomUUID(), stranger: randomUUID(), chairWallet: randomUUID(), memberWallet: randomUUID() };
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
let previousSendingEnabled = null;
let groupId = null;

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Chair','${TAG}_chair','${TAG}_chair@example.invalid','27110001001','x','active',FALSE,'pending'),
            ($2,'personal','${TAG} Member','${TAG}_member','${TAG}_member@example.invalid','27110001002','x','active',FALSE,'pending'),
            ($3,'personal','${TAG} Stranger','${TAG}_stranger','${TAG}_stranger@example.invalid','27110001003','x','active',FALSE,'pending')`,
    [ids.chair, ids.member, ids.stranger]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',1000,0,'active'), ($4,$5,$6,'personal','ZAR',1000,0,'active')`,
    [ids.chairWallet, String(Date.now()).slice(-9), ids.chair, ids.memberWallet, String(Date.now() + 3).slice(-9), ids.member]
  );
  await ensureEmailSchema();
  const { rows } = await pool.query("SELECT sending_enabled FROM email_settings WHERE id=TRUE");
  previousSendingEnabled = rows[0] ? rows[0].sending_enabled : null;
  await pool.query("UPDATE email_settings SET sending_enabled=TRUE WHERE id=TRUE");
}

async function contribute(userId, amount) {
  const walletId = userId === ids.chair ? ids.chairWallet : ids.memberWallet;
  await pool.query(
    `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, metadata)
     VALUES ($1,$2,$3,'stockvel_contribution',$4,0,$4,'completed','debit',$5,$6::jsonb)`,
    [randomUUID(), userId, walletId, amount, `${TAG}-contrib-${randomUUID().slice(0, 8)}`, JSON.stringify({ stockvelGroupId: groupId })]
  );
}

async function cleanup() {
  if (previousSendingEnabled !== null) {
    await pool.query("UPDATE email_settings SET sending_enabled=$1 WHERE id=TRUE", [previousSendingEnabled]).catch(() => {});
  }
  const users = [ids.chair, ids.member, ids.stranger];
  await pool.query("DELETE FROM email_queue WHERE idempotency_key LIKE 'stockvel-minutes:%'", []).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.chairWallet, ids.memberWallet]]).catch(() => {});
  if (groupId) {
    for (const table of ["stockvel_messages", "stockvel_meetings", "stockvel_withdrawals", "stockvel_members", "stockvel_groups"]) {
      await pool.query(`DELETE FROM ${table} WHERE ${table === "stockvel_groups" ? "id" : "group_id"} = $1`, [groupId]).catch(() => {});
    }
  }
  await pool.query("DELETE FROM stockvel_groups WHERE owner_user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  STOKVEL — DRAFTS, MEMBERS, LEDGER TRUTH, CHAT AND MINUTES, REAL DB");
    console.log("=".repeat(80));

    await seed();

    // 1. Draft saved; joiners refused until activation.
    const draft = await svc.createGroup(ids.chair, { name: `${TAG} Family Circle`, description: "School fees", contributionAmount: 200, cadence: "monthly", status: "draft" });
    groupId = draft.id;
    assert.equal(draft.status, "draft");
    let draftJoin = false;
    try { await svc.joinByCode(ids.member, draft.invite_code); } catch (e) { draftJoin = e.statusCode === 409; }
    assert.ok(draftJoin, "a draft refuses joiners with a clear reason");
    ok("draft saved — visible to the chair, closed to joiners until activated");

    // 2. Activate, member joins with the invite code.
    await svc.updateGroup(ids.chair, groupId, { status: "active" });
    await svc.joinByCode(ids.member, draft.invite_code);
    const detail = await svc.getGroup(ids.member, groupId);
    assert.equal(detail.member_count, 2, "chair + member");
    assert.equal(detail.role, "member");
    ok("activated — the member joined with the invite code and sees the group");

    // 3. Balance is the wallet's own record: two real contribution
    //    transactions, and the group reports exactly their sum.
    await contribute(ids.chair, 200);
    await contribute(ids.member, 200);
    const funded = await svc.getGroup(ids.chair, groupId);
    assert.equal(money(funded.balance), 400, "balance = the recorded transactions, nothing else");
    assert.equal(funded.contributions.length, 2, "both contributions listed with names");
    assert.equal(money(funded.my_contribution), 200);
    ok("balance R400 reconciles to the two real contribution transactions");

    // 4. Withdrawals: cannot exceed the balance; cannot self-approve;
    //    a second organiser approving works and the balance drops.
    let over = false;
    try { await svc.requestWithdrawal(ids.member, groupId, { amount: 500 }); } catch (e) { over = e.statusCode === 409; }
    assert.ok(over, "a withdrawal above the balance is refused");
    const withdrawal = await svc.requestWithdrawal(ids.chair, groupId, { amount: 150, reason: "December payout" });
    let self = false;
    try { await svc.decideWithdrawal(ids.chair, groupId, withdrawal.id, true); } catch (e) { self = e.statusCode === 409; }
    assert.ok(self, "the requester cannot approve their own withdrawal");
    await svc.changeMemberRole(ids.chair, groupId, ids.member, "promote");
    await svc.decideWithdrawal(ids.member, groupId, withdrawal.id, true);
    assert.equal(money((await svc.getGroup(ids.chair, groupId)).balance), 250, "balance drops to R250 after approval");
    ok("withdrawals: over-balance refused, self-approval refused, dual control works");

    // 5. Chat is members-only.
    await svc.postMessage(ids.chair, groupId, { message: "Welcome everyone — December payout goes to Gogo first." });
    const msg2 = await svc.postMessage(ids.member, groupId, { message: "Agreed. Contributions stay R200 for next year." });
    let strangerBlocked = false;
    try { await svc.postMessage(ids.stranger, groupId, { message: "let me in" }); } catch (e) { strangerBlocked = e.statusCode === 404; }
    assert.ok(strangerBlocked, "a stranger cannot post");
    let strangerRead = false;
    try { await svc.listMessages(ids.stranger, groupId); } catch (e) { strangerRead = e.statusCode === 404; }
    assert.ok(strangerRead, "a stranger cannot read");
    ok("group chat works and is members-only in both directions");

    // 6. Meeting: open, pin a decision, close — minutes carry everything.
    const meeting = await svc.openMeeting(ids.chair, groupId, { title: "Year-end planning" });
    await svc.postMessage(ids.member, groupId, { message: "Proposal: increase to R250 from March." });
    const proposal = (await svc.listMessages(ids.chair, groupId)).slice(-1)[0];
    await svc.markDecision(ids.chair, groupId, proposal.id, true);
    await contribute(ids.member, 50);
    const closed = await svc.closeMeeting(ids.chair, groupId, meeting.id);
    assert.equal(closed.status, "closed");
    assert.match(closed.minutes, /MINUTES: Year-end planning/);
    assert.match(closed.minutes, /DECISIONS AGREED/);
    assert.match(closed.minutes, /increase to R250 from March/i, "the pinned decision leads the minutes");
    assert.match(closed.minutes, new RegExp(`${TAG} Member: R50.00`), "the contribution during the meeting is minuted");
    assert.match(closed.minutes, /Group balance at close: R300.00/, "the closing balance is minuted");
    ok("closing the meeting compiled minutes: attendance, decision, contribution, balance");

    // 7. The minutes were emailed to every member.
    const { rows: mails } = await pool.query(
      "SELECT recipient FROM email_queue WHERE idempotency_key LIKE $1", [`stockvel-minutes:${meeting.id}:%`]);
    assert.equal(mails.length, 2, "one email per member");
    ok("minutes emailed to both members the moment the meeting closed");

    // 8. A meeting cannot be closed twice, and members cannot run meetings.
    let reclose = false;
    try { await svc.closeMeeting(ids.chair, groupId, meeting.id); } catch (e) { reclose = e.statusCode === 409; }
    assert.ok(reclose);
    await svc.changeMemberRole(ids.chair, groupId, ids.member, "demote");
    let memberMeeting = false;
    try { await svc.openMeeting(ids.member, groupId, {}); } catch (e) { memberMeeting = e.statusCode === 403; }
    assert.ok(memberMeeting, "plain members cannot open meetings");
    ok("meetings close exactly once, and only organisers run them");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — the stokvel is live: groups, chat and minutes.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
