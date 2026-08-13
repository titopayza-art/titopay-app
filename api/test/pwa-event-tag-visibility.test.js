"use strict";

// "WHAT HAPPENED TO LINKING THE WRISTBAND? IT WAS THERE AND PERFECT."
//
// It had not been removed. The Link Event Tag button appears when the server
// lists a ticket as linkable — the ticket is valid, its event is approved AND
// cashless, and no tag is on it yet. When any of that is not true, the button
// is correctly absent.
//
// The defect was what happened when the LOOKUP ITSELF failed. Both tag calls
// were wrapped in .catch(() => ({ items: [] })), so a 500, an expired session
// or a flaky connection produced exactly the same screen as "this event is not
// cashless": no button, no message, nothing to tell the two apart. A customer
// who knows the feature exists is left thinking it was taken away.
//
// The rule: a swallowed failure must still say something.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("a failed Event Tag lookup is remembered, not swallowed", () => {
  const loader = APP.slice(APP.indexOf("state.ticketing.tagLookupFailed = false;"));
  const body = loader.slice(0, loader.indexOf("renderMyTickets();"));
  assert.ok(body, "the loader should reset the flag before fetching");

  // Both lookups are allowed to fail — neither may fail silently.
  const catches = body.match(/\.catch\(\(\) => \{ state\.ticketing\.tagLookupFailed = true; return \{ items: \[\] \}; \}\)/g) || [];
  assert.equal(catches.length, 2,
    "both /tags and /tags/linkable must record the failure while still returning an empty list");
  assert.doesNotMatch(body, /\.catch\(\(\) => \(\{ items: \[\] \}\)\)/,
    "no tag lookup may swallow its failure without recording it");
});

test("the tickets screen says so when wristbands could not be checked", () => {
  const render = APP.slice(APP.indexOf("function renderMyTickets("));
  const body = render.slice(0, render.indexOf("\nfunction "));
  assert.match(body, /state\.ticketing\.tagLookupFailed \?/,
    "the failure has to reach the screen");
  assert.match(body, /could not be checked/,
    "and say plainly that the check failed rather than showing nothing");
  assert.match(body, /data-action="my-tickets-refresh"/,
    "with a way to try again");
  // The tickets themselves must never be held hostage by a tag failure.
  assert.match(body, /\$\{\(state\.ticketing\.linkableTickets \|\| \[\]\)\.map\(eventTagLinkCard\)/,
    "the linkable cards still render normally when the lookup worked");
});

test("the Link Event Tag button still exists and is still one tap", () => {
  assert.match(APP, /function eventTagLinkCard\(ticket = \{\}\)/, "the card was not removed");
  assert.match(APP, /data-action="event-tag-link:\$\{esc\(ticket\.ticketId\)\}"/,
    "and it still opens the tap-to-link flow directly");
});
