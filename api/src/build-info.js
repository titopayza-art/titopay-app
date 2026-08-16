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

const API_BUILD = 31;

// Most recent first. Keep this short; it is a deployment aid, not a changelog.
const BUILD_NOTES = {
  31: "The ladder is three levels and the whole ladder moved: unverified " +
      "R25 000 a month, identity verified R200 000 a month, fully verified " +
      "no standing limit on any rail. Set deliberately ABOVE the identity " +
      "assurance the platform currently holds, so the trade-off is written " +
      "into the config rather than discovered later. Risk is still applied " +
      "last, so an elevated or high risk account is narrowed on every level " +
      "including the top one.",
  30: "Providers become replaceable and a business stops being a person. Core " +
      "asks for a CAPABILITY (processPayment, processPayout, verifyIdentity) " +
      "and never for a company; which supplier answers is one environment " +
      "variable per capability. A business now has its own entity, its own " +
      "registration number where its type has one, and its own KYB status, so " +
      "one verified person can hold several businesses without re-verifying " +
      "themselves once. The top verification level gains a R200 000 monthly " +
      "ceiling in place of no standing limit at all.",
  29: "A cancelled event is answered instead of hidden: its public page used to " +
      "404 the moment it was cancelled, killing every share, email link and " +
      "poster QR pointing at it, and My Tickets never carried the event status " +
      "so a cancelled ticket looked live. Customers can also remove a ticket " +
      "from My Tickets, which hides it and never deletes it, so the row, its " +
      "scan history and the organiser's counts are untouched and it can be " +
      "brought back.",
  28: "The schema can rebuild an empty database again: two ticketing tables " +
      "referenced transactions 200 lines before it was created, and because " +
      "the file runs as one statement that rolled the WHOLE schema back and " +
      "left nothing behind. Adds `npm run db:diagnose`, which reports the real " +
      "reason a console page is failing instead of the sanitised message the " +
      "operator sees.",
  27: "The same commit-then-500 audit bug fixed for security content in build " +
      "26 was still live on PUT /admin/roles/:role, which wrote a role name " +
      "into a UUID column: changing what a role may do saved the change and " +
      "then reported failure, logging nothing. Fixed at the call site AND in " +
      "writeAuditLog, so any identifier that is not a UUID now travels in the " +
      "metadata rather than costing the whole audit record.",
  26: "Saving security content no longer answers 500 after saving it: the audit " +
      "write put the settings key in a UUID column, so the copy changed while " +
      "the admin was shown an error and the log recorded nothing. The console " +
      "and the API now offer the SAME icon list, so re-saving cannot downgrade " +
      "a stored icon, and the admin read reports whether anything is stored and " +
      "who wrote it.",
  25: "The customer security copy is admin-editable: the Stay safe with TitoPay " +
      "card, its warning, the acknowledge button and the safety tips now live in " +
      "platform_settings and are edited from the console with a live preview. " +
      "Reading is public and never throws; the app keeps the same defaults so " +
      "the warning still renders with no network at all.",
  24: "Refund policy ENFORCED, not just stored: refunds_allowed, the cut-off " +
      "and the conditions had never been read by anything, and the app sent " +
      "every tier as refundable regardless. Buyers now see the terms before " +
      "paying and organisers approve refunds themselves. Plus waitlists on " +
      "sold-out events, promoter links that attribute sales, multi-day events, " +
      "duplicate-an-event, and server-rendered Open Graph link previews.",
  23: "Event discovery: search and category filtering answered in SQL over the " +
      "whole approved catalogue instead of in the browser over one batch, with " +
      "category counts built from the full catalogue so a filter can always be " +
      "undone. One shared category vocabulary for the organiser's form and the " +
      "buyer's chips. Browsing still needs no account.",
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
