"use strict";

// TO BE LISTED ON TITOPRO, VERIFY YOUR IDENTITY.
//
// The professional is the side receiving money from strangers, repeatedly,
// for services. That is the side the FIC Act cares about and the side where
// an unverified identity turns a marketplace into a laundering channel.
//
// What is defended here:
//
//   1. an unverified professional cannot publish a listing;
//   2. DRAFTING is not gated - somebody writes their profile while their
//      documents are being reviewed;
//   3. the check is the COMPLIANCE tier, not the permissive chat helper that
//      counts anybody holding a wallet number as verified;
//   4. verification lapsing takes a live listing DOWN;
//   5. the back door is shut - a job cannot be sent to an unlisted person;
//   6. every listing a customer can see is verified, by construction.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const profiles = require("../src/services/titopro-profile-service");
const jobs = require("../src/services/titopro-service");
const restrictions = require("../src/services/account-restriction-service");
const { isVerifiedTitoPayUser } = require("../src/lib/chat-policy");

let sequence = 0;
async function makeUser({ fica = "pending", status = "active" } = {}) {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Sipho Ndlovu',$2,$3,$4,'personal',$5,$6,'x')`,
    [id, `pro_${tag}`, `pro_${tag}@test.local`, `+2782${tag}`.slice(0, 13), status, fica]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',0)`,
    [uuidv4(), id, tag.slice(0, 10)]);
  return { userId: id, ipAddress: "127.0.0.1", userAgent: "node-test" };
}

async function makeAdmin() {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Compliance',$2,$3,'super_admin','x','active')`,
    [id, `adm_${tag}`, `adm_${tag}@titopay.test`]);
  return { userId: id, userType: "admin", ipAddress: "127.0.0.1", userAgent: "node-test" };
}

const DRAFT = {
  professions: ["plumber"], headline: "Drains and geysers, Soweto",
  bio: "Fifteen years on the tools.", suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25
};

test.before(() => profiles.ensureProfileSchema());

test("AN UNVERIFIED PROFESSIONAL CANNOT PUBLISH", async () => {
  const pro = await makeUser({ fica: "pending" });
  await profiles.saveProfile(pro, DRAFT);
  await assert.rejects(() => profiles.publishProfile(pro), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details?.code, "fica_required");
    assert.match(error.message, /Complete your FICA verification/i);
    return true;
  });
  const { profile } = await profiles.getMyProfile(pro);
  assert.equal(profile.status, "draft", "and the listing stays a draft");
  assert.equal(profile.ficaVerified, false);
});

test("DRAFTING IS NOT GATED - write the profile while the documents are reviewed", async () => {
  const pro = await makeUser({ fica: "submitted" });
  const saved = await profiles.saveProfile(pro, DRAFT);
  assert.equal(saved.status, "draft");
  assert.equal(saved.headline, "Drains and geysers, Soweto");
  assert.equal(saved.canPublish, false);
  assert.match(saved.blockers[0], /Complete your FICA verification/i,
    "and they are told exactly what to go and do");
});

test("A VERIFIED PROFESSIONAL GOES LIVE", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  const published = await profiles.publishProfile(pro);
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);
  assert.ok(published.ficaVerifiedAt, "and what was true when it went live is recorded");
  assert.equal(published.ficaVerified, true);
});

test("both spellings the platform uses for a verified identity are accepted", async () => {
  // compliance-service treats verified, approved, complete and completed as
  // the FICA-verified tier. The admin review writes 'approved'; other paths
  // have written 'verified'. A listing must not depend on which.
  for (const fica of ["approved", "verified", "complete", "completed"]) {
    const pro = await makeUser({ fica });
    await profiles.saveProfile(pro, DRAFT);
    assert.equal((await profiles.publishProfile(pro)).status, "published", `fica_status=${fica}`);
  }
});

test("A REJECTED VERIFICATION IS TOLD TO CONTACT SUPPORT, NOT TO TRY AGAIN", async () => {
  const pro = await makeUser({ fica: "rejected" });
  await profiles.saveProfile(pro, DRAFT);
  await assert.rejects(() => profiles.publishProfile(pro), /Contact TitoPay support/i);
});

test("THE PERMISSIVE CHAT CHECK WOULD HAVE ADMITTED EVERYBODY", async () => {
  // lib/chat-policy.js is the helper that looks right for this and is the
  // wrong one: it counts a user as verified merely for HOLDING A WALLET
  // NUMBER. This test exists so that if somebody swaps the gate for it, the
  // difference is visible rather than silent.
  const unverified = await makeUser({ fica: "pending" });
  const { rows } = await pool.query(
    `SELECT u.*, w.wallet_number FROM users u
       JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`, [unverified.userId]);

  assert.equal(isVerifiedTitoPayUser(rows[0]), true,
    "the chat helper says yes to an unverified professional with a wallet");
  assert.equal((await profiles.listingEligibility(unverified.userId)).ficaVerified, false,
    "the listing gate says no, which is the whole point");

  // And the gate reads the compliance tier rather than re-deriving one.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "titopro-profile-service.js"), "utf8");
  assert.match(source, /tierForUserRow/, "the compliance engine decides what verified means");
  assert.ok(!/isVerifiedTitoPayUser/.test(source.replace(/\/\/.*$/gm, "")),
    "and the chat helper is not used outside the comment that warns about it");
});

test("A SUSPENDED ACCOUNT CANNOT PUBLISH EVEN WHEN FICA IS APPROVED", async () => {
  // Verified is not the same as in good standing.
  const pro = await makeUser({ fica: "approved", status: "suspended" });
  await profiles.saveProfile(pro, DRAFT);
  await assert.rejects(() => profiles.publishProfile(pro), (error) => {
    assert.match(error.message, /not active/i);
    return true;
  });
});

test("VERIFICATION LAPSING TAKES A LIVE LISTING DOWN", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await profiles.publishProfile(pro);

  // The admin FICA review comes back rejected the next morning.
  await pool.query("UPDATE users SET fica_status = 'rejected' WHERE id = $1", [pro.userId]);
  const result = await profiles.enforceVerificationStillHolds(pro.userId, { reason: "FICA verification was not approved." });

  assert.equal(result.changed, true);
  assert.equal(result.profile.status, "suspended");
  assert.match(result.profile.unpublishedReason, /not approved/i);
  assert.equal((await profiles.searchProfessionals({ profession: "plumber" }))
    .some((item) => item.userId === pro.userId), false, "and it is gone from discovery");
});

test("A RESTRICTION TAKES THE LISTING DOWN TOO", async () => {
  // Wired into restrictAccount, so a fraud suspension stops TitoPay sending
  // that person any more work.
  const admin = await makeAdmin();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await profiles.publishProfile(pro);

  await restrictions.restrictAccount(admin, pro.userId, {
    status: "suspended", category: "fraud_suspected",
    reason: "Three customers reported paying for work that was never done."
  });
  const { profile } = await profiles.getMyProfile(pro);
  assert.equal(profile.status, "suspended", "the listing came down with the account");
});

test("enforcing does nothing to a listing that is still entitled to be up", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await profiles.publishProfile(pro);
  assert.deepEqual(await profiles.enforceVerificationStillHolds(pro.userId), { changed: false });
  assert.equal((await profiles.getMyProfile(pro)).profile.status, "published");
});

test("THE BACK DOOR IS SHUT - no job to an unlisted professional", async () => {
  // Without this the FICA requirement would guard only the browse screen: a
  // job posted straight at a user id would reach somebody who never verified.
  const customer = await makeUser({ fica: "approved" });
  const unlisted = await makeUser({ fica: "pending" });
  await profiles.saveProfile(unlisted, DRAFT);

  await assert.rejects(
    () => jobs.createJob(customer, {
      profession: "plumber", professionalUserId: unlisted.userId, title: "Blocked drain" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details?.code, "not_listed");
      return true;
    });

  // Once they verify and publish, the same request works.
  await pool.query("UPDATE users SET fica_status = 'approved' WHERE id = $1", [unlisted.userId]);
  await profiles.publishProfile(unlisted);
  const job = await jobs.createJob(customer, {
    profession: "plumber", professionalUserId: unlisted.userId, title: "Blocked drain" });
  assert.equal(job.status, "requested");
});

test("a job to a SUSPENDED listing is refused as well", async () => {
  const admin = await makeAdmin();
  const customer = await makeUser({ fica: "approved" });
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await profiles.publishProfile(pro);
  await restrictions.restrictAccount(admin, pro.userId, {
    status: "suspended", category: "terms_breach", reason: "Working off-platform after taking the lead." });

  await assert.rejects(
    () => jobs.createJob(customer, { profession: "plumber", professionalUserId: pro.userId, title: "Leaking tap" }),
    /not currently listed/i);
});

test("EVERY LISTING A CUSTOMER CAN SEE IS VERIFIED, BY CONSTRUCTION", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, { ...DRAFT, city: "Soweto" });
  await profiles.publishProfile(pro);

  const found = await profiles.searchProfessionals({ profession: "plumber", city: "Soweto" });
  const mine = found.find((item) => item.userId === pro.userId);
  assert.ok(mine, "published listings are discoverable");
  assert.equal(mine.ficaVerified, true);
  assert.equal(mine.name, "Sipho Ndlovu");
  assert.deepEqual(mine.professionLabels, ["Plumber"]);
  // Drafts are visible to nobody.
  const drafter = await makeUser({ fica: "pending" });
  await profiles.saveProfile(drafter, { ...DRAFT, city: "Soweto" });
  assert.equal(found.concat(await profiles.searchProfessionals({ city: "Soweto" }))
    .some((item) => item.userId === drafter.userId), false);
});

test("THE DATABASE REFUSES A PUBLISHED LISTING WITH NO VERIFICATION RECORDED", async () => {
  // A constraint rather than trusting every future code path to remember.
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await assert.rejects(
    () => pool.query("UPDATE titopro_profiles SET status = 'published' WHERE user_id = $1", [pro.userId]),
    /titopro_profiles_published_is_verified/);
});

test("a listing needs a service and an area before it can go live", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, { professions: [], city: "Soweto" });
  await assert.rejects(() => profiles.publishProfile(pro), /at least one service/i);
  await profiles.saveProfile(pro, { professions: ["plumber"] });
  await assert.rejects(() => profiles.publishProfile(pro), /area you work in/i);
});

test("an unknown profession cannot be listed", async () => {
  const pro = await makeUser({ fica: "approved" });
  await assert.rejects(() => profiles.saveProfile(pro, { professions: ["astronaut"] }),
    /is not a TitoPro profession/i);
  await assert.rejects(() => profiles.saveProfile(pro, { professions: ["plumber", "wizard"] }),
    /is not a TitoPro profession/i);
});

test("the listing says which of its services need more than an identity check", async () => {
  // A plumber is identity. A day nanny is alone with a child, and the listing
  // surfaces that so the requirement cannot be forgotten at review time.
  const pro = await makeUser({ fica: "approved" });
  const saved = await profiles.saveProfile(pro, { ...DRAFT, professions: ["plumber", "day_nanny", "cleaner"] });
  assert.deepEqual(saved.enhancedVettingProfessions.sort(), ["cleaner", "day_nanny"]);
});

test("pausing is the professional's own choice and needs no verification", async () => {
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  await profiles.publishProfile(pro);
  assert.equal((await profiles.pauseProfile(pro)).status, "paused");
  assert.equal((await profiles.searchProfessionals({ profession: "plumber" }))
    .some((item) => item.userId === pro.userId), false);
  assert.equal((await profiles.publishProfile(pro)).status, "published", "and they can come back");
});

test("the schema heals itself if the table is missing", async () => {
  await pool.query("DROP TABLE IF EXISTS titopro_profiles CASCADE");
  profiles.resetProfileSchemaCache();
  const pro = await makeUser({ fica: "approved" });
  await profiles.saveProfile(pro, DRAFT);
  assert.equal((await profiles.publishProfile(pro)).status, "published");
});

test.after(async () => { await pool.end().catch(() => null); });
