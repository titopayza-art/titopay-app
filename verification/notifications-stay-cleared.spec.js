// A CLEARED INBOX MUST STAY CLEARED.
//
// The complaint: notifications a customer cleared came back. Screenshot showed
// payment notices dated a month earlier sitting in a Notification Centre that
// had been emptied.
//
// This drives the REAL SHIPPED BUNDLE - app.min.js, not the source - with the
// API stubbed, because the question is not what the server sends. The
// notification inbox is built ENTIRELY on the phone: syncTransactionNotifications()
// walks /v1/transactions on every load and re-derives a notification per row.
// So "clearing" has to survive a re-derivation that happens seconds later, and
// whether it does is a question about localStorage and nothing else.
//
// The sequence is the customer's: sign in, see the notices, press Clear inbox,
// reload the app, look again.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8155;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "11111111-2222-4333-8444-555555555555",
  fullName: "Cleared Inbox Probe", username: "clearedprobe",
  email: "cleared@titopay.local", phone: "+27820000001",
  accountType: "personal", account_type: "personal", status: "active",
};

// Dated a month back, exactly like the ones in the screenshot: comfortably
// older than any clear, so nothing can come back on a timestamp technicality.
const OLD = "2026-08-10T11:06:00.000Z";
const TRANSACTIONS = [
  { id: "tx-1", reference: "TX-1786360007091-8GQ7LN", service_code: "send_money",
    service_name: "Send Money", amount: "1500.00", direction: "debit", status: "completed",
    created_at: OLD, metadata: { recipientContact: "+27762642251" } },
  { id: "tx-2", reference: "TX-1786359945206-A6LWUN", service_code: "wallet_transfer",
    service_name: "Wallet Transfer", amount: "2000.00", direction: "debit", status: "completed",
    created_at: OLD, metadata: { recipientUsername: "titopay" } },
  { id: "tx-3", reference: "TP-TOPUP-MSMWLCA7-35CF8678", service_code: "wallet_topup",
    service_name: "Wallet Top Up", amount: "150.00", direction: "credit", status: "completed",
    created_at: OLD, metadata: {} },
];

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
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ": " + detail : ""}`);
};

// The app talks to a hardcoded API_BASE, so the stub goes in at the network
// layer rather than by patching the bundle. That keeps the code under test
// byte-identical to what ships.
const HITS = [];
async function stubApi(context) {
  await context.route("https://api.titopay.co.za/**", async (route) => {
    HITS.push(new URL(route.request().url()).pathname);
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/health") return json({ status: "ok" });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/transactions") return json({ items: TRANSACTIONS });
    if (p === "/beneficiaries") return json({ items: [], summary: null });
    return json({ items: [] });
  });
}

async function openInbox(page) {
  await page.click('[data-action="notifications"]', { timeout: 15000 });
  await page.waitForSelector(".modal-card", { timeout: 15000 });
  await page.waitForTimeout(400);
}

// Counts the payment notices specifically. The inbox also carries a standing
// welcome notice, and counting everything would let a real regression hide
// behind it.
async function paymentNotices(page) {
  return page.evaluate(() => {
    const stored = Object.keys(localStorage)
      .filter((key) => key.startsWith("titopay_in_app_notifications_v1"))
      .flatMap((key) => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } });
    return stored.filter((item) => String(item.id || "").startsWith("tx-")).map((item) => item.title);
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
  if (process.env.DEBUG_BOOT) {
    page.on("console", (m) => console.log(`    [console.${m.type()}] ${m.text().slice(0, 160)}`));
    page.on("requestfailed", (r) => console.log(`    [failed] ${r.url().slice(0, 110)} ${r.failure()?.errorText || ""}`));
  }

  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user,
    }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);

  await page.goto(ORIGIN, { waitUntil: "load" });
  // Waited for, not slept on. boot() has no final render() after loadAccount:
  // the only repaint is inside a promise that races it, so on a fast link the
  // shell can settle on the landing screen for a beat before the account
  // poller repaints it. Real, but a separate matter from this test.
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);

  const booted = await page.evaluate(() => Boolean(document.querySelector("[data-app-topbar]")));
  if (!booted && process.env.DEBUG_BOOT) {
    console.log("    body starts:", await page.evaluate(() => document.body.innerText.slice(0, 220).replace(/\s+/g, " ")));
    console.log("    state.user:", await page.evaluate(() => { try { return JSON.stringify(window.state && window.state.user); } catch { return "no window.state"; } }));
    console.log("    auth in store:", await page.evaluate(() => localStorage.getItem("titopay_candidate_auth_v1") ? "present" : "ABSENT"));
    console.log("    last-active in store:", await page.evaluate(() => localStorage.getItem("titopay_last_active_v1") || "ABSENT"));
    console.log("    API calls the app made:", HITS.slice(0, 14).join(", ") || "(none)");
    console.log("    localStorage keys:", await page.evaluate(() => Object.keys(localStorage).join(" | ")));
  }
  ok("the app booted signed in", booted, booted ? "" : "no app topbar; the session stub did not take");
  if (!booted) { await browser.close(); server.close(); process.exit(1); }

  await openInbox(page);
  const before = await paymentNotices(page);
  console.log(`  notices before clearing: ${before.length} -> ${before.join(", ") || "(none)"}`);
  // The harness has to be able to SEE the inbox fill, or a clean result after
  // clearing proves only that it was empty all along.
  ok("the inbox derives a notice per transaction", before.length === TRANSACTIONS.length,
    `${before.length} of ${TRANSACTIONS.length}`);

  await page.click('[data-action="clear-notifications"]', { timeout: 10000 });
  await page.waitForTimeout(700);
  const justAfter = await paymentNotices(page);
  ok("Clear inbox empties it there and then", justAfter.length === 0, `${justAfter.length} left`);
  await page.screenshot({ path: `${ARTIFACTS}/notifications-cleared.png` });

  // THE ACTUAL QUESTION. Reload, which re-runs loadAccount() and with it
  // syncTransactionNotifications() over the same three transactions.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  const afterReload = await paymentNotices(page);
  console.log(`  notices after reload:    ${afterReload.length} -> ${afterReload.join(", ") || "(none)"}`);
  ok("A CLEARED INBOX STAYS CLEARED ACROSS A RELOAD",
    afterReload.length === 0, `${afterReload.length} came back`);

  // And once more, because a defect that needs two reloads is still a defect.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  const afterSecond = await paymentNotices(page);
  ok("and across a second reload", afterSecond.length === 0, `${afterSecond.length} came back`);

  await openInbox(page);
  await page.screenshot({ path: `${ARTIFACTS}/notifications-after-reload.png` });

  // NOW THE THING THAT ACTUALLY BREAKS IT.
  //
  // Both notification keys embed state.accountType:
  //   titopay_in_app_notifications_v1:<accountType>:<identity>
  //   titopay_notices_cleared_v1:<accountType>:<identity>
  // and accountType is not fixed to the account. The landing screen carries a
  // Personal / Business toggle, and switchLandingAccount() writes straight to
  // state.accountType. Flip it and the app looks for the cleared marker under a
  // key nobody ever wrote, finds nothing, and re-derives every notification
  // from the same transaction list.
  //
  // Simulated the way the app would produce it: the marker moves to the other
  // account type's key, which is precisely what a flip makes the reader do.
  const flipped = await page.evaluate(() => {
    const clearedKey = Object.keys(localStorage).find((k) => k.startsWith("titopay_notices_cleared_v1"));
    const storeKey = Object.keys(localStorage).find((k) => k.startsWith("titopay_in_app_notifications_v1"));
    if (!clearedKey || !storeKey) return { ok: false, clearedKey, storeKey };
    const swap = (key) => key.includes(":personal:")
      ? key.replace(":personal:", ":business:") : key.replace(":business:", ":personal:");
    for (const key of [clearedKey, storeKey]) {
      const value = localStorage.getItem(key);
      localStorage.removeItem(key);
      localStorage.setItem(swap(key), value);
    }
    return { ok: true, clearedKey, became: swap(clearedKey) };
  });
  ok("the simulation moved the real keys", flipped.ok === true, JSON.stringify(flipped));
  console.log(`  cleared marker now lives at: ${flipped.became}`);

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(2500);
  const afterFlip = await paymentNotices(page);
  console.log(`  notices after the account-type flip: ${afterFlip.length} -> ${afterFlip.join(", ") || "(none)"}`);
  ok("A CLEARED INBOX SURVIVES AN ACCOUNT-TYPE FLIP",
    afterFlip.length === 0, `${afterFlip.length} came back from the dead`);

  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
