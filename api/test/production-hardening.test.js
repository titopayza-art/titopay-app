"use strict";

// THE PRODUCTION-HARDENING BATCH, PINNED AT THE SOURCE.
//
// Behaviour is proven in verification/production-hardening-live.js; these
// checks stop the contracts rotting: stokvel money moves only through the
// treasurer endpoint on the transfer rails, gifts carry their message, the
// support list stays clean, and every email is honest - branded, copyright,
// no dead links, unsubscribe on marketing, no verify-email to a page that is
// not deployed.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const TX = read("src", "services", "transaction-service.js");
const STOKVEL = read("src", "services", "stockvel-service.js");
const STOKVEL_ROUTES = read("src", "routes", "stockvel.routes.js");
const EMAIL = read("src", "services", "email-centre-service.js");
const AUTH = read("src", "services", "auth-service.js");
const TICKETING = read("src", "services", "ticketing-service.js");
const SUPPORT = read("src", "services", "support-ticket-reply-service.js");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("stokvel contributions ride the transfer rails to the treasurer", () => {
  assert.match(TX, /"stockvel_contribution"[\s\S]{0,600}LIVE_QR_WALLET_SERVICES/,
    "stockvel_contribution must be a live single-recipient service");
  assert.doesNotMatch(TX, /MULTI_PARTY_SERVICES_PENDING_SETTLEMENT = new Set\(\[[^\]]*"stockvel_contribution"/,
    "the contribution code must no longer be refused");
  assert.match(STOKVEL, /serviceCode: "stockvel_contribution"/);
  assert.match(STOKVEL, /recipient: group\.username \|\| group\.email/,
    "the recipient is the treasurer resolved server-side, never client input");
  assert.match(STOKVEL_ROUTES, /router\.post\("\/:id\/contributions"/);
  assert.match(STOKVEL_ROUTES, /router\.get\("\/:id\/contributions\/preview"/);
  // The wizard creates groups directly and free.
  const wizard = APP_JS.slice(APP_JS.indexOf("function openStockvelCreateWizard("));
  assert.match(wizard.slice(0, wizard.indexOf("</form>")), /data-form="stockvel-create"/);
  assert.match(APP_JS, /async function submitStockvelCreate/);
  assert.match(APP_JS, /async function submitStockvelContribution/);
});

test("a gift notifies its recipient with occasion and message", () => {
  assert.match(TX, /normalizedServiceCode === "send_gift" && recipientWallet\?\.user_id/);
  assert.match(TX, /notificationType: "gift_received"/);
  // The PWA no longer offers a schedule that nothing honours.
  assert.doesNotMatch(APP_JS, /scheduledDelivery/,
    "the fake Schedule-it option must stay gone until real scheduling exists");
});

test("the support list hides ratings and clears finished requests in one call", () => {
  assert.match(SUPPORT, /<> 'support_rating'/);
  assert.match(SUPPORT, /async function hideMyFinishedTickets/);
  assert.match(APP_JS, /data-support-clear-finished/);
});

test("every email is branded with the copyright line and live legal links", () => {
  assert.match(EMAIL, /Copyright © \$\{new Date\(\)\.getUTCFullYear\(\)\} TitoPay\. All Rights Reserved\./);
  assert.doesNotMatch(EMAIL, /website_url\)\}\/privacy/,
    "/privacy does not exist on the website - the footer must link /legal");
  assert.doesNotMatch(EMAIL, /website_url\)\}\/terms/,
    "/terms does not exist on the website - the footer must link /legal");
});

test("registration no longer sends a verify-email pointing at a missing page", () => {
  assert.doesNotMatch(AUTH, /await createVerificationForUser\(rows\[0\], meta\)/,
    "the dead-link verification email must stay off until its landing page is deployed");
  assert.match(EMAIL, /createVerificationForUser/, "the machinery survives for when the page ships");
});

test("marketing emails carry a signed unsubscribe and honour opt-outs", () => {
  assert.match(EMAIL, /marketing_email_optouts/);
  assert.match(EMAIL, /function buildUnsubscribeUrl/);
  assert.match(EMAIL, /timingSafeEqual/, "the unsubscribe signature check must be constant-time");
  const ADMIN = read("src", "routes", "admin.routes.js");
  assert.match(ADMIN, /marketingOptOutEmails/);
  assert.match(ADMIN, /unsubscribeUrl:buildUnsubscribeUrl\(recipient\.email\)/);
  const APP_SRC = read("src", "app.js");
  assert.match(APP_SRC, /\/v1\/email\/unsubscribe/);
});

test("an emailed ticket carries its PDF", () => {
  assert.match(TICKETING, /renderTicketPdf/);
  assert.match(TICKETING, /application\/pdf/);
  assert.match(EMAIL, /attachments/);
  // The PDF renders locally with no network fetches.
  const PDF = read("src", "services", "ticket-pdf-service.js");
  assert.match(PDF, /require\("pdfkit"\)/);
  assert.doesNotMatch(PDF, /https?:\/\//, "the ticket PDF must never fetch anything remote");
});

test("no catalogue door previews cleanly only to fail at Confirm", () => {
  // Every service the catalogue can submit either has a live flow or is
  // refused at the fee preview. These codes were the half-open doors.
  for (const code of ["shop_marketplace", "rewards", "virtual_doctor", "travel", "donate", "cross_border", "get_cash", "cash_back", "refund"]) {
    assert.match(TX, new RegExp(`"${code}"`), `${code} must be listed as provider-dependent`);
  }
});
