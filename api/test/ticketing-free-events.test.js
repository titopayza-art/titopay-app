"use strict";

// FREE EVENTS DON'T NEED FICA; PAID ONES STILL DO.
//
// A business can now set up a free event — a seminar, a conference, a community
// meetup — without full FICA verification, because a free event never receives
// money. The moment any ticket carries a price, the money-readiness checks come
// back, at every gate: create, edit, and submit.
//
// The gate is one pure function, assertTicketingEligibility, and these tests
// hold it to the rule directly, without a database. The compliance-critical
// property is the one asserted hardest: a paid ticket by an unverified business
// is refused. The end-to-end proof against a real database — that a free ticket
// actually moves no money — is verification/free-ticketing-live.js.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ticketTypesIncludePaid,
  assertTicketingEligibility
} = require("../src/services/ticketing-service");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");

// A business that has done everything EXCEPT the money-readiness steps — no
// merchant profile, no completed registration, not FICA-approved, no active
// wallet. This is the exact account in the "why can't I set up a free event?"
// screenshot, and it must be able to run a FREE event.
const UNVERIFIED = {
  structuralBlockers: [],
  paymentBlockers: [
    "A registered business merchant profile is required before selling paid tickets.",
    "Business registration details must be completed before selling paid tickets.",
    "Full business FICA verification is required before selling paid tickets.",
    "An active business wallet is required to receive ticket payments."
  ]
};

// A genuinely structural block — this is not a business account at all, so it
// cannot run any event, free or paid. Merchant profile and registration are NO
// LONGER structural: they gate paid tickets, not event creation.
const INCOMPLETE = {
  structuralBlockers: ["Only TitoPay Business accounts can create events."],
  paymentBlockers: ["Full business FICA verification is required before selling paid tickets."]
};

// Fully ready.
const VERIFIED = { structuralBlockers: [], paymentBlockers: [] };

const FREE = [{ ticketName: "General", price: 0 }];
const PAID = [{ ticketName: "General", price: 0 }, { ticketName: "VIP", price: 250 }];

test("what counts as paid", () => {
  assert.equal(ticketTypesIncludePaid(FREE), false);
  assert.equal(ticketTypesIncludePaid([{ price: 0 }, { price: 0 }]), false);
  assert.equal(ticketTypesIncludePaid([]), false, "an event with no tickets yet is not paid");
  assert.equal(ticketTypesIncludePaid(PAID), true);
  assert.equal(ticketTypesIncludePaid([{ price: 0.01 }]), true, "a single cent is a paid ticket");
  assert.equal(ticketTypesIncludePaid([{ price: "150" }]), true, "a stringified price still counts");
  assert.equal(ticketTypesIncludePaid([{ price_amount: 100 }]), true, "the snake_case field is read too");
  assert.equal(ticketTypesIncludePaid([{ price: -5 }]), false, "a negative price is not a sale");
});

test("an unverified business CAN set up a free event", () => {
  // The whole point of the feature: this must not throw.
  assert.doesNotThrow(() => assertTicketingEligibility(UNVERIFIED, FREE, "creating events"));
  assert.doesNotThrow(() => assertTicketingEligibility(UNVERIFIED, [], "creating events"),
    "a draft with no tickets yet is treated as free");
});

test("an unverified business CANNOT set up a paid event", () => {
  const error = assertThrows(() => assertTicketingEligibility(UNVERIFIED, PAID, "creating events"));
  assert.equal(error.statusCode, 403);
  assert.match(error.message, /FICA/i, "the message must name the actual requirement");
  assert.equal(error.details.action, "complete_fica");
  // Only the payment blockers are surfaced — the structural ones are already met.
  assert.ok(error.details.blockers.every((b) => /FICA|wallet|verification|merchant|registration/i.test(b)),
    "every surfaced blocker for a paid event is a money-readiness one");
});

test("the paid-ticket gate holds at every entry point", () => {
  // create, edit and submit all call the same gate. If any one of them let a
  // paid ticket through for an unverified business, that business could receive
  // money without FICA — so all three are asserted.
  for (const verb of ["creating events", "editing events", "submitting events"]) {
    assert.throws(() => assertTicketingEligibility(UNVERIFIED, PAID, verb), /FICA/i,
      `${verb} must enforce FICA for paid tickets`);
    assert.doesNotThrow(() => assertTicketingEligibility(UNVERIFIED, FREE, verb),
      `${verb} must allow free tickets`);
  }
});

test("a structurally incomplete business is stopped even for a free event", () => {
  // Free does not mean anonymous. A real, active, registered business is still
  // required — a free seminar is still published under a business's name.
  const error = assertThrows(() => assertTicketingEligibility(INCOMPLETE, FREE, "creating events"));
  assert.equal(error.statusCode, 403);
  assert.match(error.message, /Business verification is required/i);
  assert.deepEqual(error.details.blockers, INCOMPLETE.structuralBlockers,
    "the structural blocker, not the FICA one, is what is reported for a free event");
});

test("a fully verified business is unaffected", () => {
  assert.doesNotThrow(() => assertTicketingEligibility(VERIFIED, PAID, "creating events"));
  assert.doesNotThrow(() => assertTicketingEligibility(VERIFIED, FREE, "creating events"));
});

test("eligibility reports whether free events are possible, separately from paid", () => {
  // getBusinessEligibility must expose the split so the PWA can offer free-event
  // creation while still gating paid tickets behind FICA.
  assert.match(SOURCE, /canCreateFreeEvents: structuralBlockers\.length === 0/);
  assert.match(SOURCE, /structuralBlockers,\s*\n\s*paymentBlockers,/,
    "both blocker lists must be returned, not just the combined one");
  assert.match(SOURCE, /const blockers = \[\.\.\.structuralBlockers, \.\.\.paymentBlockers\]/,
    "the combined blockers/eligible must keep their original meaning for existing callers");
});

test("merchant profile and business registration gate PAID tickets, not free events", () => {
  // The reported bug: these two checks sat in the structural list and blocked a
  // business from setting up a free event. They must live with the payment
  // blockers, or the free-event path is broken again.
  const eligibilityFn = SOURCE.match(/const structuralBlockers = \[\][\s\S]*?const blockers = /);
  assert.ok(eligibilityFn, "the eligibility block must be found");
  const block = eligibilityFn[0];
  const structuralPart = block.slice(0, block.indexOf("const paymentBlockers"));
  const paymentPart = block.slice(block.indexOf("const paymentBlockers"));

  // Structural must NOT mention merchant profile or registration any more.
  assert.doesNotMatch(structuralPart, /merchant profile/i,
    "merchant profile must not be a structural (all-events) requirement");
  assert.doesNotMatch(structuralPart, /registration details/i,
    "business registration must not be a structural requirement");

  // They must be present in the payment (paid-only) group.
  assert.match(paymentPart, /merchant_uuid\) paymentBlockers\.push/,
    "the merchant-profile check must be a payment blocker");
  assert.match(paymentPart, /business_name \|\| !row\.merchant_id\) paymentBlockers\.push/,
    "the registration check must be a payment blocker");

  // Structural is only the three account-level checks — that is what a free
  // event needs, and all it needs.
  assert.match(structuralPart, /account_type !== "business"/);
  assert.match(structuralPart, /user_status !== "active"/);
  assert.match(structuralPart, /profile_locked/);
});

test("a free ticket is charged nothing, and moves no money", () => {
  // The buyer service fee is a flat R10, so 'free' has to be made free on
  // purpose — a percentage-only fee would have been zero by itself. These are
  // source assertions because the fee and the ledger both need a database; the
  // running proof is verification/free-ticketing-live.js.
  assert.match(SOURCE, /const isFree = subtotal <= 0;/);
  assert.match(SOURCE, /const buyerFee = isFree \? 0 :/);
  assert.match(SOURCE, /const businessCommission = isFree \? 0 :/);

  // applyWalletMovement throws on a zero amount, so every movement is guarded.
  assert.match(SOURCE, /if \(preview\.total > 0\) \{\s*\n\s*await applyWalletMovement/,
    "the buyer debit must be skipped when there is nothing to pay");
  assert.match(SOURCE, /if \(businessWallet && preview\.businessNet > 0\) \{\s*\n\s*await applyWalletMovement/,
    "the business credit must be skipped when there is nothing to settle");
  assert.match(SOURCE, /if \(preview\.businessNet > 0 && !businessWallet\) throw/,
    "a missing business wallet must only stop a paid ticket, never a free one");
});

test("a free purchase never requires the platform revenue wallet", () => {
  // The reported bug: purchaseTickets loaded the revenue wallet unconditionally
  // and threw a 500 ("revenue wallet is not configured") when it was absent — so
  // EVERY purchase, free ones included, failed on an environment with no revenue
  // wallet set up. The revenue wallet only banks platform fees, so it must be
  // loaded only when there is a fee to bank. The running proof is
  // verification/free-ticketing-live.js with the revenue wallet hidden.
  assert.doesNotMatch(SOURCE, /const revenueWallet = await loadRevenueWalletForUpdate\(client\);/,
    "the revenue wallet must NOT be loaded unconditionally in a purchase");
  assert.match(SOURCE, /const hasFees = money\(preview\.buyerFee \+ preview\.businessCommission\) > 0;/,
    "a purchase must decide up front whether any fee is owed");
  assert.match(SOURCE, /const revenueWallet = hasFees \? await loadRevenueWalletForUpdate\(client\) : null;/,
    "the revenue wallet must be loaded only when a fee is actually owed");
  // The dereference and the null-guard must share the same condition, so a
  // free ticket can never reach revenueWallet.id.
  assert.match(SOURCE, /if \(hasFees && revenueWallet\) \{\s*\n\s*await applyWalletMovement\(client, \{\s*\n\s*walletId: revenueWallet\.id/,
    "the revenue movement must be guarded by the same hasFees check that loaded the wallet");
});

test("a free order cannot be pushed through the refund money path", () => {
  // Refund charges a R0.50 processing fee; letting a free order into that path
  // would debit a business to 'refund' money it never received.
  assert.match(SOURCE, /This ticket was free, so there is nothing to refund/);
});

// A tiny throws helper that returns the error, since AppError carries the
// statusCode and details this test checks.
function assertThrows(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected the call to throw");
}
