"use strict";

/* WHAT A PERSON SEES IMMEDIATELY AFTER SIGNING IN.
 *
 * This exists because of a bug it would have caught on the day it shipped.
 *
 * The back-gesture work in v413 made every popstate peel the top layer. But
 * setting location.hash ALSO fires popstate, and login() does exactly that
 * with a sheet still open: it sets the route to dashboard, closes the auth
 * sheet, then opens the Security Tip screen. The peel ran a microtask later,
 * by which time the sheet on screen was the Security Tip screen rather than
 * the auth sheet the gesture was aimed at, so it closed the wrong one. The
 * Security Tip screen simply stopped appearing after sign-in, silently, with
 * no error anywhere.
 *
 * Every check here drives the REAL journey: tap Sign in, type into the fields,
 * press the button. Calling login() or showSecurityTipModal() directly is what
 * hid the fault the first time round -- both of those worked perfectly while
 * the journey was broken.
 *
 * The shipped bundle hardcodes the production API host, so requests to it are
 * forwarded to the local API. Nothing else is simulated.
 *
 * Needs the stack:  bash scratchpad/start-native-stack.sh
 * Run: node verification/pwa-sign-in-journey.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const LIVE = "https://api.titopay.co.za";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "SignInJourney!2026#x";

let passed = 0;
let ran = 0;
const check = (condition, message, detail = "") => {
  ran += 1;
  if (condition) { passed += 1; console.log("  PASS  " + message); return true; }
  console.error(`  FAIL  ${message}${detail ? "\n        " + detail : ""}`);
  process.exitCode = 1;
  return false;
};

async function forwardLiveApi(context) {
  await context.route(`${LIVE}/**`, async (route) => {
    const request = route.request();
    const target = request.url().replace(LIVE, "http://127.0.0.1:8110");
    const headers = Object.assign({}, request.headers());
    delete headers.host; delete headers.origin; delete headers.referer;
    const response = await fetch(target, {
      method: request.method(), headers,
      body: request.postData() || undefined, redirect: "manual"
    });
    const body = Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, key) => {
      if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) out[key] = value;
    });
    out["access-control-allow-origin"] = "*";
    await route.fulfill({ status: response.status, headers: out, body });
  });
}

const sheetText = (page) => page.evaluate(() => {
  const backdrop = document.querySelector(".modal-backdrop");
  return backdrop ? backdrop.innerText.replace(/\s+/g, " ") : "";
});

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — what a person sees after signing in");
  console.log("=============================================================\n");

  const tail = String(Date.now()).slice(-7);
  const account = {
    fullName: "Sign In Journey", email: `journey${tail}@titopay.local`,
    phone: `+2774${tail}`, password: PASSWORD, accountType: "personal"
  };
  const registered = await fetch(`${API}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account)
  });
  if (!check(registered.status === 201 || registered.status === 200,
    "an account exists to sign in with", `register returned ${registered.status}`)) process.exit(1);

  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, serviceWorkers: "block"
  });
  await forwardLiveApi(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${PWA}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // ---- the journey, tapped rather than called ----------------------------
  await page.click("text=Sign in");
  await page.waitForTimeout(700);
  check(/Sign in/i.test(await sheetText(page)), "tapping Sign in opens the sheet");

  await page.fill('.modal-backdrop input[name="identifier"]', account.email);
  await page.fill('.modal-backdrop input[name="password"]', PASSWORD);
  await page.click('.modal-backdrop button[type="submit"]:has-text("Sign in securely")');

  // Polled, because the fault was a sheet that appeared and was then removed
  // a microtask later. A single reading at the end would have called that a
  // pass on the way in and a fail on the way out, depending only on timing.
  let everSeen = false;
  let stillOpenAt = 0;
  for (let i = 0; i < 40; i += 1) {
    const text = await sheetText(page);
    if (/Stay safe with TitoPay/i.test(text)) { everSeen = true; stillOpenAt = i * 200; }
    await page.waitForTimeout(200);
  }
  const signedIn = await page.evaluate(() =>
    Boolean(typeof state !== "undefined" && state.auth && state.auth.accessToken));

  check(signedIn, "the sign-in completes");
  check(await page.evaluate(() => location.hash) === "#dashboard",
    "and lands on the dashboard", await page.evaluate(() => location.hash));
  check(everSeen, "the Security Tip screen appears after signing in");
  check(stillOpenAt >= 6000,
    "and it is still there seconds later, not swept away by something behind it",
    `last seen at t+${stillOpenAt}ms of 8000`);

  const text = await sheetText(page);
  check(/Never share your PIN/i.test(text), "it carries the warning");
  check((text.match(/Never share codes|Check before you pay|Keep contact details|Lock your wallet|Beware of urgency|Use your device lock/g) || []).length >= 6,
    "and all six tips");
  check(/I understand/i.test(text), "and the acknowledgement");

  // ---- and the back gesture still behaves on it ---------------------------
  await page.goBack().catch(() => {});
  await page.waitForTimeout(900);
  const afterBack = await page.evaluate(() => ({
    sheet: Boolean(document.querySelector(".modal-backdrop")),
    hash: location.hash
  }));
  check(!afterBack.sheet, "the back gesture closes it");
  check(afterBack.hash === "#dashboard",
    "and leaves the customer on the dashboard rather than signed out",
    afterBack.hash);

  check(errors.length === 0, "the journey raised no script errors", errors[0] || "");

  await browser.close();
  console.log(`\n  ${passed}/${ran} sign-in journey checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
