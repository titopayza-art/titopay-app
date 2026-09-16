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

const REPO = path.join(__dirname, "..", "..");
const APP = fs.readFileSync(path.join(REPO, "pwa", "app.js"), "utf8");

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
  assert.deepEqual(keys, ["events", "sales", "coupons", "vendors", "tags", "campaigns"]);
    // SIX DOORS, NOT FIVE, AND ON PURPOSE.
  //
  // The rule this test carries is that the hub must stay a set of short doors
  // rather than one long sheet. Discount Codes is a distinct organiser job
  // with its own form and its own list, so folding it into Sales or Campaign
  // Tools would have grown one of those back into the mega-sheet this rule
  // exists to prevent. The cap moved to six deliberately; the thing being
  // protected is the LENGTH of each door, which is still checked below.
  assert.ok(keys.length <= 6, "a hub with more than six doors is a menu, not a simplification");

  // Each door renders from data the hub already loaded — a door that fetches
  // for itself is how the jumping came back last time.
  assert.equal((APP.match(/async function loadBusinessTicketingData\(\)/g) || []).length, 1,
    "one shared read for the hub and every door under it");
  for (const renderer of ["ticketingEventsSection", "ticketingSalesSection", "ticketingVendorsSection",
                          "ticketingTagsSection", "ticketingCampaignsSection", "ticketingCouponsSection"]) {
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

test("grouping the Services screen loses nothing and buries nothing", () => {
  // Nineteen tiles in a flat grid is a list you read rather than a page you
  // scan. Grouping only helps if it is honest: every service must come out the
  // other side, exactly once, at the same tap depth.
  const groups = (APP.match(/const SERVICE_GROUPS = \[[\s\S]*?\n\];/) || [""])[0];
  assert.ok(groups, "SERVICE_GROUPS declares the grouping");

  const keys = [...groups.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys[keys.length - 1], "more", "the catch-all must sort last, or an unmapped service lands above real ones");
  assert.match(groups, /\{ key: "more", label: "More", members: null \}/,
    "the catch-all owns no members of its own — it exists to catch what the map does not know");

  // A service may not be claimed by two groups; the first would silently win.
  const members = [...groups.matchAll(/members: \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]));
  assert.equal(new Set(members).size, members.length,
    `a service is claimed by two groups: ${members.filter((id, i) => members.indexOf(id) !== i).join(", ")}`);

  // Every service in the shipped catalogue is either mapped or caught. This is
  // the check that makes the grouping safe: nothing can vanish.
  const catalogue = JSON.parse(fs.readFileSync(path.join(REPO, "pwa", "services-default.json"), "utf8"));
  const list = Array.isArray(catalogue) ? catalogue : (catalogue.services || catalogue.items || []);
  assert.ok(list.length > 10, "the fallback catalogue should be present");

  // groupedServiceSections renders every service it is given, so "caught by
  // More" is a pass. The real risk is a group that silently drops one.
  const renderer = functionBody("groupedServiceSections");
  assert.match(renderer, /buckets\.get\(serviceGroupOf\(service\)\)\.push\(service\)/,
    "every service must be pushed into a bucket");
  assert.match(functionBody("serviceGroupOf"), /return "more";/,
    "an unmapped service falls through to More rather than disappearing");

  // THE CATCH-ALL IS A SAFETY NET, NOT A HOME.
  //
  // "More" is the last heading on the screen and it tells a customer nothing,
  // so a service that lands there is a service nobody finds. TitoPro shipped
  // into it: complete, routed, tested, and filed at the bottom of the page
  // under a heading with no meaning. Every service TitoPay actually promotes
  // must have a named home.
  const named = new Set(members);
  for (const service of ["titopro", "tickets", "stockvel", "send-money", "top-up"]) {
    assert.ok(named.has(service) || service === "book",
      `"${service}" is in no group, so it renders under More at the bottom of the screen`);
  }
  // Book is the documented exception: it is two products wearing one tile and
  // is routed by account type in serviceGroupOf rather than by this map.
  assert.match(functionBody("serviceGroupOf"), /keys\.includes\("book"\)/,
    "Book earns its way out of the map by being routed explicitly");
});

// THE FALLBACK CATALOGUE IS WHAT THE APP SHOWS WHEN THE API CANNOT BE REACHED.
//
// It is a real file the app fetches, not a comment: pwa/services-default.json.
// A service added to the API's DEFAULT_SERVICES and forgotten here is missing
// from the Services screen for every customer on a bad connection, and from
// the first paint for everybody else. TitoPro shipped that way.
//
// One direction only. The app file legitimately carries entries the API does
// not (refund, business-staff, enterprise-distribution and the combined
// airtime-data tile), so this asks that nothing the API ships is absent here,
// not that the two lists are identical.
test("the app's fallback catalogue carries every service the API ships", () => {
  const source = fs.readFileSync(
    path.join(REPO, "api", "src", "services", "service-management-service.js"), "utf8");
  const block = source.slice(source.indexOf("const DEFAULT_SERVICES = ["));
  const rows = block.slice(0, block.indexOf("\n];")).split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('["'))
    .map((line) => JSON.parse(line.replace(/,$/, "")));
  assert.ok(rows.length > 30, `expected the service catalogue, parsed ${rows.length} rows`);

  const fallback = JSON.parse(fs.readFileSync(path.join(REPO, "pwa", "services-default.json"), "utf8"));
  const shipped = new Set(fallback.items.map((item) => item.service_code));

  // FICA is the one deliberate absence, and the app proves it: visibleServices
  // filters the tile out entirely because verification is reached from Profile
  // & Security, and a second door to it would be a duplicate route.
  assert.match(functionBody("visibleServices"), /\["fica"\]\.includes\(action\)/,
    "fica is excluded from the grid on purpose, so it is excluded from this check on purpose");

  const missing = rows
    .filter((row) => row[5] === "active" && row[0] !== "fica")
    .map((row) => row[0])
    .filter((code) => !shipped.has(code));
  assert.deepEqual(missing, [],
    `these active services are in the API catalogue and missing from pwa/services-default.json: ${missing.join(", ")}`);

  // AND THE TWO FIELDS THAT CANNOT LEGITIMATELY DIFFER.
  //
  // `action` is what the tile dispatches on, so a fallback that disagrees
  // opens the wrong screen. `sort_order` is where the tile lands, so a
  // fallback that disagrees moves it on the first paint and then moves it
  // again when the API answers.
  //
  // Status, visibility and name are deliberately NOT compared, because the
  // fallback is allowed to be - and in three places is - more honest than the
  // raw seed:
  //   * airtime, data, electricity and voucher read "coming soon" here while
  //     DEFAULT_SERVICES still says "active". That is correct: the capability
  //     gate downgrades them on every API read because no supplier adapter can
  //     send a purchase, and the fallback states the same conclusion directly
  //     rather than promising a tile it would take back;
  //   * airtime and data are hidden individually because the app ships one
  //     combined "Airtime & Data" tile;
  //   * tickets is "Event Tickets" here, which is the rename normalizeService
  //     applies to the API's answer too.
  for (const row of rows) {
    const [code, , , action, , , , , order] = row;
    const tile = fallback.items.find((item) => item.service_code === code);
    if (!tile) continue;
    assert.equal(tile.action, action, `${code}: the fallback dispatches on a different action`);
    assert.equal(tile.sort_order, order, `${code}: the fallback would put this tile somewhere else`);
  }
});

test("the app asks in its own voice — no browser prompts left", () => {
  // window.prompt and window.confirm arrive on a phone as a grey box carrying
  // the site's address. It reads as "the app broke", not "the app asked".
  const offenders = [];
  APP.split("\n").forEach((line, index) => {
    if (/window\.(prompt|confirm)\s*\(/.test(line)) offenders.push(`${index + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [],
    "use askForValue()/askToConfirm() instead:\n  " + offenders.join("\n  "));

  // The dialog must layer OVER the open sheet. openModal closes whatever is
  // open, so building on it would shut the sheet the person is working in.
  const dialog = functionBody("appDialog");
  assert.doesNotMatch(dialog, /openModal\(/, "appDialog must not be built on openModal");
  assert.match(dialog, /document\.body\.appendChild\(layer\)/, "the dialog is its own layer above the sheet");
  assert.match(dialog, /document\.addEventListener\("keydown", onKey, true\)/,
    "Escape must be captured, or it closes the sheet underneath instead of the dialog");
});
