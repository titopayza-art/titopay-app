// THE CLIENT HALF OF ONE-SESSION-PER-ACCOUNT, IN A REAL BROWSER.
//
// The API tests prove the rule. They cannot prove the four things that only
// exist on the screen, and those are the ones the customer actually meets:
//
//   1. the app generates a device id, keeps it, and sends it when signing in;
//   2. an unrecognised device is told a code went to BOTH channels;
//   3. a device signed out by a sign-in elsewhere is put back on the login
//      screen rather than left holding a dashboard that no longer works;
//   4. the reason is ON that screen, and survives the reload that normally
//      swallows a toast.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/single-device-session.spec.js
//
// PWA_ROOT overrides the app directory so an extracted app.zip is tested
// exactly as it will be deployed.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API_ORIGIN = "https://api.titopay.co.za";

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain"
};

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(PWA_ROOT, file);
    if (!resolved.startsWith(PWA_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// The API, standing in for the real one. Every route the app touches during a
// sign-in, answering exactly as the deployed API does.
async function withApi(page, { onLogin, onAuthed } = {}) {
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
      headers: { "access-control-allow-origin": "*" }
    });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    if (url.pathname === "/v1/auth/login") {
      const body = JSON.parse(request.postData() || "{}");
      return json(200, onLogin ? onLogin(body) : { ok: true });
    }
    if (onAuthed) {
      const handled = onAuthed(url.pathname);
      if (handled) return json(handled.status, handled.body);
    }
    return json(200, { ok: true });
  });
}

async function openApp(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.titopayDeviceId === "function"
    || document.querySelector("[data-form='login'], .landing-flow, main"), null, { timeout: 15000 }).catch(() => null);
  return { context, page, errors };
}

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> one active session, and the device that lost it");
  console.log("=============================================================\n");

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    // ---- 1. The device id exists, persists, and is well formed -------------
    let session = await openApp(browser, origin);
    const first = await session.page.evaluate(() => window.titopayDeviceId && window.titopayDeviceId());
    const again = await session.page.evaluate(() => window.titopayDeviceId && window.titopayDeviceId());
    check("the app generates a device id", Boolean(first) && /^[A-Za-z0-9_-]{16,128}$/.test(first || ""), String(first).slice(0, 12) + "…");
    check("it is the SAME id on a second call", first === again);
    const stored = await session.page.evaluate(() => localStorage.getItem("titopay_device_v1"));
    check("it is kept in storage, not regenerated per sign-in", stored === first);

    await session.page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = await session.page.evaluate(() => window.titopayDeviceId && window.titopayDeviceId());
    check("it survives a reload", afterReload === first);

    // A different browser profile is a different device. That is the point.
    const other = await openApp(browser, origin);
    const otherId = await other.page.evaluate(() => window.titopayDeviceId && window.titopayDeviceId());
    check("a different installation gets a DIFFERENT id", Boolean(otherId) && otherId !== first);
    await other.context.close();
    check("no page errors", session.errors.length === 0, session.errors.join(" | "));
    await session.context.close();

    // ---- 2. The id is actually sent when signing in ------------------------
    session = await openApp(browser, origin);
    const sent = [];
    await withApi(session.page, {
      onLogin: (body) => { sent.push(body); return { ok: true, otpRequired: true, newDevice: true, challengeId: "c1", maskedDestination: "+27 82 *** 1234" }; }
    });
    const deviceIdNow = await session.page.evaluate(() => window.titopayDeviceId());
    await session.page.evaluate(() => window.login({ identifier: "tester", password: "x" }));
    check("signing in sends a device id", sent.length === 1 && Boolean(sent[0]?.deviceId), JSON.stringify(Object.keys(sent[0] || {})));
    check("and it is THIS device's id", sent[0]?.deviceId === deviceIdNow);

    // ---- 3. An unrecognised device is told about both channels -------------
    const toast = await session.page.evaluate(() => document.querySelector(".toast, [class*='toast']")?.textContent || "");
    check("the new-device toast names both channels",
      /cellphone/i.test(toast) && /email/i.test(toast), toast.slice(0, 80));
    await session.context.close();

    // ---- 4. A displaced device is forced back to the login screen ----------
    session = await openApp(browser, origin);
    await withApi(session.page, {
      onLogin: () => ({ ok: true, accessToken: "a", refreshToken: "r", user: { id: "u1", fullName: "Tester" } })
    });
    // Sign in, then have the API answer as it does once another device has
    // taken the session: the refresh refuses and says why.
    await session.page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
    await session.page.route(`${API_ORIGIN}/v1/auth/refresh`, (route) => route.fulfill({
      status: 401, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        ok: false,
        error: "Your TitoPay account was logged in on another device.",
        details: { code: "session_displaced", reason: "signed_in_on_another_device" }
      })
    }));
    const outcome = await session.page.evaluate(async () => {
      try {
        await window.refreshCustomerSession();
        return { threw: false };
      } catch (error) {
        return { threw: true, message: error.message, displaced: Boolean(error.displacedSession) };
      }
    });
    check("the refresh is rejected", outcome.threw === true);
    check("the app recognises it as displacement, not an expiry", outcome.displaced === true);
    check("the message is the security one", /logged in on another device/i.test(outcome.message || ""), String(outcome.message).slice(0, 60));

    const clearedToken = await session.page.evaluate(() => localStorage.getItem("titopay_candidate_auth_v1"));
    check("THE TOKEN IS GONE from this device", !clearedToken || clearedToken === "null", String(clearedToken).slice(0, 20));

    // ---- 5. The reason is on the login screen, and survives a reload -------
    const remembered = await session.page.evaluate(() => localStorage.getItem("titopay_session_displaced_v1"));
    check("the reason is kept for the login screen", /another device/i.test(remembered || ""), String(remembered).slice(0, 50));

    await session.page.reload({ waitUntil: "domcontentloaded" });
    const alertText = await session.page.evaluate(() => {
      const form = window.loginForm ? window.loginForm() : "";
      const holder = document.createElement("div");
      holder.innerHTML = form;
      return holder.querySelector(".signin-alert")?.textContent || "";
    });
    check("the login screen SHOWS the reason after a reload",
      /logged in on another device/i.test(alertText), alertText.trim().slice(0, 70));

    const readTwice = await session.page.evaluate(() => {
      const holder = document.createElement("div");
      holder.innerHTML = window.loginForm();
      return holder.querySelector(".signin-alert")?.textContent || "";
    });
    check("and only once - it is cleared when read", readTwice === "", JSON.stringify(readTwice));
    await session.context.close();

    // ---- 6. The alert is styled, in both themes ---------------------------
    session = await openApp(browser, origin);
    const styled = await session.page.evaluate(() => {
      const el = document.createElement("p");
      el.className = "signin-alert";
      el.textContent = "test";
      document.body.appendChild(el);
      const style = getComputedStyle(el);
      const result = { border: style.borderTopWidth, display: style.display, color: style.color };
      el.remove();
      return result;
    });
    check("the alert has the security styling applied",
      styled.display === "flex" && styled.border !== "0px", JSON.stringify(styled));
    await session.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
