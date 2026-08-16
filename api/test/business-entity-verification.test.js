"use strict";

// ONE VERIFIED PERSON, THREE LEGITIMATE BUSINESSES.
//
// This is the claim the whole change rests on, so it is proven against a real
// database and a real HTTP server rather than asserted in a comment.
//
// The old shape said the opposite. A business account was a `users` row, its
// FICA pack carried the owner's ID number, and the identity check refuses a
// document that already anchors another account — so the second business a
// person tried to verify collided with the first. Every test below is a
// consequence of pulling the entity, the person and the relationship apart.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");
const { ensureBusinessSchema } = require("../src/services/business-verification-service");

const TAG = "bizverify";
const owner = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const stranger = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const unverified = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };

async function seedUser(user, suffix, { verified = true } = {}) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business',$2,$3,$4,$5,'x','active',FALSE,'pending')`,
    [user.id, `${TAG} ${suffix}`, `${TAG}_${suffix}`, `${TAG}_${suffix}@example.invalid`,
      `2712000${Math.floor(1000 + Math.random() * 8999)}`]
  );
  if (verified) {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS basic_verified_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_hash TEXT");
    await pool.query(
      "UPDATE users SET basic_verified_at = NOW(), id_number_hash = $2 WHERE id = $1",
      [user.id, `${TAG}-hash-${suffix}`]
    );
  }
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]
  );
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function cleanup() {
  for (const u of [owner, stranger, unverified]) {
    await pool.query(
      `DELETE FROM business_verifications WHERE business_id IN
         (SELECT id FROM business_profiles WHERE account_user_id = $1)`, [u.id]).catch(() => {});
    await pool.query("DELETE FROM business_profiles WHERE account_user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => {});
  }
}

test.before(async () => {
  await ensureBusinessSchema();
  await cleanup();
  await seedUser(owner, "owner");
  await seedUser(stranger, "stranger");
  await seedUser(unverified, "newbie", { verified: false });
});
test.after(async () => { await cleanup(); await pool.end(); });

let server;
let baseUrl;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

function call(method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
const addBusiness = (token, body) => call("POST", "/v1/business/verification/businesses", token, body);

test("one verified person can hold three separate businesses", async () => {
  const submitted = [
    { businessName: `${TAG} Spaza`, businessType: "sole_proprietor", role: "owner" },
    { businessName: `${TAG} Transport`, businessType: "private_company", registrationNumber: "2020/123456/07", role: "director" },
    { businessName: `${TAG} Stokvel Admin`, businessType: "close_corporation", registrationNumber: "CK1998/044556/23", role: "member" }
  ];
  for (const body of submitted) {
    const response = await addBusiness(owner.token, body);
    assert.equal(response.status, 201, `${body.businessName} was accepted: ${await response.text()}`);
  }

  const overview = await (await call("GET", "/v1/business/verification", owner.token)).json();
  assert.equal(overview.businesses.length, 3, "the same person holds all three");
  assert.deepEqual(overview.businesses.map((b) => b.yourRole).sort(), ["director", "member", "owner"]);
  // Each business carries its OWN identity, and they are all different.
  const ids = new Set(overview.businesses.map((b) => b.id));
  assert.equal(ids.size, 3, "three distinct business identities");

  // And the person was verified exactly once. Nothing above created a second
  // personal identity, and the account's own document hash is untouched.
  const { rows } = await pool.query(
    "SELECT id_number_hash, basic_verified_at FROM users WHERE id = $1", [owner.id]);
  assert.equal(rows[0].id_number_hash, `${TAG}-hash-owner`, "the person's identity was not rewritten");
  assert.ok(rows[0].basic_verified_at, "and it is still the one verification they ever did");
  const { rows: verifications } = await pool.query(
    "SELECT COUNT(*)::INT AS n FROM kyc_verifications WHERE user_id = $1", [owner.id]);
  assert.equal(verifications[0].n, 0, "registering a business creates no personal KYC record at all");
});

test("a business type with no registration number is never asked for one", async () => {
  // A spaza owner, a hawker or a freelancer cannot produce a CIPC number.
  const informal = await addBusiness(owner.token, {
    businessName: `${TAG} Hawker`, businessType: "informal_trader", role: "owner"
  });
  assert.equal(informal.status, 201);
  const body = await informal.json();
  assert.equal(body.business.registrationNumber, null);
  assert.equal(body.business.requiresRegistrationNumber, false);

  // A registered type, by contrast, must supply it.
  const missing = await addBusiness(owner.token, {
    businessName: `${TAG} Missing Number`, businessType: "private_company", role: "director"
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error || "", /registration number/i);
});

test("a personal identity number can never be a business identifier", async () => {
  const response = await addBusiness(owner.token, {
    businessName: `${TAG} Confused`, businessType: "private_company",
    registrationNumber: "8001015009087", role: "owner"
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error || "", /identifies the business itself, not a person/i);
});

test("the business door refuses an identity document outright", async () => {
  // Sending one here would create a second identity for the same human being.
  const response = await addBusiness(owner.token, {
    businessName: `${TAG} Wrong Door`, businessType: "sole_proprietor",
    role: "owner", idNumber: "8001015009087"
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error || "", /verified separately, and only once/i);
});

test("two businesses cannot claim the same registration number", async () => {
  const response = await addBusiness(stranger.token, {
    businessName: `${TAG} Impostor`, businessType: "private_company",
    registrationNumber: "2020/123456/07", role: "owner"
  });
  assert.equal(response.status, 409);
  const message = (await response.json()).error || "";
  assert.match(message, /already on TitoPay/i);
  // And it says nothing whatsoever about the person who registered it.
  assert.doesNotMatch(message, new RegExp(TAG, "i"));
});

test("business verification is never auto-passed", async () => {
  const overview = await (await call("GET", "/v1/business/verification", owner.token)).json();
  const target = overview.businesses.find((b) => b.businessType === "private_company");
  const response = await call("POST", `/v1/business/verification/businesses/${target.id}/submit`, owner.token, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  // TitoPay has no register lookup, so a business goes to a human. It must not
  // come back verified, and it must not come back with a fabricated reference.
  assert.notEqual(body.business.verificationStatus, "verified");
  assert.equal(body.business.verificationStatus, "review_required");
  assert.equal(body.authorisedPerson.identityVerified, true);
  const { rows } = await pool.query(
    "SELECT status, assurance, provider_reference FROM business_verifications WHERE business_id = $1", [target.id]);
  assert.equal(rows[0].status, "review_required");
  assert.equal(rows[0].assurance, "manual");
  assert.equal(rows[0].provider_reference, null, "no reference is invented for a check that did not happen");
});

test("a business cannot be seen or submitted by someone with no relationship to it", async () => {
  const mine = await (await call("GET", "/v1/business/verification", owner.token)).json();
  const theirs = await (await call("GET", "/v1/business/verification", stranger.token)).json();
  assert.ok(mine.businesses.length > 0);
  assert.equal(theirs.businesses.length, 0, "authorisation follows the relationship, not the account type");
  const response = await call("POST",
    `/v1/business/verification/businesses/${mine.businesses[0].id}/submit`, stranger.token, {});
  assert.equal(response.status, 404);
});

test("a business is registered by a verified person, and the app is told which", async () => {
  const overview = await (await call("GET", "/v1/business/verification", unverified.token)).json();
  assert.equal(overview.person.identityVerified, false);
  assert.match(overview.person.note, /only ever do that once/i);
  const response = await addBusiness(unverified.token, {
    businessName: `${TAG} Too Early`, businessType: "sole_proprietor", role: "owner"
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error || "", /Verify your own identity first/i);
});

test("KYB is its own axis and never quotes a limit as automatic", async () => {
  const overview = await (await call("GET", "/v1/business/verification", owner.token)).json();
  // The business status is a KYB status, not a KYC tier, not a risk rating.
  for (const business of overview.businesses) {
    assert.ok(["unverified", "pending", "review_required", "verified", "rejected"]
      .includes(business.verificationStatus));
    // An internal risk rating must never reach a customer.
    assert.doesNotMatch(JSON.stringify(business), /elevated|high_risk|edd_review/);
  }
  assert.match(overview.limitsNote, /applicable compliance requirements/i);
  assert.doesNotMatch(overview.limitsNote, /guaranteed|automatically/i);
});
