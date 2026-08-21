"use strict";

// EVENT DISCOVERY, PINNED.
//
// Behaviour is proven on the real API in verification/event-discovery-live.js.
// These contracts hold the parts that would be quiet and expensive to lose:
// search happening in SQL rather than in the browser, the search box never
// becoming SQL itself, and the shop window staying open to people who have not
// signed up yet.

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
const CSS = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "styles.css"), "utf8");
const MIN_CSS = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "styles.min.css"), "utf8");
const { EVENT_CATEGORIES } = require("../src/services/ticketing-service");

test("search is answered by the database, not by the phone", () => {
  // The old screen pulled a batch and filtered it in JavaScript, so the events
  // outside that batch were invisible to search no matter what was typed.
  assert.match(TICKETING, /async function listPublicApprovedEvents\(\{ search/);
  assert.match(TICKETING, /event_name ILIKE \$\$\{values\.length\}|event_name ILIKE \$/);
  assert.match(TICKETING, /category = \$\$\{values\.length\}|category = \$/);
  // The app asks the server rather than filtering an array it already holds.
  assert.match(APP, /params\.set\("search", state\.ticketing\.search\)/);
  assert.match(APP, /params\.set\("category", state\.ticketing\.category\)/);
});

test("the search box can never become SQL", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function listPublicApprovedEvents("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  // The term is pushed as a parameter and referenced by position. If a future
  // edit interpolates it into the string instead, this fails.
  assert.match(body, /values\.push\(`%\$\{term\}%`\)/);
  assert.doesNotMatch(body, /ILIKE '.*\$\{term\}/, "the term must never be inlined into the SQL string");
  assert.doesNotMatch(body, /category = '\$\{/, "the category must never be inlined either");
});

test("browsing needs no account: this is the shop window", () => {
  // Scoped to the handler itself rather than to everything before the next
  // route: routes get inserted between them, and a slice that drifts would
  // start asserting about somebody else's endpoint.
  const start = ROUTES.indexOf('router.get("/public/events"');
  const block = ROUTES.slice(start, ROUTES.indexOf("});", start));
  assert.doesNotMatch(block, /requireAuth/, "the public events list must not require a token");
  const previewStart = ROUTES.indexOf('router.get("/public/events/:slug/preview"');
  const preview = ROUTES.slice(previewStart, ROUTES.indexOf("});", previewStart));
  assert.doesNotMatch(preview, /requireAuth/, "a link preview must be readable by a crawler");
  assert.match(ROUTES, /router\.get\("\/public\/event-categories"/);
});

test("category chips come from the whole catalogue, so a filter can be undone", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function listPublicApprovedEvents("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  const facet = body.slice(body.indexOf("facetRows"));
  // The facet query is deliberately NOT filtered by the caller's search or
  // category: a chip that vanishes when tapped is a trap with no way out.
  assert.match(facet, /WHERE status = 'approved' AND category IS NOT NULL/);
  assert.doesNotMatch(facet.slice(0, facet.indexOf("GROUP BY")), /\$\d/,
    "the facet query takes no filter parameters");
});

test("organisers pick a category from one shared list", () => {
  assert.ok(EVENT_CATEGORIES.length >= 8, "a real spread of categories");
  assert.ok(EVENT_CATEGORIES.includes("Music & Concerts"));
  assert.ok(EVENT_CATEGORIES.includes("Other"), "there is always somewhere to put an unusual event");
  // The app's own list must match the server's, or the form offers something
  // the API will not accept.
  const listed = (APP.match(/const EVENT_CATEGORY_OPTIONS = \[[\s\S]*?\n\];/) || [""])[0];
  for (const category of EVENT_CATEGORIES) {
    assert.ok(listed.includes(`"${category}"`), `the app offers ${category}`);
  }
  // And the organiser picks, rather than typing free text that no filter can
  // ever group reliably.
  assert.match(APP, /<label>Category<select name="category" required>/);
});

test("the buyer can search, filter and share", () => {
  assert.match(APP, /data-ticket-search placeholder="Search events, venues or cities"/);
  assert.match(APP, /data-event-categories/);
  assert.match(APP, /function renderEventCategoryChips/);
  assert.match(APP, /async function shareTicketingEvent/);
  // Share uses the phone's own sheet where there is one, and the clipboard
  // everywhere else. A cancelled share must not claim anything was copied.
  assert.match(APP, /if \(navigator\.share\)/);
  assert.match(APP, /error\.name === "AbortError"\) return/);
  assert.match(APP, /data-action="event-share:/);
});

test("typing does not re-render the field being typed into", () => {
  // Re-rendering a focused input is what loses the caret and closes the
  // keyboard mid-word on a phone. The search box is rendered once, and only
  // the results below it change.
  const fn = APP.slice(APP.indexOf("function renderPublicTickets()"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.doesNotMatch(body, /data-ticket-search placeholder/,
    "renderPublicTickets must not rebuild the search input");
  // And the request is debounced rather than fired on every keystroke.
  assert.match(APP, /clearTimeout\(state\.ticketing\.searchTimer\)/);
});

test("the card styles exist in BOTH stylesheets", () => {
  // There is no CSS build step, so a rule added to one file and not the other
  // ships an unstyled screen.
  for (const selector of [".event-search-input", ".event-chip", ".event-card", ".event-poster",
    ".event-date-badge", ".event-category-pill", ".event-share-btn", ".event-hero"]) {
    assert.ok(CSS.includes(selector), `styles.css has ${selector}`);
    assert.ok(MIN_CSS.includes(selector), `styles.min.css has ${selector}`);
  }
  // A long title must never push the price and the button off a small card.
  assert.match(CSS, /\.event-card-title[\s\S]{0,260}-webkit-line-clamp: 2/);
  // 16px minimum or iOS zooms the page when the search field takes focus.
  assert.match(CSS, /\.event-search-input[\s\S]{0,400}font-size: max\(16px/);
});

test("the calendar icon is real, not the grid fallback", () => {
  // icon() silently falls back to a grid glyph for an unknown name, so a
  // missing icon shows the wrong picture rather than failing.
  assert.match(APP, /\n    calendar: `/);
});

test("no em dash in the discovery copy", () => {
  const start = APP.indexOf("function ticketingPublicEventRow");
  const section = APP.slice(start, APP.indexOf("async function shareTicketingEvent"));
  assert.ok(!section.includes("—"), "em dashes are not used in customer-facing text");
});
