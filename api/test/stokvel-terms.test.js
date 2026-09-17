"use strict";

// THE GROUP'S OWN RULES, AND WHO HAS AGREED TO WHICH VERSION OF THEM.
//
// A stokvel runs on a constitution the members write: what everyone pays in,
// when, what happens when somebody misses a month. Until now it lived in a
// WhatsApp group and in people's memory, which is where arguments about money
// come from.
//
// What these tests hold, and why each one matters when real savings are
// involved:
//
//   an amendment is a NEW VERSION      editing wording in place would leave a
//                                      set of acceptances attached to text
//                                      nobody can read any more - worse than
//                                      keeping no record at all
//   responses follow the version       what somebody agreed to in March stays
//                                      attached to the March wording
//   only the current version answers   nobody can quietly accept superseded
//                                      terms
//   a rejection blocks nothing         TitoPay records the group's decision;
//                                      it does not adjudicate a private
//                                      agreement, and freezing somebody's
//                                      savings over a rules dispute would be
//                                      exactly that
//   the tally counts the MEMBERSHIP    "3 of 8" is honest; "3 of 3" when five
//                                      people said nothing is not
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "stokvel-terms-access-secret-length!!";
process.env.JWT_REFRESH_SECRET ||= "stokvel-terms-refresh-secret-length!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const stokvel = require("../src/services/stockvel-service");

const uid = () => crypto.randomUUID();
const stamp = Date.now().toString(36);

const chairId = uid();
const organiserId = uid();
const memberId = uid();
const quietId = uid();
const outsiderId = uid();
const userIds = [chairId, organiserId, memberId, quietId, outsiderId];

const FIRST_TERMS = [
  "1. Every member contributes R500 by the 7th of each month.",
  "2. A member who misses two consecutive months forfeits that cycle's payout.",
  "3. Payouts rotate in the order members joined.",
  "4. The chair and one organiser must both agree before any withdrawal."
].join("\n");

const AMENDED_TERMS = FIRST_TERMS.replace("R500", "R750");

async function makeUser(id, username, fullName) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash)
     VALUES ($1,'personal',$2,$3,'$2a$10$stokveltermstestnotarealhashxxxxxxxxxxxxxxxxxxxx')`,
    [id, fullName, username]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',0,0,'active')`,
    [uid(), String(7000000000 + Math.floor(Math.random() * 899999999)), id]
  );
}

let groupId;
let firstVersionId;

test.before(async () => {
  await stokvel.ensureStockvelSchema();
  await makeUser(chairId, `tc_chair_${stamp}`, "Terms Chair");
  await makeUser(organiserId, `tc_org_${stamp}`, "Terms Organiser");
  await makeUser(memberId, `tc_member_${stamp}`, "Terms Member");
  await makeUser(quietId, `tc_quiet_${stamp}`, "Terms Quiet Member");
  await makeUser(outsiderId, `tc_out_${stamp}`, "Terms Outsider");

  const group = await stokvel.createGroup(chairId, {
    name: `Terms Club ${stamp}`, cadence: "monthly", contributionAmount: 500 });
  groupId = group.id;
  const detail = await stokvel.getGroup(chairId, groupId);
  await stokvel.joinByCode(organiserId, detail.invite_code);
  await stokvel.joinByCode(memberId, detail.invite_code);
  await stokvel.joinByCode(quietId, detail.invite_code);
  await stokvel.changeMemberRole(chairId, groupId, organiserId, "promote");
});

test.after(async () => {
  await pool.query("DELETE FROM stockvel_groups WHERE owner_user_id = $1", [chairId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await pool.end();
});

/* ---------------------------------------------------------- publishing */

test("a group starts with no terms at all", async () => {
  const terms = await stokvel.getTerms(memberId, groupId);
  assert.equal(terms.current, null);
  assert.deepEqual(terms.history, []);
});

test("an organiser publishes the first version", async () => {
  const published = await stokvel.publishTerms(chairId, groupId, {
    title: "Terms Club constitution", body: FIRST_TERMS });
  assert.equal(published.version, 1);
  firstVersionId = published.id;

  const terms = await stokvel.getTerms(memberId, groupId);
  assert.equal(terms.current.version, 1);
  assert.equal(terms.current.title, "Terms Club constitution");
  assert.match(terms.current.body, /R500/);
  assert.equal(terms.current.publishedBy, "Terms Chair");
});

test("a plain member cannot publish terms for everybody else", async () => {
  // Terms bind the whole group. One member issuing rules for the others is not
  // a stokvel - responding is everyone's, publishing is not.
  await assert.rejects(
    () => stokvel.publishTerms(memberId, groupId, { body: FIRST_TERMS }),
    /Only the group's organisers/
  );
});

test("an outsider can neither read nor publish the terms", async () => {
  await assert.rejects(() => stokvel.getTerms(outsiderId, groupId), /not found/i);
  await assert.rejects(() => stokvel.publishTerms(outsiderId, groupId, { body: FIRST_TERMS }), /not found/i);
});

test("empty or absurd terms are refused", async () => {
  await assert.rejects(() => stokvel.publishTerms(chairId, groupId, { body: "" }), /Terms/);
  await assert.rejects(() => stokvel.publishTerms(chairId, groupId, { body: "too short" }), /Terms/);
  await assert.rejects(
    () => stokvel.publishTerms(chairId, groupId, { body: "x".repeat(20001) }), /Terms/);
});

/* ---------------------------------------------------------- responding */

test("a member accepts, rejects, or just says something", async () => {
  const accepted = await stokvel.respondToTerms(memberId, groupId, firstVersionId,
    { decision: "accepted" });
  assert.equal(accepted.decision, "accepted");

  const rejected = await stokvel.respondToTerms(organiserId, groupId, firstVersionId,
    { decision: "rejected", comment: "R500 is too much for me this year." });
  assert.equal(rejected.decision, "rejected");

  // A comment with no decision: somebody with a question who is not ready to
  // agree or refuse. This is what people actually do when terms land.
  const commented = await stokvel.respondToTerms(chairId, groupId, firstVersionId,
    { comment: "Noted, let us discuss clause 2 at the next meeting." });
  assert.equal(commented.decision, null);
  assert.match(commented.comment, /clause 2/);
});

test("a response with neither a decision nor a comment is refused", async () => {
  await assert.rejects(
    () => stokvel.respondToTerms(memberId, groupId, firstVersionId, {}),
    /Accept, reject, or leave a comment/
  );
  await assert.rejects(
    () => stokvel.respondToTerms(memberId, groupId, firstVersionId, { decision: "maybe" }),
    /accepted or rejected/
  );
});

test("a member may change their mind while a version is current", async () => {
  await stokvel.respondToTerms(organiserId, groupId, firstVersionId,
    { decision: "accepted", comment: "Spoke to the chair, I am in." });
  const terms = await stokvel.getTerms(organiserId, groupId);
  assert.equal(terms.myResponse.decision, "accepted");
  // One row per member per version, not a second row.
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM stockvel_terms_responses WHERE terms_id = $1 AND user_id = $2",
    [firstVersionId, organiserId]);
  assert.equal(rows[0].c, 1);
});

test("THE TALLY IS COUNTED AGAINST THE MEMBERSHIP, NOT THE RESPONSES", async () => {
  // "2 of 4" is honest. "2 of 2" while two members have said nothing is the
  // number that lets an organiser believe the group has agreed when it has not.
  const terms = await stokvel.getTerms(chairId, groupId);
  assert.equal(terms.tally.memberCount, 4, "chair, organiser, member, quiet member");
  assert.equal(terms.tally.accepted, 2, "member and organiser");
  assert.equal(terms.tally.commented, 1, "the chair asked a question");
  assert.equal(terms.tally.responded, 3);
  assert.equal(terms.tally.pending, 1, "the quiet member has not answered");
});

test("every response is visible to the group, with who said it", async () => {
  const terms = await stokvel.getTerms(quietId, groupId);
  const names = terms.responses.map((row) => row.name).sort();
  assert.deepEqual(names, ["Terms Chair", "Terms Member", "Terms Organiser"]);
  assert.ok(terms.responses.some((row) => /clause 2/.test(row.comment)));
  assert.equal(terms.myResponse, null, "the quiet member has not answered");
});

/* ----------------------------------------------------------- amendments */

test("AN AMENDMENT IS A NEW VERSION, AND EVERYBODY ANSWERS AGAIN", async () => {
  const amended = await stokvel.publishTerms(organiserId, groupId, {
    title: "Terms Club constitution", body: AMENDED_TERMS,
    changeNote: "Monthly contribution raised from R500 to R750." });
  assert.equal(amended.version, 2);

  const terms = await stokvel.getTerms(memberId, groupId);
  assert.equal(terms.current.version, 2);
  assert.match(terms.current.body, /R750/);
  assert.match(terms.current.changeNote, /R500 to R750/);
  // THE POINT OF VERSIONING. Nobody has agreed to the new wording yet, and
  // their acceptance of the old wording does not carry over.
  assert.equal(terms.tally.accepted, 0);
  assert.equal(terms.tally.responded, 0);
  assert.equal(terms.tally.pending, 4);
  assert.equal(terms.myResponse, null, "an old acceptance is not an acceptance of this");
});

test("the superseded version and its responses are kept, in full", async () => {
  // "What did I actually agree to in March" has to have an answer.
  const old = await stokvel.getTermsVersion(memberId, groupId, firstVersionId);
  assert.equal(old.version, 1);
  assert.match(old.body, /R500/, "the original wording is still readable");
  assert.equal(old.responses.length, 3);
  assert.ok(old.responses.some((row) => row.name === "Terms Member" && row.decision === "accepted"));

  const terms = await stokvel.getTerms(memberId, groupId);
  assert.equal(terms.history.length, 1);
  assert.equal(terms.history[0].version, 1);
});

test("a superseded version can no longer be accepted", async () => {
  await assert.rejects(
    () => stokvel.respondToTerms(quietId, groupId, firstVersionId, { decision: "accepted" }),
    /has been replaced/
  );
});

test("versions do not collide when two organisers publish at once", async () => {
  // Both publishes are serialised on a per-group advisory lock; without it the
  // two would read the same MAX(version) and one insert would lose its race
  // with a unique-violation 500.
  const [a, b] = await Promise.all([
    stokvel.publishTerms(chairId, groupId, { body: `${AMENDED_TERMS}\n5. Clause added by the chair.` }),
    stokvel.publishTerms(organiserId, groupId, { body: `${AMENDED_TERMS}\n5. Clause added by an organiser.` })
  ]);
  assert.notEqual(a.version, b.version);
  assert.deepEqual([a.version, b.version].sort(), [3, 4]);
});

/* --------------------------------- a rejection records, it does not punish */

test("REJECTING THE TERMS BLOCKS NOTHING", async () => {
  // TitoPay records what the group decided. It does not adjudicate a private
  // agreement between members, and a platform that froze somebody's savings
  // over a rules dispute would be doing exactly that.
  const current = (await stokvel.getTerms(memberId, groupId)).current;
  await stokvel.respondToTerms(memberId, groupId, current.id,
    { decision: "rejected", comment: "I do not agree with the new amount." });

  // The group is still readable, contributions are still possible, and the
  // member is still a member.
  const detail = await stokvel.getGroup(memberId, groupId);
  assert.equal(detail.id, groupId);
  assert.ok(detail.members.some((row) => row.id === memberId));
  await assert.doesNotReject(() => stokvel.requestWithdrawal(memberId, groupId, { amount: 0.01, reason: "still allowed" })
    .catch((error) => {
      // The only permitted refusal here is "the group holds nothing", which is
      // about the balance and not about the rejection.
      if (/cannot exceed it|holds R/.test(error.message)) return null;
      throw error;
    }));
});

test("the terms are the group's, and the record says so", async () => {
  // Everything a member is shown has to make clear whose rules these are.
  // TitoPay hosts and records them; it does not write, vet or enforce them.
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "services", "stockvel-service.js"), "utf8");
  assert.match(source, /These are the MEMBERS' terms, never TitoPay's/);
  assert.match(source, /does not draft, vet, advise on or\s*\/\/ enforce/);
});
