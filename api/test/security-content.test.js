"use strict";

// ADMIN-EDITABLE SECURITY COPY, PINNED.
//
// The wording a customer reads on the "Stay safe with TitoPay" card is now
// written by an admin. Two properties matter more than the feature itself, and
// both are easy to lose in a later refactor:
//
//   1. The customer must see a real warning even when nothing is stored, a
//      field was saved blank, or TitoPay cannot be reached at all. An empty
//      security card is worse than an out of date one.
//   2. The text is authored in one place and rendered in another, which is the
//      shape of a stored XSS. It must be escaped at every render site.
//
// The rules above are proven by CALLING mergeWithDefaults, normalizeForSave and
// normalizeTipIcon, not by matching the shape of their source. An earlier
// version of this file asserted only that certain lines existed, which a
// refactor that kept every line and inverted one condition would have passed
// while every customer read a blank security card.
//
// Source matching is still used, deliberately, for the three things that are
// not functions: what the PWA renders, where the public route is mounted, and
// whether the shipped bundle was rebuilt.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const ADMIN_ROUTES = read("src", "routes", "admin.routes.js");
const PUBLIC_ROUTE = read("src", "routes", "security-content.routes.js");
const ROUTE_INDEX = read("src", "routes", "index.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
const APP_MIN = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.min.js"), "utf8");
const CONSOLE_JS = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "admin.js"), "utf8");
const {
  SECURITY_CONTENT_DEFAULTS,
  SECURITY_TIP_ICONS,
  MAX_TIPS,
  mergeWithDefaults,
  normalizeForSave,
  normalizeTipIcon
} = require("../src/services/security-content-service");

// The exact wording that was live before this feature existed. If a future
// edit changes a default, it changes what every customer reads, so it should
// have to change this line too.
const LIVE_CARD_BODY = "Never share your PIN, password or verification codes. TitoPay will never ask for those by phone, email, WhatsApp, SMS or social media.";

const TEXT_FIELDS = ["eyebrow", "title", "cardHeading", "cardBody", "acknowledgeLabel", "tipsEyebrow"];

function throwsWith(fn, status, fragment) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.statusCode, status, `expected ${status}, got ${error.statusCode}: ${error.message}`);
    if (fragment) assert.match(error.message, fragment);
    return;
  }
  assert.fail("expected a rejection, the call returned normally");
}

test("the defaults are the copy that was already live", () => {
  assert.equal(SECURITY_CONTENT_DEFAULTS.cardBody, LIVE_CARD_BODY);
  assert.equal(SECURITY_CONTENT_DEFAULTS.title, "Stay safe with TitoPay");
  assert.equal(SECURITY_CONTENT_DEFAULTS.cardHeading, "Protect your account");
  assert.equal(SECURITY_CONTENT_DEFAULTS.acknowledgeLabel, "I understand");
  assert.equal(SECURITY_CONTENT_DEFAULTS.tips.length, 6);
});

// ---------------------------------------------------------------------------
// Reads: nothing a customer sees can come back blank
// ---------------------------------------------------------------------------

test("an empty database serves the full shipped copy", () => {
  for (const stored of [null, undefined, {}, "", 0, [], "not an object"]) {
    const merged = mergeWithDefaults(stored);
    assert.deepEqual(merged, SECURITY_CONTENT_DEFAULTS, `stored value ${JSON.stringify(stored)}`);
  }
});

test("a field saved blank falls back to its default, field by field", () => {
  for (const field of TEXT_FIELDS) {
    for (const blank of ["", "   ", "\n\t ", null, undefined]) {
      const merged = mergeWithDefaults({ [field]: blank });
      assert.equal(merged[field], SECURITY_CONTENT_DEFAULTS[field],
        `${field} = ${JSON.stringify(blank)} must render the default, not ""`);
    }
    // And one real value proves the fallback is not simply ignoring input.
    assert.equal(mergeWithDefaults({ [field]: "Real copy" })[field], "Real copy");
  }
});

test("a field holding something that is not text still renders, never blank", () => {
  // Reads are forgiving on purpose: a row hand-edited in the database, or
  // written by an older shape of this feature, must degrade rather than take a
  // signed-out screen down.
  for (const odd of [{ nested: true }, ["a"], true, 12]) {
    const merged = mergeWithDefaults({ cardBody: odd });
    assert.equal(typeof merged.cardBody, "string");
    assert.ok(merged.cardBody.trim().length > 0, `cardBody = ${JSON.stringify(odd)} rendered blank`);
  }
});

test("an over-long stored value is cut rather than refused", () => {
  const merged = mergeWithDefaults({ title: "x".repeat(500) });
  assert.equal(merged.title.length, 80);
});

test("an empty or unusable tips list falls back to the shipped tips", () => {
  for (const tips of [[], "nope", {}, null, [{ title: "", body: "" }], [{ title: "Heading only", body: "" }], [{ title: "", body: "Advice only" }]]) {
    const merged = mergeWithDefaults({ tips });
    assert.deepEqual(merged.tips, SECURITY_CONTENT_DEFAULTS.tips, `tips = ${JSON.stringify(tips)}`);
  }
});

test("a half-filled tip is dropped, and the rest survive", () => {
  const merged = mergeWithDefaults({
    tips: [
      { title: "Real", body: "Real advice", icon: "lock" },
      { title: "Heading with no advice", body: "  " }
    ]
  });
  assert.equal(merged.tips.length, 1);
  assert.deepEqual(merged.tips[0], { title: "Real", body: "Real advice", icon: "lock" });
});

test("a stored list longer than the cap is trimmed rather than served whole", () => {
  const tips = Array.from({ length: MAX_TIPS + 8 }, (_, i) => ({ title: `T${i}`, body: `B${i}`, icon: "shield" }));
  assert.equal(mergeWithDefaults({ tips }).tips.length, MAX_TIPS);
});

// ---------------------------------------------------------------------------
// Writes: strict where reads are forgiving
// ---------------------------------------------------------------------------

test("an empty payload saves the shipped copy rather than blanks", () => {
  assert.deepEqual(normalizeForSave({}), SECURITY_CONTENT_DEFAULTS);
  assert.deepEqual(normalizeForSave(null), SECURITY_CONTENT_DEFAULTS);
});

test("clearing a field means restore the default, not store an empty string", () => {
  for (const field of TEXT_FIELDS) {
    const saved = normalizeForSave({ [field]: "   " });
    assert.equal(saved[field], SECURITY_CONTENT_DEFAULTS[field]);
  }
});

test("a value that is not text is refused instead of stored as [object Object]", () => {
  // String() coercion would have made "[object Object]" the live security
  // warning a customer reads.
  for (const field of TEXT_FIELDS) {
    throwsWith(() => normalizeForSave({ [field]: { evil: true } }), 400, /must be text/);
    throwsWith(() => normalizeForSave({ [field]: ["a"] }), 400, /must be text/);
    throwsWith(() => normalizeForSave({ [field]: 42 }), 400, /must be text/);
  }
  throwsWith(() => normalizeForSave({ tips: [{ title: { a: 1 }, body: "x" }] }), 400, /must be text/);
  throwsWith(() => normalizeForSave({ tips: [{ title: "x", body: 7 }] }), 400, /must be text/);
});

test("copy that is too long is refused, so nothing is silently cut mid-sentence", () => {
  throwsWith(() => normalizeForSave({ title: "x".repeat(81) }), 400);
  throwsWith(() => normalizeForSave({ cardBody: "x".repeat(401) }), 400);
  throwsWith(() => normalizeForSave({ tips: [{ title: "x".repeat(81), body: "ok" }] }), 400);
  throwsWith(() => normalizeForSave({ tips: [{ title: "ok", body: "x".repeat(281) }] }), 400);
  // And the boundary itself saves.
  assert.equal(normalizeForSave({ title: "x".repeat(80) }).title, "x".repeat(80));
});

test("a write cannot bloat the row", () => {
  const tips = Array.from({ length: MAX_TIPS + 1 }, (_, i) => ({ title: `T${i}`, body: `B${i}` }));
  throwsWith(() => normalizeForSave({ tips }), 400, /limited to/);
  throwsWith(() => normalizeForSave({ tips: "all of them" }), 400, /must be a list/);
  assert.ok(MAX_TIPS <= 12);
});

test("saving an empty tips list keeps the shipped tips, never no tips", () => {
  assert.deepEqual(normalizeForSave({ tips: [] }).tips, SECURITY_CONTENT_DEFAULTS.tips);
  assert.deepEqual(normalizeForSave({ tips: [{ title: "", body: "" }] }).tips, SECURITY_CONTENT_DEFAULTS.tips);
});

test("what is saved is what a customer would be served", () => {
  // The save path and the read path must agree, or the console confirms one
  // thing and the app renders another.
  const authored = {
    eyebrow: "Alert",
    title: "New scam doing the rounds",
    cardHeading: "Do not tap that link",
    cardBody: "TitoPay never sends a link asking you to reconfirm your PIN.",
    acknowledgeLabel: "Got it",
    tipsEyebrow: "What to do",
    tips: [{ title: "Report it", body: "Send us the message from the app.", icon: "chat" }]
  };
  const saved = normalizeForSave(authored);
  assert.deepEqual(mergeWithDefaults(saved), saved);
});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

test("an icon this app cannot draw becomes a shield rather than a broken glyph", () => {
  for (const bad of ["plane", "", null, undefined, "not-an-icon", 7, {}, "shield; drop table"]) {
    assert.equal(normalizeTipIcon(bad), "shield", `icon ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeTipIcon("  QR  "), "qr", "names are trimmed and lower-cased");
  assert.equal(normalizeTipIcon("Check-Circle"), "check-circle");
  for (const name of SECURITY_TIP_ICONS) {
    assert.equal(normalizeTipIcon(name), name);
  }
});

test("the console offers exactly the icons the API accepts", () => {
  // The defect this pins: the picker offered sixteen names while the API
  // accepted eighty-odd, so opening stored content whose icon came from outside
  // the sixteen and pressing Save quietly rewrote it to "shield".
  const listBlock = CONSOLE_JS.slice(
    CONSOLE_JS.indexOf("const SECURITY_CONTENT_ICONS = ["),
    CONSOLE_JS.indexOf("];", CONSOLE_JS.indexOf("const SECURITY_CONTENT_ICONS = ["))
  );
  const consoleIcons = (listBlock.match(/"[a-z-]+"/g) || []).map((name) => name.replace(/"/g, ""));
  assert.ok(consoleIcons.length > 0, "the console icon list was not found");
  assert.deepEqual(consoleIcons, [...SECURITY_TIP_ICONS],
    "the console picker and the API allowlist must be the same list, in the same order");

  // A name in the picker with no drawing behind it previews as an empty box.
  const pathsBlock = CONSOLE_JS.slice(
    CONSOLE_JS.indexOf("const SECURITY_CONTENT_ICON_PATHS = {"),
    CONSOLE_JS.indexOf("\n};", CONSOLE_JS.indexOf("const SECURITY_CONTENT_ICON_PATHS = {"))
  );
  for (const name of consoleIcons) {
    const key = /^[a-z]+$/.test(name) ? `\n  ${name}: ` : `\n  "${name}": `;
    assert.ok(pathsBlock.includes(key), `the console has no drawing for "${name}"`);
  }
});

test("every icon the API accepts is one the customer app can draw", () => {
  const registry = APP.slice(APP.indexOf("const ICON_PATHS = {"), APP.indexOf("\n};", APP.indexOf("const ICON_PATHS = {")));
  assert.ok(registry.length > 1000, "the PWA icon registry was not found");
  for (const name of SECURITY_TIP_ICONS) {
    const key = /^[a-z]+$/.test(name) ? `\n    ${name}: ` : `\n    "${name}": `;
    assert.ok(registry.includes(key), `the PWA cannot draw "${name}"`);
  }
  // And the app refuses a name it cannot draw instead of rendering the generic
  // grid square next to a security warning.
  assert.match(APP, /function securityTipIcon\(name\)[\s\S]{0,300}ICON_PATHS\[resolved\] \? resolved : "shield"/);
  assert.match(APP, /icon: securityTipIcon\(tip\?\.icon\)/);
});

// ---------------------------------------------------------------------------
// The customer app
// ---------------------------------------------------------------------------

test("the app carries the same defaults, so it works with no network at all", () => {
  assert.ok(APP.includes(LIVE_CARD_BODY), "the PWA still holds the live wording");
  assert.match(APP, /const SECURITY_CONTENT_DEFAULTS = \{/);
  for (const tip of SECURITY_CONTENT_DEFAULTS.tips) {
    assert.ok(APP.includes(tip.body), `the PWA holds the "${tip.title}" tip`);
  }
});

test("the shipped bundle carries this feature, not the version before it", () => {
  // The browser loads app.min.js. Asserting only against app.js would pass on a
  // build where the minified bundle was never regenerated, which is the exact
  // way four earlier features reached the tests and not the customer.
  assert.ok(APP_MIN.includes(LIVE_CARD_BODY), "app.min.js is stale - rebuild it");
  for (const name of ["securityContent", "loadSecurityContent", "securityTipCard", "securityTipIcon"]) {
    assert.ok(APP_MIN.includes(`function ${name}(`), `${name} is missing from app.min.js - rebuild it`);
  }
  for (const tip of SECURITY_CONTENT_DEFAULTS.tips) {
    assert.ok(APP_MIN.includes(tip.body), `app.min.js is missing the "${tip.title}" tip - rebuild it`);
  }
});

test("nothing the app renders can come back blank", () => {
  assert.match(APP, /return value \|\| SECURITY_CONTENT_DEFAULTS\[field\]/);
  assert.match(APP, /tips: tips\.length \? tips : SECURITY_CONTENT_DEFAULTS\.tips/);
});

test("the admin-authored text is escaped at every render site", () => {
  // The whole point of the feature is that this text comes from somewhere else.
  for (const site of [
    /<p class="eyebrow">\$\{esc\(content\.eyebrow\)\}<\/p>/,
    /<h2>\$\{esc\(content\.title\)\}<\/h2>/,
    // The heading is a parameter on purpose: the landing menu titles this card
    // "Stay safe" and must keep doing so, while the three security screens pass
    // the admin-editable cardHeading. Both are escaped.
    /<h3>\$\{esc\(heading\)\}<\/h3>/,
    /<p>\$\{esc\(securityContent\(\)\.cardBody\)\}<\/p>/,
    /data-close>\$\{esc\(content\.acknowledgeLabel\)\}<\/button>/,
    /<p class="eyebrow">\$\{esc\(content\.tipsEyebrow\)\}<\/p>/
  ]) {
    assert.match(APP, site, `render site ${site} escapes its value`);
  }
  // The tips go through settingsRow, which escapes both of its text arguments.
  assert.match(APP, /content\.tips\.map\(\(tip\) => settingsRow\(tip\.title, tip\.body, tip\.icon\)\)/);
  assert.match(APP, /function settingsRow\(label, value, iconName[\s\S]{0,220}esc\(label\)[\s\S]{0,80}esc\(value\)/);
  // esc() survives minification, so the shipped bundle escapes too: terser does
  // not rename top-level functions.
  assert.ok(APP_MIN.includes("function esc("), "esc() was renamed or dropped in the bundle");
  // And the console escapes it on the way back out into its own preview.
  assert.match(CONSOLE_JS, /escapeHtml/);
});

test("a failed fetch does not silence updates for the rest of the session", () => {
  // Marking the request done and never clearing it on failure meant one
  // network blip stopped the customer ever receiving revised wording.
  const fn = APP.slice(APP.indexOf("function loadSecurityContent()"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /\.catch\(\(\) => \{[\s\S]{0,400}securityContentRequested = false;/);
});

test("the wording survives closing the app, so the first screen is current", () => {
  // In-memory only meant the fetch helped the SECOND security screen of a
  // session and never the first, which on a screen most people open once is no
  // help at all.
  assert.match(APP, /const SECURITY_CONTENT_CACHE_KEY = "titopay_security_content_v1"/);
  assert.match(APP, /writeJson\(SECURITY_CONTENT_CACHE_KEY, result\.content\)/);
  const fn = APP.slice(APP.indexOf("function securityContent()"));
  const body = fn.slice(0, fn.indexOf("\n// Fetched once per session"));
  assert.match(body, /readJson\(SECURITY_CONTENT_CACHE_KEY\)/);
  assert.match(body, /securityContentSeeded = true/, "the cache is read once, not on every render");
});

test("the landing menu keeps its own heading", () => {
  // securityTipCard() is called bare from the landing menu, where the card has
  // always been titled "Stay safe". Routing that call through the editable
  // cardHeading would silently change a screen nobody asked to change.
  assert.match(APP, /function securityTipCard\(heading = "Stay safe"\)/);
  assert.match(APP, /\$\{securityTipCard\(\)\}/, "the landing menu still calls it with no heading");
});

// ---------------------------------------------------------------------------
// Routing and permissions
// ---------------------------------------------------------------------------

test("reading is public and writing is not", () => {
  // Comment lines are stripped first: the file explains, in prose, WHY it is
  // mounted ahead of the requireAuth on the bare /v1 prefix, and that sentence
  // must not read as the route using one.
  const publicCode = PUBLIC_ROUTE
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(publicCode, /requireAuth/, "the public route must serve a signed-out visitor");
  const get = ADMIN_ROUTES.indexOf('router.get("/security-content"');
  const put = ADMIN_ROUTES.indexOf('router.put("/security-content"');
  assert.ok(get > -1 && put > -1, "both admin endpoints exist");
  for (const start of [get, put]) {
    const handler = ADMIN_ROUTES.slice(start, ADMIN_ROUTES.indexOf("\n});", start));
    assert.match(handler, /requireAdminPermission\("security"\)/);
  }
  // Every change is attributable, and the log carries the wording itself so
  // "what did the app tell my customer that day" is answerable.
  const putHandler = ADMIN_ROUTES.slice(put, ADMIN_ROUTES.indexOf("\n});", put));
  assert.match(putHandler, /writeAuditLog/);
  assert.match(putHandler, /action: "security_content_updated"/);
  assert.match(putHandler, /cardBody: content\.cardBody/);
  // audit_logs.entity_id is a UUID column and a platform setting is keyed by
  // name. Passing the key there made Postgres reject the insert, so the PUT
  // stored the copy and then answered 500: an admin saw an error next to
  // content that had in fact changed, and the log recorded nothing at all.
  assert.match(putHandler, /entityId: null/, "a platform setting has no UUID entity");
  assert.match(putHandler, /settingKey: SECURITY_CONTENT_KEY/, "the key belongs in the metadata");
  assert.doesNotMatch(putHandler, /entityId: SECURITY_CONTENT_KEY/);
});

test("the public route answers on /v1, not on the bare path", () => {
  // This is the trap that made an earlier public endpoint unreachable: a route
  // added beside the health routes is mounted OUTSIDE mountVersionedRoutes, so
  // it answers on /security-content and never on /v1/security-content, while
  // every test that calls the handler directly still passes.
  const mounter = ROUTE_INDEX.slice(ROUTE_INDEX.indexOf("function mountVersionedRoutes"));
  const mount = mounter.slice(0, mounter.indexOf("\n}\n") + 1);
  assert.match(mount, /router\.use\(`\$\{prefix\}\/security-content`, securityContentRoutes\)/,
    "the public security-content route must be mounted inside mountVersionedRoutes, under the version prefix");
  // And it must come before the lookup routes, which put a requireAuth on the
  // bare prefix and would swallow anything mounted after them.
  const securityAt = mount.indexOf("/security-content");
  const lookupAt = mount.indexOf("lookupRoutes");
  assert.ok(securityAt > -1 && lookupAt > -1, "both mounts were found");
  assert.ok(securityAt < lookupAt, "security-content is mounted after the authenticated lookup routes");
  // The app asks for the versioned path, so a drift on either side is a 401.
  assert.match(APP, /api\("\/v1\/security-content", \{ auth: false \}\)/);
});

test("the console page is reachable and gated", () => {
  assert.match(CONSOLE_JS, /\["\/security-content\/", "security-content", "Security Content"\]/);
  assert.match(CONSOLE_JS, /"security-content": renderSecurityContent/);
  assert.match(CONSOLE_JS, /"security-content": "security"/, "the page requires the security permission");
  assert.match(CONSOLE_JS, /function renderSecurityContent/);
});

test("a console that could not read the stored copy cannot overwrite it", () => {
  // The guard used to be a paragraph of warning text beside a live Save button.
  const fn = CONSOLE_JS.slice(CONSOLE_JS.indexOf("async function renderSecurityContent()"));
  const body = fn.slice(0, fn.indexOf("\n/* RBAC editor"));
  assert.match(body, /type="submit"\$\{loadFailed \? " disabled" : ""\}/, "Save is disabled after a failed read");
  assert.match(body, /if \(loadFailed\) \{[\s\S]{0,260}return;/, "submitting by keyboard is refused too");
  assert.match(body, /data-sc-retry/, "there is a way to try the read again");
  // An operator must be able to tell stored copy from the shipped defaults.
  assert.match(body, /securityContentProvenance\(result\)/);
  assert.match(CONSOLE_JS, /function securityContentProvenance[\s\S]{0,400}Nobody has edited this yet/);
});
