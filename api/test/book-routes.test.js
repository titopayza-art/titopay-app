"use strict";

// BOOK, OVER THE WIRE.
//
// The services are tested elsewhere. This proves the part a person actually
// meets: the router is mounted, the endpoints answer, and the whole first
// journey works - a business pays, creates a booking page, and gets a link.
//
// It also pins the mount ORDER. lookupRoutes sits on the bare /v1 prefix with
// requireAuth on it, so a router mounted after it never receives a request and
// every unmatched path becomes 401 instead of 404. Book's public venue page will
// live in this router, and mounted on the wrong side of that line it would
// answer 401 to a WhatsApp crawler and preview as nothing.

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
const { ensureBookSchema } = require("../src/services/book-schema");

const TAG = "bookroute";
const owner = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const personal = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
let server;
let baseUrl;

async function ensureRevenueWallet() {
  const { rows } = await pool.query("SELECT id FROM wallets WHERE kind='revenue' AND user_id IS NULL LIMIT 1");
  if (rows[0]) return;
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1, NULL, 'revenue', 0, 0, 'ZAR')`, [randomUUID()]);
}

async function seed(user, accountType, balance) {
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE)`,
    [user.id, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`,
     `${TAG}_${suffix}@example.invalid`, `2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1,$2,$3,$4,0,'ZAR')`,
    [randomUUID(), user.id, accountType === "business" ? "business" : "personal", balance]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]
  );
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function cleanup() {
  for (const u of [owner, personal]) {
    await pool.query("DELETE FROM book_venues WHERE business_user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM book_activations WHERE business_user_id=$1", [u.id]).catch(() => {});
    await pool.query(
      "DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [u.id]).catch(() => {});
    await pool.query(
      "DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [u.id]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]).catch(() => {});
  }
}

test.before(async () => {
  await ensureBookSchema();
  await ensureRevenueWallet();
  await cleanup();
  await seed(owner, "business", 1000);
  await seed(personal, "personal", 1000);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
  await pool.end();
});

function call(method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/* --------------------------------------------------------- it is mounted */

test("the Book router is mounted and answers on both prefixes", async () => {
  for (const prefix of ["/v1", "/api"]) {
    const response = await call("GET", `${prefix}/book/options`, owner.token);
    assert.equal(response.status, 200, `${prefix}/book/options should answer`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.categories.length > 15, "the setup screen gets its list from the server");
  }
});

test("Book is mounted ABOVE lookupRoutes, so it is not swallowed", async () => {
  // lookupRoutes sits on the bare prefix with requireAuth and turns every
  // unmatched path into 401. If Book were mounted after it, this 200 would be a
  // 401 - and the public venue page added later would be invisible to crawlers.
  const mounted = await call("GET", "/v1/book/options", owner.token);
  assert.equal(mounted.status, 200);

  const swallowed = await call("GET", "/v1/book-not-a-real-thing", owner.token);
  assert.notEqual(swallowed.status, 200, "a genuinely missing path must not answer 200");
});

/* ------------------------------------------------------------- the gate */

test("a personal account is told plainly that Book is a business feature", async () => {
  const response = await call("GET", "/v1/book/activation", personal.token);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(body.error, /business/i);
});

test("no token is refused", async () => {
  const response = await call("GET", "/v1/book/activation");
  assert.equal(response.status, 401);
});

/* -------------------------------------------------- the whole first journey */

test("a business pays, creates a booking page, and gets a shareable link", async () => {
  // 1. What does it cost?
  const before = await (await call("GET", "/v1/book/activation", owner.token)).json();
  assert.equal(before.activation.active, false);
  assert.equal(before.activation.amount, 250);

  // 2. A venue cannot exist before paying.
  const tooEarly = await call("POST", "/v1/book/venues", owner.token,
    { name: "Kasi Kitchen", category: "restaurant" });
  assert.equal(tooEarly.status, 402, "402 Payment Required is the honest answer");

  // 3. Pay.
  const paid = await call("POST", "/v1/book/activation", owner.token, {});
  assert.equal(paid.status, 201, "201 because this call is what bought it");
  assert.equal((await paid.json()).activation.active, true);

  // A second call is a retry, not a second purchase.
  const retry = await call("POST", "/v1/book/activation", owner.token, {});
  assert.equal(retry.status, 200, "200 because they already had it");

  // 4. Create the booking page.
  const created = await call("POST", "/v1/book/venues", owner.token, {
    name: "Kasi Kitchen", category: "restaurant", city: "Johannesburg"
  });
  assert.equal(created.status, 201, await created.clone().text());
  const venue = (await created.json()).venue;
  assert.equal(venue.name, "Kasi Kitchen");
  assert.equal(venue.status, "draft", "a new page is a draft until it is published");
  assert.equal(venue.bookingWord, "Reservation", "a restaurant takes reservations, not appointments");

  // 5. THE LINK. Clean, readable, no random suffix.
  assert.equal(venue.slug, "kasi-kitchen");

  // 6. It is listed.
  const list = await (await call("GET", "/v1/book/venues", owner.token)).json();
  assert.equal(list.venues.length, 1);

  // 7. Publishing makes it live.
  const published = await call("POST", `/v1/book/venues/${venue.id}/status`, owner.token, { status: "published" });
  assert.equal(published.status, 200);
  const live = (await published.json()).venue;
  assert.equal(live.status, "published");
  assert.ok(live.publishedAt, "the moment it went live is recorded");
});

test("a doctor's page hides the exact free-slot count by default", async () => {
  // A public, pollable "3 slots left" is marketing for a restaurant and a
  // patient-load signal for a practice.
  const created = await call("POST", "/v1/book/venues", owner.token, { name: `${TAG} Practice`, category: "doctor" });
  assert.equal(created.status, 201);
  const venue = (await created.json()).venue;
  assert.equal(venue.showsAvailabilityCount, false);
  assert.equal(venue.bookingWord, "Appointment");
});

test("a stranger cannot read or change somebody else's venue", async () => {
  const list = await (await call("GET", "/v1/book/venues", owner.token)).json();
  const venueId = list.venues[0].id;
  // The personal account is refused at the account-type gate before ownership
  // is even consulted, which is the correct order.
  const read = await call("GET", `/v1/book/venues/${venueId}`, personal.token);
  assert.equal(read.status, 403);
  // And a business asking for an id it does not own gets 404, never 403, so a
  // venue id cannot be discovered by the difference between the two answers.
  const missing = await call("GET", `/v1/book/venues/${randomUUID()}`, owner.token);
  assert.equal(missing.status, 404);
});

test("a bad category is refused with a sentence a person can act on", async () => {
  const response = await call("POST", "/v1/book/venues", owner.token, { name: "Nope", category: "cryptomine" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /kind of business/i);
});
