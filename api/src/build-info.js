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

const API_BUILD = 11;

// Most recent first. Keep this short; it is a deployment aid, not a changelog.
const BUILD_NOTES = {
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
