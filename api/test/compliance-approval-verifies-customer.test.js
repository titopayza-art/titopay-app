"use strict";

// APPROVING A REVIEW HAS TO VERIFY THE CUSTOMER.
//
// The compliance decision endpoint used to update kyc_reviews and stop there,
// while the only write to users.fica_status anywhere set it to 'submitted'.
// Nothing ever set 'approved'. approvedFicaDetails() requires BOTH the review
// and the user record to say approved, so a compliance officer could approve a
// customer and that customer stayed unverified for good: no verified identity
// on their statements, and every check gated on users.fica_status = 'approved'
// permanently shut.
//
// This drives the real endpoint over HTTP with a real admin session, because
// the defect lived in the gap between two tables and only an end-to-end call
// crosses it.

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

const TAG = "ficaapprove";
const customer = { id: randomUUID() };
const admin = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
let server;
let baseUrl;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',FALSE,'submitted')`,
    [customer.id, `${TAG} ${suffix}`, `${TAG}_${suffix}`, `${TAG}_${suffix}@example.invalid`,
     `2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Compliance Officer',$2,$3,'compliance','x','active')`,
    [admin.id, `${TAG}_admin_${suffix}`, `${TAG}_admin_${suffix}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'admin',$2,'admin','x',$3, NOW() + INTERVAL '1 hour')`,
    [admin.session, admin.id, admin.jti]
  );
  admin.token = signAccessToken({ sub: admin.id, sid: admin.session, jti: admin.jti, typ: "admin", scope: "admin" });
}

async function newReview() {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO kyc_reviews (id, user_id, review_type, status, notes)
     VALUES ($1,$2,'FICA','pending',$3::jsonb)`,
    [id, customer.id, JSON.stringify({ metadata: { identityKind: "South African ID", idNumber: "9001015000085", address: "12 Demo Street, Sandton" } })]
  );
  return id;
}

async function cleanup() {
  await pool.query("DELETE FROM kyc_reviews WHERE user_id=$1", [customer.id]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [admin.id]).catch(() => {});
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [admin.id]).catch(() => {});
  await pool.query("DELETE FROM admin_users WHERE id=$1", [admin.id]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [customer.id]).catch(() => {});
}

test.before(async () => {
  await cleanup();
  await seed();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
  await pool.end();
});

const decide = (reviewId, status) => fetch(`${baseUrl}/v1/admin/compliance/reviews/${reviewId}/status`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
  body: JSON.stringify({ status })
});
const ficaStatus = async () =>
  (await pool.query("SELECT fica_status FROM users WHERE id=$1", [customer.id])).rows[0].fica_status;

test("approving a FICA review makes the customer verified", async () => {
  const reviewId = await newReview();
  assert.equal(await ficaStatus(), "submitted", "starts unverified");

  const response = await decide(reviewId, "approved");
  assert.equal(response.status, 200, await response.clone().text());

  assert.equal(await ficaStatus(), "approved",
    "the decision must reach the customer record, not just the review row");

  // And the verified identity is now readable, which is the thing the whole
  // chain exists to produce.
  const { approvedFicaDetails } = require("../src/services/wallet-service");
  const details = await approvedFicaDetails(pool, customer.id);
  assert.ok(details, "an approved customer has verified identity details");
  assert.equal(details.idNumber, "9001015000085");
});

test("rejecting a FICA review marks the customer rejected", async () => {
  await pool.query("UPDATE users SET fica_status='submitted' WHERE id=$1", [customer.id]);
  const reviewId = await newReview();
  const response = await decide(reviewId, "rejected");
  assert.equal(response.status, 200);
  assert.equal(await ficaStatus(), "rejected");
});

test("a non-terminal decision leaves the customer's status alone", async () => {
  await pool.query("UPDATE users SET fica_status='submitted' WHERE id=$1", [customer.id]);
  const reviewId = await newReview();
  const response = await decide(reviewId, "pending");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await ficaStatus(), "submitted",
    "only approved and rejected move the account holder's status");
});

// A PRE-EXISTING MISMATCH, RECORDED RATHER THAN HIDDEN.
//
// The endpoint validates against ["pending","submitted","pending_review",
// "approved","rejected"], but kyc_reviews.status is CHECK-constrained to
// ["pending","in_review","approved","rejected","expired"]. So "submitted" and
// "pending_review" pass the route's own validation and then fail at the
// database as a 500. Not introduced by the approval fix and not fixed here:
// deciding which of the two vocabularies is correct is a compliance call, not
// a refactor. This test states the current behaviour so the day somebody
// reconciles them, it fails and gets updated deliberately.
test("the route's status vocabulary is wider than the column's, and that still bites", async () => {
  const reviewId = await newReview();
  const response = await decide(reviewId, "pending_review");
  assert.equal(response.status, 500,
    "if this is no longer 500 the vocabularies were reconciled: update this test");
  assert.equal(await ficaStatus(), "submitted", "and nothing moved on the customer");
});
