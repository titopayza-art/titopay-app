"use strict";

// TITOPRO OVER HTTP, WHICH IS THE ONLY WAY ANYBODY REACHES IT.
//
// Every service behind TitoPro was built and tested before a single route
// existed, so all of it was unreachable: no listing could be published, no
// professional found, no job raised. A feature with no door is not a feature.
//
// This drives the whole thing through the mounted router the way the app
// will, and defends the things a route layer gets wrong:
//
//   1. the actor comes from the TOKEN, never from the request body - a
//      userId taken from the body would make every ownership check in the
//      services decorative;
//   2. the gates survive the trip - an unverified professional is refused at
//      the endpoint, not only in the service;
//   3. each step of a job is its own route, so the state machine is not
//      handed to whoever is calling;
//   4. the catalogue tells a professional what listing will require BEFORE
//      they fill the form in.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { v4: uuidv4 } = require("uuid");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");
const profiles = require("../src/services/titopro-profile-service");
const vetting = require("../src/services/titopro-vetting-service");
const pricing = require("../src/services/pricing-service");
const reference = require("../src/config/titopro-reference");

let server;
let base;
test.before(async () => {
  await profiles.ensureProfileSchema();
  await vetting.ensureVettingSchema();
  await require("../src/services/titopro-service").ensureTitoProSchema();
  await pricing.applyTitoProPricingOnce();
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/v1/titopro`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => null);
});

let sequence = 0;
// A real user, a real session row and a real signed token - the request goes
// through requireAuth exactly as the app's would.
async function signedIn({ fica = "approved" } = {}) {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Sipho Ndlovu',$2,$3,$4,'personal','active',$5,'x')`,
    [id, `http_${tag}`, `http_${tag}@test.local`, `+2782${tag}`.slice(0, 13), fica]);
  const sessionId = uuidv4();
  const jti = uuidv4();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer',$3,$4, NOW() + INTERVAL '1 day')`,
    [sessionId, id, crypto.randomUUID(), jti]);
  const token = signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer", scope: "customer" });
  return { userId: id, token };
}

function call(actor, path, { method = "GET", body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (response) => ({ status: response.status, payload: await response.json().catch(() => ({})) }));
}

const LISTING = {
  professions: ["plumber"], headline: "Drains and geysers, Soweto",
  suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25
};

test("THE DOOR IS SHUT TO ANYBODY WITHOUT A TOKEN", async () => {
  for (const path of ["/professions", "/me/listing", "/search", "/jobs"]) {
    const { status } = await call(null, path);
    assert.equal(status, 401, `${path} must require a signed-in caller`);
  }
});

test("THE CATALOGUE TELLS A PROFESSIONAL WHAT LISTING WILL REQUIRE", async () => {
  const actor = await signedIn();
  const { status, payload } = await call(actor, "/professions");
  assert.equal(status, 200);
  assert.equal(payload.professions.length, reference.PROFESSION_KEYS.length);
  assert.equal(payload.shapes.length, 4);

  const plumber = payload.professions.find((item) => item.key === "plumber");
  assert.equal(plumber.usesDiary, true);
  assert.deepEqual(plumber.requiredChecks, [], "a plumber needs identity and nothing more");

  const cleaner = payload.professions.find((item) => item.key === "cleaner");
  assert.deepEqual(cleaner.requiredChecks.map((c) => c.key), ["police_clearance", "reference_check"]);
  assert.match(cleaner.requiredChecks[0].says, /SAPS/,
    "and says what the check actually is, before the form is filled in");

  assert.equal(payload.professions.some((item) => item.key === "day_nanny"), false);
});

test("A LISTING GOES UP AND IS FOUND - the whole professional journey", async () => {
  const pro = await signedIn({ fica: "approved" });

  const draft = await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  assert.equal(draft.status, 200);
  assert.equal(draft.payload.profile.status, "draft");

  const live = await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal(live.status, 200);
  assert.equal(live.payload.profile.status, "published");

  const found = await call(pro, "/search?profession=plumber&city=Soweto");
  assert.equal(found.status, 200);
  const mine = found.payload.professionals.find((item) => item.userId === pro.userId);
  assert.ok(mine, "and a customer can find them");
  assert.equal(mine.ficaVerified, true);

  const paused = await call(pro, "/me/listing/pause", { method: "POST" });
  assert.equal(paused.payload.profile.status, "paused");
  const gone = await call(pro, "/search?profession=plumber&city=Soweto");
  assert.equal(gone.payload.professionals.some((item) => item.userId === pro.userId), false);
});

test("THE FICA GATE SURVIVES THE TRIP TO THE ENDPOINT", async () => {
  const pro = await signedIn({ fica: "pending" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  const { status, payload } = await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal(status, 403);
  assert.equal(payload.details?.code, "fica_required");
  assert.match(payload.error, /Complete your FICA verification/i);
});

test("THE VETTING GATE SURVIVES IT TOO", async () => {
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: { ...LISTING, professions: ["cleaner"] } });
  const { status, payload } = await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal(status, 403);
  assert.equal(payload.details?.code, "vetting_required");
  assert.match(payload.error, /Police clearance and References/);

  // And the professional can see their own outstanding checks to act on them.
  const own = await call(pro, "/me/vetting");
  assert.equal(own.status, 200);
  assert.deepEqual(own.payload.checks, [], "nothing on file yet, which is why they are blocked");
});

test("A WHOLE JOB, END TO END, OVER HTTP", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });

  const created = await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId,
    title: "Blocked kitchen drain", suburb: "Pimville", city: "Soweto" } });
  assert.equal(created.status, 201);
  const jobId = created.payload.job.id;
  assert.match(created.payload.job.reference, /^TP-J-[A-HJ-NP-Z2-9]{8}$/);

  const quoted = await call(pro, `/jobs/${jobId}/quote`, { method: "POST", body: { amount: 850 } });
  assert.equal(quoted.status, 200);
  assert.equal(quoted.payload.job.quotedAmount, 850);
  assert.equal(quoted.payload.job.professionalFee, 32.75, "R20 plus 1,5%, through the real pricing engine");
  assert.equal(quoted.payload.job.customerFee, 5);

  assert.equal((await call(customer, `/jobs/${jobId}/accept`, { method: "POST" })).payload.job.status, "accepted");
  await call(pro, `/jobs/${jobId}/schedule`, { method: "POST", body: { bookingId: uuidv4() } });
  await call(pro, `/jobs/${jobId}/start`, { method: "POST" });
  assert.equal((await call(pro, `/jobs/${jobId}/done`, { method: "POST" })).payload.job.status, "work_done");
  assert.equal((await call(customer, `/jobs/${jobId}/confirm`, { method: "POST" })).payload.job.status, "confirmed");

  // Both sides can list it afterwards, from their own side.
  assert.ok((await call(customer, "/jobs?role=customer")).payload.jobs.some((j) => j.id === jobId));
  assert.ok((await call(pro, "/jobs?role=professional")).payload.jobs.some((j) => j.id === jobId));
});

test("EACH SIDE CAN ONLY DO ITS OWN HALF, THROUGH THE ROUTE", async () => {
  // The services compare against req.auth. If the route had taken a userId
  // from the body, every one of those checks would be decorative.
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  const jobId = (await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Leaking tap" } })).payload.job.id;

  const customerQuoting = await call(customer, `/jobs/${jobId}/quote`, { method: "POST", body: { amount: 10 } });
  assert.equal(customerQuoting.status, 403);
  assert.match(customerQuoting.payload.error, /Only the professional/i);

  await call(pro, `/jobs/${jobId}/quote`, { method: "POST", body: { amount: 850 } });
  const proAccepting = await call(pro, `/jobs/${jobId}/accept`, { method: "POST" });
  assert.equal(proAccepting.status, 403);
  assert.match(proAccepting.payload.error, /Only the customer/i);
});

test("A STRANGER CANNOT READ SOMEBODY ELSE'S JOB", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  const stranger = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  const jobId = (await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Burst geyser" } })).payload.job.id;

  const peeking = await call(stranger, `/jobs/${jobId}`);
  assert.equal(peeking.status, 404, "not found, not forbidden - its existence is not theirs to learn");
  assert.equal((await call(customer, `/jobs/${jobId}`)).status, 200);
});

test("the state machine is not handed to the caller", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  const jobId = (await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Slow drain" } })).payload.job.id;

  // No route sets a status directly, and a step that does not exist is a 404
  // rather than something the router improvises.
  assert.equal((await call(pro, `/jobs/${jobId}/mark-paid`, { method: "POST" })).status, 404);
  // And a legal step in an illegal order is refused by the engine.
  const early = await call(customer, `/jobs/${jobId}/confirm`, { method: "POST" });
  assert.equal(early.status, 409);
  assert.match(early.payload.error, /cannot become confirmed/i);
});

test("a job cannot be sent to somebody who is not listed", async () => {
  const customer = await signedIn({ fica: "approved" });
  const unlisted = await signedIn({ fica: "approved" });
  const { status, payload } = await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: unlisted.userId, title: "Blocked drain" } });
  assert.equal(status, 409);
  assert.equal(payload.details?.code, "not_listed");
});

test("the fee preview answers before anybody commits", async () => {
  const actor = await signedIn();
  const { status, payload } = await call(actor, "/quote-preview?amount=350");
  assert.equal(status, 200);
  assert.equal(payload.fees.customerFee, 5);
  assert.equal(payload.fees.professionalFee, 25.25);
  assert.equal(payload.fees.customerPays, 355);
  assert.equal(payload.fees.professionalReceives, 324.75);
});
