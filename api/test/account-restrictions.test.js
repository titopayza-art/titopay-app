"use strict";

// INACTIVE WITH A REASON, NEVER DELETED.
//
// TitoPay already kept every customer row - account-closure-service.js sets
// users.status = 'closed' and deletes nothing, because FICA requires the
// records to outlive the relationship. What was missing was the REASON on the
// path that matters most: an account TitoPay restricted itself recorded
// nothing beyond "user_suspended" in the audit log, so months later nobody
// could tell a dormancy sweep from a sanctions match.
//
// What is defended here:
//
//   1. nothing is ever deleted - not the user, not the wallet, not the
//      restriction itself once lifted;
//   2. a restriction without a written reason is refused;
//   3. TIPPING OFF - a customer under AML or fraud review is told their
//      account is restricted and never why;
//   4. a suspension made through the old reasonless button is still recorded,
//      so it cannot be invisible;
//   5. lifting restores the status the account actually had before, not
//      blindly 'active'.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const restrictions = require("../src/services/account-restriction-service");
const reference = require("../src/config/account-status-reference");

let sequence = 0;
async function makeCustomer(status = "active") {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Restricted Tester',$2,$3,$4,'personal',$5,'verified','x')`,
    [id, `rest_${tag}`, `rest_${tag}@test.local`, `+2782${tag}`.slice(0, 13), status]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',1500)`,
    [uuidv4(), id, tag.slice(0, 10)]);
  return id;
}

async function makeAdmin() {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Compliance Officer',$2,$3,'super_admin','x','active')`,
    [id, `comp_${tag}`, `comp_${tag}@titopay.test`]);
  return { userId: id, userType: "admin", ipAddress: "127.0.0.1", userAgent: "node-test" };
}

const userStatus = async (id) =>
  (await pool.query("SELECT status FROM users WHERE id = $1", [id])).rows[0]?.status;

test.before(() => restrictions.ensureRestrictionSchema());

test("RESTRICTING AN ACCOUNT DELETES NOTHING", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "aml_review",
    reason: "Six cash top-ups just under the reporting threshold in four days.",
    caseReference: "AML-2026-0114"
  });

  assert.equal(await userStatus(userId), "suspended");
  // The customer, the wallet and the money are all still there.
  const { rows: user } = await pool.query("SELECT id, full_name, email, phone FROM users WHERE id = $1", [userId]);
  assert.equal(user.length, 1, "THE CUSTOMER ROW SURVIVES");
  assert.ok(user[0].email && user[0].phone, "and so do the FICA identifiers");
  const { rows: wallet } = await pool.query("SELECT available_balance FROM wallets WHERE user_id = $1", [userId]);
  assert.equal(Number(wallet[0].available_balance), 1500, "the balance is untouched, not swept");
});

test("THE INTERNAL REASON IS KEPT IN FULL, FOR COMPLIANCE", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  const reason = "Six cash top-ups just under the reporting threshold in four days, then an immediate withdrawal.";
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "aml_review", reason, caseReference: "AML-2026-0115"
  });
  const [record] = await restrictions.restrictionHistory(userId);
  assert.equal(record.reason, reason, "verbatim, not summarised");
  assert.equal(record.category, "aml_review");
  assert.equal(record.caseReference, "AML-2026-0115");
  assert.equal(record.restrictedBy, admin.userId, "and who decided it");
  assert.equal(record.inForce, true);
});

test("TIPPING OFF - AN AML SUBJECT IS NEVER TOLD WHY", async () => {
  // Telling a customer they are the subject of a suspicion report is an
  // offence under the Financial Intelligence Centre Act. The sentence they
  // see is chosen by STATUS from a fixed map and is identical whether the
  // cause was a sanctions match or a clerical error.
  const admin = await makeAdmin();
  const secret = "Name matched a designated persons list on screening. STR filed 2026-09-15.";
  for (const category of ["aml_review", "fraud_suspected", "sanctions_match", "law_enforcement"]) {
    const userId = await makeCustomer();
    await restrictions.restrictAccount(admin, userId, { status: "suspended", category, reason: secret });
    const shown = await restrictions.customerFacingRestriction(userId);

    assert.equal(shown.restricted, true);
    assert.equal(shown.reason, null, `${category}: no reason reaches the customer`);
    assert.equal(shown.since, null, `${category}: not even the date`);
    assert.equal(shown.message, "Your TitoPay account is currently restricted. Please contact TitoPay support.");
    // The strongest form of the check: the payload is exactly these three
    // fields with exactly these values, so a field added later that carried
    // anything about the cause would fail here rather than reach a customer.
    assert.deepEqual(shown, {
      restricted: true,
      message: "Your TitoPay account is currently restricted. Please contact TitoPay support.",
      reason: null,
      since: null
    }, `${category}: the customer payload must carry nothing else`);
    // And no distinctive term from the internal note survives. Matched on word
    // boundaries - a naive substring search finds "str" inside "restricted".
    const serialised = JSON.stringify(shown);
    for (const term of ["AML", "sanction", "fraud", "designated", "STR", "screening", "investigation", "suspicion"]) {
      assert.ok(!new RegExp(`\\b${term}`, "i").test(serialised),
        `${category}: "${term}" leaked into ${serialised}`);
    }
  }
});

test("ordinary administration IS explained - being kept in the dark is its own harm", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "inactive", category: "dormant",
    reason: "No sign-in or transaction for 18 months. Swept on the quarterly dormancy run."
  });
  const shown = await restrictions.customerFacingRestriction(userId);
  assert.equal(shown.reason, "No activity for a long period.", "a dormancy sweep may say so");
  assert.ok(shown.since, "and when");
  // But it is still the CATEGORY's sentence, not the internal note.
  assert.ok(!JSON.stringify(shown).includes("quarterly dormancy run"));
});

test("an unrestricted account is told nothing at all", async () => {
  const userId = await makeCustomer();
  assert.deepEqual(await restrictions.customerFacingRestriction(userId), { restricted: false, message: "" });
});

test("A RESTRICTION WITHOUT A WRITTEN REASON IS REFUSED", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  for (const reason of [undefined, "", "   ", "fraud"]) {
    await assert.rejects(
      () => restrictions.restrictAccount(admin, userId, { status: "suspended", category: "fraud_suspected", reason }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
      `refused: ${JSON.stringify(reason)}`);
  }
  assert.equal(await userStatus(userId), "active", "and the account was not touched");
});

test("an unknown category or status is refused rather than stored", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  const reason = "A perfectly adequate written reason for the file.";
  await assert.rejects(() => restrictions.restrictAccount(admin, userId,
    { status: "suspended", category: "vibes", reason }), /Restriction reason is invalid/i);
  await assert.rejects(() => restrictions.restrictAccount(admin, userId,
    { status: "deleted", category: "aml_review", reason }), /Account status is invalid/i);
  assert.equal(await userStatus(userId), "active");
});

test("A MIS-KEYED CATEGORY IS CAUGHT - dormancy cannot block an account", async () => {
  // The next reviewer reads the category as a finding of fact, so "blocked
  // for dormancy" or "dormant for a sanctions match" must not be storable.
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  const reason = "A perfectly adequate written reason for the file.";
  await assert.rejects(
    () => restrictions.restrictAccount(admin, userId, { status: "blocked", category: "dormant", reason }),
    /applies to: inactive/i);
  await assert.rejects(
    () => restrictions.restrictAccount(admin, userId, { status: "inactive", category: "sanctions_match", reason }),
    /applies to: suspended, blocked/i);
});

test("EVERY LIVE SESSION DIES WITH THE RESTRICTION", async () => {
  // A status change alone leaves an access token working until it expires.
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  const sessionId = uuidv4();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','hash','jti', NOW() + INTERVAL '7 days')`, [sessionId, userId]);
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "fraud_suspected",
    reason: "Three disputed card top-ups from different BINs inside an hour."
  });
  const { rows } = await pool.query("SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1", [sessionId]);
  assert.ok(rows[0].revoked_at, "the session is revoked");
  assert.equal(rows[0].revoked_reason, "account_restricted");
});

test("only ONE restriction can be in force at a time", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "aml_review", reason: "Structuring pattern across four days." });
  await assert.rejects(
    () => restrictions.restrictAccount(admin, userId, {
      status: "blocked", category: "fraud_suspected", reason: "A second, different reason entirely." }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already has a restriction in force/i);
      return true;
    });
});

test("LIFTING KEEPS THE RECORD - a wrongly suspended account can prove it was", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "fraud_suspected", reason: "Flagged by the card-testing rule." });
  const lifted = await restrictions.liftRestriction(admin, userId, {
    reason: "Reviewed. The three declines were the customer's own bank, not card testing." });

  assert.equal(lifted.inForce, false);
  assert.ok(lifted.liftedAt);
  assert.equal(lifted.liftedBy, admin.userId);
  assert.match(lifted.liftReason, /not card testing/);
  assert.equal(await userStatus(userId), "active");

  // The original reason is still readable. Nothing was erased to tidy up.
  const history = await restrictions.restrictionHistory(userId);
  assert.equal(history.length, 1);
  assert.match(history[0].reason, /card-testing rule/);
  assert.equal(await (await restrictions.customerFacingRestriction(userId)).restricted, false);
});

test("LIFTING RESTORES THE STATUS THE ACCOUNT ACTUALLY HAD", async () => {
  // An account that was dormant before a fraud review should not be promoted
  // to active by the review ending.
  const admin = await makeAdmin();
  const userId = await makeCustomer("inactive");
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "fraud_suspected", reason: "Reviewed after a dormant-account login attempt." });
  assert.equal(await userStatus(userId), "suspended");
  await restrictions.liftRestriction(admin, userId, { reason: "Review closed with no finding against the customer." });
  assert.equal(await userStatus(userId), "inactive", "back to dormant, not promoted to active");
});

test("lifting requires its own written reason", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "aml_review", reason: "Structuring pattern across four days." });
  await assert.rejects(() => restrictions.liftRestriction(admin, userId, { reason: "ok" }), /Why it is being lifted/i);
  await assert.rejects(() => restrictions.liftRestriction(admin, userId, {}), /Why it is being lifted/i);
  assert.equal(await userStatus(userId), "suspended", "still restricted");
});

test("lifting an account with nothing in force is a 404, not a silent success", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await assert.rejects(
    () => restrictions.liftRestriction(admin, userId, { reason: "Nothing here to lift, as it happens." }),
    (error) => {
      assert.equal(error.statusCode, 404);
      return true;
    });
});

test("THE OLD REASONLESS SUSPEND IS RECORDED, NOT INVISIBLE", async () => {
  // The admin console still posts /users/:id/suspend with an empty body.
  // Requiring a reason there would break that button between the API and the
  // console deploying, so it keeps working - but it lands in the queue under
  // a category that reads as the gap it is.
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  const recorded = await restrictions.recordUnspecifiedRestriction(admin, userId, "suspended");
  assert.equal(recorded.category, "unspecified");
  assert.equal(recorded.categoryLabel, "No reason recorded");
  assert.equal(recorded.disclosable, false, "and it is not disclosed to the customer either");
  assert.match(recorded.reason, /Needs review/);

  const open = await restrictions.openRestrictions({ category: "unspecified" });
  assert.ok(open.some((item) => item.userId === userId), "it shows up in the compliance queue");

  // Re-activating through the same legacy button closes it again.
  await restrictions.liftAnyOpenRestriction(admin, userId, "Re-activated from the admin user list.");
  assert.equal((await restrictions.restrictionHistory(userId))[0].inForce, false);
});

test("the legacy path never double-writes over a real restriction", async () => {
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "sanctions_match", reason: "Possible match on a designated persons list." });
  const second = await restrictions.recordUnspecifiedRestriction(admin, userId, "suspended");
  assert.equal(second, null, "the stated reason is not overwritten by an unspecified one");
  assert.equal((await restrictions.restrictionHistory(userId)).length, 1);
});

test("the compliance queue shows what is in force, oldest first", async () => {
  const admin = await makeAdmin();
  const first = await makeCustomer();
  await restrictions.restrictAccount(admin, first, {
    status: "suspended", category: "aml_review", reason: "First case, opened earliest of the two." });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await makeCustomer();
  await restrictions.restrictAccount(admin, second, {
    status: "suspended", category: "aml_review", reason: "Second case, opened after the first one." });

  const queue = await restrictions.openRestrictions({ category: "aml_review" });
  const firstAt = queue.findIndex((item) => item.userId === first);
  const secondAt = queue.findIndex((item) => item.userId === second);
  assert.ok(firstAt >= 0 && secondAt > firstAt, "the one open longest is nearest the top");
  assert.ok(queue[firstAt].fullName, "with a name a reviewer can act on");
});

test("THIS SERVICE CONTAINS NO DELETE AT ALL", () => {
  // The point of the whole file. A purge added later, however well meant,
  // would take the FICA records with it.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "account-restriction-service.js"), "utf8");
  assert.ok(!/\bDELETE\s+FROM\b/i.test(source), "no DELETE statement");
  assert.ok(!/\bTRUNCATE\b/i.test(source), "no TRUNCATE");
  assert.ok(!/\bDROP\s+TABLE\b/i.test(source), "no DROP TABLE");
});

test("and the closure path still deletes nothing either", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "account-closure-service.js"), "utf8");
  assert.ok(!/\bDELETE\s+FROM\s+users\b/i.test(source), "closing an account never removes the customer");
  assert.match(source, /status = 'closed'/, "it sets a status instead");
});

test("every category names statuses that exist, and every status has a customer sentence", () => {
  for (const category of reference.RESTRICTION_CATEGORIES) {
    assert.ok(category.statuses.length > 0, `${category.key} must apply to something`);
    for (const status of category.statuses) {
      assert.ok(reference.isAccountStatus(status), `${category.key} names unknown status "${status}"`);
      assert.ok(reference.isRestrictedStatus(status), `${category.key} names "${status}", which is not a restriction`);
    }
    assert.equal(typeof category.disclose, "boolean", `${category.key} must decide about tipping off`);
    assert.ok(category.label && category.says, `${category.key} needs a label and a sentence`);
  }
  for (const status of reference.RESTRICTED_STATUSES) {
    assert.ok(reference.customerMessageFor(status), `${status} needs something to tell the customer`);
  }
});

test("THE SENSITIVE CATEGORIES ARE THE ONES THAT CANNOT BE DISCLOSED", () => {
  // Stated as a list rather than left to whoever edits the config next.
  for (const key of ["aml_review", "fraud_suspected", "sanctions_match", "law_enforcement", "unspecified"]) {
    assert.equal(reference.mayDiscloseReason(key), false, `${key} must never be explained to the customer`);
  }
  for (const key of ["dormant", "customer_request", "deceased_estate", "chargeback_abuse", "terms_breach"]) {
    assert.equal(reference.mayDiscloseReason(key), true, `${key} may be explained`);
  }
});

test("the schema heals itself if the table is missing", async () => {
  await pool.query("DROP TABLE IF EXISTS account_restrictions CASCADE");
  restrictions.resetRestrictionSchemaCache();
  const admin = await makeAdmin();
  const userId = await makeCustomer();
  await restrictions.restrictAccount(admin, userId, {
    status: "suspended", category: "aml_review", reason: "Rebuilt from nothing and still recorded." });
  assert.equal((await restrictions.restrictionHistory(userId)).length, 1);
});

test.after(async () => { await pool.end().catch(() => null); });
