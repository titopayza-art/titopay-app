"use strict";

// A READINESS PAGE IS ONLY WORTH HAVING IF IT CANNOT GO STALE.
//
// The question it answers — can TitoPay be a payment option in somebody else's
// checkout — is one an aggregator asks, and one the platform can answer about
// itself. What it must never become is a list somebody maintains, because a
// stale readiness report is read as a current one long after it stopped being
// true. Both directions of that failure are worse than having no page: the day
// the hosted payment page ships it would still say missing, and the day the
// idempotency guard is deleted it would still say ready.
//
// So every check is derived from the mounted routes, the live schema and the
// running configuration. These tests prove that by MOVING the platform and
// watching the answer follow, which is the only way to tell a derived answer
// from a hardcoded one that happens to be right today.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { pool } = require("../src/db/pool");
const { integrationReadiness } = require("../src/services/integration-readiness-service");

test.after(async () => { await pool.end(); });

test("it reports what the platform actually has, not a written list", async () => {
  const report = await integrationReadiness();
  const byKey = new Map(report.checks.map((check) => [check.key, check]));

  // These are real today, and the report finds them by looking.
  assert.equal(byKey.get("payment_intents").status, "ready");
  assert.match(byKey.get("payment_intents").detail, /\d+ endpoints, \d+ states/,
    "the endpoint and state counts are counted, not stated");
  assert.equal(byKey.get("idempotency").status, "ready");
  assert.equal(byKey.get("replay_protection").status, "ready");
  assert.equal(byKey.get("signed_webhooks").status, "ready");
  assert.equal(byKey.get("secret_rotation").status, "ready");
  assert.equal(byKey.get("refunds").status, "ready");

  // And these are honestly not.
  assert.equal(byKey.get("hosted_payment_page").status, "missing");
  assert.equal(byKey.get("return_url").status, "missing");
  assert.equal(byKey.get("merchant_settlement").status, "missing");

  // The one that is neither: the engine exists but only a till can reach it.
  assert.equal(byKey.get("partner_intent_creation").status, "partial",
    "an engine reachable only by terminal auth is not a yes and not a no");
  assert.match(byKey.get("partner_intent_creation").detail, /terminal authentication/);
});

test("THE STATE MACHINE IS COUNTED FROM THE SOURCE THAT DEFINES IT", async () => {
  // The check that proves derivation rather than description. The number of
  // states is read out of pos/service.js, so it cannot drift from the machine.
  const report = await integrationReadiness();
  const intents = report.checks.find((check) => check.key === "payment_intents");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pos", "service.js"), "utf8");
  const inSource = new Set((source.match(/"(PENDING|SCANNED|AUTHORIZED|COMPLETED|CANCELLED|EXPIRED|FAILED|REFUNDED|REVERSED)"/g) || [])
    .map((s) => s.replace(/"/g, "")));
  assert.equal(intents.evidence.split(", ").length, inSource.size,
    "the reported states match the states the engine actually defines");
  assert.ok(inSource.has("SCANNED"), "and SCANNED is one of them, which is what makes it a QR engine");
});

test("a missing table turns a ready check into a missing one", async () => {
  // Driven, not argued. The refunds check is answered from information_schema,
  // so renaming the table away must change the answer — and renaming it back
  // must change it again. A hardcoded true would pass neither half.
  const before = await integrationReadiness();
  assert.equal(before.checks.find((c) => c.key === "refunds").status, "ready");

  await pool.query("ALTER TABLE pos_refunds RENAME TO pos_refunds_readiness_probe");
  try {
    const during = await integrationReadiness();
    assert.equal(during.checks.find((c) => c.key === "refunds").status, "missing",
      "the report follows the schema rather than remembering an answer");
    assert.equal(during.summary.ready, before.summary.ready - 1,
      "and the summary follows with it");
  } finally {
    await pool.query("ALTER TABLE pos_refunds_readiness_probe RENAME TO pos_refunds");
  }

  const after = await integrationReadiness();
  assert.equal(after.checks.find((c) => c.key === "refunds").status, "ready",
    "restored, so the check is reading live state on every call");
});

test("the endpoint is Super Admin, and the rail agrees", () => {
  // A page describing the platform's own architecture is gated like the
  // Integration Centre beside it. Rail looser than API and an operator finds a
  // page that 403s; API looser than rail and the permission is not one.
  const routes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "admin.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/integration-readiness", requireSuperAdmin/);

  const console_ = fs.readFileSync(
    path.join(__dirname, "..", "..", "admin", "assets", "admin.js"), "utf8");
  assert.match(console_, /"integration-readiness": "__super_admin__"/,
    "the rail asks for the same thing the endpoint enforces");
  assert.match(console_, /\["\/integration-readiness\/", "integration-readiness", "Integration Readiness"\]/);
  assert.match(console_, /"integration-readiness": renderIntegrationReadiness/);

  const shell = fs.readFileSync(
    path.join(__dirname, "..", "..", "admin", "integration-readiness", "index.html"), "utf8");
  assert.match(shell, /data-page="integration-readiness"/);
  assert.match(shell, /style-src 'self'/, "carrying the same CSP as every other page");
});

test("the page renders no control, because there is nothing here to set", () => {
  // Read-only by nature: every value is a fact about the platform, and a
  // control would imply one could be changed from here. The way to change one
  // is to build the thing.
  const console_ = fs.readFileSync(
    path.join(__dirname, "..", "..", "admin", "assets", "admin.js"), "utf8");
  const page = console_.slice(console_.indexOf("async function renderIntegrationReadiness"),
    console_.indexOf("// THE SERVICE CATALOGUE: WHAT IS LIVE"));
  for (const control of ["<select", "<input", "<form", "method: \"PUT\"", "method: \"POST\""]) {
    assert.ok(!page.includes(control), `the readiness page must not render ${control}`);
  }
});
