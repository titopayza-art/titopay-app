"use strict";

// TITOPRO MODERATION OVER HTTP, INCLUDING WHO IS ALLOWED TO DO IT.
//
// Taking somebody's livelihood off a marketplace is a real power, so the
// question this file asks is not only "does the route work" but "who can
// reach it". What is defended:
//
//   1. the moderation routes require an ADMIN token, not a customer one -
//      a professional with a signed-in app cannot suspend a rival;
//   2. they require the titopro_moderation permission, so a role that has
//      no business taking listings down cannot, even with a valid session;
//   3. the queue, the decision and the listing action all work end to end;
//   4. approving through the route does NOT publish anything.

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
const reputation = require("../src/services/titopro-reputation-service");
const pricing = require("../src/services/pricing-service");

let server;
let base;
test.before(async () => {
  await profiles.ensureProfileSchema();
  await vetting.ensureVettingSchema();
  await require("../src/services/titopro-service").ensureTitoProSchema();
  await reputation.ensureReputationSchema();
  await pricing.applyTitoProPricingOnce();
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => null);
});

let sequence = 0;
function tag() {
  sequence += 1;
  return `${String(Date.now()).slice(-6)}${sequence}`;
}

async function signedInCustomer() {
  const id = uuidv4();
  const suffix = tag();
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Thandi Mokoena',$2,$3,$4,'personal','active','approved','x')`,
    [id, `mod_${suffix}`, `mod_${suffix}@test.local`, `+2782${suffix}`.slice(0, 13)]);
  const sessionId = uuidv4();
  const jti = uuidv4();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer',$3,$4, NOW() + INTERVAL '1 day')`,
    [sessionId, id, crypto.randomUUID(), jti]);
  return { userId: id, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer", scope: "customer" }) };
}

async function signedInAdmin(role) {
  const id = uuidv4();
  const suffix = tag();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Moderator',$2,$3,$4,'x','active')`,
    [id, `modadm_${suffix}`, `modadm_${suffix}@titopay.test`, role]);
  const sessionId = uuidv4();
  const jti = uuidv4();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'admin',$2,'admin','x',$3, NOW() + INTERVAL '1 day')`,
    [sessionId, id, jti]);
  return { userId: id, role, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "admin", scope: "admin" }) };
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

async function listedProfessional() {
  const pro = await signedInCustomer();
  await call(pro, "/titopro/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/titopro/me/listing/publish", { method: "POST" });
  return pro;
}

const ROUTES = [
  ["GET", "/admin/titopro/reports"],
  ["GET", "/admin/titopro/listings"]
];

test("A CUSTOMER TOKEN REACHES NONE OF THE MODERATION ROUTES", async () => {
  const customer = await signedInCustomer();
  for (const [method, path] of ROUTES) {
    const { status } = await call(customer, path, { method });
    assert.equal(status, 403, `${method} ${path} must refuse a customer token`);
  }
  // Nor can a professional take a rival down by posting at the route directly.
  const rival = await listedProfessional();
  const attempt = await call(customer, `/admin/titopro/listings/${rival.userId}/moderate`, {
    method: "POST", body: { action: "remove", reason: "Because I can." } });
  assert.equal(attempt.status, 403);
  assert.equal((await call(customer, `/titopro/professionals/${rival.userId}`)).status, 200,
    "and the listing is untouched");
});

test("AN ADMIN ROLE WITHOUT THE PERMISSION IS REFUSED", async () => {
  // finance has a perfectly valid admin session and no business deciding who
  // is allowed to trade on TitoPro.
  const finance = await signedInAdmin("finance");
  for (const [method, path] of ROUTES) {
    const { status, payload } = await call(finance, path, { method });
    assert.equal(status, 403, `${method} ${path}`);
    assert.match(payload.error, /Permission denied/i);
  }
});

test("THE DESKS THAT FIELD COMPLAINTS CAN REACH THE QUEUE", async () => {
  for (const role of ["customer_support", "compliance"]) {
    const admin = await signedInAdmin(role);
    const { status } = await call(admin, "/admin/titopro/reports");
    assert.equal(status, 200, `${role} fields complaints and must be able to read them`);
  }
});

test("A REPORT REACHES THE QUEUE, IS ACTED ON, AND THE LISTING COMES DOWN", async () => {
  const admin = await signedInAdmin("customer_support");
  const customer = await signedInCustomer();
  const pro = await listedProfessional();

  const report = (await call(customer, `/titopro/professionals/${pro.userId}/report`, {
    method: "POST", body: { category: "unsafe", detail: "He left live wires hanging out of the wall." }
  })).payload.report;

  const queue = await call(admin, "/admin/titopro/reports?status=open");
  assert.equal(queue.status, 200);
  const queued = queue.payload.reports.find((row) => row.reference === report.reference);
  assert.ok(queued, "the report is in front of an operator");
  assert.equal(queued.urgent, true);
  assert.equal(queued.professionalName, "Thandi Mokoena");
  assert.equal(queued.detail, "He left live wires hanging out of the wall.");

  // The whole listing, with everything needed to decide about it.
  const detail = await call(admin, `/admin/titopro/listings/${pro.userId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.listing.statusLabel, "Live");
  assert.equal(detail.payload.reports.length, 1);
  assert.ok(detail.payload.contact.email, "and who to contact about it");

  const suspended = await call(admin, `/admin/titopro/listings/${pro.userId}/moderate`, {
    method: "POST", body: { action: "suspend", reason: "Unsafe electrical work reported by a customer." } });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.payload.profile.adminAction, "suspended");
  assert.equal(suspended.payload.reportsClosed, 1);

  // Off TitoPro, and the professional cannot put it back.
  assert.equal((await call(customer, `/titopro/professionals/${pro.userId}`)).status, 409);
  const retry = await call(pro, "/titopro/me/listing/publish", { method: "POST" });
  assert.equal(retry.status, 403);
  assert.equal(retry.payload.details?.code, "listing_suspended");

  // And the listing is findable again by an operator.
  const actioned = await call(admin, "/admin/titopro/listings?state=actioned");
  assert.ok(actioned.payload.listings.some((row) => row.userId === pro.userId));
});

test("APPROVING THROUGH THE ROUTE HANDS IT BACK, IT DOES NOT PUBLISH", async () => {
  const admin = await signedInAdmin("compliance");
  const pro = await listedProfessional();
  await call(admin, `/admin/titopro/listings/${pro.userId}/moderate`, {
    method: "POST", body: { action: "suspend", reason: "Held while a complaint is looked at." } });

  const approved = await call(admin, `/admin/titopro/listings/${pro.userId}/moderate`, {
    method: "POST", body: { action: "approve", reason: "Nothing in it. The customer withdrew the complaint." } });
  assert.equal(approved.payload.profile.adminAction, null);
  // NOT published. Nothing an operator does here can put a listing in front of
  // customers that would not have been allowed there anyway.
  assert.equal(approved.payload.profile.status, "paused");

  const searcher = await signedInCustomer();
  assert.equal((await call(searcher, `/titopro/professionals/${pro.userId}`)).status, 409);
  // The professional puts it back themselves, through the usual gates.
  assert.equal((await call(pro, "/titopro/me/listing/publish", { method: "POST" })).status, 200);
  assert.equal((await call(searcher, `/titopro/professionals/${pro.userId}`)).status, 200);
});

test("A MODERATION DECISION WITHOUT A REASON IS REFUSED AT THE ROUTE", async () => {
  const admin = await signedInAdmin("customer_support");
  const pro = await listedProfessional();
  const { status, payload } = await call(admin, `/admin/titopro/listings/${pro.userId}/moderate`, {
    method: "POST", body: { action: "suspend" } });
  assert.equal(status, 400);
  assert.match(payload.error, /Reason is required/i);
  assert.equal((await call(pro, "/titopro/me/listing")).payload.profile.status, "published",
    "and nothing happened to the listing");
});

test("A RATING CAN BE MODERATED BUT NEVER DELETED", async () => {
  const admin = await signedInAdmin("customer_support");
  const customer = await signedInCustomer();
  const pro = await listedProfessional();
  const jobId = (await call(customer, "/titopro/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Blocked drain" } })).payload.job.id;
  await call(pro, `/titopro/jobs/${jobId}/quote`, { method: "POST", body: { amount: 700 } });
  await call(customer, `/titopro/jobs/${jobId}/accept`, { method: "POST" });
  await call(pro, `/titopro/jobs/${jobId}/start`, { method: "POST" });
  await call(pro, `/titopro/jobs/${jobId}/done`, { method: "POST" });
  await call(customer, `/titopro/jobs/${jobId}/confirm`, { method: "POST" });
  await call(customer, `/titopro/jobs/${jobId}/rate`, { method: "POST", body: {
    stars: 1, comment: "This man is a thief." } });

  const page = await call(customer, `/titopro/professionals/${pro.userId}`);
  const ratingId = page.payload.professional.reviews[0].id;

  const hidden = await call(admin, `/admin/titopro/ratings/${ratingId}/moderate`, {
    method: "POST", body: { action: "hide_comment", reason: "Untested accusation of a crime." } });
  assert.equal(hidden.status, 200);

  const after = await call(customer, `/titopro/professionals/${pro.userId}`);
  assert.equal(after.payload.professional.reviews[0].comment, null, "the words come down");
  assert.equal(after.payload.professional.rating, 1, "the star does not");

  const { rows } = await pool.query("SELECT comment FROM titopro_ratings WHERE id = $1", [ratingId]);
  assert.equal(rows[0].comment, "This man is a thief.", "and nothing was deleted");
});
