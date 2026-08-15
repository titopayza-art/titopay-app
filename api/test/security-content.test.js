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

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const SERVICE = read("src", "services", "security-content-service.js");
const ADMIN_ROUTES = read("src", "routes", "admin.routes.js");
const PUBLIC_ROUTE = read("src", "routes", "security-content.routes.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
const CONSOLE_JS = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "admin.js"), "utf8");
const { SECURITY_CONTENT_DEFAULTS, MAX_TIPS } = require("../src/services/security-content-service");

// The exact wording that was live before this feature existed. If a future
// edit changes a default, it changes what every customer reads, so it should
// have to change this line too.
const LIVE_CARD_BODY = "Never share your PIN, password or verification codes. TitoPay will never ask for those by phone, email, WhatsApp, SMS or social media.";

test("the defaults are the copy that was already live", () => {
  assert.equal(SECURITY_CONTENT_DEFAULTS.cardBody, LIVE_CARD_BODY);
  assert.equal(SECURITY_CONTENT_DEFAULTS.title, "Stay safe with TitoPay");
  assert.equal(SECURITY_CONTENT_DEFAULTS.cardHeading, "Protect your account");
  assert.equal(SECURITY_CONTENT_DEFAULTS.acknowledgeLabel, "I understand");
  assert.equal(SECURITY_CONTENT_DEFAULTS.tips.length, 6);
});

test("the app carries the same defaults, so it works with no network at all", () => {
  // Not a duplicate for its own sake: this copy is what renders when the
  // customer's phone cannot reach TitoPay.
  assert.ok(APP.includes(LIVE_CARD_BODY), "the PWA still holds the live wording");
  assert.match(APP, /const SECURITY_CONTENT_DEFAULTS = \{/);
  for (const tip of SECURITY_CONTENT_DEFAULTS.tips) {
    assert.ok(APP.includes(tip.body), `the PWA holds the "${tip.title}" tip`);
  }
});

test("nothing a customer reads can come back blank", () => {
  // Every field falls back rather than rendering empty, on both sides.
  assert.match(SERVICE, /function readText\(value, fallback, max\)[\s\S]{0,200}if \(!text\) return fallback/);
  assert.match(SERVICE, /return tips\.length \? tips : SECURITY_CONTENT_DEFAULTS\.tips/);
  assert.match(APP, /return value \|\| SECURITY_CONTENT_DEFAULTS\[field\]/);
  assert.match(APP, /tips: tips\.length \? tips : SECURITY_CONTENT_DEFAULTS\.tips/);
});

test("a read never throws, because a signed-out screen must not 500", () => {
  const fn = SERVICE.slice(SERVICE.indexOf("async function getSecurityContent"));
  const body = fn.slice(0, fn.indexOf("\n// Writes are strict"));
  assert.match(body, /catch \(error\)[\s\S]{0,400}return mergeWithDefaults\(null\)/);
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
});

test("a write cannot bloat the row or smuggle an unknown icon", () => {
  assert.match(SERVICE, /if \(value\.tips\.length > MAX_TIPS\) throw new AppError\(400/);
  assert.ok(MAX_TIPS <= 12);
  assert.match(SERVICE, /if \(!Array\.isArray\(value\.tips\)\) throw new AppError\(400/);
  assert.match(SERVICE, /function normalizeTipIcon[\s\S]{0,220}SECURITY_TIP_ICONS\.has\(name\) \? name : FALLBACK_TIP_ICON/);
  // Length caps exist for every field a person can type into.
  for (const field of ["eyebrow", "title", "cardHeading", "cardBody", "acknowledgeLabel", "tipsEyebrow", "tipTitle", "tipBody"]) {
    assert.match(SERVICE, new RegExp(`${field}: \\d+`), `${field} is length-capped`);
  }
});

test("the landing menu keeps its own heading", () => {
  // securityTipCard() is called bare from the landing menu, where the card has
  // always been titled "Stay safe". Routing that call through the editable
  // cardHeading would silently change a screen nobody asked to change.
  assert.match(APP, /function securityTipCard\(heading = "Stay safe"\)/);
  assert.match(APP, /\$\{securityTipCard\(\)\}/, "the landing menu still calls it with no heading");
});

test("the console page is reachable and gated", () => {
  assert.match(CONSOLE_JS, /\["\/security-content\/", "security-content", "Security Content"\]/);
  assert.match(CONSOLE_JS, /"security-content": renderSecurityContent/);
  assert.match(CONSOLE_JS, /"security-content": "security"/, "the page requires the security permission");
  assert.match(CONSOLE_JS, /function renderSecurityContent/);
});
