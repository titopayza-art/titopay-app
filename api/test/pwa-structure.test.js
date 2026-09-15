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

test("the system back gesture closes the layer on top, not the screen", () => {
  // On an installed app, Back closes whatever is covering the screen. The
  // sheets, the Pay hub and the confirm dialog lived outside the history
  // stack, so Back skipped straight past them: on Android it left the app, and
  // on iOS the edge swipe took the whole screen away with a sheet still open.
  // Behaviour is proven in verification/pwa-native-feel.spec.js; this stops
  // the wiring being removed one call at a time.
  assert.match(source, /history\.pushState\(\{ tpSheet: 1 \}, ""\)/,
    "a sheet claims one history entry");
  assert.match(source, /const OVERLAY_SELECTOR = "\.modal-backdrop, \.pay-hub-backdrop:not\(\[data-closing\]\), \.tp-dialog-layer"/,
    "and every overlay that covers the screen is counted, not just the sheets");
  assert.match(source, /window\.addEventListener\("popstate", onHistoryBack\)/);

  // The entry is claimed at the url the sheet opened on, because several flows
  // close a sheet and then navigate; unwinding into that navigation would undo
  // it. The comparison is what tells the two cases apart.
  const release = source.slice(source.indexOf("function releaseSheetHistory"),
    source.indexOf("function onHistoryBack"));
  assert.match(release, /location\.href !== sheetHistoryHref/,
    "a route that moved on is left alone rather than unwound");
  assert.match(release, /if \(overlayIsOpen\(\)\) return;/,
    "and an entry is never handed back while something is still open");

  // Top layer first, and one layer at a time.
  const back = source.slice(source.indexOf("function onHistoryBack"),
    source.indexOf("function openModal("));
  assert.ok(back.indexOf(".tp-dialog-layer") < back.indexOf(".pay-hub-backdrop")
    && back.indexOf(".pay-hub-backdrop") < back.indexOf(".modal-backdrop"),
    "the dialog is peeled before the hub, and the hub before the sheet");
  assert.match(back, /handleAction\("modal-back"\)/,
    "a sheet opened from a sheet returns to the one that opened it");
  assert.match(back, /if \(overlayIsOpen\(\)\) claimSheetHistory\(\);/,
    "whatever is still open claims an entry of its own, so the next Back peels again");
  assert.match(back, /sheetHistorySkips < 4/,
    "stepping over a stale entry is bounded, so a history stack this code did "
    + "not create can never loop");

  // Every overlay opens through one of these, and each has to claim.
  for (const opener of ["function openModal(", "function openPayHub(", "function appDialog("]) {
    const body = source.slice(source.indexOf(opener), source.indexOf(opener) + 6000);
    assert.match(body, /claimSheetHistory\(\)/, `${opener.trim()} claims a history entry`);
  }
});

test("every control the app renders answers a tap", () => {
  // -webkit-tap-highlight-color is transparent across the app, so a control
  // with no :active rule of its own gives no feedback at all when tapped and
  // the tap reads as a miss. These three were found with no answer by a walk
  // of the real screens in verification/pwa-native-feel.spec.js.
  const css = fs.readFileSync(pwaFile("styles.css"), "utf8");
  const min = fs.readFileSync(pwaFile("styles.min.css"), "utf8");
  for (const sheet of [css, min]) {
    assert.match(sheet, /\.segment button:active/);
    assert.match(sheet, /\.chip:not\(:disabled\):active/);
    assert.match(sheet, /\.install-float-dismiss:active/);
  }
  // The landing segment is the first control a new customer touches, and on a
  // short screen it was 40px tall. Measured before it was changed: the landing
  // still fits with no scroll at 44px on 360x640, 375x667, 360x740, 390x664,
  // 412x732 and 414x736.
  assert.doesNotMatch(css, /body\.landing-static \.landing-flow \.segment button \{\s*min-height: 40px;/);
  assert.doesNotMatch(min, /landing-flow \.segment button\{min-height:40px\}/);
});

test("every iOS startup image the page declares is a whole file at the size it claims", () => {
  // The one startup image the app shipped was truncated in the writing: the
  // top 660 rows of 2532 were all that was ever there, and a PNG with no IEND
  // chunk does not decode. iOS silently fell back to a white rectangle, which
  // is exactly the flash the tag exists to prevent, and the failure was
  // invisible from the source. Every declared image is now read from disk.
  const html = fs.readFileSync(pwaFile("index.html"), "utf8");
  const declared = Array.from(html.matchAll(
    /href="\.\/assets\/(splash-(\d+)x(\d+)\.png)[^"]*"[\s\S]{0,240}?-webkit-device-pixel-ratio: (\d)\)/g));
  assert.ok(declared.length >= 8,
    `one image covers one phone; every other device flashes (found ${declared.length})`);

  for (const [, name, width, height] of declared) {
    const bytes = fs.readFileSync(pwaFile(`assets/${name}`));
    assert.ok(bytes.length > 4096, `${name} is too small to be a real image`);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${name} is not a PNG`);
    // The last chunk of a complete PNG is IEND. Its absence is precisely how
    // the shipped file failed.
    assert.equal(bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii"), "IEND",
      `${name} is truncated: iOS will not decode it and shows a white flash instead`);
    // IHDR carries the real dimensions, and iOS matches on them exactly.
    assert.equal(bytes.readUInt32BE(16), Number(width), `${name} is not ${width} pixels wide`);
    assert.equal(bytes.readUInt32BE(20), Number(height), `${name} is not ${height} pixels tall`);
  }

  // The device size and the pixel size have to agree, or iOS matches the media
  // query and then draws the wrong picture.
  for (const [, name, width, height, ratio] of declared) {
    const media = html.slice(html.indexOf(name));
    const cssWidth = Number((media.match(/device-width: (\d+)px/) || [])[1]);
    const cssHeight = Number((media.match(/device-height: (\d+)px/) || [])[1]);
    assert.equal(cssWidth * Number(ratio), Number(width), `${name}: width does not match its media query`);
    assert.equal(cssHeight * Number(ratio), Number(height), `${name}: height does not match its media query`);
  }
});

test("a business account sees four options, a personal account sees three", () => {
  // A business owner with only a company number in front of them was looking at
  // a form that offered an ID number and nothing else, so the registration
  // number is now a fourth choice HERE, where they are already standing.
  const select = source.slice(source.indexOf('<select id="bv-doc" name="documentType">'),
    source.indexOf('<select id="bv-doc" name="documentType">') + 600);
  assert.match(select, /value="sa_id"/);
  assert.match(select, /value="passport"/);
  assert.match(select, /value="other"/);
  assert.match(select, /value="company_registration"/, "the fourth option is missing");
  // It is gated on the account type in the same expression that renders it, so
  // a personal account cannot be shown a company field.
  assert.match(select, /state\.accountType === "business" \?[^:]*company_registration/,
    "the company option must be rendered only for a business account");
});

test("a company registration number never verifies a person", () => {
  // THE ONE RULE THIS FEATURE RESTS ON. A registration number says a company is
  // on a register anyone can search. It says nothing about who is holding the
  // phone. If this branch were ever pointed at /v1/compliance/basic-verify, a
  // business would reach a higher limit with no person verified at all.
  const submit = source.slice(source.indexOf("async function submitBasicVerify"),
    source.indexOf("async function submitBasicVerify") + 2200);
  const companyBranch = submit.slice(submit.indexOf('documentType === "company_registration"'),
    submit.indexOf("let body;"));
  assert.ok(companyBranch.length > 100, "the company branch is missing from submitBasicVerify");
  assert.match(companyBranch, /\/v1\/business\/verification\/businesses/,
    "the company option must post to the business register");
  assert.doesNotMatch(companyBranch, /basic-verify/,
    "a company registration number must never be submitted as a personal identity document");
  assert.doesNotMatch(companyBranch, /identity is verified/i,
    "and must never tell the customer their identity was verified");
});

test("an unregistered business type is never asked for a registration number", () => {
  // A spaza, a hawker or a freelancer has no CIPC number. Requiring one would
  // shut the very customers this app is for out of their own business.
  const registered = source.slice(source.indexOf("const REGISTERED_BUSINESS_TYPES"),
    source.indexOf("const REGISTERED_BUSINESS_TYPES") + 260);
  for (const key of ["private_company", "public_company", "close_corporation", "non_profit", "cooperative", "trust"]) {
    assert.match(registered, new RegExp(`"${key}"`), `${key} has a registration number`);
  }
  for (const key of ["sole_proprietor", "informal_trader", "partnership"]) {
    assert.doesNotMatch(registered, new RegExp(`"${key}"`), `${key} has no registration number and must not be required to give one`);
  }
});

test("the printed poster names the owner from the same source the payer sees", () => {
  // A printed A4 poster cannot be corrected once it is on a counter. It used to
  // print businessProfileName(), which falls through to the owner's personal
  // full name when the session carries no business name, while the payer's
  // phone named the merchant. Measured before the fix: the poster said
  // "Person 121" and the phone said "Corner Cafe", for one account, on the
  // exact screen that tells people to check one against the other.
  assert.match(source, /async function posterOwnerName\(/,
    "the poster must resolve its name from the API, not from the session");
  const resolver = source.slice(source.indexOf("async function posterOwnerName("),
    source.indexOf("async function openQrPosterModal"));
  assert.match(resolver, /\/v1\/qr\/\$\{encodeURIComponent\(id\)\}\/details/,
    "it must ask the same endpoint the payer's review screen asks");
  assert.match(resolver, /owner\?\.displayName/, "and print the name that endpoint returns");
  assert.match(resolver, /catch \(error\)/, "a failed lookup must never block the poster");

  const poster = source.slice(source.indexOf("async function openQrPosterModal"),
    source.indexOf("async function openQrPosterModal") + 900);
  assert.match(poster, /const name = await posterOwnerName\(qr\);/,
    "the poster still names the owner from the session object");
});

test("a route change is not mistaken for a back gesture", () => {
  // Setting location.hash fires popstate, and several flows do that with a
  // sheet still open: login sets the route to dashboard, closes the auth
  // sheet, then opens the Security Tip screen. Treating that popstate as a
  // back gesture peeled a layer that was never the target, and because the
  // peel runs a microtask later it closed the sheet the flow had just opened.
  // The Security Tip screen stopped appearing after sign-in, silently.
  // Proven end to end in verification/pwa-sign-in-journey.spec.js.
  const back = source.slice(source.indexOf("function onHistoryBack"),
    source.indexOf("function openModal("));
  assert.match(back, /location\.href !== sheetHistoryHref/,
    "a popstate that moved the route releases the entry and peels nothing");
  assert.ok(back.indexOf("location.href !== sheetHistoryHref") < back.indexOf(".tp-dialog-layer"),
    "and it is checked BEFORE any layer is looked at");
  assert.match(back, /document\.querySelector\("\.modal-backdrop"\) !== sheet/,
    "the peel is checked against the sheet that was on screen when the gesture arrived");
});

// BOOK READS EVERY TIME ON ONE CLOCK.
//
// The availability engine builds slot instants on a UTC day from opening hours
// stored as minutes from midnight, and the time picker labels them with
// getUTCHours. Any Book screen that reads a booking time back with the
// browser's LOCAL clock therefore contradicts the times the customer was
// offered - by two hours in South Africa, where every user of this product is.
// That is not a cosmetic difference: the customer is shown 20:30, told 22:30,
// and the business's day list says something else again.
test("Book shows booking times on the same clock the picker offered them on", () => {
  const start = source.indexOf("BOOK, FOR A CUSTOMER.");
  assert.ok(start > 0, "the customer half of Book should be findable");
  const bookSource = source.slice(start);

  // formatDate is the app-wide local-clock formatter. Book uses bookWhenText.
  const localReads = bookSource.match(/formatDate\((?:made\.)?startsAt\)/g) || [];
  assert.deepEqual(localReads, [],
    `a Book screen is formatting a booking time on the local clock: ${localReads.join(", ")}`);

  // And the two helpers that keep it consistent must both read UTC.
  assert.match(source, /function bookTimeOfDay\(iso\)[\s\S]{0,300}getUTCHours/,
    "bookTimeOfDay must read UTC");
  assert.match(source, /function bookWhenText\(iso\)[\s\S]{0,400}timeZone: "UTC"/,
    "bookWhenText must read UTC");
});

// A PERSONAL WALLET DOES NOT SAY "RUN YOUR BUSINESS".
//
// Empty groups are dropped from the Services grid, and every member of the
// business group except Book is business-only - so that heading had never once
// rendered for a customer. Filing Book there put it on the personal screen as a
// section of one, announcing "Run your business" to somebody booking a table.
// Book is two products wearing one tile and needs a home per account type.
test("the Book tile is filed by who is looking at it", () => {
  const start = source.indexOf("function serviceGroupOf(service)");
  assert.ok(start > 0, "serviceGroupOf should exist");
  const fn = source.slice(start, start + 1400);
  assert.match(fn, /keys\.includes\("book"\)/,
    "serviceGroupOf must special-case Book, the way the visibility filter already does");
  assert.match(fn, /state\.accountType === "business" \? "business" : "buy"/,
    "a business gets its console under Run your business; a customer gets it under Buy");
  // And the special case must run BEFORE the generic member lookup, or the
  // business group would claim Book back for everybody.
  assert.ok(fn.indexOf('keys.includes("book")') < fn.indexOf("for (const group of SERVICE_GROUPS)"),
    "the special case must be reached before the generic group scan");
});

// THE FICA SUBMIT BUTTON HAS TO ACTUALLY SUBMIT.
//
// onSubmit calls setBusy(form, true), which disables every control in the form.
// The HTML spec omits disabled controls from a FormData built afterwards, so a
// handler that rebuilds FormData from the form receives an empty set. submitFica
// did exactly that, threw "Choose a document to upload." on a form that had one,
// and no FICA submission ever reached the server from that button. It must use
// the FormData onSubmit captured BEFORE setBusy ran.
test("submitFica uses the form data captured before the fields were disabled", () => {
  assert.match(source, /if \(form\.dataset\.form === "fica-upload"\) await submitFica\(form, formData\);/,
    "the dispatcher must hand submitFica the pre-captured FormData");
  const start = source.indexOf("async function submitFica(");
  assert.ok(start > 0, "submitFica should exist");
  const head = source.slice(start, start + 260);
  assert.match(head, /async function submitFica\(form, formData\)/,
    "submitFica must accept the captured FormData");
  assert.match(head, /const data = formData \|\| new FormData\(form\)/,
    "submitFica must prefer the captured FormData over rebuilding it");
  // setBusy still disables everything; that is what makes the above necessary.
  assert.match(source, /function setBusy\(form, busy\)[\s\S]{0,220}element\.disabled = busy/,
    "setBusy still disables the fields, so any form-reading handler needs the captured data");
});

// A TICKET SHOWS THE DOORS TIME, NOT A MIDNIGHT NOBODY ATTENDS.
//
// The stub formatted events.event_date - a DATE column with no clock - through
// formatDate, which carries timeStyle: "short". Every ticket therefore read
// "12 Dec 2026, 00:00". Worse, `new Date("2026-12-12")` is UTC midnight and
// Intl then renders it in the reader's zone, so the same ticket said 02:00 in
// South Africa, and a date on a month boundary could show the previous day.
//
// The start time lives beside the date on the event, so the stub reads the day
// in UTC, the way it was stored, and appends that start time.
test("a ticket stub shows the event's start time, read as a UTC calendar date", () => {
  const start = source.indexOf("function ticketWhenText(");
  assert.ok(start > 0, "ticketWhenText should exist");
  const fn = source.slice(start, start + 700);
  assert.match(fn, /timeZone: "UTC"/,
    "a calendar date must be read in UTC or the day itself can shift for the reader");
  assert.doesNotMatch(fn, /timeStyle/,
    "a DATE column has no clock: rendering one invents a midnight");
  assert.match(fn, /clock \? `\$\{text\}, \$\{clock\}` : text/,
    "the real start time is appended when the event has one, and omitted when it does not");

  // And the stub must actually use it, with the start time resolved from the
  // event that travels with the ticket.
  const stubStart = source.indexOf("function ticketStub(");
  assert.ok(stubStart > 0, "ticketStub should exist");
  // The whole function, bounded by the next top-level declaration, rather than
  // a guessed byte count. A fixed 1800-char window silently stopped covering
  // the header the moment the ticket face grew a poster band and a seat block,
  // and a slice that ends early turns every doesNotMatch below into a test
  // that passes because it looked at nothing.
  const stubEnd = source.indexOf("\nfunction ", stubStart + 10);
  assert.ok(stubEnd > stubStart, "the end of ticketStub should be findable");
  const stub = source.slice(stubStart, stubEnd);
  assert.match(stub, /<article class="ticket-stub/, "the slice reaches the markup it is asserting about");
  assert.match(stub, /const startTime = ticket\.startTime \|\| ticket\.event\?\.startTime/,
    "ticketStub must resolve the start time, including from the ticket's own event");
  assert.match(stub, /ticketWhenText\(eventDate, startTime\)/,
    "ticketStub must render through ticketWhenText");
  assert.doesNotMatch(stub, /formatDate\(eventDate\)/,
    "the old time-bearing formatter must be gone from the stub");
});

test("the seat band survives night mode, where --navy is nearly white", () => {
  // THE TRAP THIS TEST EXISTS FOR.
  //
  // In night mode the palette inverts and --navy becomes #e8eeff — a near
  // white. Any dark surface written as `background: var(--navy)` with white
  // text on it therefore renders white-on-white and disappears. The ticket
  // header already had to be pinned to the literal for exactly this reason,
  // through a separate night override that is easy to forget to add.
  //
  // The seat band uses the literal directly instead, so there is nothing to
  // forget. Both files are checked because styles.css is the readable source
  // of record and styles.min.css is the one the browser actually loads.
  for (const name of ["styles.css", "styles.min.css"]) {
    const css = fs.readFileSync(pwaFile(name), "utf8");
    const start = css.indexOf(".ticket-seating {") >= 0
      ? css.indexOf(".ticket-seating {")
      : css.indexOf(".ticket-seating{");
    assert.ok(start > 0, `.ticket-seating must be defined in ${name}`);
    const rule = css.slice(start, css.indexOf("}", start));
    assert.match(rule, /background:\s*#061a3d/,
      `${name}: the seat band must name the dark navy literally`);
    assert.doesNotMatch(rule, /background:\s*var\(--navy\)/,
      `${name}: var(--navy) inverts to near-white at night and would hide the seat`);
  }
});

test("a general admission ticket grows no seat block", () => {
  // Seating must be additive. Every event already selling is general
  // admission, and the API omits the seating field entirely for those, so the
  // band has to be conditional on the field being there rather than on it
  // being non-empty — an empty band of three dashes would be worse than none.
  const start = source.indexOf("function ticketSeatingBand(");
  assert.ok(start > 0, "ticketSeatingBand should exist");
  const fn = source.slice(start, source.indexOf("\nfunction ", start + 10));
  assert.match(fn, /if \(!seating\) return "";/,
    "no seating field means no band at all");
  assert.match(fn, /\.filter\(\(\[, value\]\) => String\(value \|\| ""\)\.trim\(\)\)/,
    "only the cells that carry a value are drawn");
  assert.match(fn, /if \(!cells\.length\) return "";/);

  // And the old flat seat row is suppressed when the band renders, so a seat
  // is never stated twice on one ticket.
  const stub = source.slice(source.indexOf("function ticketStub("));
  assert.match(stub, /seat && !seatingBand \? `<div><span>Seat<\/span>/,
    "the label-and-value seat row only appears when there is no band");
});
