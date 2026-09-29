"use strict";

// THE TWO COMMERCIAL PROFILE ROUTES, OVER REAL HTTP.
//
// business-commercial-profile.test.js proves the SERVICE. It calls
// getCommercialProfile and updateCommercialProfile directly, so it would pass
// unchanged if the router referenced the wrong function, read the wrong path
// parameter, or was never mounted at all. Those are the failures a person meets
// as a screen that will not load, and nothing was catching them.
//
// So this file goes through the wire: a real server, a real session, a real
// Bearer token, the exact paths the app calls.

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

const TAG = "bizcommercial";
const owner = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const stranger = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
let businessId;

async function seedUser(user, suffix) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business',$2,$3,$4,$5,'x','active',FALSE,'pending')`,
    [user.id, `${TAG} ${suffix}`, `${TAG}_${suffix}`, `${TAG}_${suffix}@example.invalid`,
      `2712000${Math.floor(1000 + Math.random() * 8999)}`]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]
  );
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function cleanup() {
  for (const u of [owner, stranger]) {
    await pool.query(
      `DELETE FROM business_representatives WHERE business_id IN
         (SELECT id FROM business_profiles WHERE account_user_id = $1)`, [u.id]).catch(() => {});
    await pool.query("DELETE FROM business_profiles WHERE account_user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => {});
  }
}

let server;
let baseUrl;

test.before(async () => {
  await ensureBusinessSchema();
  await cleanup();
  await seedUser(owner, "owner");
  await seedUser(stranger, "stranger");
  businessId = randomUUID();
  await pool.query(
    `INSERT INTO business_profiles (id, account_user_id, business_name, business_type, created_by)
     VALUES ($1,$2,$3,'sole_proprietor',$2)`,
    [businessId, owner.id, `${TAG} Kasi Kitchen`]
  );
  await pool.query(
    `INSERT INTO business_representatives (id, business_id, person_user_id, role, status)
     VALUES ($1,$2,$3,'owner','active')`,
    [randomUUID(), businessId, owner.id]
  );
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
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
const profilePath = () => `/v1/business/verification/businesses/${businessId}/commercial-profile`;

test("GET is mounted and serves the options the screen renders from", async () => {
  const response = await call("GET", profilePath(), owner.token);
  assert.equal(response.status, 200, `the route is reachable: ${await response.clone().text()}`);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.profile.industry, null, "nothing is assumed about a business that has not answered");
  assert.deepEqual(body.profile.sourcesOfFunds, []);
  // The picker screens have no hard-coded list; an empty options block is a
  // blank screen in the app, so it is asserted here and not only in the service.
  assert.ok(body.profile.options.industries.length > 10);
  assert.ok(body.profile.options.sourcesOfFunds.length > 5);
  assert.equal(body.profile.options.maxSourcesOfFunds, 5);
  for (const option of body.profile.options.industries) {
    assert.ok(option.key && option.label && option.hint, `${option.key} arrives complete`);
  }
});

test("PUT saves through the route and the answer is there on the next GET", async () => {
  const put = await call("PUT", profilePath(), owner.token, {
    industry: "food_drink",
    sourcesOfFunds: ["trading_income", "grants_donations"]
  });
  assert.equal(put.status, 200, `the update is accepted: ${await put.clone().text()}`);
  const saved = (await put.json()).profile;
  assert.equal(saved.industry, "food_drink");
  assert.equal(saved.primarySourceOfFunds, "trading_income", "the first one chosen is the main source");

  // Re-reading is the part a screen actually depends on.
  const again = (await (await call("GET", profilePath(), owner.token)).json()).profile;
  assert.equal(again.industry, "food_drink");
  assert.deepEqual(again.sourcesOfFunds, ["trading_income", "grants_donations"]);
});

test("a bad value comes back as a refusal a person can read, not a 500", async () => {
  const response = await call("PUT", profilePath(), owner.token, { industry: "cryptomining" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(body.error && body.error.length > 5, "there is a message to show");
  assert.ok(!/\bat \/|node_modules|SELECT /i.test(JSON.stringify(body)),
    "an internal detail is never handed to the app");
});

test("the routes are guarded: no token is refused, and a stranger is not told the business exists", async () => {
  const anonymous = await fetch(`${baseUrl}${profilePath()}`);
  assert.equal(anonymous.status, 401);

  const read = await call("GET", profilePath(), stranger.token);
  assert.equal(read.status, 404, "a business you are not on does not exist as far as you are concerned");
  const write = await call("PUT", profilePath(), stranger.token, { industry: "food_drink" });
  assert.equal(write.status, 404);

  // And nothing the stranger sent was stored.
  const mine = (await (await call("GET", profilePath(), owner.token)).json()).profile;
  assert.equal(mine.industry, "food_drink", "the owner's own answer is untouched");
});

test("the route does not move kyb_status", async () => {
  const before = await pool.query("SELECT kyb_status FROM business_profiles WHERE id=$1", [businessId]);
  await call("PUT", profilePath(), owner.token, { industry: "transport_logistics" });
  const after = await pool.query("SELECT kyb_status FROM business_profiles WHERE id=$1", [businessId]);
  assert.equal(after.rows[0].kyb_status, before.rows[0].kyb_status,
    "self-declared answers are not verification, over HTTP either");
});
