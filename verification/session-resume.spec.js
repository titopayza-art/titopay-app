// Does the idle policy now survive the app being closed?
//
// This drives the real bundle in a real browser. It does not stub the app: it
// seeds localStorage the way a signed-in customer's device looks, then loads
// the page and asks what the app decided. Each case closes the page entirely
// between steps, which is the thing the old timer could not survive.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = "/home/user/titopay-app/pwa";
const PORT = 8123;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// SERVED OVER HTTP, NOT file://. index.html requests "./app.min.js?v=489", and
// over file:// Chromium takes the query string as part of the FILENAME, looks
// for a file literally called `app.min.js?v=489`, and fails to find it — so the
// bundle never executes and every check passes or fails for the wrong reason.
// That is what the first run of this harness actually measured.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
function startServer() {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(PWA, clean === "/" ? "index.html" : clean);
    if (!file.startsWith(PWA)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}
const TEN_MIN = 10 * 60 * 1000;
const AUTH_KEY = "titopay_candidate_auth_v1";
const LAST_ACTIVE_KEY = "titopay_last_active_v1";
const FAKE = { accessToken: "seeded-access-token", refreshToken: "seeded-refresh-token", scope: "customer" };

const API_OK = {
  "/v1/auth/me": { ok: true, user: { id: "u1", fullName: "Test Customer", accountType: "personal", status: "active" } },
  "/v1/wallets": { ok: true, wallets: [] },
  "/v1/transactions": { ok: true, transactions: [] }
};
function stubApi(page) {
  return page.route("**/api.titopay.co.za/**", (route) => {
    const url = new URL(route.request().url());
    const body = API_OK[url.pathname] || { ok: true };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openApp(context, seed) {
  const page = await context.newPage();
  // Nothing here is allowed to reach the real API.
  await stubApi(page);
  await page.addInitScript((s) => {
    localStorage.clear();
    if (s.auth) localStorage.setItem(s.authKey, JSON.stringify(s.auth));
    if (s.lastActive !== null) localStorage.setItem(s.lastActiveKey, String(s.lastActive));
  }, seed);
  await page.goto(ORIGIN + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  // `state` is deliberately not exposed on window, and adding a hook to the
  // shipped bundle just so a test can read it would be the wrong trade. What
  // is observable is the thing that actually matters: whether the credentials
  // are still on the device after the app has decided, and whether the person
  // is looking at a sign-in screen.
  const result = await page.evaluate((keys) => ({
    authStillOnDevice: localStorage.getItem(keys.authKey) !== null,
    stampOnDevice: localStorage.getItem(keys.lastActiveKey),
    showsSignIn: Boolean(document.querySelector(".auth-screen, .landing-flow")),
    // Function declarations at the top level of a classic script become
    // globals, so this proves the bundle ran rather than assuming it did.
    bundleRan: typeof window.boot === "function"
  }), { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY });
  result.restored = result.authStillOnDevice;
  if (!result.bundleRan) throw new Error("app.min.js did not execute — the harness is measuring nothing");
  await page.close();
  return result;
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const now = Date.now();
  const checks = [];
  const check = (name, got, want) => {
    checks.push([name, got === want, got, want]);
  };

  // 1. THE BUG AS REPORTED. Signed in, app closed, opened again much later.
  //    Before this change the session came straight back.
  let r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: FAKE, lastActive: now - 6 * 60 * 60 * 1000 });   // six hours ago
  check("6 hours closed -> session NOT restored", r.restored, false);
  check("6 hours closed -> credentials removed from the device", r.authStillOnDevice, false);

  // 1b. AND THE CUSTOMER IS TOLD WHY. A sign-in screen with no explanation
  //     reads as the app having forgotten them, which is a support call.
  {
    const page = await context.newPage();
    await stubApi(page);
    await page.addInitScript((s) => {
      localStorage.clear();
      localStorage.setItem(s.authKey, JSON.stringify(s.auth));
      localStorage.setItem(s.lastActiveKey, String(s.lastActive));
    }, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY, auth: FAKE, lastActive: now - 6 * 3600 * 1000 });
    await page.goto(ORIGIN + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const toast = await page.evaluate(() => (document.querySelector(".toast") || {}).textContent || "");
    check("the customer is told why they were signed out",
      /signed out after 10 minutes of inactivity/i.test(toast), true);
    await page.close();
  }

  // 2. Just past the window.
  r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: FAKE, lastActive: now - (TEN_MIN + 30 * 1000) });
  check("10m30s closed -> session NOT restored", r.restored, false);

  // 3. Inside the window: switching to another app mid-payment must not
  //    throw the customer out.
  r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: FAKE, lastActive: now - 60 * 1000 });
  check("1 minute closed -> session restored", r.restored, true);

  // 4. FAILING CLOSED. A stored session with no timestamp beside it — an
  //    upgrade from the old build, or someone deleting the stamp to keep a
  //    session alive — is expired, never treated as fresh.
  r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: FAKE, lastActive: null });
  check("no timestamp -> session NOT restored", r.restored, false);

  // 5. A CLOCK WOUND BACKWARDS must not read as "no time has passed".
  r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: FAKE, lastActive: now + 48 * 60 * 60 * 1000 });   // stamped in the future
  check("timestamp in the future -> session NOT restored", r.restored, false);

  // 6. A signed-out device is unaffected — no session, no error, no stamp.
  r = await openApp(context, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY,
    auth: null, lastActive: null });
  check("signed out -> stays signed out", r.restored, false);

  // 7. THE STAMP IS ACTUALLY WRITTEN while the app is in use, and on hide —
  //    without this the whole mechanism expires a live session.
  const page = await context.newPage();
  await stubApi(page);
  await page.addInitScript((s) => {
    localStorage.clear();
    localStorage.setItem(s.authKey, JSON.stringify(s.auth));
    localStorage.setItem(s.lastActiveKey, String(s.lastActive));
  }, { authKey: AUTH_KEY, lastActiveKey: LAST_ACTIVE_KEY, auth: FAKE, lastActive: now - 60 * 1000 });
  await page.goto(ORIGIN + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const seeded = now - 60 * 1000;
  const afterOpen = Number(await page.evaluate((k) => localStorage.getItem(k), LAST_ACTIVE_KEY));
  check("opening the app refreshes the stamp", afterOpen > seeded, true);
  // A tap a second later writes nothing, and that is correct: writes are
  // throttled to 30s because activity fires on every scroll and tap, and the
  // value only has to be accurate to well inside a ten minute window.
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterTap = Number(await page.evaluate((k) => localStorage.getItem(k), LAST_ACTIVE_KEY));
  check("a tap inside the throttle window writes nothing", afterTap === afterOpen, true);
  // Hiding the app is the write that matters: it is the last thing that
  // happens before the in-memory timer is destroyed.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  const afterHide = Number(await page.evaluate((k) => localStorage.getItem(k), LAST_ACTIVE_KEY));
  check("hiding the app forces a write past the throttle", afterHide > afterTap, true);
  await page.close();

  await browser.close();
  server.close();

  let failed = 0;
  for (const [name, ok, got, want] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `   (got ${got}, wanted ${want})`}`);
    if (!ok) failed += 1;
  }
  console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
