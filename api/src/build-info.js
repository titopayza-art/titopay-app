"use strict";

// WHICH BUILD IS ACTUALLY RUNNING ON THE SERVER?
//
// Four separate debugging sessions have now started with a feature that was
// present in the code, proven by tests and a live harness, and absent on the
// customer's phone: the TitoKids co-parent screen, the "Not found" ticketing
// panel, the admin console's ticketing metrics reading R0.00, and the
// wristband Link button. In every case the answer was the same, and in every
// case it took an investigation to establish it, because the deployed API
// state was invisible from outside.
//
// The PWA solved this for itself: index.html carries app.min.js?v=NNN, so the
// running bundle can be read in one request. This is the same idea for the
// API. GET /health reports the build, so "is the server current?" becomes one
// curl instead of an afternoon.
//
// BUMP API_BUILD whenever api.zip is rebuilt for deployment, and add a line to
// the notes below. The number is deliberately a plain integer: it only has to
// answer "newer or older than the build that contains the fix".

const API_BUILD = 22;

// Most recent first. Keep this short; it is a deployment aid, not a changelog.
const BUILD_NOTES = {
  22: "Ticket discount codes: organisers create a code with an expiry and " +
      "either a percentage or an amount off, optionally capped by total uses, " +
      "uses per person and ticket type. Buyers enter it at checkout. The " +
      "discount comes off the subtotal so the organiser funds it, and TitoPay " +
      "charges commission on what was paid, never on the money given away. " +
      "Schema is additive; orders written before this are untouched.",
  21: "Sign out now revokes the session the server already proved, instead of " +
      "matching a refresh token hash from the request body and reporting " +
      "success whether or not anything was revoked. A refresh token is still " +
      "honoured when sent, scoped to the caller's own account, so it can no " +
      "longer sign a stranger out. Other devices are unaffected.",
  20: "Two holes a live probe opened, closed. The API enforced no password " +
      "rule at all and accepted the password 'a'; it now applies a policy at " +
      "registration and reset, and NEVER at sign-in, so no existing customer " +
      "is locked out. Account lockout is checked before the password is " +
      "verified, so a correct guess against a locked account no longer looks " +
      "different from a wrong one.",
  19: "Fewer database round trips on the money path: the limit engine now " +
      "returns the 24 hour debit count with the rest of its usage picture, " +
      "and transaction monitoring reads it from there instead of asking the " +
      "ledger the same two questions again. No rule, limit or number changed.",
  18: "Basic Verified limits set to the assurance TitoPay actually has: " +
      "R25 000 a month, R10 000 a payment, with the rest of the rung moved " +
      "to stay coherent. Raise them in the console the day an identity " +
      "verification provider is wired in.",
  17: "Held money now lives in a suspense wallet so every leg balances; both " +
      "sender and recipient are told about a hold (in-app only, never a " +
      "claim-by-link message); hold window 7 days; earned capacity counts " +
      "distinct real counterparties, so it cannot be farmed by self-payment.",
  16: "Limit engine: verification x product x earned standing x risk, risk last. " +
      "Refusals quote remaining capacity, never the law. Money beyond a recipient's " +
      "capacity is held for them to claim, released on verification, returned in " +
      "full (fee included) if unclaimed. Limit config versioned and reversible.",
  15: "Money Integrity Engine: ledger-vs-balance sweeps, duplicate/orphan/" +
      "unbalanced detection, transaction status history by trigger, provider " +
      "reconciliation with exception queues, compliance case management, " +
      "dashboards, regulatory report evidence, security signals into risk.",
  14: "Identity verification goes international: SA ID, passport or other " +
      "approved document with issuing country, hash-only storage, verification " +
      "history, and nine customer-safe verification states on the wallet badge.",
  13: "Compliance finalized: risk axis separate from KYC (normal/elevated/high " +
      "risk/EDD), sanctions screening list, transaction monitoring, ongoing CDD, " +
      "daily/withdrawal/balance limits, pre-limit upgrade nudges, RMCP disclaimers.",
  12: "Progressive KYC/FICA: four tiers with configurable limits, instant SA ID " +
      "basic verification, automatic EDD flags, and Limits and Verification in the app.",
  11: "Receiving is open unless the account is blocked; every sent transfer " +
      "records and reports who was paid, name and contact included.",
  10: "FICA is now the R200 000 monthly receiving limit, not a wall: unverified " +
      "accounts receive and request freely under the line, one rule on all rails.",
  9: "/health now reports the email worker's own build, so an unrestarted worker is visible.",
  8: "Emails render full-width and readable on phones: viewport-aware wrapper.",
  7: "Stokvel treasurer contributions live; gift notices; PDF tickets in email; " +
     "email overhaul (copyright, legal links, unsubscribe, no dead verify link); " +
     "support list cleanup; response compression; hot-path indexes.",
  6: "Payment requests live: Request funds and Bill Split store real requests, " +
     "notify the payer, and settle on the wallet_transfer rails when paid.",
  5: "Cleared notifications stay cleared on every device: server-side clear marker.",
  4: "Campaigns scoped to one event, paid on submission, released only on admin approval.",
  3: "Campaign Tools: R1500 email pack per event, R0.60 per SMS sent.",
  2: "Ticket phases and pre-sales enforced; registration events; organiser social links.",
  1: "Ticketing analytics on the console's path; Service Builder API storage; " +
     "raw emails can never render blank; TitoKids invite rewritten; build number added."
};

module.exports = {
  API_BUILD,
  BUILD_NOTES,
  buildInfo() {
    return { build: API_BUILD, appVersion: "1.0" };
  }
};
