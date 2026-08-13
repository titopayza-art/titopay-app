"use strict";

// "CAN I LINK MY WRISTBAND, AND WHY DID YOU REMOVE THAT FEATURE?"
//
// It was never removed. It moved onto the ticket, and it appears when the
// server says that ticket can take a tag. The failure was one of SILENCE: when
// a ticket was not eligible, the card showed nothing at all, and to somebody
// who knows the feature exists, nothing is indistinguishable from deleted.
//
// A ticket must now account for its own wristband state in all four cases:
// linkable, already linked, cashless but not offered, and not cashless.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const APP = fs.readFileSync(path.join(REPO, "pwa", "app.js"), "utf8");
const TICKETING = fs.readFileSync(path.join(REPO, "api", "src", "services", "ticketing-service.js"), "utf8");

test("a ticket carries the facts it needs to explain itself", () => {
  assert.match(TICKETING, /COALESCE\(e\.cashless_tags_enabled, FALSE\) AS cashless_tags_enabled/,
    "listMyTickets must report whether the event is cashless");
  assert.match(TICKETING, /AS wristband_linked/,
    "and whether a tag is already on this ticket");
  assert.match(TICKETING, /cashlessTagsEnabled: Boolean\(row\.cashless_tags_enabled\)/);
  assert.match(TICKETING, /wristbandLinked: Boolean\(row\.wristband_linked\)/);
});

test("no ticket leaves the wristband question unanswered", () => {
  const fn = APP.slice(APP.indexOf("function ticketWristbandNote(ticket = {})"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);

  // Every branch returns something: silence is the bug this replaces.
  assert.match(body, /if \(linkableTicketId\(ticket\)\)/, "linkable → offer it");
  assert.match(body, /ticket\.wristbandLinked/, "already linked → confirm it");
  assert.match(body, /ticket\.cashlessTagsEnabled/, "cashless but not offered → say what to do");
  assert.match(body, /not switched on cashless wristbands/, "not cashless → say so plainly");
  assert.doesNotMatch(body, /return "";/, "no branch may return an empty note");

  // And the note is actually used by the card.
  assert.match(APP, /<footer class="ticket-stub-foot">\$\{ticketWristbandNote\(ticket\)\}<\/footer>/,
    "the ticket footer renders the note");
});
