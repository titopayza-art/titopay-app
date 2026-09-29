"use strict";

// THE ACTIVATION AND RETENTION PAGE.
//
// Build 110 gave the platform four endpoints that can answer the only two
// questions that say whether there is a business here: of the people who
// registered, how many ever transacted, and of those, how many came back. For
// one release those numbers existed and nobody could see them, which is the
// same as not having them — a metric nobody looks at changes nobody's
// behaviour.
//
// This pins the page that shows them. Most of what it protects is not layout,
// it is HONESTY: the activation service learned three modelling errors the hard
// way and wrote them down, and a dashboard is exactly where they come back. A
// console that draws these stages as a narrowing funnel, or reads a percentage
// off a cohort of three as a trend, would undo the work in the service.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const MODULE = read("admin", "assets", "admin-marketing.js");
const CONSOLE = read("admin", "assets", "admin.js");
const CSS = read("admin", "assets", "admin.css");
const ROUTES = read("api", "src", "routes", "marketing.routes.js");

test("the console has a page for the activation and retention numbers", () => {
  // Reachable three ways, because the console needs all three: a tab inside the
  // marketing module, a sidebar entry, and a URL of its own that an operator
  // can bookmark or be sent.
  assert.match(MODULE, /\["growth", "Activation & Retention"\]/, "a tab in the marketing module");
  assert.match(MODULE, /growth: viewGrowth/, "wired into the view dispatcher");
  assert.match(CONSOLE, /\["\/marketing-sales\/growth\/", "marketing-growth", "Activation & Retention"\]/,
    "a sidebar entry");
  assert.match(CONSOLE, /"marketing-growth": \(me\) => renderMarketingSales\(me, "growth"\)/,
    "a loader");
  assert.match(CONSOLE, /"marketing-growth": \["Marketing · Activation & Retention"/,
    "a title and subtitle");

  // The page it loads from, with the console's own CSP, matching every other
  // marketing page rather than being a one-off.
  const page = read("admin", "marketing-sales", "growth", "index.html");
  assert.match(page, /data-page="marketing-growth"/);
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /style-src 'self'/);
  const sibling = read("admin", "marketing-sales", "analytics", "index.html");
  assert.equal(page.replace("marketing-growth", "X"), sibling.replace("marketing-analytics", "X"),
    "the growth page differs from its siblings only by which page it declares");
});

test("the page reads the growth endpoint that already exists, and reads it once", () => {
  const view = MODULE.slice(MODULE.indexOf("async function viewGrowth"),
    MODULE.indexOf("/* --------------------------------------------------------------------- ROI */"));
  const calls = view.match(/apiFetch\(/g) || [];
  assert.equal(calls.length, 1,
    "one round trip: the three figures are only meaningful together and /growth composes them");
  assert.match(view, /\/admin\/marketing\/growth\?days=/);
  // And that endpoint is real, admin-only, and takes the window this page sends.
  assert.match(ROUTES, /router\.get\("\/growth", requireAdminPermission\("marketing_analytics"\)/);
  assert.match(ROUTES, /growthSnapshot\(req\.query\)/);
});

test("the cohort window is its own control and never offers a window the API refuses", () => {
  // Every other marketing page's picker asks "what happened in this period".
  // This one asks "who REGISTERED in this period", and then follows those same
  // people forwards. Sharing the range picker would quietly change the meaning.
  assert.match(MODULE, /COHORT_WINDOWS = \[\[30,/);
  assert.match(MODULE, /data-mk-cohort=/, "its own control");
  assert.match(MODULE, /state\.cohortDays = Number\(cohort\.dataset\.mkCohort\)/, "its own handler");

  const service = read("api", "src", "services", "activation-service.js");
  const cap = Number((service.match(/MAX_COHORT_DAYS = (\d+)/) || [])[1]);
  assert.ok(cap > 0, "the service caps the registration window");
  const offered = (MODULE.match(/COHORT_WINDOWS = \[(.+?)\];/s)[1].match(/\[(\d+),/g) || [])
    .map((m) => Number(m.slice(1, -1)));
  assert.ok(offered.length >= 2);
  assert.ok(Math.max(...offered) <= cap,
    `the page offers up to ${Math.max(...offered)} days but the API refuses past ${cap}`);
});

test("the page states what these numbers are, and are not", () => {
  // THE THREE MODELLING ERRORS THE SERVICE LEARNED, restated where an operator
  // reads them. Each of these sentences exists because getting it wrong would
  // report a working product as a broken one, or the reverse.
  //
  //   1. these stages do not nest, so the page must not draw a funnel
  //   2. verification is not a gate, so it is reported beside, not inside
  //   3. funded-but-never-spent is the diagnosis, so it is on the front row
  assert.match(MODULE, /These are stages, not a funnel that narrows/);
  assert.match(MODULE, /Reported beside the stages, not inside them/);
  assert.match(MODULE, /Funded, never spent/);
  assert.match(MODULE, /not required to transact/);
  // And that it measures the product rather than a campaign, which is the whole
  // reason this is not the existing Analytics page.
  assert.match(MODULE, /measures the product, not a campaign/);
  assert.doesNotMatch(MODULE.slice(MODULE.indexOf("function stagesPanel")),
    /funnelPanel\(/, "the stages are not rendered through the campaign funnel");
});

test("a percentage on a handful of people is marked, not presented as a trend", () => {
  assert.match(MODULE, /THIN_COHORT = \d+/);
  assert.match(MODULE, /too small to read as a rate/);
  assert.match(MODULE, /c\.size < THIN_COHORT \? ' class="mk-thin"'/,
    "the row itself is marked, so the eye skips it");
  assert.match(CSS, /\.mk-cohort tr\.mk-thin/);
  // Marked, never hidden. A thin cohort is still the truth.
  assert.doesNotMatch(MODULE, /filter\(\(c\) => c\.size >= THIN_COHORT\)/);
});

test("nothing on the page needs an inline style, because the console CSP forbids one", () => {
  const view = MODULE.slice(MODULE.indexOf("/* ----------------------------------------------- activation and retention */"),
    MODULE.indexOf("/* --------------------------------------------------------------------- ROI */"));
  assert.doesNotMatch(view, /style="/, "an inline style would be blocked and the bar would vanish");
  // The heat ramp arrives as a class ladder, the same way the bars do, and
  // every step the code can emit exists in the stylesheet.
  assert.match(MODULE, /function heatClass/);
  for (let step = 0; step <= 100; step += 10) {
    assert.match(CSS, new RegExp(`\\.mk-heat-${step}\\b`), `mk-heat-${step} is defined`);
  }
});

test("the console asset version moved, or the browser keeps the module it already has", () => {
  // admin.js imports this module with ?v=<version>, so a new view that ships
  // under the old stamp is a view nobody's browser fetches. This is the same
  // trap the PWA has, and it has already cost one release here.
  const stamp = (CONSOLE.match(/return "(admin-console-v\d+)"/) || [])[1];
  assert.ok(stamp, "admin.js declares a fallback asset version");
  const index = read("admin", "index.html");
  assert.match(index, new RegExp(`admin\\.css\\?v=${stamp}`), "the stylesheet is stamped with it");
  assert.match(index, new RegExp(`admin\\.js\\?v=${stamp}`), "and so is the console script");
  const page = read("admin", "marketing-sales", "growth", "index.html");
  assert.match(page, new RegExp(`admin\\.js\\?v=${stamp}`), "and so is the new page");
  assert.ok(Number(stamp.replace(/\D/g, "")) >= 99,
    "the version moved for the release that added this page");
});
