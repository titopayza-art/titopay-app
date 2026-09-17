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
  professions: ["plumber"], tradingName: "Sipho's Plumbing", headline: "Drains and geysers, Soweto",
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

/* ------------------------------------------------ ratings and reporting */

test("RATING IS A ROUTE OF ITS OWN, NOT A STEP THE JOB ENGINE SWALLOWS", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  const jobId = (await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Blocked drain" } })).payload.job.id;

  // THE TRAP THIS DEFENDS. /jobs/:id/:step sits below this route and answers
  // "Unknown step" for anything not in its map. If /jobs/:id/rate were
  // declared after it, every rating in the product would 404 - and the app's
  // .catch would show "that rating could not be sent" with nothing to explain
  // it. Route order is the whole mechanism, so it is asserted rather than
  // trusted to survive the next edit to this file.
  const tooEarly = await call(customer, `/jobs/${jobId}/rate`, { method: "POST", body: { stars: 5 } });
  assert.equal(tooEarly.status, 409, "reached the rating route, not the step router");
  assert.equal(tooEarly.payload.details?.code, "job_not_confirmed");

  await call(pro, `/jobs/${jobId}/quote`, { method: "POST", body: { amount: 850 } });
  await call(customer, `/jobs/${jobId}/accept`, { method: "POST" });
  await call(pro, `/jobs/${jobId}/start`, { method: "POST" });
  await call(pro, `/jobs/${jobId}/done`, { method: "POST" });
  await call(customer, `/jobs/${jobId}/confirm`, { method: "POST" });

  const rated = await call(customer, `/jobs/${jobId}/rate`, { method: "POST", body: {
    stars: 5, comment: "On time and cleaned up after himself." } });
  assert.equal(rated.status, 201);
  assert.equal(rated.payload.rating.stars, 5);

  // The customer's own rating comes back, so the app shows "you rated this"
  // rather than offering the form a second time.
  const readBack = await call(customer, `/jobs/${jobId}/rating`);
  assert.equal(readBack.payload.rating.stars, 5);

  // And it is on the professional's page, with a first name and no surname.
  const page = await call(customer, `/professionals/${pro.userId}`);
  assert.equal(page.status, 200);
  assert.equal(page.payload.professional.rating, 5);
  assert.equal(page.payload.professional.ratingCount, 1);
  assert.equal(page.payload.professional.reviews[0].by, "Sipho");
  assert.equal(page.payload.professional.reviews[0].comment, "On time and cleaned up after himself.");

  // The professional cannot rate their own job through the route either.
  const selfRating = await call(pro, `/jobs/${jobId}/rate`, { method: "POST", body: { stars: 5 } });
  assert.equal(selfRating.status, 403);
});

test("A PROFESSIONAL'S PAGE ONLY EXISTS WHILE THEY ARE LISTED", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal((await call(customer, `/professionals/${pro.userId}`)).status, 200);

  await call(pro, "/me/listing/pause", { method: "POST" });
  const gone = await call(customer, `/professionals/${pro.userId}`);
  assert.equal(gone.status, 409);
  assert.equal(gone.payload.details?.code, "not_listed");
});

test("REPORTING A LISTING, FROM THE LIST THE API ITSELF SERVES", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });

  // The app builds its picker from this, so a reason on the screen and a
  // reason the API accepts cannot drift apart.
  const reasons = await call(customer, "/report-reasons");
  assert.equal(reasons.status, 200);
  assert.deepEqual(reasons.payload.reasons.map((item) => item.key), reference.REPORT_CATEGORY_KEYS);

  const before = await call(customer, `/professionals/${pro.userId}/my-report`);
  assert.equal(before.payload.report, null);

  const sent = await call(customer, `/professionals/${pro.userId}/report`, { method: "POST", body: {
    category: "off_platform_payment", detail: "He asked me to EFT him instead of paying in the app." } });
  assert.equal(sent.status, 201);
  assert.match(sent.payload.report.reference, /^TP-R-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(sent.payload.report.urgent, true);

  const after = await call(customer, `/professionals/${pro.userId}/my-report`);
  assert.equal(after.payload.report.reference, sent.payload.report.reference);

  // NOTHING HAPPENED TO THE LISTING. A report is an accusation; a listing that
  // comes down on one is a listing any competitor can take down.
  assert.equal((await call(customer, `/professionals/${pro.userId}`)).status, 200);

  // And a second report while the first is open is refused rather than queued.
  const again = await call(customer, `/professionals/${pro.userId}/report`, { method: "POST", body: {
    category: "no_show", detail: "And he has still not come back." } });
  assert.equal(again.status, 409);
  assert.equal(again.payload.details?.code, "report_already_open");
});

test("THE NEW DOORS ARE SHUT TO ANYBODY WITHOUT A TOKEN TOO", async () => {
  const id = uuidv4();
  for (const [path, method] of [
    ["/report-reasons", "GET"],
    [`/professionals/${id}`, "GET"],
    [`/professionals/${id}/report`, "POST"],
    [`/professionals/${id}/my-report`, "GET"],
    [`/jobs/${id}/rate`, "POST"],
    [`/jobs/${id}/rating`, "GET"]
  ]) {
    assert.equal((await call(null, path, { method })).status, 401, `${method} ${path}`);
  }
});

/* ---------------------------------------------- listing details and chat */

test("A LISTING CARRIES A TRADING NAME, PHOTOS AND THE PROFESSIONAL'S TERMS", async () => {
  const pro = await signedIn({ fica: "approved" });
  // A one-pixel PNG. Real enough to pass the same validation PUT /auth/me/photo
  // uses, small enough to keep the test honest about shape rather than size.
  const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const saved = await call(pro, "/me/listing", { method: "PUT", body: {
    ...LISTING,
    tradingName: "Sipho's Plumbing",
    terms: "Call-out fee R250, payable whether or not the job goes ahead. Geysers carry a 12 month guarantee.",
    photos: [photo, photo] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.profile.tradingName, "Sipho's Plumbing");
  assert.equal(saved.payload.profile.photos.length, 2);
  assert.match(saved.payload.profile.terms, /Call-out fee R250/);

  await call(pro, "/me/listing/publish", { method: "POST" });
  const customer = await signedIn({ fica: "approved" });
  const page = await call(customer, `/professionals/${pro.userId}`);
  assert.equal(page.payload.professional.name, "Sipho's Plumbing", "the name they trade under leads");
  assert.equal(page.payload.professional.verifiedName, "Sipho Ndlovu", "the checked identity backs it up");
  assert.equal(page.payload.professional.photos.length, 2);
  assert.match(page.payload.professional.terms, /12 month guarantee/,
    "terms are read BEFORE a job is raised, not discovered after the work");

  // AND THE GALLERY IS NOT ON THE SEARCH SURFACE. Six base64 photos per row
  // across fifty results is megabytes to read a list of names.
  const found = await call(customer, "/search?profession=plumber&city=Soweto");
  const row = found.payload.professionals.find((item) => item.userId === pro.userId);
  assert.equal(row.photos, undefined);
  assert.equal(row.photoCount, 2, "the count travels so a row can say how many there are");
});

test("A LISTING WITH NO NAME DOES NOT GO LIVE", async () => {
  const pro = await signedIn({ fica: "approved" });
  const { tradingName, ...noName } = LISTING;
  await call(pro, "/me/listing", { method: "PUT", body: noName });
  const refused = await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal(refused.status, 400);
  assert.equal(refused.payload.details?.code, "trading_name_required");

  await call(pro, "/me/listing", { method: "PUT", body: { ...noName, tradingName: "Sipho's Plumbing" } });
  assert.equal((await call(pro, "/me/listing/publish", { method: "POST" })).status, 200);
});

test("ONLY REAL IMAGES, AND NOT TOO MANY", async () => {
  const pro = await signedIn({ fica: "approved" });
  const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  // An <img src> that accepts SVG accepts a script, and these render on a page
  // any customer can open. The allowlist is a whitelist for that reason.
  const svg = await call(pro, "/me/listing", { method: "PUT", body: {
    ...LISTING, photos: ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="] } });
  assert.equal(svg.status, 400);
  assert.equal(svg.payload.details?.code, "photo_type");

  const notAnImage = await call(pro, "/me/listing", { method: "PUT", body: {
    ...LISTING, photos: ["https://example.invalid/photo.png"] } });
  assert.equal(notAnImage.status, 400);

  const tooMany = await call(pro, "/me/listing", { method: "PUT", body: {
    ...LISTING, photos: new Array(7).fill(photo) } });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.payload.details?.code, "too_many_photos");
});

test('"OTHER" MUST SAY WHAT IT IS, AND CANNOT REOPEN WORK TITOPAY WITHDREW', async () => {
  const pro = await signedIn({ fica: "approved" });
  const OTHER = { ...LISTING, professions: ["other"] };

  // Childcare was withdrawn deliberately. "Other" is exactly how it would come
  // back - as free text with no checks at all, which is worse than the tile
  // that was removed.
  for (const attempt of ["Nanny for toddlers", "au pair, live in", "Daycare in my home"]) {
    const refused = await call(pro, "/me/listing", { method: "PUT", body: { ...OTHER, otherService: attempt } });
    assert.equal(refused.status, 422, attempt);
    assert.equal(refused.payload.details?.code, "work_not_carried");
    assert.match(refused.payload.error, /does not carry childcare/i);
  }

  // Saved with nothing said, it is a listing offering an unnamed service.
  await call(pro, "/me/listing", { method: "PUT", body: OTHER });
  const noDescription = await call(pro, "/me/listing/publish", { method: "POST" });
  assert.equal(noDescription.status, 400);
  assert.equal(noDescription.payload.details?.code, "other_service_required");

  // A welder is exactly who this exists for.
  await call(pro, "/me/listing", { method: "PUT", body: { ...OTHER, otherService: "Welding, gates and burglar bars" } });
  assert.equal((await call(pro, "/me/listing/publish", { method: "POST" })).status, 200);
});

test("THE THREE NEW PROFESSIONS ARE IN THE CATALOGUE THE APP BUILDS ITS PICKER FROM", async () => {
  const actor = await signedIn();
  const { payload } = await call(actor, "/professions");
  const byKey = Object.fromEntries(payload.professions.map((item) => [item.key, item]));
  for (const key of ["graphic_designer", "web_developer", "other"]) {
    assert.ok(byKey[key], `${key} must be offered`);
    assert.equal(byKey[key].group, "Professional");
    assert.equal(byKey[key].usesDiary, false, "remote work takes no diary slot");
  }
  assert.equal(byKey.other.label, "Other");
});

test("EITHER SIDE OF A JOB CAN OPEN A CONVERSATION, AND IT IS KEPT WITH THE JOB", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });
  const jobId = (await call(customer, "/jobs", { method: "POST", body: {
    profession: "plumber", professionalUserId: pro.userId, title: "Blocked kitchen drain" } })).payload.job.id;

  const opened = await call(customer, `/jobs/${jobId}/chat`, { method: "POST" });
  assert.equal(opened.status, 200);
  const threadId = opened.payload.thread.id || opened.payload.thread.threadId;
  assert.ok(threadId, "a thread id comes back");

  // THE ID REALLY LANDS ON THE JOB. The route logs rather than throws if this
  // fails, so without this assertion a column type mismatch would be invisible.
  const { rows } = await pool.query("SELECT chat_thread_id FROM titopro_jobs WHERE id = $1", [jobId]);
  assert.equal(rows[0].chat_thread_id, threadId,
    "the conversation where the price was agreed has to be findable from the job");

  // The professional opening it from their side reaches the SAME thread, not a
  // second one - two inboxes for one job is the failure this guards.
  const fromPro = await call(pro, `/jobs/${jobId}/chat`, { method: "POST" });
  assert.equal(fromPro.payload.thread.id || fromPro.payload.thread.threadId, threadId);

  // A stranger cannot open a conversation about somebody else's job.
  const stranger = await signedIn({ fica: "approved" });
  assert.equal((await call(stranger, `/jobs/${jobId}/chat`, { method: "POST" })).status, 404);
});

test("A CUSTOMER CAN MESSAGE A LISTED PROFESSIONAL BEFORE ANY JOB EXISTS", async () => {
  const customer = await signedIn({ fica: "approved" });
  const pro = await signedIn({ fica: "approved" });
  await call(pro, "/me/listing", { method: "PUT", body: LISTING });
  await call(pro, "/me/listing/publish", { method: "POST" });

  // Which is the point: a price for painting a house is negotiated before
  // anybody commits to it.
  const opened = await call(customer, `/professionals/${pro.userId}/chat`, { method: "POST" });
  assert.equal(opened.status, 200);
  assert.ok(opened.payload.thread.id || opened.payload.thread.threadId);

  // But the endpoint is not a directory for messaging any user id somebody
  // types: the person has to actually be listed.
  await call(pro, "/me/listing/pause", { method: "POST" });
  const gone = await call(customer, `/professionals/${pro.userId}/chat`, { method: "POST" });
  assert.equal(gone.status, 409);
  assert.equal(gone.payload.details?.code, "not_listed");
});

test("THE VETTING ADVISORY IS SERVED BY THE API, SO ONE WORDING REACHES EVERY SURFACE", async () => {
  const actor = await signedIn();
  const { payload } = await call(actor, "/professions");
  const advisory = payload.vettingAdvisory;
  assert.ok(advisory, "the app renders this rather than carrying its own copy");

  // What TitoPay checked, and what it does not establish. Both halves, because
  // the assurance without the limit is the thing that misleads.
  assert.match(advisory.checked, /confirmed this professional's identity/i);
  assert.ok(advisory.limits.some((line) => /not a guarantee of conduct, competence or safety/i.test(line)));
  assert.ok(advisory.limits.some((line) => /does not cover anyone else/i.test(line)),
    "a check covers one person, not whoever arrives with them");

  // "Do your own due diligence" is advice nobody can act on. These are things
  // a person can actually do at a front door.
  assert.ok(advisory.steps.length >= 4, `${advisory.steps.length} steps`);
  assert.ok(advisory.steps.some((step) => /Ask for ID at the door/i.test(step)));

  // THE LIMITATION, AND ITS SHAPE.
  assert.match(advisory.liability, /does not employ them/i);
  assert.match(advisory.liability, /not responsible for loss, damage or injury/i);
  // Scoped, not absolute. A blanket exclusion of any loss whatsoever is the
  // term most likely to be struck out under the Consumer Protection Act, which
  // would leave TitoPay with nothing rather than with a narrower clause that
  // holds. This pins the hedge so a later edit cannot quietly remove it.
  assert.match(advisory.liability, /to the extent the law allows/i);
  for (const absolute of [/any loss whatsoever/i, /under no circumstances/i, /in no event/i, /all liability is excluded/i]) {
    assert.ok(!absolute.test(advisory.liability),
      `the limitation must not be written as an absolute exclusion: ${absolute}`);
  }
});
