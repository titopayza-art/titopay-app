// Two things a customer should never have to see twice.
//
//  1. The support rating card kept its stars after being pressed, so the same
//     conversation could be rated again and again and the card implied it had
//     never been answered. It is also re-rendered from the conversation's
//     status on every four-second poll, so removing it alone would not hold.
//
//  2. Every sign-in raised a "login_notification", which matched none of the
//     words the category rule looked for, so it was filed as "account" and the
//     Security filter in the inbox stayed empty — while the alerts a customer
//     most needs to check were the ones missing from it.
const { chromium } = require("playwright");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";

const stamp = Date.now();
const USER = {
  fullName: "Rating Alerts",
  email: `rate${stamp}@titopay.local`,
  phone: `+2780${String(stamp).slice(-7)}`,
  password: "RatingAlerts!2026#x",
  accountType: "personal"
};

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection to .wss:\/\/api\.titopay\.co\.za/;

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — a rated conversation stops asking, sign-ins are security");
  console.log("=============================================================\n");

  const reg = await fetch(`${API}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(USER) }).then((r) => r.json());
  const auth = reg.accessToken ? reg : await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: USER.email, password: USER.password }) }).then((r) => r.json());
  check("customer signed in", Boolean(auth.accessToken));
  const admin = await fetch(`${API}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" })
  }).then((r) => r.json());

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [auth.accessToken, auth.refreshToken]);
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      route.fulfill({ status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body: await upstream.text() });
    } catch (e) { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.accept("").catch(() => {}));   // the optional-feedback prompt
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  /* ---- 1. how the category rule files each kind of alert ------------------ */
  console.log("--- where each alert is filed ---\n");
  const filed = await page.evaluate(() => {
    const cases = [
      ["login_notification", "someone signed in", "security"],
      ["new_device_login", "a new device signed in", "security"],
      ["otp", "a one-time code", "security"],
      ["wallet_unlock", "the wallet was unlocked", "security"],
      ["support_message", "Customer Care replied", "messages"],
      ["support_resolved", "the conversation was resolved", "messages"],
      ["account_welcome", "welcome to TitoPay", "account"]
    ];
    return cases.map(([type, what, expected]) => ({
      type, what, expected, got: notificationCategory({ metadata: { notificationType: type } })
    }));
  });
  filed.forEach((f) => check(`${f.what} ("${f.type}") files under ${f.expected}`, f.got === f.expected, `filed as ${f.got}`));

  const noPinTrap = await page.evaluate(() => notificationCategory({ metadata: { notificationType: "shopping_receipt" } }));
  check('a word merely containing "pin" is not mistaken for a PIN alert', noPinTrap !== "security", `filed as ${noPinTrap}`);

  /* ---- 2. the Security filter actually has the sign-in in it -------------- */
  const inbox = await page.evaluate(() => {
    const notice = { id: `probe-login-${Date.now()}`, title: "New sign-in", body: "Signed in on Chrome.", metadata: { notificationType: "login_notification" } };
    addInAppNotification(notice);
    const all = (state.notifications || []).map((n) => notificationCategory(n));
    return { security: all.filter((c) => c === "security").length, total: all.length };
  });
  check("the Security filter is no longer empty", inbox.security > 0, `${inbox.security} of ${inbox.total} notifications are security`);

  /* ---- 3. rating a conversation once ------------------------------------- */
  console.log("\n--- rating a finished conversation ---\n");
  await page.evaluate(() => handleAction("chatbot"));
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).find((c) => c.textContent.trim() === "Talk to a human");
    chip?.click();
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector('[data-support-escalation="live_chat"]')?.click());
  await page.waitForTimeout(2500);

  const conversationId = await page.evaluate(() => sessionStorage.getItem("titopay_support_conversation_id"));
  const agent = async (action) => (await fetch(`${API}/admin/support/conversations/${conversationId}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` }, body: "{}"
  })).status;
  await agent("takeover"); await agent("resolve"); await agent("close");
  await page.waitForTimeout(6000);

  const before = await page.evaluate(() => ({
    card: Boolean(document.querySelector(".support-rating")),
    stars: document.querySelectorAll("[data-support-rating]").length
  }));
  check("a finished conversation asks for a rating", before.card && before.stars === 5, `${before.stars} stars`);

  await page.evaluate(() => document.querySelector('[data-support-rating="5"]')?.click());
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => ({
    stars: document.querySelectorAll("[data-support-rating]").length,
    text: (document.querySelector(".support-rating")?.innerText || "").replace(/\s+/g, " ").trim()
  }));
  check("the stars go once it has been rated", after.stars === 0, `${after.stars} stars still on screen`);
  check("and it says so instead", /thanks for the feedback/i.test(after.text), after.text.slice(0, 80));

  // The card is re-rendered from the conversation status on every poll, so the
  // real test is whether it stays answered across several of them.
  console.log("\n  holding through 3 poll cycles...\n");
  await page.waitForTimeout(13000);
  const later = await page.evaluate(() => ({
    stars: document.querySelectorAll("[data-support-rating]").length,
    text: (document.querySelector(".support-rating")?.innerText || "").replace(/\s+/g, " ").trim()
  }));
  check("it does not ask again after the next polls", later.stars === 0, `${later.stars} stars came back`);
  check("the acknowledgement is still there", /thanks for the feedback/i.test(later.text), later.text.slice(0, 80));

  // And it must not come back on a fresh open of the chat either.
  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
  await page.waitForTimeout(600);
  await page.evaluate(() => handleAction("chatbot"));
  await page.waitForTimeout(6000);
  const reopened = await page.evaluate(() => document.querySelectorAll("[data-support-rating]").length);
  check("reopening the chat does not ask for the rating again", reopened === 0, `${reopened} stars`);

  await page.screenshot({ path: `${ARTIFACTS}/pwa-rating-done.png` });
  check("no script errors", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
