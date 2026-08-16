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

test("a provider-backed request is given the provider's timeout, not the default", () => {
  // Airtime, data, electricity, vouchers and bill payments all POST to
  // /v1/transactions and all wait on Flash. They were on the 15-second default
  // while top-up and withdrawal had 45, so the app gave up while the provider
  // was still working — leaving the one outcome that is worst to explain:
  // money possibly taken, nothing on screen to say so.
  const paths = source.match(/^const PROVIDER_BACKED_PATHS = \[([\s\S]*?)^\];/m);
  const defaults = source.match(/^const DEFAULT_REQUEST_TIMEOUT_MS = (\d+);/m);
  const provider = source.match(/^const PROVIDER_REQUEST_TIMEOUT_MS = (\d+);/m);
  assert.ok(paths && defaults && provider, "the timeout configuration must exist");
  assert.ok(Number(provider[1]) > Number(defaults[1]), "the provider timeout must be the longer one");

  const fn = source.match(/function requestTimeoutFor\(path\) \{[\s\S]*?\n\}/);
  // eslint-disable-next-line no-new-func
  const requestTimeoutFor = new Function(
    "PROVIDER_BACKED_PATHS", "PROVIDER_REQUEST_TIMEOUT_MS", "DEFAULT_REQUEST_TIMEOUT_MS",
    `${fn[0]}; return requestTimeoutFor;`
    // eslint-disable-next-line no-eval
  )(eval(`[${paths[1]}]`), Number(provider[1]), Number(defaults[1]));

  for (const path of ["/v1/transactions", "/v1/payments/topup", "/v1/payouts/withdrawals"]) {
    assert.equal(requestTimeoutFor(path), Number(provider[1]), `${path} must get the provider timeout`);
  }
  assert.equal(requestTimeoutFor("/v1/wallets"), Number(defaults[1]),
    "an ordinary read must not wait as long as a provider call");
});

test("a failed statement request gives its button back", () => {
  // It used to disable the button and never re-enable it, so any failure left a
  // dead Confirm and the only way to retry was to close and reopen the sheet.
  const fn = source.match(/async function confirmEmailStatement\(button\)[\s\S]*?\n\}/);
  assert.ok(fn, "confirmEmailStatement must exist");
  assert.match(fn[0], /catch \(error\) \{\s*button\.disabled=false;\s*throw error;/,
    "a failure must re-enable the button and still surface the error");
  assert.ok(fn[0].indexOf("button.disabled=true") < fn[0].indexOf("catch (error)"),
    "the guard is only useful if the button was disabled first");
  // The key must NOT be regenerated on retry — that would turn a retry after a
  // request that actually succeeded into a second fee.
  assert.doesNotMatch(fn[0], /createClientTransactionKey/,
    "a retry must reuse the original idempotency key");
});

test("signing out clears what the app stored about the person", () => {
  // The in-app notification store is keyed per user and holds several kilobytes
  // of payment history in localStorage. It survived sign-out, on a handset that
  // may be shared or handed on.
  const fn = source.match(/function clearPersonalDeviceData\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "clearPersonalDeviceData must exist");
  assert.match(source, /localStorage\.removeItem\(AUTH_KEY\);[\s\S]{0,120}clearPersonalDeviceData\(\);/,
    "it must run as part of signing out");

  const store = {
    "titopay_in_app_notifications_v1:personal:abc": "history",
    "titopay_profile_photo_v1:abc": "photo",
    "titopay_receipts_v1:personal:abc": "receipts",
    "titopay_business_documents_v1": "invoices",
    "titopay_install_dismissed_v1": "device preference",
    "titopay_known_users_v1": "device preference"
  };
  const localStorageStub = {
    removeItem(key) { delete store[key]; },
    getItem(key) { return store[key] ?? null; }
  };
  // eslint-disable-next-line no-new-func
  new Function("localStorage", "Object", "PROFILE_PHOTO_PREFIX", "TITOPAY_RECEIPTS_KEY", "BUSINESS_DOCUMENTS_KEY",
    `${fn[0]}; clearPersonalDeviceData();`)(
    localStorageStub, { keys: () => Object.keys(store) },
    "titopay_profile_photo_v1", "titopay_receipts_v1", "titopay_business_documents_v1");

  assert.deepEqual(Object.keys(store).sort(), ["titopay_install_dismissed_v1", "titopay_known_users_v1"],
    "personal data goes; device preferences stay");
});

test("phone contacts are only offered where the browser can actually open them", () => {
  // The Contact Picker API is Chromium-on-Android only. Safari does not
  // implement it, and every browser on iOS is required to use WebKit, so Chrome
  // on an iPhone does not have it either. It is not a setting anyone can turn on.
  //
  // The button used to be rendered everywhere and answered a tap with an error,
  // which reads as something broken rather than something absent.
  const mount = source.match(/function enhanceContactPickerControls\(root = document\)[\s\S]*?\n\}/);
  assert.ok(mount, "enhanceContactPickerControls must exist");
  assert.match(mount[0], /if \(contactPickerSupported\(\)\) \{[\s\S]{0,600}?contact-picker-btn/,
    "the contacts button must be created only when the API is present");
  assert.match(mount[0], /if \(!tools\.childElementCount\) return;/,
    "an empty toolbar must not be inserted");
  // Verify TitoPay user is unrelated to contacts and must survive on every device.
  assert.match(mount[0], /recipient-verify-btn/);

  // The capability check itself, run for real against both shapes.
  const fn = source.match(/function contactPickerSupported\(\) \{[\s\S]*?\n\}/);
  // eslint-disable-next-line no-new-func
  const supported = new Function("window", "navigator", `${fn[0]}; return contactPickerSupported;`);
  assert.equal(supported({ isSecureContext: true }, {})(), false, "no API means no button");
  assert.equal(supported({ isSecureContext: false }, { contacts: { select() {} } })(), false,
    "an insecure context means no button");
  assert.equal(supported({ isSecureContext: true }, { contacts: { select() {} } })(), true);

  // And the message, for the case where support disappears between render and
  // tap, must not blame the customer's connection — they are already on HTTPS.
  assert.match(source, /This browser cannot open your phone contacts/);
  assert.doesNotMatch(source, /Phone contacts are available on supported HTTPS mobile browsers/,
    "the old wording implied an HTTPS problem the customer did not have");
});

test("the whole app is still there", () => {
  const declared = (source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).length;
  assert.ok(declared > 850, `expected the full app, found ${declared} top-level functions`);
});

test("the shipped bundle is rebuilt from this source", () => {
  const min = fs.readFileSync(pwaFile("app.min.js"), "utf8");
  // Terser does not mangle top-level names, so every entry point the tests and
  // the markup rely on must still be reachable by name.
  for (const name of ["api", "render", "boot", "primaryWallet", "statementPdf", "assembleStatementPagesPdf", "transactionPostedToWallet", "statementPostedAmount"]) {
    assert.ok(min.includes(`function ${name}(`), `${name} is missing from app.min.js — rebuild it`);
  }
  const sourceFns = new Set((source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).map((m) => m.replace(/.*function /, "")));
  assert.ok(sourceFns.size > 850);
});

test("the public app version is v1.0; internal bundle numbers never display", () => {
  // Customers see "TitoPay App v1.0" and nothing else. The cache-busting
  // bundle number (?v=NNN) is engineering plumbing: it must not appear in
  // any rendered text or tooltip, not even on the Profile version line.
  assert.match(source, /const TITOPAY_APP_VERSION = "1\.0"/);
  assert.match(source, /TitoPay App v\$\{esc\(TITOPAY_APP_VERSION\)\}/);
  assert.doesNotMatch(source, /title="Build \$\{/, "no bundle-number tooltip");
  assert.doesNotMatch(source, /appBundleVersion/, "the bundle-number reader is gone from the UI");
});

test("the account statement paginates instead of overprinting its footer", () => {
  // A busy month used to cram every row onto page 1: eight settled rows,
  // six attempts, and the rest drawn over the footer band. Rows now flow to
  // continuation pages and every page numbers itself.
  const body = source.slice(source.indexOf("function statementPdf("), source.indexOf("function assembleStatementPagesPdf("));
  assert.match(body, /startContinuationPage/);
  assert.match(body, /ACTIVITY \(CONTINUED\)/);
  assert.match(body, /Page \$\{index \+ 1\} of \$\{pages\.length\}/);
  assert.doesNotMatch(body, /posted\.slice\(0, 8\)/, "the one-page row cap is gone");
  assert.doesNotMatch(body, /Page 1 of 1/, "no hard-coded single-page footer remains");
  // The assembler emits one page object and content stream per page.
  const assembler = source.slice(source.indexOf("function assembleStatementPagesPdf("));
  assert.match(assembler.slice(0, 3000), /\/Count \$\{pages\.length\}/);
});

test("the service worker and the page agree on the bundle version", () => {
  const html = fs.readFileSync(pwaFile("index.html"), "utf8");
  const worker = fs.readFileSync(pwaFile("service-worker.js"), "utf8");
  const pageVersion = (html.match(/app\.min\.js\?v=(\d+)/) || [])[1];
  const workerVersion = (worker.match(/app\.min\.js\?v=(\d+)/) || [])[1];
  assert.ok(pageVersion, "index.html must cache-bust app.min.js");
  assert.equal(pageVersion, workerVersion, "a stale service worker would serve the previous bundle");
  assert.match(worker, new RegExp(`titopay-pwa-v${pageVersion}`), "the cache name must carry the same version");

  // The stylesheet is versioned too, and the worker precaches it by exact URL
  // (query string included), so a drift here means an offline first-load
  // cache-misses the stylesheet and renders unstyled.
  const pageStyles = (html.match(/styles\.min\.css\?v=(\d+)/) || [])[1];
  const workerStyles = (worker.match(/styles\.min\.css\?v=(\d+)/) || [])[1];
  assert.ok(pageStyles, "index.html must cache-bust styles.min.css");
  assert.equal(pageStyles, workerStyles, "the service worker must precache the same styles version the page requests");
});

test("the landing swipe does not compete with the browser's edge gesture", () => {
  // iOS Safari reserves a strip down each side for its own back and forward
  // navigation, and `touch-action` does not govern it — it is a system gesture.
  // A swipe starting there became a page transition AND stepped the account
  // type, so the app slid sideways with a pale gap where the rest of it should
  // have been. Behaviour is proven in verification/landing-swipe-edge.spec.js;
  // this stops the guard being deleted.
  assert.match(source, /const SWIPE_EDGE_GUTTER = \d+;/);
  const start = source.slice(source.indexOf("function landingSwipeStart"),
    source.indexOf("function landingSwipeMove"));
  assert.match(start, /event\.clientX < SWIPE_EDGE_GUTTER/, "the left strip is declined");
  assert.match(start, /event\.clientX > width - SWIPE_EDGE_GUTTER/, "and the right strip too");
  assert.match(start, /THE OUTER EDGE BELONGS TO THE BROWSER/,
    "and the reason is recorded where the next person will read it");
  // Declined before any movement is measured, so nothing half-happens.
  assert.ok(start.indexOf("SWIPE_EDGE_GUTTER") < start.indexOf("landingSwipe = {"),
    "the guard runs before the gesture is armed");
});
