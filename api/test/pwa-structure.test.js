"use strict";

// app.js is one classic script on purpose — no build step, no module loader,
// nothing for a static cPanel deploy to get wrong. What keeps 885 functions
// navigable is a convention, and a convention with no test decays.
//
// The rule: function declarations are hoisted, so they may live in any section.
// Everything else is order-sensitive and must stay in the two banner-marked
// blocks — one at the top, one at the bottom — in its original order.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pwaFile } = require("./pwa-path");

const appPath = pwaFile("app.js");
const source = fs.readFileSync(appPath, "utf8");
const lines = source.split("\n");

const SECTION_RULE = /^ {3}\d+\. [A-Z]/;
const TOP_BLOCK = "STATE AND CONFIGURATION";
const BOTTOM_BLOCK = "PAGE STATE AND EVENT WIRING";

// Section banners are indented three spaces inside their comment rule, so the
// raw line is what has to be matched.
const sections = () => lines
  .map((line, index) => ({ line, index: index + 1 }))
  .filter(({ line }) => SECTION_RULE.test(line));

test("the app opens with a contents list", () => {
  const head = source.slice(0, 3000);
  assert.match(head, /TitoPay — customer app \(PWA\)/);
  assert.match(head, /\* Contents/);
  const entries = head.split("\n").filter((line) => /^ \* {2,}\d+\. /.test(line));
  assert.ok(entries.length >= 20, `expected the contents list, found ${entries.length}`);
  assert.ok(entries.every((line) => /\d+ functions$/.test(line.trim())));
});

test("both order-sensitive blocks are present and marked", () => {
  assert.match(source, new RegExp(`${TOP_BLOCK} — order matters here; do not reorder`));
  assert.match(source, new RegExp(`${BOTTOM_BLOCK} — order matters here; do not reorder`));
  assert.ok(source.indexOf(TOP_BLOCK) < source.indexOf(BOTTOM_BLOCK));
});

test("no order-sensitive statement sits between the function sections", () => {
  // A `const` added mid-section still works today, but the next person to move
  // a section would silently change when it evaluates.
  const first = sections()[0];
  const bottom = lines.findIndex((line) => line.includes(BOTTOM_BLOCK)) + 1;
  assert.ok(first && bottom > first.index, "sections must sit between the two blocks");
  const strays = [];
  for (let index = first.index; index < bottom - 1; index += 1) {
    if (/^(const|let|var|class) /.test(lines[index])) strays.push(`${index + 1}: ${lines[index].slice(0, 70)}`);
  }
  assert.deepEqual(strays, [], `move these into one of the two blocks:\n${strays.join("\n")}`);
});

test("no function is declared twice", () => {
  // primaryWallet was declared twice with different bodies; the later one
  // silently shadowed the earlier, and callers written beside the dead copy got
  // behaviour they were not expecting.
  const names = (source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).map((m) => m.replace(/.*function /, ""));
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  assert.deepEqual(duplicates, [], "a duplicate declaration silently shadows the earlier one");
});

test("primaryWallet is the account-type-aware one", () => {
  const match = source.match(/function primaryWallet\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "primaryWallet must exist");
  assert.match(match[0], /state\.accountType/, "the surviving copy resolves by account type");
});

test("every hash resolves to a route the shell can actually render", () => {
  // appView() is a chain of `route === "x"` with no fallback, so an unknown
  // hash used to render an empty screen under a nav bar. Reachable from a push
  // notification: the service worker builds its destination from
  // notification.data.route, unchecked.
  const routes = source.match(/^const APP_ROUTES = \[([^\]]+)\];/m);
  assert.ok(routes, "APP_ROUTES must exist");
  const allowed = routes[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);

  // The nav and the allow-list are two copies of the same fact; drift between
  // them is a route you can tap and cannot render, or the reverse.
  const nav = source.match(/^const navItems = \[([\s\S]*?)^\];/m);
  assert.ok(nav, "navItems must exist");
  const navIds = [...nav[1].matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]);
  assert.deepEqual(allowed, navIds, "APP_ROUTES and navItems must list the same five routes, in order");

  // Both entry points normalise; neither reads the hash raw.
  assert.doesNotMatch(source, /location\.hash\.replace\("#", ""\)/,
    "the raw hash must not become state.route without passing the allow-list");
  assert.equal((source.match(/normalizeRoute\(location\.hash\)/g) || []).length, 2,
    "the initial state and the hashchange handler must both normalise");

  // And the function does what its name says.
  const fn = source.match(/function normalizeRoute\(hash\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "normalizeRoute must exist");
  // eslint-disable-next-line no-new-func
  const normalizeRoute = new Function("APP_ROUTES", `${fn[0]}; return normalizeRoute;`)(allowed);
  for (const known of allowed) assert.equal(normalizeRoute(`#${known}`), known);
  for (const unknown of ["#stockvel", "#send", "#not-a-route", "#", "", "#PROFILE", "#profile "]) {
    const resolved = normalizeRoute(unknown);
    assert.ok(allowed.includes(resolved), `"${unknown}" resolved to "${resolved}", which cannot render`);
  }
  assert.equal(normalizeRoute("#stockvel"), "dashboard");
  assert.equal(normalizeRoute("#profile "), "profile", "a trailing space is a typo, not a dead route");
});

test("the whole app is still there", () => {
  const declared = (source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).length;
  assert.ok(declared > 850, `expected the full app, found ${declared} top-level functions`);
});

test("the shipped bundle is rebuilt from this source", () => {
  const min = fs.readFileSync(pwaFile("app.min.js"), "utf8");
  // Terser does not mangle top-level names, so every entry point the tests and
  // the markup rely on must still be reachable by name.
  for (const name of ["api", "render", "boot", "primaryWallet", "statementPdf", "transactionPostedToWallet", "statementPostedAmount"]) {
    assert.ok(min.includes(`function ${name}(`), `${name} is missing from app.min.js — rebuild it`);
  }
  const sourceFns = new Set((source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).map((m) => m.replace(/.*function /, "")));
  assert.ok(sourceFns.size > 850);
});

test("the service worker and the page agree on the bundle version", () => {
  const html = fs.readFileSync(pwaFile("index.html"), "utf8");
  const worker = fs.readFileSync(pwaFile("service-worker.js"), "utf8");
  const pageVersion = (html.match(/app\.min\.js\?v=(\d+)/) || [])[1];
  const workerVersion = (worker.match(/app\.min\.js\?v=(\d+)/) || [])[1];
  assert.ok(pageVersion, "index.html must cache-bust app.min.js");
  assert.equal(pageVersion, workerVersion, "a stale service worker would serve the previous bundle");
  assert.match(worker, new RegExp(`titopay-pwa-v${pageVersion}`), "the cache name must carry the same version");
});
