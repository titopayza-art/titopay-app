"use strict";

// THE CONSOLE ASKED FOR A ROUTE NOBODY HAD REGISTERED, AND NOTHING SAID SO.
//
// admin.js fetches /admin/ticketing/analytics for the Ticketing page's money
// cards — gross sales, platform revenue, tickets sold and scanned. The
// analytics handler existed, but it had only ever been registered on the
// ticketing router, at /v1/ticketing/admin/analytics. The console's path
// 404ed, its `.catch(() => ({ analytics: null }))` swallowed the error, and
// the dashboard reported R0.00 across the board while real paid orders sat in
// the database. Events, refunds and change requests looked fine, because
// those routes did exist — which made the zeros read as "no sales" rather
// than "no endpoint".
//
// This test closes the class, not the instance: every /admin/... path the
// console fetches must resolve to a registered route. It is a source check on
// purpose — it runs in the ordinary suite in milliseconds and fails when
// somebody adds the fetch before the route, rather than when the operations
// team reads a zero that is really a 404.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const CONSOLE = fs.readFileSync(path.join(REPO, "admin", "assets", "admin.js"), "utf8");

// The /admin namespace is served by five routers. Order matters the same way
// it does in src/routes/index.js: the specific mounts sit above the broad
// /admin one, so a path is matched against the most specific mount first.
const ADMIN_MOUNTS = [
  ["/admin/support", "admin-support.routes.js"],
  ["/admin/email-otp", "email-otp-admin.routes.js"],
  ["/admin/email", "email-centre.routes.js"],
  ["/admin/marketing", "marketing.routes.js"],
  ["/admin", "admin.routes.js"]
];

function registeredPaths() {
  const paths = [];
  for (const [mount, file] of ADMIN_MOUNTS) {
    const source = fs.readFileSync(path.join(REPO, "api", "src", "routes", file), "utf8");
    for (const match of source.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      paths.push(mount + (match[1] === "/" ? "" : match[1]));
    }
    // admin-support registers resolve/close/reopen in a loop, as a template
    // literal. A ${action} placeholder becomes a wildcard segment — looser
    // than the real route, but this test asks "is anything listening here?",
    // not "what exactly".
    for (const match of source.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*`([^`]+)`/g)) {
      paths.push(mount + match[1].replace(/\$\{[^}]+\}/g, ":x"));
    }
  }
  return paths;
}

// Endpoints the console asks for but the API does not carry yet — each one
// EXPLICITLY handles the 404 and says so on screen, which is the honest
// version of what the analytics card failed to do. If one of these gets
// implemented server-side, remove it here so the guard covers it.
const KNOWN_UNSERVED = new Set([
  "/admin/sms/analytics", // renderSmsAnalytics falls back to campaign records and labels the source
  "/admin/marketing/sms-campaigns/:p/reject", // 404 → "does not offer the reject endpoint yet (A-P1-8)"
  "/admin/marketing/email-campaigns/:p/reject" // 404 → same honest message
]);

// Every path the console requests from the /admin namespace. apiFetch carries
// almost all of them; the one direct fetch (logout-all) is included by
// matching on the ADMIN_API_BASE template too.
function consolePaths() {
  const found = new Set();
  const calls = [
    ...CONSOLE.matchAll(/apiFetch\(\s*"([^"?]+)/g),
    ...CONSOLE.matchAll(/apiFetch\(\s*`([^`?]+)`?/g),
    ...CONSOLE.matchAll(/\$\{ADMIN_API_BASE\}([^`?"]+)/g)
  ];
  for (const match of calls) {
    // A ${expr} that stands as its own path segment becomes :p — one segment,
    // exactly what a router :param matches. A ${expr} glued to the end of a
    // segment is a query-string suffix (`/transactions${query}`), and one the
    // capture could not close cleanly holds a nested template — in both cases
    // the path is everything before it.
    let cleaned = match[1].replace(/(?<=\/)\$\{[^}`{]+\}/g, ":p");
    const leftover = cleaned.indexOf("${");
    if (leftover !== -1) cleaned = cleaned.slice(0, leftover);
    cleaned = cleaned.split("?")[0].replace(/\/+$/, "");
    if (cleaned.startsWith("/admin/") || cleaned === "/admin") found.add(cleaned);
  }
  return [...found].sort();
}

function routeMatches(routePath, fetchPath) {
  const route = routePath.split("/").filter(Boolean);
  const fetched = fetchPath.split("/").filter(Boolean);
  if (route.length !== fetched.length) return false;
  return route.every((segment, i) =>
    segment.startsWith(":") || fetched[i] === ":p" ? true : segment === fetched[i]);
}

test("every /admin path the console fetches is served by a registered route", () => {
  const routes = registeredPaths();
  assert.ok(routes.length > 50, "the admin routers should register a substantial route table");

  const fetched = consolePaths();
  const unserved = fetched.filter(
    (p) => !KNOWN_UNSERVED.has(p) && !routes.some((route) => routeMatches(route, p)));

  assert.deepEqual(unserved, [],
    "the console fetches these paths but no router serves them — each will 404, " +
    "and most console fetches carry a .catch that turns that into empty data on screen:\n  " +
    unserved.join("\n  "));

  // The allowlist must not outlive the fetches it excuses, or it quietly
  // becomes a hole in the guard.
  const stale = [...KNOWN_UNSERVED].filter((p) => !fetched.includes(p));
  assert.deepEqual(stale, [],
    "KNOWN_UNSERVED lists paths the console no longer fetches — remove them: " + stale.join(", "));
});

test("the ticketing analytics route answers on the path the console calls", () => {
  // The instance behind the class: keep the analytics route pinned to the
  // console's path, so the money cards can never silently zero out again.
  const adminRoutes = fs.readFileSync(path.join(REPO, "api", "src", "routes", "admin.routes.js"), "utf8");
  assert.match(adminRoutes, /router\.get\("\/ticketing\/analytics", requireAdminPermission\("ticketing"\)/,
    "admin.routes.js must serve /ticketing/analytics — the console's Ticketing metrics read it");
  assert.match(CONSOLE, /apiFetch\("\/admin\/ticketing\/analytics"\)/,
    "the console reads its metrics from /admin/ticketing/analytics");
});

test("both copies of admin.js are the same file", () => {
  // The repo carries admin/admin.js and admin/assets/admin.js; index.html
  // loads the assets copy. If they drift, whichever one a fix landed in may
  // not be the one customers run.
  const root = fs.readFileSync(path.join(REPO, "admin", "admin.js"), "utf8");
  assert.equal(root, CONSOLE,
    "admin/admin.js and admin/assets/admin.js have drifted — copy the fixed one over the other");
});

test("/health reports the API build, so deployment state is checkable", () => {
  // Four debugging sessions have opened with a feature that was present in the
  // code and absent on the server. The deployed API state was invisible from
  // outside; now one request answers it.
  const health = fs.readFileSync(path.join(REPO, "api", "src", "routes", "health.routes.js"), "utf8");
  assert.match(health, /\.\.\.buildInfo\(\)/, "healthStatus must report the build");
  assert.match(health, /require\("\.\.\/build-info"\)/);

  const info = require("../src/build-info");
  assert.equal(typeof info.API_BUILD, "number");
  assert.ok(info.API_BUILD >= 1, "the build number counts up from 1");
  assert.equal(info.buildInfo().build, info.API_BUILD);
  assert.ok(info.BUILD_NOTES[info.API_BUILD],
    "every build number needs a note saying what shipped in it, or the number cannot be acted on");
});
