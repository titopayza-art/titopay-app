"use strict";

// GUARDRAILS - these fail the build if a whole CLASS of defect is reintroduced,
// the same way test/no-jwt-derived-keys style tests already lock earlier fixes
// shut. Every check below maps to a real bug found in an audit; the comment says
// which. These are static source checks, so they need no database.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

function readAll(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const FILES = readAll(SRC);

test("no SA calendar window is computed with a bare UTC date_trunc(NOW())", () => {
  // A day/week/month window that means the South African calendar MUST be
  // anchored `DATE_TRUNC('day', NOW() AT TIME ZONE 'Africa/Johannesburg')`.
  // A bare `date_trunc('day', NOW())` rolls at 02:00 SAST and was the TitoKids
  // spend-cap bypass and several report-boundary bugs.
  const offenders = [];
  const bare = /date_trunc\(\s*'(day|week|month)'\s*,\s*now\(\)\s*\)/gi;
  for (const file of FILES) {
    const text = fs.readFileSync(file, "utf8");
    if (bare.test(text)) offenders.push(path.relative(SRC, file));
    bare.lastIndex = 0;
  }
  assert.deepEqual(offenders, [],
    `these files roll an SA calendar window in UTC; wrap NOW() in AT TIME ZONE 'Africa/Johannesburg': ${offenders.join(", ")}`);
});

test("TitoKids spend windows are anchored in South African time", () => {
  const text = fs.readFileSync(path.join(SRC, "services", "titokids-service.js"), "utf8");
  const fn = text.slice(text.indexOf("async function spentInWindows"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /Africa\/Johannesburg/,
    "spentInWindows must anchor day/week/month in Africa/Johannesburg, or a child can exceed the daily cap in the 00:00-02:00 SAST slice");
});

test("the send cap is enforced even without an idempotency key", () => {
  // The per-user limit lock + assertCanSendAmount re-check must NOT live only
  // inside `if (idempotencyKey)`, or two concurrent key-less sends bypass the
  // monthly cap. Assert the limits lock is taken AFTER the idempotency block, at
  // the function's top-level transaction scope.
  const text = fs.readFileSync(path.join(SRC, "services", "transaction-service.js"), "utf8");
  const start = text.indexOf("async function createTransaction");
  assert.ok(start >= 0, "createTransaction must exist");
  const fn = text.slice(start, text.indexOf("\nasync function ", start + 1));
  const idemReplayIdx = fn.indexOf("return transactionResponseFromRow(replayed[0]);");
  const limitsLockIdx = fn.indexOf("limits:${actor.userId}");
  assert.ok(idemReplayIdx >= 0 && limitsLockIdx >= 0, "both the idempotency replay and the limits lock must be present");
  assert.ok(limitsLockIdx > idemReplayIdx,
    "the limits lock + assertCanSendAmount must sit AFTER the idempotency replay block, so the cap is enforced on the no-key path too");
});

test("reverseTransaction refuses externally-settled service codes", () => {
  const text = fs.readFileSync(path.join(SRC, "services", "transaction-service.js"), "utf8");
  assert.match(text, /NON_REVERSIBLE_SERVICES/,
    "reverseTransaction must guard against reversing bank payouts / top-ups / tickets (a blind ledger flip double-pays)");
  const fn = text.slice(text.indexOf("async function reverseTransaction"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /NON_REVERSIBLE_SERVICES\.has/,
    "the reverse guard must actually be checked inside reverseTransaction");
});

test("statement money-in/out totals are filtered to completed transactions", () => {
  const text = fs.readFileSync(path.join(SRC, "services", "transaction-service.js"), "utf8");
  const fn = text.slice(text.indexOf("async function statementForUser"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const filters = body.match(/status = 'completed'/g) || [];
  assert.ok(filters.length >= 2,
    "both money_in_total and money_out_total must FILTER on status = 'completed' so a failed/reversed row cannot inflate a statement");
});

test("webhook delivery does not follow redirects (SSRF protection)", () => {
  const text = fs.readFileSync(path.join(SRC, "services", "webhook-service.js"), "utf8");
  assert.match(text, /redirect:\s*"manual"/,
    "webhook delivery must use redirect: 'manual' so a merchant-controlled redirect cannot bypass the private-range guard");
});
