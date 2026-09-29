"use strict";

// A SALES WINDOW THAT NOBODY CHECKED.
//
// event_ticket_types has carried sales_opening_at, sales_closing_at and
// per_customer_purchase_limit since ticketing shipped. The purchase preview
// SELECTed two of them and then never looked at the values; the purchase
// transaction did not even select them. An organiser could set Early Bird to
// close on the 30th and TitoPay would keep selling it in December.
//
// These tests cover the gate as the pure decision it is. The live harness
// covers the same rule over real HTTP, because a rule that is right in a unit
// test and unenforced in the transaction is exactly the bug being fixed here.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "phase-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "phase-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ticketing = require("../src/services/ticketing-service");
const { ticketPhaseState, normalizeSocialLinks, SOCIAL_PLATFORMS } = ticketing;

const NOW = new Date("2026-08-13T12:00:00Z");
const stock = { quantity_available: 100, quantity_reserved: 0, quantity_sold: 0 };

test("a ticket with no window is always on sale", () => {
  // Every ticket sold before phases existed has NULL for both dates. If
  // enforcement read NULL as "closed", turning this on would have shut down
  // every live event on the platform.
  const phase = ticketPhaseState({ ...stock }, NOW);
  assert.equal(phase.state, "on_sale");
  assert.equal(phase.onSale, true);
  assert.equal(phase.remaining, 100);
});

test("a phase that has not opened yet is scheduled, not sold out", () => {
  const phase = ticketPhaseState(
    { ...stock, sales_opening_at: "2026-09-01T08:00:00Z" }, NOW);
  assert.equal(phase.state, "scheduled");
  assert.equal(phase.onSale, false);

  // Even with nothing in stock it still reads as scheduled: the organiser can
  // load stock before it opens, and "sold out" would be a lie.
  const empty = ticketPhaseState(
    { quantity_available: 0, sales_opening_at: "2026-09-01T08:00:00Z" }, NOW);
  assert.equal(empty.state, "scheduled");
});

test("a phase past its closing date is closed", () => {
  const phase = ticketPhaseState(
    { ...stock, sales_closing_at: "2026-08-01T23:59:00Z" }, NOW);
  assert.equal(phase.state, "closed");
  assert.equal(phase.onSale, false);
});

test("an open window with stock gone is sold out", () => {
  const phase = ticketPhaseState({
    quantity_available: 50, quantity_sold: 48, quantity_reserved: 2,
    sales_opening_at: "2026-08-01T00:00:00Z", sales_closing_at: "2026-09-01T00:00:00Z"
  }, NOW);
  assert.equal(phase.state, "sold_out");
  assert.equal(phase.remaining, 0);
});

test("the boundary instants belong to the seller, not the buyer", () => {
  const opensAt = "2026-08-13T12:00:00Z";
  // Exactly at the opening instant the phase is open, not still scheduled.
  assert.equal(ticketPhaseState({ ...stock, sales_opening_at: opensAt }, NOW).state, "on_sale");
  // One millisecond earlier it is not.
  assert.equal(
    ticketPhaseState({ ...stock, sales_opening_at: opensAt }, new Date(NOW.getTime() - 1)).state,
    "scheduled");
  // Exactly at the closing instant it is still open; a moment later it is not.
  assert.equal(ticketPhaseState({ ...stock, sales_closing_at: opensAt }, NOW).state, "on_sale");
  assert.equal(
    ticketPhaseState({ ...stock, sales_closing_at: opensAt }, new Date(NOW.getTime() + 1)).state,
    "closed");
});

test("phases run back to back without a gap a buyer can fall into", () => {
  // Early Bird closes at the instant General opens. At that instant exactly
  // one of them must be buyable, or a buyer refreshing at midnight sees two
  // open phases or none.
  const boundary = "2026-09-01T00:00:00Z";
  const early = { ...stock, ticket_name: "Early Bird", sales_closing_at: boundary };
  const general = { ...stock, ticket_name: "General", sales_opening_at: boundary };
  const justAfter = new Date(Date.parse(boundary) + 1000);

  const openAtBoundary = [early, general].filter((t) => ticketPhaseState(t, justAfter).onSale);
  assert.equal(openAtBoundary.length, 1, "exactly one phase is open just after the handover");
  assert.equal(openAtBoundary[0].ticket_name, "General");
});

test("camelCase and snake_case rows read the same", () => {
  // The server reads database rows; the PWA reads the JSON mapping of them.
  // Both must reach the same answer or the button and the server disagree.
  const snake = ticketPhaseState(
    { quantity_available: 10, quantity_sold: 10, sales_closing_at: "2026-09-01T00:00:00Z" }, NOW);
  const camel = ticketPhaseState(
    { quantityAvailable: 10, quantitySold: 10, salesClosingAt: "2026-09-01T00:00:00Z" }, NOW);
  assert.deepEqual(snake, camel);
});

test("the gate is enforced in the purchase transaction, not only the preview", () => {
  // The preview is advisory. A phase can close between the buyer seeing the
  // price and the money moving, so the check has to exist inside the locked
  // transaction too. This is a source check because the alternative is a race
  // that cannot be reproduced on demand.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
  const purchase = source.slice(source.indexOf("async function purchaseTickets("));
  const body = purchase.slice(0, purchase.indexOf("\nasync function ", 1));
  assert.match(body, /const lockedPhase = ticketPhaseState\(locked\)/,
    "purchaseTickets must re-check the phase under the row lock");
  assert.match(body, /if \(!lockedPhase\.onSale\) throw new AppError\(409/);
  assert.match(body, /per_customer_purchase_limit/,
    "the per-person limit must be enforced inside the transaction");
});

test("registration events cannot charge", () => {
  // A registration event rides the free-ticket path, and free tickets need no
  // FICA. If a price could survive the toggle, a business with no FICA would
  // be taking money.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
  assert.match(source, /price: forceFree \? 0 : money\(item\.price\)/,
    "normalizeTicketTypes must zero the price when the event is registration-only");
  assert.match(source, /forceFree: Boolean\(payload\.registrationMode/,
    "eventPayload must pass the registration flag into ticket normalisation");
});

test("organiser social links accept only https", () => {
  // These render as links on a page anyone can open, so a javascript: or
  // data: URL here would be stored XSS.
  const links = normalizeSocialLinks({
    instagram: "javascript:alert(1)",
    facebook: "data:text/html,<script>alert(1)</script>",
    x: "http://x.com/titopay",
    tiktok: "  tiktok.com/@titopay  ",
    website: "https://titopay.co.za",
    youtube: "notaurl",
    nonsense: "https://evil.example/hack"
  });
  assert.equal(links.instagram, undefined, "javascript: is dropped");
  assert.equal(links.facebook, undefined, "data: is dropped");
  assert.equal(links.website, "https://titopay.co.za/");
  assert.ok(links.tiktok.startsWith("https://"), "a bare domain is upgraded to https, never http");
  assert.ok(links.x.startsWith("https://"), "http is upgraded rather than stored as typed");
  assert.equal(links.youtube, undefined, "a value that is not a host is dropped");
  assert.equal(links.nonsense, undefined, "only known platforms are stored");
  assert.ok(SOCIAL_PLATFORMS.includes("whatsapp"));
});

test("every social link the PWA renders is a platform the server accepts", () => {
  // The two lists drifting apart is how a link an organiser fills in silently
  // never appears, or a stored link has nowhere to render.
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
  const block = app.match(/const EVENT_SOCIALS = \[[\s\S]*?\n\];/);
  assert.ok(block, "the PWA declares its social platforms in EVENT_SOCIALS");
  const keys = [...block[0].matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.slice().sort(), SOCIAL_PLATFORMS.slice().sort(),
    "EVENT_SOCIALS and SOCIAL_PLATFORMS must carry the same platforms");
});
