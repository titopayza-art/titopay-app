"use strict";

// THE APP HAD MORE DOORS THAN ROOMS.
//
// TitoKids, Sales and My Family each reached the same screen from two places —
// a tile AND a Profile row. Two doors to one room does not make a feature
// easier to find; it makes a person unsure which door is the real one, and it
// is how a Profile screen quietly grows to fourteen rows.
//
// The rules these tests hold are written down in SIMPLICITY.md. They are
// source checks on purpose: they run in the ordinary suite in milliseconds, and
// they fail when somebody adds the second door rather than when a customer
// finds it.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

// profileFeature(title, subtitle, icon, action, primary) — the action is the
// fourth argument, and every call in the file is written on one line.
function profileFeatureActions() {
  const actions = new Set();
  for (const call of APP.match(/profileFeature\([^)]*\)/g) || []) {
    const args = call.slice("profileFeature(".length).split(",");
    if (args.length < 4) continue;
    const action = (args[3].match(/"([^"]+)"/) || [])[1];
    // Parametrised share targets ("share-titopay:whatsapp") are steps inside a
    // sheet, not doors onto a feature.
    if (action && !action.includes(":")) actions.add(action);
  }
  return actions;
}

// A tile is a service the app injects client-side; each declares its action.
function tileActions() {
  const actions = new Set();
  for (const block of APP.match(/action:\s*"[a-z0-9-]+",\s*type:\s*"[A-Za-z]+"/g) || []) {
    actions.add((block.match(/action:\s*"([a-z0-9-]+)"/) || [])[1]);
  }
  // The injected tiles, declared as `id:` / `action:` pairs over several lines.
  for (const block of APP.match(/id:\s*"[a-z0-9-]+",[\s\S]{0,400}?action:\s*"[a-z0-9-]+",/g) || []) {
    const id = (block.match(/id:\s*"([a-z0-9-]+)"/) || [])[1];
    const action = (block.match(/action:\s*"([a-z0-9-]+)"/) || [])[1];
    if (id && action && id === action) actions.add(action);
  }
  return actions;
}

// The source of one top-level function: from its declaration to the next one
// at column zero. "async function" counts as a declaration too — reading past
// it swallows unrelated code and makes the assertion below meaningless.
function functionBody(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const rest = APP.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("no feature is reachable from both a tile and a Profile row", () => {
  const profile = profileFeatureActions();
  const tiles = tileActions();
  const both = [...profile].filter((action) => tiles.has(action)).sort();

  // Bulk Distribution is the deliberate exception, and it is not really two
  // doors: the Profile row renders only while the tile is hidden. The guard
  // below checks that condition is still on the row.
  const allowed = new Set(["enterprise-distribution"]);
  const offenders = both.filter((action) => !allowed.has(action));

  assert.deepEqual(offenders, [],
    `these features have two doors: ${offenders.join(", ")}\n` +
    "Pick one — the tile or the Profile row — and put the other in appSearchEntries() " +
    "so it stays findable. See SIMPLICITY.md.");

  assert.match(APP, /isBusiness && !enterpriseDistributionTileVisible\(\) \? profileFeature\("Bulk Distribution"/,
    "Bulk Distribution's Profile row must stay conditional on its tile being hidden, or it becomes a second door");
});

test("features that live behind a single door are still findable in search", () => {
  const searchBlock = APP.slice(APP.indexOf("function appSearchEntries()"), APP.indexOf("function renderAppSearchResults()"));
  for (const action of ["tito-kids", "my-workplaces", "titopay-chat", "business-sales", "enterprise-distribution"]) {
    assert.ok(searchBlock.includes(`data-action="${action}"`),
      `${action} has one door — app search is the only other way to reach it, so it must be listed there`);
  }
});

test("Business Ticketing stays a hub of short doors, not one long sheet", () => {
  // The mega-sheet did events, sales, vendors, cashless and tag issuing at
  // once. Halfway down it, linking a vendor meant scrolling past everything,
  // and every refresh threw the organiser back to the top.
  assert.match(APP, /const TICKETING_SECTIONS = \[/,
    "the ticketing hub's doors are declared in TICKETING_SECTIONS");
  const sections = (APP.match(/const TICKETING_SECTIONS = \[[\s\S]*?\n\];/) || [""])[0];
  const keys = [...sections.matchAll(/key:\s*"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(keys, ["events", "sales", "vendors", "tags"]);
  assert.ok(keys.length <= 5, "a hub with more than five doors is a menu, not a simplification");

  // Each door renders from data the hub already loaded — a door that fetches
  // for itself is how the jumping came back last time.
  assert.equal((APP.match(/async function loadBusinessTicketingData\(\)/g) || []).length, 1,
    "one shared read for the hub and every door under it");
  for (const renderer of ["ticketingEventsSection", "ticketingSalesSection", "ticketingVendorsSection", "ticketingTagsSection"]) {
    assert.doesNotMatch(functionBody(renderer), /\bawait api\(/,
      `${renderer} must render from the hub's data, not fetch its own`);
  }
});

test("a tile that hides itself fails open", () => {
  // Hiding an empty tile is only safe if an account we have not looked at yet
  // still sees it. The check is written as "not known to be empty", never
  // "known to be non-empty".
  const fn = APP.slice(APP.indexOf("function eventScannersTileVisible()"));
  assert.match(fn.slice(0, 300), /!== "0"/,
    "eventScannersTileVisible must hide only on a stored negative, so an unknown account still sees the tile");
  assert.match(fn.slice(0, 300), /catch \(error\) \{\s*return true;/,
    "a browser with storage disabled must keep showing the tile");
});
