// "NOTIFICATION INBOX CLEARED" — AND 19 ARE STILL THERE.
//
// Reported with a screenshot: the toast fires, and the list underneath it
// still shows "New TitoPay login" from four days ago, with the header counting
// 19 unread and Security (17).
//
// This is NOT the defect fixed earlier. That one was about notices DERIVED ON
// THE PHONE from /v1/transactions, and verification/notifications-stay-cleared
// .spec.js still covers it. These come from the other direction entirely:
// /v1/chat/notifications is a SERVER feed, and syncTitoPayChatNotifications()
// walks it and re-adds every row. The earlier harness stubbed the transaction
// list and never stubbed this feed, so a green run there was always consistent
// with this bug existing. That is a gap in the test, not a false pass.
//
// Reproduced against the SHIPPED BUNDLE with the API stubbed, because the
// question is what the app does with what the server sends - and the server
// keeps sending these, which is the whole point.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8177;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "7e5e0000-1111-4222-8333-444444444444",
  fullName: "Cleared Security Probe", username: "clearedsecurity",
  email: "clearedsecurity@titopay.local", phone: "+27820000777",
  accountType: "personal", account_type: "personal", status: "active"
};

// Four days old, exactly like the screenshot, so nothing can come back on a
// timestamp technicality: every one of these is comfortably older than a clear
// performed now.
const FOUR_DAYS_AGO = new Date(Date.now() - 4 * 86400000).toISOString();
const LOGIN_NOTICES = Array.from({ length: 17 }, (_, index) => ({
  id: `srv-login-${index + 1}`,
  notification_type: "login_notification",
  title: "New TitoPay login",
  body: "A login to your TitoPay account was recorded from your iPhone. If this was not you, lock your profile and contact TitoPay support.",
  status: "unread",
  created_at: FOUR_DAYS_AGO,
  metadata: { clientNotificationId: `login-${index + 1}`, category: "security" }
}));

// THE SERVER KEEPS SERVING THEM. That is the condition under test: clearing is
// a thing the phone does, and it has to survive a feed that has not changed
// its mind. `markedRead` records whether the app asked the server to change
// that - a clear that only hides them locally is a clear that comes back on a
// new device.
let markedRead = [];

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

async function stubApi(context) {
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/chat/notifications/read" && request.method() === "POST") {
      let body = null;
      try { body = JSON.parse(request.postData() || "{}"); } catch { body = {}; }
      markedRead.push(body);
      return json({ updated: 0 });
    }
    if (p === "/chat/notifications") return json({ notifications: LOGIN_NOTICES });
    if (p === "/health") return json({ status: "ok" });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/transactions") return json({ items: [] });
    if (p === "/beneficiaries") return json({ items: [], summary: null });
    return json({ items: [] });
  });
}

// What the customer is actually looking at: the notices stored on the phone,
// counted the way the screen counts them.
async function storedNotices(page) {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("titopay_in_app_notifications_v1"));
    const all = keys.flatMap((key) => {
      try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
    });
    return {
      logins: all.filter((item) => /login/i.test(item.title || "")).length,
      total: all.length,
      keys: keys.length
    };
  });
}

async function onScreen(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".modal-backdrop .modal-card");
    const text = card ? (card.innerText || "") : "";
    return {
      loginRows: (text.match(/New TitoPay login/g) || []).length,
      unreadLine: (text.match(/(\d+)\s+unread/) || [])[0] || "(no unread line)"
    };
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubApi(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);

  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  const booted = await page.evaluate(() => Boolean(document.querySelector("[data-app-topbar]")));
  ok("the app booted signed in", booted);
  if (!booted) { await browser.close(); server.close(); process.exit(1); }
  await page.waitForTimeout(2500);

  // The harness must be able to SEE the inbox fill from the server feed, or a
  // clean result after clearing proves only that it was empty all along.
  const before = await storedNotices(page);
  console.log(`  login notices from the server feed: ${before.logins}`);
  ok("the server feed fills the inbox", before.logins === LOGIN_NOTICES.length,
    `${before.logins} of ${LOGIN_NOTICES.length}`);

  await page.click('[data-action="notifications"]', { timeout: 15000 });
  await page.waitForSelector(".modal-card", { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${ARTIFACTS}/security-notices-before-clear.png` });

  await page.click('[data-action="clear-notifications"]', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // THE SCREENSHOT'S EXACT COMPLAINT: the toast says cleared, and they are
  // still on the screen.
  const justAfter = await onScreen(page);
  const storedAfter = await storedNotices(page);
  await page.screenshot({ path: `${ARTIFACTS}/security-notices-after-clear.png` });
  console.log(`  on screen straight after clearing: ${justAfter.loginRows} rows, "${justAfter.unreadLine}"`);
  ok("CLEARING EMPTIES THE INBOX THERE AND THEN", storedAfter.logins === 0,
    `${storedAfter.logins} still stored`);
  ok("and nothing is left on the screen", justAfter.loginRows === 0,
    `${justAfter.loginRows} rows still drawn`);

  // The server has not changed its mind; the app must still not re-add them.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);
  const afterReload = await storedNotices(page);
  console.log(`  after a reload, with the feed unchanged: ${afterReload.logins}`);
  ok("A CLEARED INBOX STAYS CLEARED ACROSS A RELOAD", afterReload.logins === 0,
    `${afterReload.logins} came back`);

  // And the other half of "cleared": a clear that only hides them on this
  // phone is not a clear, because the next device downloads them again.
  //
  // AN ASSERTION I GOT WRONG FIRST TIME. This originally demanded a non-empty
  // ids array and failed on {"ids":[]} - but an empty list is the documented
  // protocol for "clear everything": chat.routes.js reads it and stamps
  // notification_clears, and the feed then refuses to serve anything older.
  // Sending individual ids would in fact be the weaker call. What matters is
  // that the call was MADE, so the clear outlives this browser's storage.
  console.log(`  clear-all sent to the server: ${JSON.stringify(markedRead)}`);
  ok("the app asked the server to clear everything, not just this phone",
    markedRead.some((body) => body && Array.isArray(body.ids) && body.ids.length === 0),
    markedRead.length ? JSON.stringify(markedRead[0]) : "(no call made)");

  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();

  /* ------------------------------------------------------------------------
     WHEN THE SERVER HALF FAILS, THE CUSTOMER IS TOLD.

     The clear used to be `.catch(() => null)` followed by an unconditional
     "Notification inbox cleared." So a failed call - offline, an expired
     session, a 500 - still reported success, and the customer only found out
     it had not worked when everything came back on another device. The local
     clear still happens; the message now says which of the two halves did.
  ------------------------------------------------------------------------ */
  const failing = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await failing.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/chat/notifications/read") {
      return route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "server unavailable" }) });
    }
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/chat/notifications") return json({ notifications: LOGIN_NOTICES });
    if (p === "/transactions") return json({ items: [] });
    return json({ items: [] });
  });
  const failPage = await failing.newPage();
  await failPage.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await failPage.goto(ORIGIN, { waitUntil: "load" });
  await failPage.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await failPage.waitForTimeout(2500);
  await failPage.click('[data-action="notifications"]', { timeout: 15000 });
  await failPage.waitForSelector(".modal-card", { timeout: 15000 });
  await failPage.click('[data-action="clear-notifications"]', { timeout: 10000 });
  await failPage.waitForTimeout(2000);
  const toast = await failPage.evaluate(() =>
    [...document.querySelectorAll(".toast, [data-toast], .toast-message")]
      .map((el) => el.innerText || "").join(" | ").trim());
  console.log(`  toast when the server refuses: "${toast.slice(0, 120)}"`);
  ok("A FAILED SERVER CLEAR IS NOT REPORTED AS SUCCESS",
    !/^Notification inbox cleared\.?$/i.test(toast.trim()), toast.slice(0, 80));
  ok("and the customer is told it may come back", /may come back|could not be reached/i.test(toast));
  // The local half still happened, because it is done before the call.
  const localAfter = await storedNotices(failPage);
  ok("the inbox is still emptied on this phone", localAfter.logins === 0, `${localAfter.logins} left`);
  await failing.close();

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
