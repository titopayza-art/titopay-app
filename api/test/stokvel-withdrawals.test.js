"use strict";

// STOKVEL WITHDRAWALS, DRIVEN THROUGH THE REAL SERVICE AGAINST A REAL DATABASE.
//
// The Stokvel had five tests before this file and every one of them was a
// regex over the source. Nothing had ever moved a rand through the service, on
// the one product in TitoPay where members pool their savings and trust a
// register to say who is owed what.
//
// What this pins, and why each one is here:
//
//   the register is the money            a contribution is the transaction the
//                                        wallet already recorded, so the group
//                                        total and the member's total are read
//                                        from the same rands that left. If
//                                        these can drift, the register is
//                                        fiction.
//   approval is a decision, not a payout TitoPay holds no group pot. Approving
//                                        must change the group's recorded
//                                        position and must NOT move money -
//                                        asserted in both directions, because
//                                        a future "helpful" auto-payout here
//                                        would be a platform paying out funds
//                                        it does not hold.
//   who may decide                       an organiser, never the requester,
//                                        never a plain member.
//   the pot cannot be over-drawn         two approvals that individually fit
//                                        must not both pass.
//   people are told                      a request reaches the organisers and
//                                        a decision reaches the member.
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "stokvel-test-access-secret-with-len!!";
process.env.JWT_REFRESH_SECRET ||= "stokvel-test-refresh-secret-with-len";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const stokvel = require("../src/services/stockvel-service");

const uid = () => crypto.randomUUID();
const stamp = Date.now().toString(36);
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

const chairId = uid();
const organiserId = uid();
const memberId = uid();
const outsiderId = uid();
const userIds = [chairId, organiserId, memberId, outsiderId];

async function makeUser(id, username, fullName, balance = 0) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash)
     VALUES ($1,'personal',$2,$3,'$2a$10$stokveltestnotarealhashxxxxxxxxxxxxxxxxxxxxxxxxxxx')`,
    [id, fullName, username]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',$4,0,'active')`,
    [uid(), String(6000000000 + Math.floor(Math.random() * 899999999)), id, balance]
  );
}

async function balanceOf(userId) {
  const { rows } = await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind = 'personal'", [userId]);
  return Number(rows[0].available_balance);
}

async function notificationsFor(userId, type) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND notification_type = $2",
    [userId, type]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return rows[0].c;
}

let groupId;

test.before(async () => {
  await stokvel.ensureStockvelSchema();
  await makeUser(chairId, `sv_chair_${stamp}`, "Sv Chair", 5000);
  await makeUser(organiserId, `sv_org_${stamp}`, "Sv Organiser", 5000);
  await makeUser(memberId, `sv_member_${stamp}`, "Sv Member", 5000);
  await makeUser(outsiderId, `sv_outsider_${stamp}`, "Sv Outsider", 5000);
});

test.after(async () => {
  await pool.query("DELETE FROM stockvel_groups WHERE owner_user_id = $1", [chairId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await pool.end();
});

/* ------------------------------------------------------- the register */

test("a group starts with its creator as chair and an empty pot", async () => {
  const group = await stokvel.createGroup(chairId, {
    name: `Ubuntu ${stamp}`, description: "Monthly savings", cadence: "monthly", contributionAmount: 500
  });
  groupId = group.id;
  assert.equal(group.role, "chair");
  assert.equal(group.can_manage, true);

  const detail = await stokvel.getGroup(chairId, groupId);
  assert.equal(detail.balance, 0, "a new group holds nothing");
  assert.equal(detail.member_count, 1);
});

test("members join with the code, and only with the code", async () => {
  const group = await stokvel.getGroup(chairId, groupId);
  await stokvel.joinByCode(organiserId, group.invite_code);
  await stokvel.joinByCode(memberId, group.invite_code);
  // "promote", not the role name: changeMemberRole takes a DIRECTION, and
  // anything that is not "promote" demotes to member. Passing "organiser" here
  // silently demoted them, which then made two later tests fail for a reason
  // that had nothing to do with what they were testing.
  await stokvel.changeMemberRole(chairId, groupId, organiserId, "promote");

  const detail = await stokvel.getGroup(chairId, groupId);
  assert.equal(detail.member_count, 3);
  const organiserView = await stokvel.getGroup(organiserId, groupId);
  assert.equal(organiserView.role, "organiser", "the promotion took");
  assert.equal(organiserView.can_manage, true);

  // An outsider is not a member and cannot read the group at all.
  await assert.rejects(() => stokvel.getGroup(outsiderId, groupId), /not a member|not found/i);
});

test("a contribution is the wallet transaction, and the register reads it back", async () => {
  const before = await balanceOf(memberId);
  const result = await stokvel.contribute(
    { userId: memberId, userType: "customer", accountType: "personal", profileLocked: false,
      ipAddress: "127.0.0.1", userAgent: "stokvel-test" },
    groupId, { amount: 400, idempotencyKey: `sv-contrib-${stamp}` }
  );
  assert.ok(result, "the contribution completed");

  const after = await balanceOf(memberId);
  assert.ok(after < before, `the member's wallet paid for it: ${before} -> ${after}`);

  // THE REGISTER IS NOT A PARALLEL TALLY. It is read from the transactions the
  // wallet recorded, so what the group is told it holds is what actually moved.
  const detail = await stokvel.getGroup(chairId, groupId);
  assert.equal(detail.balance, 400, "the group's pot is the contribution");
  assert.equal(detail.total_contributed, 400);
  const mine = await stokvel.getGroup(memberId, groupId);
  assert.equal(mine.my_contribution, 400, "and the member is credited for their own");
});

/* --------------------------------------------------- who may decide */

test("a plain member cannot decide a withdrawal", async () => {
  const request = await stokvel.requestWithdrawal(memberId, groupId, { amount: 100, reason: "transport" });
  await assert.rejects(
    () => stokvel.decideWithdrawal(memberId, groupId, request.id, true),
    /Only the group's organisers/
  );
  // Left untouched for the next test to decide.
  const detail = await stokvel.getGroup(chairId, groupId);
  assert.equal(detail.withdrawals.find((w) => w.id === request.id).status, "requested");
});

test("an organiser cannot approve their own withdrawal", async () => {
  const request = await stokvel.requestWithdrawal(organiserId, groupId, { amount: 50, reason: "airtime" });
  await assert.rejects(
    () => stokvel.decideWithdrawal(organiserId, groupId, request.id, true),
    /cannot approve your own withdrawal/
  );
  // Another organiser can, which is what makes the rule a separation of duties
  // rather than a block.
  const decided = await stokvel.decideWithdrawal(chairId, groupId, request.id, true);
  assert.equal(decided.status, "approved");
});

/* ------------------------------- approval decides, it does not pay out */

test("APPROVING RECORDS A DECISION AND MOVES NO MONEY", async () => {
  // The whole design rests on this. "TitoPay holds no group pot" is what the
  // statement screen tells members, and it is only true while this service
  // owns no payout rail. If a later change makes approval move money, TitoPay
  // starts paying out funds it never held - and this test is the tripwire.
  const request = await stokvel.requestWithdrawal(memberId, groupId, { amount: 120, reason: "school books" });

  const chairBefore = await balanceOf(chairId);
  const memberBefore = await balanceOf(memberId);
  const potBefore = (await stokvel.getGroup(chairId, groupId)).balance;

  await stokvel.decideWithdrawal(chairId, groupId, request.id, true);

  assert.equal(await balanceOf(chairId), chairBefore, "the organiser's wallet is untouched");
  assert.equal(await balanceOf(memberId), memberBefore, "and so is the member's - approval is not payment");

  // What DOES change is the group's recorded position.
  const potAfter = (await stokvel.getGroup(chairId, groupId)).balance;
  assert.equal(potAfter, money(potBefore - 120), "the pot records the approved withdrawal");
});

test("a decided request cannot be decided twice", async () => {
  const request = await stokvel.requestWithdrawal(memberId, groupId, { amount: 10, reason: "sweets" });
  await stokvel.decideWithdrawal(chairId, groupId, request.id, false);
  await assert.rejects(
    () => stokvel.decideWithdrawal(chairId, groupId, request.id, true),
    /already declined|already decided/i
  );
});

test("the pot cannot be over-drawn by two withdrawals that each fit alone", async () => {
  const pot = (await stokvel.getGroup(chairId, groupId)).balance;
  assert.ok(pot > 0, `there is something to draw against (R${pot})`);
  const first = await stokvel.requestWithdrawal(memberId, groupId, { amount: pot, reason: "first" });
  const second = await stokvel.requestWithdrawal(memberId, groupId, { amount: pot, reason: "second" });

  await stokvel.decideWithdrawal(chairId, groupId, first.id, true);
  await assert.rejects(
    () => stokvel.decideWithdrawal(chairId, groupId, second.id, true),
    /no longer holds enough/,
    "the second approval must see the first one's effect"
  );
  const detail = await stokvel.getGroup(chairId, groupId);
  assert.equal(detail.balance, 0, "the group is drawn down to nothing, not below it");
});

/* --------------------------------------------------- people are told */

test("a request reaches the organisers, and the decision reaches the member", async () => {
  const organiserBefore = await notificationsFor(organiserId, "stockvel_withdrawal_requested");
  const memberBefore = await notificationsFor(memberId, "stockvel_withdrawal_decided");

  // Fund the pot so there is something to ask for.
  await stokvel.contribute(
    { userId: memberId, userType: "customer", accountType: "personal", profileLocked: false,
      ipAddress: "127.0.0.1", userAgent: "stokvel-test" },
    groupId, { amount: 200, idempotencyKey: `sv-contrib2-${stamp}` }
  );
  const request = await stokvel.requestWithdrawal(memberId, groupId, { amount: 60, reason: "electricity" });

  assert.ok(await notificationsFor(organiserId, "stockvel_withdrawal_requested") > organiserBefore,
    "an organiser was told a member is asking for money");
  assert.equal(await notificationsFor(memberId, "stockvel_withdrawal_requested"), 0,
    "the person who asked is not told about their own request");

  await stokvel.decideWithdrawal(chairId, groupId, request.id, true);
  assert.ok(await notificationsFor(memberId, "stockvel_withdrawal_decided") > memberBefore,
    "and the member was told what the group decided");
});

test("the withdrawal payload names the requester and, once decided, the decider", async () => {
  // THE FIELD NAMES ARE THE CONTRACT. The app read requestedBy and this sent
  // only `requester`, so every withdrawal in the app showed an amount with
  // nobody's name against it. Both spellings are asserted so a tidy-up cannot
  // quietly drop the one the app depends on.
  const detail = await stokvel.getGroup(chairId, groupId);
  const decided = detail.withdrawals.find((w) => w.status === "approved");
  assert.ok(decided, "there is an approved withdrawal to inspect");
  assert.ok(decided.requester, "requester is present");
  assert.equal(decided.requestedBy, decided.requester, "and so is requestedBy, the name the app reads");
  assert.ok(decided.requesterUserId, "with the id the app needs to spot your own request");
  assert.ok(decided.decidedBy, "an approved withdrawal names who approved it");
  assert.ok(decided.decidedAt, "and when");

  const open = detail.withdrawals.find((w) => w.status === "requested");
  if (open) assert.equal(open.decidedBy, null, "an undecided one names nobody");
});

test("a group holding members' money cannot be deleted", async () => {
  await stokvel.contribute(
    { userId: memberId, userType: "customer", accountType: "personal", profileLocked: false,
      ipAddress: "127.0.0.1", userAgent: "stokvel-test" },
    groupId, { amount: 75, idempotencyKey: `sv-contrib3-${stamp}` }
  );
  await assert.rejects(
    () => stokvel.deleteGroup(chairId, groupId),
    /still holds/,
    "deleting a group with a balance would strand members' savings"
  );
});
