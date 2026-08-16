"use strict";

// REFUND POLICY, WAITLIST, PROMOTERS AND LINK PREVIEWS, PINNED.
//
// Proven end to end against real wallets in verification/ticket-refunds-live.js.
// These hold the parts that were quietly wrong for a long time and would be
// easy to make wrong again.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const TICKETING = read("src", "services", "ticketing-service.js");
const ROUTES = read("src", "routes", "ticketing.routes.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
const { refundPolicyFor, refundEligibility } = require("../src/services/ticketing-service");

const future = (days) => new Date(Date.now() + days * 86400000);

test("the refund policy is described in words a buyer can act on", () => {
  const open = refundPolicyFor({ refunds_allowed: true, refund_deadline: future(10) }, {});
  assert.equal(open.refundsAllowed, true);
  assert.match(open.headline, /Refundable until/);
  assert.ok(open.feeNotice.length > 0, "the buyer is told the fee is not returned");

  const closed = refundPolicyFor({ refunds_allowed: false }, {});
  assert.equal(closed.refundsAllowed, false);
  assert.equal(closed.headline, "This ticket is non-refundable.");
  assert.equal(closed.feeNotice, "", "there is no fee notice on a ticket that cannot be refunded");
});

test("a non-refundable ticket is refused, in the organiser's own words", () => {
  const result = refundEligibility(
    { status: "paid", total: 200 },
    { refunds_allowed: false, refund_conditions: "All sales are final." },
    {});
  assert.equal(result.eligible, false);
  assert.match(result.reason, /does not offer refunds/i);
  assert.match(result.reason, /All sales are final/, "the organiser's wording is quoted back");
});

test("the cut-off is enforced, not merely displayed", () => {
  const past = refundEligibility({ status: "paid", total: 200 },
    { refunds_allowed: true, refund_deadline: future(-1) }, {});
  assert.equal(past.eligible, false);
  assert.match(past.reason, /refund window .* closed/i);

  const inside = refundEligibility({ status: "paid", total: 200 },
    { refunds_allowed: true, refund_deadline: future(5) }, { event_date: future(20) });
  assert.equal(inside.eligible, true, inside.reason);
});

test("an event that has already happened cannot be refunded", () => {
  // Otherwise a no-show stays refundable forever whenever the deadline column
  // happened to be left empty.
  const result = refundEligibility({ status: "paid", total: 200 },
    { refunds_allowed: true, refund_deadline: null }, { event_date: future(-3) });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /already taken place/i);
});

test("a scanned ticket and a free ticket are both refused", () => {
  const scanned = refundEligibility({ status: "paid", total: 200 },
    { refunds_allowed: true }, { event_date: future(10) }, { scannedCount: 1 });
  assert.equal(scanned.eligible, false);
  assert.match(scanned.reason, /scanned/i);

  const free = refundEligibility({ status: "paid", total: 0 }, { refunds_allowed: true }, {});
  assert.equal(free.eligible, false);
  assert.match(free.reason, /free/i);
});

test("one function answers the buyer's screen and the refund gate", () => {
  // A policy shown at checkout and a policy applied at the counter that could
  // differ is worse than no policy at all.
  assert.match(TICKETING, /refundPolicy: refundPolicyFor\(row, row\)/,
    "the purchase preview carries the policy");
  const fn = TICKETING.slice(TICKETING.indexOf("async function requestTicketRefund("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.match(body, /refundEligibility\(order, order, order/,
    "the request is gated by the same function");
  assert.match(body, /if \(!eligibility\.eligible\) throw new AppError\(409, eligibility\.reason\)/);
  // The preview must actually SELECT the columns, or the policy silently reads
  // as non-refundable on every ticket.
  assert.match(TICKETING, /tt\.refunds_allowed, tt\.refund_deadline, tt\.refund_conditions/);
});

test("the organiser sets the policy; the app no longer hard-codes yes", () => {
  assert.doesNotMatch(APP, /refundsAllowed: true\b/,
    "every tier used to be sent as refundable whatever the organiser intended");
  assert.match(APP, /refundsAllowed,\n\s*refundDeadline,/);
  assert.match(APP, /name="refundsAllowed"/);
  assert.match(APP, /name="refundCutoffDays"/);
  // And the buyer reads it before paying, not after asking.
  assert.match(APP, /refund-policy-note/);
  assert.match(APP, /refundPolicy = preview\.refundPolicy/);
});

test("an organiser id never lands in the admin column", () => {
  // processed_by is a foreign key into admin_users. An organiser is a customer,
  // so writing their id there would break the insert outright.
  assert.match(TICKETING, /ALTER TABLE ticket_refunds ADD COLUMN IF NOT EXISTS processed_by_user_id UUID REFERENCES users\(id\)/);
  const fn = TICKETING.slice(TICKETING.indexOf("async function processTicketRefund("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.match(body, /const isAdmin = String\(actor\?\.userType \|\| "admin"\) === "admin"/);
  assert.match(body, /const adminId = isAdmin \?/);
  assert.match(body, /const organiserId = isAdmin \? null :/);
});

test("every organiser desk is owner-scoped", () => {
  for (const marker of [
    'router.get("/business/events/:id/refunds"',
    'router.post("/business/events/:id/refunds/:refundId/action"',
    'router.get("/business/events/:id/waitlist"',
    'router.post("/business/events/:id/waitlist/notify"',
    'router.get("/business/events/:id/promoters"',
    'router.post("/business/events/:id/promoters"',
    'router.delete("/business/events/:id/promoters/:promoterId"',
    'router.post("/business/events/:id/duplicate"'
  ]) {
    const start = ROUTES.indexOf(marker);
    assert.ok(start > -1, `${marker} exists`);
    const handler = ROUTES.slice(start, ROUTES.indexOf("\n});", start));
    assert.match(handler, /requireEventOwner\(req\)/, `${marker} goes through requireEventOwner`);
  }
  // The refund action additionally proves the refund belongs to that event.
  const start = ROUTES.indexOf('router.post("/business/events/:id/refunds/:refundId/action"');
  const handler = ROUTES.slice(start, ROUTES.indexOf("\n});", start));
  assert.match(handler, /FROM ticket_refunds WHERE id = \$1 AND event_id = \$2/);
});

test("a waitlist reserves nothing and cannot be gamed", () => {
  assert.match(TICKETING, /CREATE TABLE IF NOT EXISTS ticket_waitlist/);
  // One place per person per tier, enforced by the database rather than by a
  // read-then-write two taps could interleave.
  assert.match(TICKETING, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_waitlist_unique/);
  assert.match(TICKETING, /Nothing is reserved and nothing has been charged/);
  // No money path anywhere near it.
  const fn = TICKETING.slice(TICKETING.indexOf("async function joinTicketWaitlist("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.doesNotMatch(body, /applyWalletMovement|available_balance/,
    "joining a waitlist must not touch a wallet");
});

test("a promoter code attributes, and never breaks a payment", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function purchaseTickets("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  // Resolved by subquery inside the transaction: an unknown or switched-off
  // code sets NULL rather than throwing.
  assert.match(body, /UPDATE ticket_orders SET promoter_id = \(/);
  assert.match(body, /WHERE event_id = \$2 AND code = \$3 AND status = 'active'/);
  assert.doesNotMatch(body, /promoterCode[\s\S]{0,200}throw new AppError/,
    "a promoter code must never be a reason a payment fails");
  // Attribution only. TitoPay pays no commission on it.
  assert.match(TICKETING, /pays no commission|no commission on it/i);
});

test("link previews serve real tags, escaped", () => {
  const start = ROUTES.indexOf('router.get("/public/events/:slug/preview"');
  const handler = ROUTES.slice(start, ROUTES.indexOf("\n});", start));
  for (const tag of ["og:title", "og:description", "og:url", "twitter:card"]) {
    assert.ok(handler.includes(tag), `the preview emits ${tag}`);
  }
  assert.match(handler, /escapeHtmlAttribute\(event\.eventName\)/,
    "an event name must be escaped before it goes into an attribute");

  // og:image USED to be offered only for an http(s) poster, which meant never:
  // every poster is stored as a data: URL, so every shared event previewed with
  // no image at all. It now points at a route that decodes those bytes.
  assert.match(handler, /apiPublicOrigin\(req\)[\s\S]*?\/poster`/,
    "og:image must point at a poster route a crawler can fetch");
  assert.match(handler, /event\.eventBannerUrl\s*\n?\s*\?/,
    "an event with no poster must offer no og:image, rather than one that 404s");
  assert.match(ROUTES, /router\.get\("\/public\/events\/:slug\/poster"/,
    "the poster route the preview points at must exist");

  // The description goes into an HTML attribute, so it is flattened and cut at
  // a word boundary. It used to slice raw text at 160 characters, ending
  // mid-word with the description's own line breaks still in it.
  assert.match(ROUTES, /function metaSummary\(/);
  assert.match(handler, /metaSummary\(event\.description, 160\)/);

  // THE SHARED LINK IS THE APP'S OWN, not this preview path. Organisers were
  // sending their audience an api.titopay.co.za URL that reads like a developer
  // path. Crawlers reach the preview through the app's .htaccess instead.
  const share = APP.slice(APP.indexOf("async function shareTicketingEvent"),
    APP.indexOf("async function openPublicTicketingEvent"));
  const shareCode = share.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.match(shareCode, /\$\{origin\}\/events\/\$\{encodeURIComponent\(slug\)\}/,
    "the app must share the real event link");
  assert.doesNotMatch(shareCode, /\/preview/,
    "the app must not hand an organiser an API path to send to their audience");
});

test("the poster route is public, read-only and refuses anything but an image", () => {
  const start = ROUTES.indexOf('router.get("/public/events/:slug/poster"');
  assert.ok(start > -1, "the poster route must exist");
  const handler = ROUTES.slice(start, ROUTES.indexOf("\n});", start));
  // Approved events only: getPublicApprovedEvent is the same gate the preview
  // and the public event page use, so a draft's poster is never reachable.
  assert.match(handler, /getPublicApprovedEvent\(req\.params\.slug\)/,
    "a draft or rejected event's poster must not be servable");
  assert.doesNotMatch(handler, /requireAuth/, "a crawler cannot authenticate");
  // Only real image types are decoded, and the browser is told not to guess.
  assert.match(handler, /image\\\/\(\?:png\|jpe\?g\|webp\|gif\)/,
    "only image content types may be served from a stored data: URL");
  assert.match(handler, /X-Content-Type-Options.*nosniff/,
    "a decoded blob must never be sniffed into something executable");
  assert.match(handler, /404/, "an event with no poster answers 404, not an empty 200");
});

test("multi-day is a column, not a recurrence engine", () => {
  // Every ticket, scan, report and settlement keys off one events row. A
  // series of occurrences would be a rewrite of the money path.
  assert.match(TICKETING, /ALTER TABLE events ADD COLUMN IF NOT EXISTS event_end_date DATE/);
  assert.match(TICKETING, /async function duplicateEvent/);
  // A copy must not inherit the original's sales.
  const fn = TICKETING.slice(TICKETING.indexOf("async function duplicateEvent("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  // Comment lines are stripped first. The comment above the INSERT explains
  // why the counter is left behind, and naming it there must not read as the
  // code carrying it across.
  const code = body.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /quantity_sold/, "a duplicate must not carry the original's sales counters");
  assert.match(body, /'draft'/, "a copy goes through approval like any other event");
});

test("the hub is still six doors, not a menu", () => {
  const sections = (APP.match(/const TICKETING_SECTIONS = \[[\s\S]*?\n\];/) || [""])[0];
  const keys = [...sections.matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 6,
    "refunds, waitlist and promoter links joined existing doors rather than adding a seventh");
  assert.ok(keys.includes("sales") && keys.includes("coupons"));
});

test("no em dash in the new customer-facing copy", () => {
  const start = APP.indexOf("function aftersalesPanels");
  const section = APP.slice(start, APP.indexOf("async function refreshEventPromoters"));
  assert.ok(!section.includes("—"), "em dashes are not used in customer-facing text");
  const preview = ROUTES.slice(ROUTES.indexOf('router.get("/public/events/:slug/preview"'));
  assert.ok(!preview.slice(0, 2600).includes("—"), "nor in a link preview people will read");
});
