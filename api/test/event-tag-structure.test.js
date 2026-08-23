"use strict";

// Event Tags carry one rule that no amount of later editing may quietly undo:
//
//   EVENT TAG ≠ WALLET
//
// The end-to-end harness proves it holds at runtime. These are the static
// guards — the things a future change could break in a way a passing app would
// still hide, like adding a balance column that nothing reads yet, or logging
// a credential.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serviceSource = fs.readFileSync(path.join(__dirname, "../src/services/event-tag-service.js"), "utf8");
const ticketingSource = fs.readFileSync(path.join(__dirname, "../src/services/ticketing-service.js"), "utf8");
const ticketingRoutes = fs.readFileSync(path.join(__dirname, "../src/routes/ticketing.routes.js"), "utf8");
const adminRoutes = fs.readFileSync(path.join(__dirname, "../src/routes/admin.routes.js"), "utf8");
const posRoutes = fs.readFileSync(path.join(__dirname, "../src/pos/routes.js"), "utf8");
const authService = fs.readFileSync(path.join(__dirname, "../src/services/auth-service.js"), "utf8");

// The Event Tag half of the ticketing schema, isolated from the rest of it.
const schema = ticketingSource.slice(ticketingSource.indexOf("CREATE TABLE IF NOT EXISTS event_tags"));

test("no Event Tag table has a balance column", () => {
  const tagTables = schema.slice(0, schema.indexOf("`)"));
  const offenders = tagTables
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(balance|available_balance|reserved_balance|credit|debit|amount|float|loaded|topped_up)\b/i.test(line));
  assert.deepEqual(offenders, [], "an Event Tag holds no money; it points at the attendee's existing wallet");
});

test("no second wallet or ledger is created for events", () => {
  for (const forbidden of [
    /CREATE TABLE[^;]*event_wallets/i,
    /CREATE TABLE[^;]*event_ledger/i,
    /CREATE TABLE[^;]*event_tag_ledger/i,
    /CREATE TABLE[^;]*event_balances/i,
    /CREATE TABLE[^;]*event_topups/i,
  ]) {
    assert.ok(!forbidden.test(ticketingSource), `${forbidden} would be a second ledger`);
  }
});

test("every Event Tag migration is additive", () => {
  // No DROP, no TRUNCATE, no destructive ALTER anywhere in the tag schema.
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i.test(schema), "migrations must not drop anything");
  assert.ok(!/\bTRUNCATE\b/i.test(schema), "migrations must not truncate anything");
  assert.ok(!/ALTER\s+TABLE\s+\w+\s+RENAME/i.test(schema), "migrations must not rename existing columns");
  // Every new table and column is guarded so a redeploy is a no-op.
  const creates = schema.match(/CREATE TABLE (IF NOT EXISTS )?/g) || [];
  assert.ok(creates.length >= 3, `expected the three tag tables, found ${creates.length}`);
  assert.ok(creates.every((c) => /IF NOT EXISTS/.test(c)), "every CREATE TABLE must be IF NOT EXISTS");
  const alters = ticketingSource.match(/ALTER TABLE events ADD COLUMN (IF NOT EXISTS )?cashless\w+/g) || [];
  assert.equal(alters.length, 2, "cashless_tags_enabled and cashless_settings");
  assert.ok(alters.every((a) => /IF NOT EXISTS/.test(a)), "every ADD COLUMN must be IF NOT EXISTS");
});

test("cashless is off unless someone switches it on", () => {
  assert.match(ticketingSource, /cashless_tags_enabled BOOLEAN NOT NULL DEFAULT FALSE/,
    "an existing event must behave exactly as it did before");
});

test("only the hash of a credential is stored, never the credential", () => {
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.ok(!/\btoken TEXT\b/.test(schema), "the credential itself is never a column");
  // The one place a token is produced, and the one place it is written.
  // 16 bytes = 128 bits: unguessable for a payment credential, and half the
  // former string length for writing to a physical tag.
  assert.match(serviceSource, /crypto\.randomBytes\(16\)\.toString\("base64url"\)/);
  assert.match(serviceSource, /VALUES \(\$1,\$2,\$3,\$4,'UNASSIGNED'\)/);
  assert.match(serviceSource, /sha256\(token\)/);
});

test("publicTag never returns a credential or its hash", () => {
  const body = serviceSource.slice(serviceSource.indexOf("function publicTag"));
  const shape = body.slice(0, body.indexOf("\n}"));
  assert.ok(!/token/i.test(shape), "no endpoint may hand a credential back");
  // And it exposes nothing that leaks the holder's identity either.
  for (const leak of ["user_id", "userId", "walletId", "wallet_id", "phone", "email", "id_number"]) {
    assert.ok(!shape.includes(leak), `publicTag must not expose ${leak}`);
  }
});

test("nothing logs a credential", () => {
  const logLines = serviceSource
    .split("\n")
    .filter((line) => /console\.(log|info|warn|error)|logger\./.test(line));
  assert.deepEqual(logLines, [], "no logging at all in the tag path, so nothing can leak into logs");
  // And the audit trail records actions, not credentials.
  const auditCall = serviceSource.slice(serviceSource.indexOf("async function recordTagEvent"));
  assert.ok(!/token/i.test(auditCall.slice(0, auditCall.indexOf("\n}"))), "the audit trail carries no credential");
});

test("the charge path resolves everything server-side", () => {
  const charge = serviceSource.slice(
    serviceSource.indexOf("async function chargeEventTag"),
    serviceSource.indexOf("/* =", serviceSource.indexOf("async function chargeEventTag"))
  );
  // The request supplies a credential and an amount. Nothing else it says is
  // trusted: user, wallet, event and vendor are all looked up here.
  assert.ok(!/payload\.(userId|walletId|eventId|customerId|merchantId)/.test(charge),
    "the terminal must not be able to name the customer, wallet, event or merchant");
  assert.match(charge, /FROM event_tags t\s+JOIN events e/, "the event comes from the tag");
  assert.match(charge, /FROM event_vendors v/, "the vendor must be authorised for that event");
  assert.match(charge, /terminal\.merchant_id/, "the merchant comes from the authenticated terminal");
  // The same locking and idempotency the POS lane already uses.
  assert.match(charge, /pg_advisory_xact_lock/);
  assert.match(charge, /pos_idempotency_keys/);
  assert.match(charge, /FOR UPDATE OF w/);
  assert.match(charge, /profile_locked.*423|423.*Profile is locked/s, "a locked wallet still cannot pay");
  assert.match(charge, /Insufficient balance/);
});

test("the money moves through the existing ledger, not a new one", () => {
  assert.match(serviceSource, /require\("\.\/wallet-service"\)/);
  assert.match(serviceSource, /applyWalletMovement/);
  // Exactly one debit and one credit, against one transactions row.
  const charge = serviceSource.slice(serviceSource.indexOf("async function chargeEventTag"));
  assert.equal((charge.match(/entryType: "debit"/g) || []).length, 1);
  assert.equal((charge.match(/entryType: "credit"/g) || []).length, 1);
  assert.equal((charge.match(/INSERT INTO transactions/g) || []).length, 1);
  // And no direct balance arithmetic anywhere in the file.
  assert.ok(!/UPDATE wallets\s+SET/i.test(serviceSource),
    "balances are only ever changed by applyWalletMovement");
});

test("the tag charge rides the POS terminal authentication, unchanged", () => {
  assert.match(posRoutes, /router\.post\("\/event-tags\/charge", requireTerminalAuth/);
  // confirmPayment is a customer-authorised path and must not have been widened
  // to accept a terminal-authorised debit.
  const posService = fs.readFileSync(path.join(__dirname, "../src/pos/service.js"), "utf8");
  const confirm = posService.slice(posService.indexOf("async function confirmPayment"));
  assert.match(confirm.slice(0, 200), /actor\.userType !== "customer"/,
    "POS confirm still requires the customer's own token");
  assert.ok(!/event_tag/i.test(posService), "the existing POS service was not touched");
});

test("every staff and organiser route is gated, and none trusts the body", () => {
  const tagRoutes = ticketingRoutes
    .split("\n")
    .filter((line) => /^router\.(get|post)\("\/(business\/events\/:id\/(cashless|vendors|tags)|tags)/.test(line));
  assert.ok(tagRoutes.length >= 11, `expected the tag routes, found ${tagRoutes.length}`);
  assert.ok(tagRoutes.every((line) => line.includes("requireAuth")), "every tag route requires a session");
  // The two gates, and the fact that ownership is resolved rather than asserted.
  assert.match(ticketingRoutes, /await getBusinessEvent\(req\.auth\.userId, eventId\)/);
  assert.match(ticketingRoutes, /canManageEventTicketing\(req\.auth\.userId, eventId, "tags"\)/);
  // The attendee's own tags come from the token, never the URL or the body.
  assert.match(ticketingRoutes, /listMyEventTags\(req\.auth\.userId\)/);
  assert.match(ticketingRoutes, /reportMyTagLost\(req\.auth, tagId\)/);
});

test("admin tag routes sit behind their own permission", () => {
  const adminTagRoutes = adminRoutes
    .split("\n")
    .filter((line) => /^router\.(get|post)\("\/ticketing\/(events\/:id\/(tags|vendors)|tags\/)/.test(line));
  assert.ok(adminTagRoutes.length >= 5, `expected the admin tag routes, found ${adminTagRoutes.length}`);
  assert.ok(adminTagRoutes.every((line) => line.includes('requireAdminPermission("event_tags")')));
  // Admin can look and can stop a tag. Admin cannot mint, assign or replace one.
  assert.ok(!/\/ticketing\/(events\/:id\/tags\/issue|tags\/:tagId\/(assign|replace))/.test(adminRoutes));
});

test("the event_tags permission exists and is not handed out broadly", () => {
  assert.match(authService, /"event_tags"/);
  const roles = authService.slice(authService.indexOf("const ADMIN_ROLE_PERMISSIONS"), authService.indexOf("\n};", authService.indexOf("const ADMIN_ROLE_PERMISSIONS")));
  const holders = roles
    .split("\n")
    // Role lines only — `name: [...]`. The comment above them names the
    // permission too, and is not a grant.
    .filter((line) => /^\s{2}\w+:\s*\[/.test(line) && line.includes('"event_tags"'))
    .map((line) => line.trim().split(":")[0]);
  assert.deepEqual(holders.sort(), ["compliance", "customer_support", "finance"],
    "blocking an attendee's wristband is a support and compliance job, not a marketing one");
});

test("an Event Tag tap is registered as a real service code", () => {
  // transactions.service_code is a foreign key into pricing_rules, so without
  // this row a tap could not reach the ledger at all.
  const pricing = fs.readFileSync(path.join(__dirname, "../src/services/pricing-service.js"), "utf8");
  // Asserts the ROW EXISTS, not its price: this test exists for the foreign
  // key, and the approved figure is owned by approved-pricing-schedule.test.js
  // so a price change does not have to be edited in two places.
  assert.match(pricing, /\["event_tag", "Event Tag Payment"/);
  assert.match(ticketingSource, /ensureDefaultPricingRule\("event_tag"\)/);
});
