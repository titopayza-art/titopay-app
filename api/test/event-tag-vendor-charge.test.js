"use strict";

// VENDOR IN-APP SOFTPOS — THE GUARDS AROUND TAP-TO-CHARGE.
//
// A vendor can charge a patron's Event Tag from the TitoPay app instead of an
// admin-registered hardware terminal. The full money movement and the
// authorisation are proven end to end against a real database in
// verification/vendor-tag-charge-live.js (vendor charges, idempotent replay,
// non-vendor refused, over-balance refused, blocked tag refused).
//
// These source guards keep the two safety properties that matter from
// regressing: the vendor path REUSES the proven terminal charge path rather than
// forking a second money mover, and it cannot be talked into charging by a
// caller who is not a live merchant.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "event-tag-service.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "ticketing.routes.js"), "utf8");
const eventTags = require("../src/services/event-tag-service");

test("the vendor charge function is exported and wired to an authenticated route", () => {
  assert.equal(typeof eventTags.chargeEventTagAsVendor, "function");
  assert.match(ROUTES, /router\.post\("\/vendor\/tag-charge", requireAuth/,
    "the vendor charge must sit behind requireAuth");
});

test("the vendor path reuses the proven charge path, not a second money mover", () => {
  const fn = SERVICE.match(/async function chargeEventTagAsVendor[\s\S]*?\n\}/);
  assert.ok(fn, "chargeEventTagAsVendor must exist");
  // It must DELEGATE to chargeEventTag rather than issue its own INSERT/ledger
  // writes — that is what keeps the advisory lock, idempotency, balance check
  // and audit identical to the hardware-terminal path.
  assert.match(fn[0], /return chargeEventTag\(vendorTerminal, payload, idempotencyKey, requestId\)/);
  assert.doesNotMatch(fn[0], /applyWalletMovement|INSERT INTO transactions/,
    "the vendor path must not move money itself; it delegates");
});

test("only a live business merchant can charge", () => {
  const fn = SERVICE.match(/async function chargeEventTagAsVendor[\s\S]*?\n\}/)[0];
  // No merchant profile -> refused. A personal account has no merchant row.
  assert.match(fn, /JOIN merchants m ON m\.user_id = u\.id/);
  assert.match(fn, /if \(!vendor\) throw new AppError\(403/);
  // A suspended account or an inactive merchant cannot take payments.
  assert.match(fn, /vendor\.user_status !== "active" \|\| vendor\.profile_locked\) throw new AppError\(403/);
  assert.match(fn, /vendor\.merchant_status !== "active"\) throw new AppError\(403/);
});

test("the vendor's idempotency scope cannot collide with a hardware terminal's", () => {
  const fn = SERVICE.match(/async function chargeEventTagAsVendor[\s\S]*?\n\}/)[0];
  // chargeEventTag builds its scope from terminal.id; a namespaced id keeps the
  // app path and the hardware path in separate idempotency namespaces.
  assert.match(fn, /id: `vendor-app:\$\{vendor\.id\}`/);
  assert.match(fn, /merchant_id: vendor\.id/);
});

test("the hardware terminal charge path is left completely unchanged", () => {
  // The vendor path must not have widened requireTerminalAuth or chargeEventTag.
  // chargeEventTag still authenticates via a terminal object and still checks
  // event_vendors for that terminal's merchant — the authorisation the vendor
  // path relies on.
  assert.match(SERVICE, /async function chargeEventTag\(terminal, payload = \{\}, idempotencyKey, requestId\)/);
  assert.match(SERVICE, /WHERE v\.event_id = \$1 AND v\.merchant_id = \$2/,
    "the vendor-authorisation check inside chargeEventTag must still be there");
});
