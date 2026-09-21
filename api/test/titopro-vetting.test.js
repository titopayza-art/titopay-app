"use strict";

// FICA IS IDENTITY. IT IS NOT A BACKGROUND CHECK.
//
// Somebody can be perfectly identified and still be unsuitable to be alone
// with a child or to hold the keys to an empty house. So the professions
// marked `enhanced` in the TitoPro catalogue - a cleaner, a tutor, a
// locksmith - need cleared checks on file before they may be listed,
// on top of the FICA verification every professional needs.
//
// What is defended here:
//
//   1. an enhanced profession cannot be listed on FICA alone;
//   2. a standard profession is NOT held to checks it does not need;
//   3. a professional cannot clear themselves;
//   4. an EXPIRED clearance stops counting the moment it lapses, with no
//      window where a stale row is still treated as good;
//   5. a failed or withdrawn check takes a live listing down;
//   6. mixing one enhanced service into a listing gates the whole listing.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const vetting = require("../src/services/titopro-vetting-service");
const profiles = require("../src/services/titopro-profile-service");
const reference = require("../src/config/titopro-reference");

let sequence = 0;
async function makeUser({ fica = "approved" } = {}) {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Nomsa Dube',$2,$3,$4,'personal','active',$5,'x')`,
    [id, `vet_${tag}`, `vet_${tag}@test.local`, `+2782${tag}`.slice(0, 13), fica]);
  return { userId: id, ipAddress: "127.0.0.1", userAgent: "node-test" };
}

async function makeAdmin() {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Compliance',$2,$3,'super_admin','x','active')`,
    [id, `vadm_${tag}`, `vadm_${tag}@titopay.test`]);
  return { userId: id, userType: "admin", ipAddress: "127.0.0.1", userAgent: "node-test" };
}

const listingFor = (professions) => ({
  professions, tradingName: "Sipho's Plumbing", headline: "Available in Soweto", suburb: "Pimville", city: "Soweto"
});

// Clear every check an enhanced profession needs.
async function clearAll(admin, userId, professions) {
  for (const check of new Set(professions.flatMap((key) => reference.requiredChecksFor(key)))) {
    await vetting.recordCheck(admin, userId, {
      checkType: check, status: "cleared",
      evidenceReference: `REF-${check}-0099`,
      note: "Certificate sighted and verified against the original."
    });
  }
}

test.before(async () => {
  await vetting.ensureVettingSchema();
  await profiles.ensureProfileSchema();
});

test("A CLEANER CANNOT BE LISTED ON FICA ALONE", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["cleaner"]));
  await assert.rejects(() => profiles.publishProfile(pro), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details?.code, "vetting_required", "refused for vetting, not for FICA");
    assert.equal(error.details?.ficaVerified, true, "their identity is not in question");
    assert.match(error.message, /Police clearance and References/);
    return true;
  });
});

test("A PLUMBER IS NOT HELD TO CHECKS A PLUMBER DOES NOT NEED", async () => {
  // Somebody who fixes a geyser and leaves is an identity question. Applying
  // childcare vetting to every trade would stop the marketplace before it
  // started, for no gain.
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["plumber", "electrician", "painter"]));
  assert.equal((await profiles.publishProfile(pro)).status, "published");
});

test("CLEARED CHECKS LET THE LISTING GO LIVE", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["cleaner"]));
  await clearAll(admin, pro.userId, ["cleaner"]);

  const published = await profiles.publishProfile(pro);
  assert.equal(published.status, "published");
  assert.equal(published.vettingSatisfied, true);
  assert.deepEqual(published.outstandingChecks, []);
});

test("HALF THE CHECKS IS NOT ENOUGH, and the professional is told which half", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["cleaner"]));
  await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "cleared",
    evidenceReference: "SAPS-2026-88119", note: "Certificate sighted, dated August 2026."
  });

  const { profile } = await profiles.getMyProfile(pro);
  assert.equal(profile.canPublish, false);
  assert.deepEqual(profile.outstandingChecks, ["References"], "only the one still missing");
  await assert.rejects(() => profiles.publishProfile(pro), /References/);
});

test("ONE ENHANCED SERVICE GATES THE WHOLE LISTING", async () => {
  // Otherwise somebody lists as a plumber, goes live, then quietly adds day
  // cleaner to a listing that is already published.
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["plumber", "handyman", "cleaner"]));
  await assert.rejects(() => profiles.publishProfile(pro), /Police clearance/);
});

test("A PROFESSIONAL CANNOT CLEAR THEMSELVES", async () => {
  // recordCheck takes an ADMIN actor. Passing the professional's own actor
  // must not be mistaken for a compliance officer's decision.
  const pro = await makeUser({ fica: "approved" });
  await assert.rejects(
    () => vetting.recordCheck({}, pro.userId, {
      checkType: "police_clearance", status: "cleared",
      evidenceReference: "SELF-1", note: "I checked myself and I am fine." }),
    (error) => {
      assert.equal(error.statusCode, 401);
      return true;
    });
  assert.deepEqual(await vetting.clearedChecks(pro.userId), []);
});

test("A DECISION NEEDS EVIDENCE AND A NOTE", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser();
  await assert.rejects(() => vetting.recordCheck(admin, pro.userId,
    { checkType: "police_clearance", status: "cleared", note: "Looked fine." }),
    /Certificate or case number/i);
  await assert.rejects(() => vetting.recordCheck(admin, pro.userId,
    { checkType: "police_clearance", status: "cleared", evidenceReference: "SAPS-1" }),
    /What was checked/i);
  // A pending marker needs neither - it only says somebody has started.
  const pending = await vetting.recordCheck(admin, pro.userId,
    { checkType: "police_clearance", status: "pending" });
  assert.equal(pending.status, "pending");
  assert.equal(pending.inForce, false);
});

test("AN EXPIRED CLEARANCE STOPS COUNTING THE MOMENT IT LAPSES", async () => {
  // Evaluated against the clock at read time rather than by a sweep, so there
  // is no window in which a stale row is treated as good because a scheduled
  // job has not run yet.
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["tutor"]));
  await clearAll(admin, pro.userId, ["tutor"]);
  assert.equal((await profiles.publishProfile(pro)).status, "published");

  await pool.query(
    `UPDATE titopro_vetting_checks SET expires_at = NOW() - INTERVAL '1 day'
      WHERE user_id = $1 AND check_type = 'police_clearance'`, [pro.userId]);

  assert.equal((await vetting.clearedChecks(pro.userId)).includes("police_clearance"), false);
  const [record] = (await vetting.checksForUser(pro.userId)).filter((c) => c.checkType === "police_clearance");
  assert.equal(record.status, "cleared", "the row still says cleared");
  assert.equal(record.inForce, false, "but it is not in force, which is the field callers read");
  assert.equal(record.expired, true);
});

test("AN EXPIRED CLEARANCE TAKES A LIVE LISTING DOWN", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["cleaner"]));
  await clearAll(admin, pro.userId, ["cleaner"]);
  await profiles.publishProfile(pro);

  await pool.query(
    "UPDATE titopro_vetting_checks SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1", [pro.userId]);
  const result = await profiles.enforceVerificationStillHolds(pro.userId);

  assert.equal(result.changed, true, "a clearance that ran out is not a smaller problem than one never obtained");
  assert.equal(result.profile.status, "suspended");
  assert.equal((await profiles.searchProfessionals({ profession: "cleaner" }))
    .some((item) => item.userId === pro.userId), false);
});

test("A FAILED CHECK TAKES THE LISTING DOWN IMMEDIATELY", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["cleaner"]));
  await clearAll(admin, pro.userId, ["cleaner"]);
  await profiles.publishProfile(pro);

  await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "failed",
    evidenceReference: "SAPS-2026-88120",
    note: "Certificate returned with a relevant conviction. Not suitable for in-home work."
  });
  assert.equal((await profiles.getMyProfile(pro)).profile.status, "suspended",
    "no sweep needed - it comes down with the decision");
});

test("a standard profession is unaffected by somebody else's failed check", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["plumber"]));
  await profiles.publishProfile(pro);
  await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "failed",
    evidenceReference: "SAPS-X", note: "Irrelevant to the work this person is listed for." });
  assert.equal((await profiles.getMyProfile(pro)).profile.status, "published",
    "a plumber's listing does not rest on a check a plumber never needed");
});

test("THE DATABASE REFUSES A CLEARANCE WITH NO EXPIRY", async () => {
  // A clearance nobody ever revisits is not a control.
  const pro = await makeUser();
  await assert.rejects(() => pool.query(
    `INSERT INTO titopro_vetting_checks (id, user_id, check_type, status, decided_at)
     VALUES ($1,$2,'police_clearance','cleared',NOW())`, [uuidv4(), pro.userId]),
    /titopro_vetting_cleared_is_dated/);
});

test("the validity period comes from configuration, not from this code", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser();
  const record = await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "cleared",
    evidenceReference: "SAPS-2026-1", note: "Sighted against the original document." });
  const expected = reference.vettingCheck("police_clearance").validDays;
  const days = Math.round((new Date(record.expiresAt) - Date.now()) / 86400000);
  assert.ok(Math.abs(days - expected) <= 1, `expected about ${expected} days, got ${days}`);
  // And an officer may set a shorter one for a particular case.
  const shorter = await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "cleared", validDays: 90,
    evidenceReference: "SAPS-2026-2", note: "Shortened pending a second reference." });
  assert.ok(Math.abs(Math.round((new Date(shorter.expiresAt) - Date.now()) / 86400000) - 90) <= 1);
});

test("re-clearing replaces the record rather than stacking a second one", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser();
  await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "cleared",
    evidenceReference: "SAPS-OLD", note: "First certificate, now superseded." });
  await vetting.recordCheck(admin, pro.userId, {
    checkType: "police_clearance", status: "cleared",
    evidenceReference: "SAPS-NEW", note: "Renewal certificate sighted." });
  const all = await vetting.checksForUser(pro.userId);
  assert.equal(all.filter((c) => c.checkType === "police_clearance").length, 1,
    "one live answer to the question of whether this person is cleared");
  assert.equal(all[0].evidenceReference, "SAPS-NEW");
});

test("an unknown check type or outcome is refused", async () => {
  const admin = await makeAdmin();
  const pro = await makeUser();
  await assert.rejects(() => vetting.recordCheck(admin, pro.userId,
    { checkType: "vibes_check", status: "cleared" }), /Check type is invalid/i);
  await assert.rejects(() => vetting.recordCheck(admin, pro.userId,
    { checkType: "police_clearance", status: "probably_fine" }), /Check outcome is invalid/i);
});

test("THE COMPLIANCE QUEUES ARE USABLE", async () => {
  const admin = await makeAdmin();
  const waiting = await makeUser();
  await vetting.recordCheck(admin, waiting.userId, { checkType: "reference_check", status: "pending" });
  const pending = await vetting.pendingChecks();
  const mine = pending.find((item) => item.userId === waiting.userId);
  assert.ok(mine, "a started check is in the queue");
  assert.equal(mine.fullName, "Nomsa Dube", "with a name an officer can act on");

  // And clearances about to run out, so somebody can be asked BEFORE the
  // listing drops rather than after.
  const soon = await makeUser();
  await vetting.recordCheck(admin, soon.userId, {
    checkType: "police_clearance", status: "cleared", validDays: 10,
    evidenceReference: "SAPS-SOON", note: "Short renewal, expiring shortly." });
  assert.ok((await vetting.expiringSoon({ withinDays: 30 })).some((item) => item.userId === soon.userId));
  assert.ok(!(await vetting.expiringSoon({ withinDays: 5 })).some((item) => item.userId === soon.userId));
});

test("the shortfall is empty for a listing that needs nothing", async () => {
  const pro = await makeUser();
  assert.deepEqual(await vetting.vettingShortfall(pro.userId, ["plumber", "painter"]),
    { satisfied: true, missing: [], required: [] });
});

test("every enhanced profession names checks that exist", () => {
  for (const item of reference.PROFESSIONS) {
    const required = reference.requiredChecksFor(item.key);
    if (item.vetting === "enhanced") {
      assert.ok(required.length > 0, `${item.key} is enhanced but requires nothing`);
    } else {
      assert.deepEqual(required, [], `${item.key} is standard and must require nothing`);
    }
    for (const check of required) {
      assert.ok(reference.vettingCheck(check), `${item.key} names unknown check "${check}"`);
    }
  }
});

test("DAY NANNIES ARE WITHDRAWN, AND WITHDRAWING FAILS CLOSED", async () => {
  // Childcare is not a harder version of cleaning. It was removed - and the
  // removal itself is the interesting part: professions is a TEXT[] with no
  // foreign key, and requiredChecksFor returns an EMPTY list for a key it does
  // not recognise. So a listing saved before the withdrawal, still carrying
  // that key, would have published with NO background checks at all. The
  // removal would have opened exactly the hole the vetting closes.
  assert.equal(reference.isProfession("day_nanny"), false, "no longer offered");
  assert.deepEqual(reference.requiredChecksFor("day_nanny"), [],
    "and an unknown key requires nothing, which is why the guard below exists");

  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["plumber"]));
  // Written straight to the column, exactly as a listing saved before the
  // withdrawal would already read.
  await pool.query(
    "UPDATE titopro_profiles SET professions = ARRAY['plumber','day_nanny'] WHERE user_id = $1",
    [pro.userId]);

  await assert.rejects(() => profiles.publishProfile(pro), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.details?.code, "profession_withdrawn");
    assert.deepEqual(error.details?.withdrawn, ["day_nanny"]);
    assert.match(error.message, /no longer lists day nanny/i);
    return true;
  });
});

test("A LIVE LISTING OFFERING A WITHDRAWN PROFESSION COMES DOWN", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, listingFor(["plumber"]));
  await profiles.publishProfile(pro);
  // The withdrawal happens after somebody is already live.
  await pool.query(
    "UPDATE titopro_profiles SET professions = ARRAY['plumber','day_nanny'] WHERE user_id = $1",
    [pro.userId]);

  const result = await profiles.enforceVerificationStillHolds(pro.userId);
  assert.equal(result.changed, true, "leaving it up would advertise work TitoPay decided not to carry");
  assert.equal(result.profile.status, "suspended");
});

test("the schema heals itself if the table is missing", async () => {
  await pool.query("DROP TABLE IF EXISTS titopro_vetting_checks CASCADE");
  vetting.resetVettingSchemaCache();
  const admin = await makeAdmin();
  const pro = await makeUser();
  const record = await vetting.recordCheck(admin, pro.userId, {
    checkType: "reference_check", status: "cleared",
    evidenceReference: "REF-REBUILD", note: "Two references contacted and confirmed." });
  assert.equal(record.inForce, true);
});

test.after(async () => { await pool.end().catch(() => null); });
