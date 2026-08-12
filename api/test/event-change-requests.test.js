"use strict";

// ORGANISER CHANGE REQUESTS + SAFE CANCEL + REFUND ECONOMICS.
//
// The runtime proof against a real database is
// verification/event-change-requests-live.js (14 checks). These are the
// structural invariants that must never silently regress: the state machine is
// guarded, a cancel opens refund requests without moving money, the refund
// reverses the commission rather than overcharging the business, and a
// cancelled event's tickets stop scanning in.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const service = require("../src/services/ticketing-service");
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "ticketing.routes.js"), "utf8");
const ADMIN_ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "admin.routes.js"), "utf8");

test("the change-request service functions are exported", () => {
  for (const fn of ["requestEventChange", "listMyEventChangeRequests", "listEventChangeRequests", "processEventChangeRequest"]) {
    assert.equal(typeof service[fn], "function", `${fn} must be exported`);
  }
});

test("the admin event state machine only allows sensible transitions", () => {
  // Before this guard existed any action was accepted from any status: an admin
  // could approve a never-submitted draft (skipping validation) or reinstate a
  // cancelled event. The change-request applier reuses this transition.
  assert.match(SOURCE, /const EVENT_ACTION_ALLOWED_FROM = \{/);
  const block = SOURCE.match(/const EVENT_ACTION_ALLOWED_FROM = \{[\s\S]*?\};/)[0];
  // approve must not be reachable from a terminal state.
  assert.doesNotMatch(block.match(/approve: \[[^\]]*\]/)[0], /cancelled|completed|rejected/,
    "approve must not be allowed from a terminal status");
  // suspend only from approved; reinstate only from suspended.
  assert.match(block, /suspend: \["approved"\]/);
  assert.match(block, /reinstate: \["suspended"\]/);
  // The guard actually throws.
  assert.match(SOURCE, /if \(!allowedFrom\.includes\(previousStatus\)\) \{\s*\n\s*throw new AppError\(409/,
    "an illegal transition must be a 409, not a silent write");
});

test("re-approving an event clears stale rejection/suspension text", () => {
  // In the approved branch of adminTransitionEvent, both stale-reason columns
  // are cleared so a now-live event carries no old rejection/suspension text.
  assert.match(SOURCE, /sets\.push\("rejection_reason = NULL", "suspended_reason = NULL"\);/,
    "the approved branch must clear both stale-reason columns");
  const approvedIdx = SOURCE.indexOf('if (status === "approved") {');
  const clearIdx = SOURCE.indexOf('sets.push("rejection_reason = NULL", "suspended_reason = NULL");');
  assert.ok(approvedIdx !== -1 && clearIdx > approvedIdx && clearIdx - approvedIdx < 400,
    "the clear must sit inside the approved branch");
});

test("a cancel opens refund requests but moves no money in the cascade", () => {
  const fn = SOURCE.match(/async function cancelEventCascade\([\s\S]*?\n\}/)[0];
  // It invalidates still-valid tickets.
  assert.match(fn, /UPDATE tickets SET status = 'cancelled'[\s\S]*?status = 'valid'/,
    "valid tickets must be invalidated on cancel");
  // It opens a refund request for paid orders only, de-duplicated.
  assert.match(fn, /INSERT INTO ticket_refunds/, "a refund request must be opened per paid order");
  assert.match(fn, /o\.total > 0/, "only orders that moved money get a refund request");
  assert.match(fn, /NOT EXISTS[\s\S]*?ticket_refunds/, "an existing open refund must not be duplicated");
  // Crucially, the cascade must NOT move money itself — no wallet movement, so a
  // drained business wallet can never leave a cancel half-applied.
  assert.doesNotMatch(fn, /applyWalletMovement/,
    "the cancel cascade must never move money — settlement stays in the guarded refund path");
});

test("a cancelled or suspended event refuses entry at the door", () => {
  const fn = SOURCE.match(/async function scanTicket\([\s\S]*?\n\}/)[0];
  assert.match(fn, /e\.status AS event_status/, "scanTicket must read the event status");
  assert.match(fn, /event_status === "cancelled"/, "a cancelled event must refuse entry");
  assert.match(fn, /event_status === "suspended"/, "a suspended event must hold entry");
});

test("a refund reverses the commission instead of overcharging the business", () => {
  const fn = SOURCE.match(/async function processTicketRefund\([\s\S]*?\n\}/)[0];
  // The business is debited its net share, not the whole subtotal.
  assert.match(fn, /const businessPortion = money\(Number\(order\.business_net \|\| 0\) \* ratio\)/,
    "the business is debited its recorded net share");
  assert.match(fn, /const commissionPortion = money\(refundAmount - businessPortion\)/,
    "the commission portion is the remainder");
  assert.match(fn, /const businessDebitTotal = money\(businessPortion \+ refundProcessingFee\)/,
    "the business is only ever debited its net share plus the refund fee");
  // The commission is reversed from the revenue wallet and recorded as negative
  // revenue.
  assert.match(fn, /source: "commission_reversal"/, "the commission must be reversed from the revenue wallet");
  assert.match(fn, /-commissionPortion, revenueWallet\.id/, "the reversal is recorded as negative revenue");
  // The buyer still gets the full subtotal back.
  assert.match(fn, /walletId: buyerWallet\.id,[\s\S]*?amount: refundAmount/,
    "the buyer is credited the full refund amount");
});

test("change requests are only accepted on an approved (or suspended) event", () => {
  const fn = SOURCE.match(/async function requestEventChange\([\s\S]*?\n\}/)[0];
  assert.match(SOURCE, /CHANGE_REQUEST_ALLOWED_EVENT_STATUS = new Set\(\["approved", "suspended"\]\)/);
  assert.match(fn, /CHANGE_REQUEST_ALLOWED_EVENT_STATUS\.has\(event\.status\)/,
    "a draft/in-review event must refuse a change request");
  assert.match(fn, /You already have a pending change request/,
    "only one open request per event at a time");
});

test("a postpone edits only date/time; a cancel reuses the guarded admin cancel", () => {
  const fn = SOURCE.match(/async function processEventChangeRequest\([\s\S]*?\n\}/)[0];
  // Postpone is date-only, so ticket types (and quantity_sold) are never touched.
  assert.match(fn, /applyEventDetailUpdate\(request\.event_id, changes, \{ dateOnly: true \}\)/,
    "a postpone must be a date-only update");
  // Cancel goes back through adminTransitionEvent so the safe cascade + audit run.
  assert.match(fn, /adminTransitionEvent\(request\.event_id, \{ action: "cancel"/,
    "an approved cancel request must reuse the guarded admin cancel path");
  // The narrow updater never deletes/recreates ticket types.
  const upd = SOURCE.match(/async function applyEventDetailUpdate\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(upd, /event_ticket_types/, "a detail update must never touch ticket types");
  assert.doesNotMatch(upd, /replaceTicketTypes/, "a detail update must never replace ticket types");
});

test("the routes for organiser + admin change requests exist", () => {
  assert.match(ROUTES, /post\("\/business\/events\/:id\/change-request"/, "organiser can raise a request");
  assert.match(ROUTES, /get\("\/business\/events\/:id\/change-requests"/, "organiser can list their requests");
  assert.match(ADMIN_ROUTES, /get\("\/ticketing\/change-requests"/, "admin can list the queue");
  assert.match(ADMIN_ROUTES, /post\("\/ticketing\/change-requests\/:id\/action"/, "admin can approve/decline");
});
