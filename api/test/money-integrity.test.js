"use strict";

// THE MONEY INTEGRITY FRAMEWORK, PINNED. Behaviour is proven live in
// verification/money-integrity-live.js; these contracts stop the
// architecture rotting: one observing engine, deduplicated alerts that
// re-open, a database-level status history, reconciliation that never
// auto-corrects, case management with decisions, and no admin surface that
// can silently move or set a balance.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const INTEGRITY = read("src", "services", "money-integrity-service.js");
const COMPLIANCE = read("src", "services", "compliance-service.js");
const ADMIN = read("src", "routes", "admin.routes.js");
const TX_ROUTES = read("src", "routes", "transaction.routes.js");
const AUTH = read("src", "services", "auth-service.js");
const WORKER = read("src", "email-worker.js");
const SCHEMA = read("src", "db", "schema.sql");

test("every status transition is recorded at the database, and reversed is terminal", () => {
  // The trigger writes history in the same database transaction as the
  // change, so no code path can change a status silently.
  assert.match(INTEGRITY, /CREATE OR REPLACE FUNCTION titopay_record_tx_status/);
  assert.match(INTEGRITY, /transaction_status_history/);
  assert.match(INTEGRITY, /reversed is terminal/);
  assert.match(SCHEMA, /titopay_tx_status_update BEFORE UPDATE OF status ON transactions/);
  assert.match(SCHEMA, /titopay_tx_status_insert AFTER INSERT ON transactions/);
  // The lifecycle map exists for the rails to consult.
  assert.match(INTEGRITY, /ALLOWED_STATUS_TRANSITIONS/);
});

test("the sweep detects the failure modes that matter, and repairs nothing", () => {
  for (const check of ["balance_mismatch", "duplicate_posting", "orphan_transaction",
    "unbalanced_entries", "negative_balance", "stale_in_flight", "provider_review"]) {
    assert.match(INTEGRITY, new RegExp(check), `sweep covers ${check}`);
  }
  // Observation only: the engine must never write to wallets or the ledger.
  assert.doesNotMatch(INTEGRITY, /UPDATE wallets SET available_balance/);
  assert.doesNotMatch(INTEGRITY, /INSERT INTO wallet_ledger/);
  assert.match(INTEGRITY, /repairing a\s+financial record silently is exactly what this engine exists to prevent/i);
});

test("alerts deduplicate while open and re-open after resolution", () => {
  assert.match(INTEGRITY, /fingerprint TEXT NOT NULL UNIQUE/);
  assert.match(INTEGRITY, /ON CONFLICT \(fingerprint\) DO UPDATE/);
  assert.match(INTEGRITY, /WHERE money_integrity_alerts\.status = 'resolved'/);
  // Resolution requires a stated note, and both actions are audit-logged.
  assert.match(INTEGRITY, /State how this alert was resolved/);
  assert.match(INTEGRITY, /money_integrity_alert_resolved/);
});

test("reconciliation records runs, queues exceptions, and never auto-corrects", () => {
  assert.match(INTEGRITY, /reconciliation_runs/);
  assert.match(INTEGRITY, /reconciliation_exceptions/);
  for (const type of ["unmatched_provider_transaction", "amount_mismatch", "missing_settlement", "unexpected_settlement"]) {
    assert.match(INTEGRITY, new RegExp(type));
  }
  assert.match(INTEGRITY, /never auto-corrected/i);
  assert.doesNotMatch(INTEGRITY, /UPDATE transactions SET status/,
    "reconciliation observes; it does not rewrite transaction outcomes");
});

test("the worker runs the sweep on a single-process cadence", () => {
  assert.match(WORKER, /cyclesSinceIntegrity/);
  assert.match(WORKER, /runIntegritySweep/);
});

test("no admin surface can silently set or move a balance", () => {
  // The only wallet mutation on the admin surface is status (freeze etc.);
  // there is deliberately no endpoint that writes a balance.
  assert.doesNotMatch(ADMIN, /UPDATE wallets SET available_balance/);
  assert.doesNotMatch(ADMIN, /INSERT INTO wallet_ledger/);
  // The one money-moving admin action, reversal, records a reason and
  // raises a standing visibility alert.
  assert.match(TX_ROUTES, /manual_reversal/);
  assert.match(TX_ROUTES, /reason/);
});

test("case management: assignment and decisions with notes, audit-logged", () => {
  assert.match(ADMIN, /router\.get\("\/compliance\/cases"/);
  assert.match(ADMIN, /router\.post\("\/compliance\/cases\/:id\/assign"/);
  assert.match(ADMIN, /router\.post\("\/compliance\/cases\/:id\/decide"/);
  assert.match(ADMIN, /compliance_case_assigned/);
  assert.match(ADMIN, /compliance_case_decided/);
  assert.match(ADMIN, /A decision carries a note explaining it\./);
});

test("dashboards, dry-run checks and regulatory evidence exist", () => {
  assert.match(ADMIN, /router\.get\("\/compliance\/overview"/);
  assert.match(ADMIN, /router\.post\("\/compliance\/transaction-check"/);
  assert.match(ADMIN, /router\.get\("\/integrity\/alerts"/);
  assert.match(ADMIN, /router\.get\("\/integrity\/reconciliation"/);
  assert.match(ADMIN, /router\.post\("\/compliance\/reports"/);
  // Regulatory report types are never an enum invented in code.
  assert.match(INTEGRITY, /report_type TEXT NOT NULL/);
  assert.doesNotMatch(INTEGRITY, /'STR'|'CTR'|goAML/i,
    "no report type is hard-coded; compliance maps the obligations");
});

test("security events feed the central risk engine as signals", () => {
  assert.match(AUTH, /recordRiskSignal\(user\.id, "failed_logins"/);
  assert.match(COMPLIANCE, /duplicate_account/);
  assert.match(COMPLIANCE, /document_reuse_attempt/);
  // Signals, never verdicts: the login path must not depend on the risk
  // engine answering.
  assert.match(AUTH, /\.catch\(\(\) => \{\}\)/);
});

test("limit changes carry reason, previous and new values into the audit", () => {
  assert.match(ADMIN, /State the reason for this limit change/);
  assert.match(COMPLIANCE, /metadata: \{ reason, previous, config: merged, warnings \}/);
});

test("the suspended state exists, distinct from restricted", () => {
  assert.match(COMPLIANCE, /suspended: "Suspended"/);
  assert.match(COMPLIANCE, /if \(accountStatus === "suspended"\) return "suspended"/);
});

test("integrity thresholds are configuration, not code", () => {
  assert.match(INTEGRITY, /money_integrity_config/);
  assert.match(INTEGRITY, /DEFAULT_INTEGRITY_CONFIG/);
  assert.match(INTEGRITY, /staleInFlightHours/);
  assert.match(INTEGRITY, /escalationEmail: null/,
    "no escalation address is invented; compliance configures it");
});

test("integrity settings are editable from the console with the same discipline as limits", () => {
  assert.match(ADMIN, /router\.get\("\/integrity\/config"/);
  assert.match(ADMIN, /router\.put\("\/integrity\/config"/);
  assert.match(INTEGRITY, /async function saveIntegrityConfig/);
  assert.match(INTEGRITY, /State the reason for this integrity settings change/);
  assert.match(INTEGRITY, /integrity_config_updated/);
  assert.match(INTEGRITY, /metadata: \{ reason: stated, previous, config: merged \}/);
  // And the console page carries the panels.
  const CONSOLE = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "admin.js"), "utf8");
  for (const marker of ["data-integrity-sweep", "data-integrity-alert-resolve", "data-case-decide",
    "data-limits-save", "data-integrity-config-save", "data-screening-run", "data-report-record"]) {
    assert.ok(CONSOLE.includes(marker), `console wires ${marker}`);
  }
});
