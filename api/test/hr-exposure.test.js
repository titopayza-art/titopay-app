"use strict";

// THE HR PORTAL IS NOT A SEPARATE SYSTEM.
//
// hr.routes.js is mounted into the same Express app as the payments API, ahead
// of the customer auth stack, and it queries the same Postgres. A weakness in
// the staff portal is therefore a weakness in the process that moves customer
// money — not something contained to an HR page.
//
// Two things were measured against a running API before any of this was
// written, and both are what these tests now hold in place.
//
// 1. HOW MANY PASSWORD GUESSES EACH DOOR TOOK
//
//      customer login   /v1/auth/login          blocked after 5
//      admin login      /v1/admin/login         blocked after 5
//      HR login         /api/v1/hr/auth/login   NOT BLOCKED in 60 attempts
//
//    hr.routes.js never imported a limiter. The only thing in front of it was
//    generalLimiter, whose own comment says it is "a fairness control rather
//    than a security control" — 120 requests per 60 seconds. Against 5 per 15
//    minutes elsewhere, that is 360 times as many guesses per hour.
//
//    Account lockout (5 failures, 15 minutes) did blunt an attack on ONE
//    account. It does nothing against spraying one common password across every
//    staff address, which is how this is actually done.
//
// 2. THE PUBLIC WRITE ENDPOINT ACCEPTED ANYTHING
//
//    /public/career-application guards itself with `if (configuredToken)`, so an
//    unset HR_WEBSITE_TOKEN skips the check rather than refusing. Measured with
//    it unset:
//
//      no credential at all          -> 201, row written
//      a deliberately wrong token    -> 201, token never examined
//      one request carrying 200 KB   -> 201, 200000 bytes stored
//
//    Unbounded free text on an unauthenticated endpoint, writing to the same
//    database that serves payments.

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "hr.routes.js"), "utf8");
const LIMITS = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "rate-limits.js"), "utf8");

test("HR login is rate limited like every other login", () => {
  assert.match(ROUTES, /require\("\.\.\/middleware\/rate-limits"\)/,
    "hr.routes.js imported no limiter at all");
  assert.match(ROUTES, /router\.post\("\/auth\/login",\s*authLimiter/,
    "HR login must carry the same limiter as customer and admin login");
});

test("HR password reset is rate limited", () => {
  // Without it, this endpoint is a way to mail every staff address repeatedly.
  assert.match(ROUTES, /router\.post\("\/auth\/reset",\s*authLimiter/);
});

test("HR refresh is deliberately NOT on the sensitive limiter", () => {
  // This is a decision, not an omission, and it is the one that would have
  // broken the portal. The sensitive key is IP + identifier + route, and a
  // refresh request carries only a refreshToken — no email — so every member of
  // staff behind one office NAT collapses to the SAME key. Five refreshes per
  // fifteen minutes for the whole company is an outage, not a control. Refresh
  // also already requires a valid signed token, so it is not a guessing surface.
  assert.doesNotMatch(ROUTES, /router\.post\("\/auth\/refresh",\s*authLimiter/,
    "a refresh limiter keyed on IP alone locks out a whole office");
  assert.match(LIMITS, /const raw = authenticatedIdentity \|\| body\.identifier \|\| body\.email/,
    "if the identifier ever includes a refresh token, revisit the line above");
});

test("the public career endpoint carries its own tight limiter", () => {
  // publicContactLimiter already existed for exactly this shape of endpoint:
  // unauthenticated, writes a row, 5 per 15 minutes.
  assert.match(ROUTES, /router\.post\("\/public\/career-application",\s*publicContactLimiter/);
  assert.match(LIMITS, /publicContactLimiter = rateLimit\(\{[\s\S]{0,200}max: 5/);
});

test("an unauthenticated applicant cannot store unbounded text", () => {
  // The cap lives in the service rather than the route on purpose: the same
  // function is reachable through a second, older copy of this handler in
  // auth.js, and a guard on one route would not cover it.
  const { __applicationLimits } = require("../src/services/hr-service");
  assert.ok(__applicationLimits, "the caps must be exported so they can be tested");

  const { capText, FIELD_LIMITS } = __applicationLimits;
  assert.equal(capText("A".repeat(200000), FIELD_LIMITS.notes).length, FIELD_LIMITS.notes,
    "200 KB of free text was previously stored verbatim");
  assert.ok(FIELD_LIMITS.notes <= 5000, "a job application does not need more than a few thousand characters");
  assert.equal(capText("  padded  ", 100), "padded", "values are trimmed as well as capped");
  assert.equal(capText(null, 100), "", "a missing value is empty, never the string 'null'");
  assert.equal(capText(undefined, 100), "");

  // Every stored field is capped, not just the obvious one.
  for (const field of ["name", "email", "jobTitle", "phone", "qualification", "portfolio", "notes", "websiteApplicationId"]) {
    assert.ok(Number.isInteger(FIELD_LIMITS[field]) && FIELD_LIMITS[field] > 0,
      `${field} is stored from an unauthenticated request and has no cap`);
  }
});

test("the service applies the caps rather than merely exporting them", () => {
  // A limit nothing calls is decoration. This asserts the INSERT is fed capped
  // values, by reading what the function actually hands the database.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "hr-service.js"), "utf8");
  const fn = source.match(/async function receiveWebsiteApplication[\s\S]*?\n\}/);
  assert.ok(fn, "receiveWebsiteApplication must exist");
  const body = fn[0];
  assert.match(body, /capText\(/, "the caps are never applied");
  // The parameter array handed to pool.query must not contain a raw payload value.
  assert.doesNotMatch(body, /payload\.phone \|\| null/,
    "phone still reaches the database uncapped");
  assert.doesNotMatch(body, /payload\.qualification \|\| null/,
    "qualification still reaches the database uncapped");
});

test("fail-open on HR_WEBSITE_TOKEN is recorded, not silently accepted", () => {
  // The guard is still `if (configuredToken)`, because flipping it to fail
  // closed would break the careers form on any deployment where the variable
  // was never set — and that cannot be verified from here. What CAN be done is
  // refuse to let it be invisible.
  assert.match(ROUTES, /HR_WEBSITE_TOKEN/);
  assert.match(ROUTES, /console\.warn\(\s*"\[hr-public-application\]"/,
    "an unset token must announce itself rather than quietly opening the endpoint");
});
