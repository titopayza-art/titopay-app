// The live site as a phone app (A1-A9): home-screen install, the offline app
// shell, bottom tab bars, tap targets, the full-screen gate scanner, layout
// shift, the install offer, pull to refresh, loading placeholders and motion.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/app.js <dir> [port]
//
// TR_ONLY=A5 runs only the tests whose name starts with that. Chromium gets a
// fake camera (--use-fake-device-for-media-stream) and the page a stand-in
// BarcodeDetector, so the camera scan path runs end to end.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { Client, outbox, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: app.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const BUILD = fs.readFileSync(path.join(DIR, "public_html", "version.txt"), "utf8").match(/build (\S+)/)[1];
const SHOTS = path.join(DIR, "app-shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).slice(0, 1600)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const stamp = Date.now().toString(36);
const PHONE = { width: 390, height: 844 }, DESK = { width: 1366, height: 900 };

async function signUp(name, email, password) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: name, email, password, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return c;
}
async function signedIn(email, password, portal) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/login", { email, password, portal });
  await c.refreshCsrf();
  return c;
}
async function book(c, slug, quantity) {
  const ev = await c.call("GET", `/api/public/events/${slug}`);
  const tt = (ev.ticketTypes || ev.event?.ticketTypes || ev.ticket_types || [])[0];
  await c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: tt.id, quantity }], idempotencyKey: crypto.randomUUID() });
  return (await c.call("GET", "/api/me/tickets")).tickets;
}

// ---------------------------------------------------------------- browser
let browser;
async function newCtx(size, client, opts = {}) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, hasTouch: size.width < 600, isMobile: size.width < 600, ...opts });
  await ctx.addInitScript((freeId) => {
    try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {}
    // The gate opens straight on the free event for someone who works only there.
    try { if (!localStorage.getItem("tr_scan_event")) localStorage.setItem("tr_scan_event", freeId); } catch {}
    // Layout shifts from the first paint on.
    window.__cls = 0;
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
  }, SEED.events.free.id);
  if (client) await ctx.addCookies(Object.entries(client.cookies).map(([name, value]) => ({ name, value, url: BASE })));
  ctx.problems = [];
  return ctx;
}
async function openPage(ctx) {
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) ctx.problems.push(`console: ${m.text().slice(0, 200)}`); });
  p.on("pageerror", (e) => ctx.problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return p;
}
async function settle(p, extra = 400) {
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await p.waitForFunction(() => !document.documentElement.classList.contains("booting") && !document.querySelector("#main .spinner"), null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(extra);
}
async function onPage(size, client, url, fn, opts) {
  const ctx = await newCtx(size, client, opts); const p = await openPage(ctx);
  try { await p.goto(BASE + url, { waitUntil: "domcontentloaded" }); await settle(p); return await fn(p, ctx); }
  finally { await ctx.close(); }
}
const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, display: st.display, position: st.position }; }, sel);
// Controls under 44 px tall (the size a thumb needs), among the ones that are visible.
const smallTargets = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })
  .filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => `${Math.round(e.getBoundingClientRect().height)}px "${(e.innerText || e.value || e.getAttribute("aria-label") || e.placeholder || "").trim().slice(0, 30)}"`), sel);
// A finger dragging down the screen (Chrome DevTools touch events).
async function pullDown(p, from = 200, to = 520) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: from }] });
  for (let y = from + 40; y <= to; y += 40) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
// The camera: a stand-in BarcodeDetector reads whatever the test puts in window.__qr; vibrations are recorded.
const CAMERA_STUB = () => {
  window.BarcodeDetector = class { async detect() { const v = window.__qr; if (v) { window.__qr = null; return [{ rawValue: v }]; } return []; } };
  window.__vib = [];
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern) => { window.__vib.push(pattern); return true; } });
};

(async () => {
  browser = await chromium.launch({ executablePath: CHROME, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const free = SEED.events.free;
  // A customer with two tickets (to swipe between), a friend who sends them a
  // third (a transfer waiting), door staff who only scan, the organiser and the admin.
  const pw = `App-${stamp}-pass-2026`;
  const custEmail = `naledi-${stamp}@example.test`;
  const cust = await signUp("Naledi App", custEmail, pw);
  const mine = (await book(cust, free.slug, 2)).filter((t) => t.status === "valid");
  sql(DATA, "UPDATE events SET transfers_enabled = 1 WHERE id = ?", [free.id]);
  const friend = await signUp("Kagiso Friend", `kagiso-${stamp}@example.test`, pw);
  const gift = (await book(friend, free.slug, 1))[0];
  await friend.call("POST", `/api/me/tickets/${gift.id}/transfer`, { toEmail: custEmail });
  const org = await signedIn(SEED.organiser.email, SEED.organiser.password, "organiser");
  const doorEmail = `lindiwe-${stamp}@example.test`;
  const door = await signUp("Lindiwe Gate", doorEmail, pw);
  await org.call("POST", `/api/organiser/${SEED.organiser.orgId}/events/${free.id}/staff`, { email: doorEmail, canScan: true, canManageTags: false, canSellTickets: false }, 201);
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);

  await test("A1 the manifest makes TicketRoom installable (name, colours, maskable icons, shortcuts) and every page links it with the iOS tags", async () => {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    assert(res.ok && /manifest\+json/.test(res.headers.get("content-type")), `manifest ${res.status} ${res.headers.get("content-type")}`);
    const m = await res.json();
    assert(m.name === "TicketRoom" && m.short_name === "TicketRoom" && m.start_url === "/" && m.display === "standalone" && m.scope === "/", JSON.stringify(m));
    assert(/^#0B1D3F$/i.test(m.theme_color) && /^#0B1D3F$/i.test(m.background_color), "brand navy theme and background");
    for (const [size, purpose] of [[192, "maskable"], [512, "maskable"], [192, "any"], [512, "any"]]) {
      const ic = m.icons.find((i) => i.sizes === `${size}x${size}` && i.purpose === purpose && i.type === "image/png");
      assert(ic, `no ${purpose} ${size} icon`);
      const png = Buffer.from(await (await fetch(BASE + ic.src)).arrayBuffer());
      assert(png.slice(1, 4).toString() === "PNG" && png.readUInt32BE(16) === size && png.readUInt32BE(20) === size, `${ic.src} is not a ${size}px PNG`);
    }
    const sc = Object.fromEntries((m.shortcuts || []).map((s) => [s.short_name, s.url]));
    // The gate scanner is only for event teams, so it is not an app shortcut for everyone.
    assert(sc["My tickets"] === "/account#/tickets" && !Object.values(sc).includes("/scan"), `shortcuts ${JSON.stringify(sc)}`);
    for (const page of ["/", "/account", "/scan", "/organisers", "/admin", "/pos", `/events/${free.slug}`]) {
      const h = await (await fetch(BASE + page)).text();
      for (const want of ['rel="manifest"', 'rel="apple-touch-icon" href="/assets/app/apple-touch-icon.png"', 'name="apple-mobile-web-app-capable" content="yes"', 'name="apple-mobile-web-app-status-bar-style"', "viewport-fit=cover"]) assert(h.includes(want), `${page} lacks ${want}`);
    }
    assert((await fetch(`${BASE}/assets/app/apple-touch-icon.png`)).ok, "apple-touch-icon");
  });

  await test("A2 the service worker caches the shell for this build; My tickets (with QR) and the scanner open with no signal", async () => {
    // Customer: online once (the wallet is saved), then offline.
    {
      const ctx = await newCtx(PHONE, cust); const p = await openPage(ctx);
      await p.goto(`${BASE}/account#/tickets`); await settle(p);
      await p.evaluate(() => navigator.serviceWorker.ready);
      await p.waitForFunction(() => (JSON.parse(localStorage.getItem("tr_wallet_v1") || "null")?.tickets || []).some((t) => t.qrData), null, { timeout: 10000 });
      const c = await p.evaluate(async () => { const keys = await caches.keys(); const k = keys.find((x) => x.startsWith("ticketroom-shell-")); const cache = await caches.open(k); return { keys, paths: (await cache.keys()).map((r) => new URL(r.url).pathname) }; });
      assert(c.keys.includes(`ticketroom-shell-${BUILD}`), `cache per build: ${c.keys}`);
      for (const want of ["/account", "/scan", "/assets/tr.css", "/assets/core.js", "/assets/account.js", "/assets/scan.js", "/assets/cashdesk.js", "/assets/boxoffice.js", "/assets/scan-offline.js", "/assets/jsQR.min.js", "/manifest.webmanifest", "/assets/app/icon-192.png"]) assert(c.paths.includes(want), `shell cache lacks ${want}`);
      await ctx.setOffline(true);
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.locator(".ticket .t-qr img").first().waitFor({ timeout: 15000 });
      const src = await p.locator(".ticket .t-qr img").first().getAttribute("src");
      assert(/^data:image\/svg\+xml/.test(src), `offline QR from the saved wallet: ${src.slice(0, 40)}`);
      assert(/offline/i.test(await p.locator("main").innerText()), "says it is offline");
      await ctx.close();
    }
    // Event team: the gate once online, then reopened with no signal.
    {
      const ctx = await newCtx(PHONE, door); const p = await openPage(ctx);
      await p.goto(`${BASE}/scan`); await settle(p);
      await p.evaluate(() => navigator.serviceWorker.ready);
      await p.locator("#offline-state").filter({ hasText: "Offline ready" }).waitFor({ timeout: 15000 });
      await p.waitForTimeout(2500); // the list is saved on the phone a moment after it arrives
      await ctx.setOffline(true);
      await p.goto(`${BASE}/scan`, { waitUntil: "domcontentloaded" });
      await p.locator("[data-cam]").waitFor({ timeout: 15000 }).catch(async (e) => { throw new Error(`offline gate: ${(await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)} ${ctx.problems.join(" | ")}`); });
      await p.fill("#mc", mine[1].code); await p.press("#mc", "Enter");
      await p.waitForFunction(() => /ADMIT/.test(document.querySelector("#verdict")?.innerText || ""), null, { timeout: 10000 });
      assert(/OFFLINE/.test(await p.locator("#verdict").innerText()), "checked against the phone's list");
      await ctx.close();
    }
  });

  await test("A3 phones get bottom tab bars (customer, organiser, admin) with icons, the current tab, a transfer badge and More as a sheet; computers keep the side menu", async () => {
    await onPage(PHONE, cust, "/account#/tickets", async (p) => {
      const tabs = await p.$$eval(".tabbar a, .tabbar .tab-more", (els) => els.map((e) => ({ label: e.querySelector(".tab-label")?.textContent, current: e.getAttribute("aria-current"), icon: getComputedStyle(e.querySelector(".tab-ico, svg")).getPropertyValue("--ico") || e.querySelector("svg") ? "yes" : "", badge: e.querySelector(".tab-badge")?.textContent || "" })));
      assert(JSON.stringify(tabs.map((t) => t.label)) === JSON.stringify(["My tickets", "Orders", "Transfers", "Account"]), `customer tabs ${JSON.stringify(tabs)}`);
      assert(tabs[0].current === "page" && tabs.every((t) => t.icon), `current tab and icons ${JSON.stringify(tabs)}`);
      assert(tabs[2].badge === "1", `pending transfer badge: ${JSON.stringify(tabs[2])}`);
      const bar = await box(p, ".tabbar"), strip = await box(p, ".shell .side");
      assert(bar.position === "fixed" && Math.abs(bar.bottom - 844) < 1, `bar at the bottom ${JSON.stringify(bar)}`);
      assert(!strip || strip.display === "none" || strip.h === 0, "the top strip is gone on a phone");
      const ico = await p.$eval('.tabbar a[href="#/tickets"]', (a) => a.style.getPropertyValue("--ico"));
      assert(/svg/.test(ico), "My tickets uses the menu's ticket icon");
      await p.locator(".tabbar .tab-more").click();
      await p.locator("dialog.sheet[open] .sheet-nav a").first().waitFor();
      const links = await p.$$eval("dialog.sheet[open] .sheet-nav a", (as) => as.map((a) => a.getAttribute("href")));
      for (const want of ["#/waitlists", "#/resale", "#/saved", "#/refunds", "#/settings"]) assert(links.includes(want), `Account sheet lacks ${want}: ${links}`);
      await p.waitForTimeout(400); const sheet = await box(p, "dialog.sheet[open]");
      assert(Math.abs(sheet.bottom - 844) < 2 && sheet.w >= 389, `sheet sits at the bottom ${JSON.stringify(sheet)}`);
      await p.locator('dialog.sheet[open] .sheet-nav a[href="#/settings"]').click();
      await p.waitForFunction(() => location.hash === "#/settings" && !document.querySelector("dialog[open]"));
      await p.locator('.tabbar a[href="#/orders"]').click();
      await p.waitForFunction(() => document.querySelector('.tabbar a[href="#/orders"]')?.getAttribute("aria-current") === "page");
    });
    await onPage(PHONE, org, "/organisers#/", async (p) => {
      const labels = await p.$$eval(".tabbar .tab-label", (els) => els.map((e) => e.textContent));
      assert(labels.length === 5 && labels[0] === "Dashboard" && labels[1] === "Events" && labels[4] === "More", `organiser tabs ${labels}`);
      await p.locator(".tabbar .tab-more").click();
      const n = await p.locator("dialog.sheet[open] .sheet-nav a").count();
      assert(n >= 8, `More shows the full menu (${n})`);
    });
    await onPage(PHONE, admin, "/admin#/", async (p) => {
      const labels = await p.$$eval(".tabbar .tab-label", (els) => els.map((e) => e.textContent));
      assert(labels.length === 5 && labels[0] === "Overview" && labels[4] === "More", `admin tabs ${labels}`);
      await p.locator(".tabbar .tab-more").click();
      assert(await p.locator('dialog.sheet[open] .sheet-nav a[href="#/audit"]').count() === 1, "admin More has the whole menu");
    });
    for (const [c, url] of [[cust, "/account#/tickets"], [org, "/organisers#/"], [admin, "/admin#/"]]) {
      await onPage(DESK, c, url, async (p) => {
        const bar = await box(p, ".tabbar"), side = await box(p, ".side");
        assert(!bar || bar.display === "none", `${url}: no tab bar on a computer`);
        assert(side && side.display !== "none" && side.w > 200, `${url}: side menu on a computer ${JSON.stringify(side)}`);
      });
    }
  });

  await test("A4 tap targets on a phone are at least 44 px (tab bars, the menu sheet, ticket buttons, the scanner)", async () => {
    await onPage(PHONE, cust, "/account#/tickets", async (p) => {
      let small = await smallTargets(p, ".tabbar a, .tabbar button, main .btn, main button, main input");
      assert(!small.length, `customer: ${small.join("; ")}`);
      await p.locator(".tabbar .tab-more").click();
      small = await smallTargets(p, "dialog[open] a, dialog[open] button");
      assert(!small.length, `sheet: ${small.join("; ")}`);
    });
    await onPage(PHONE, door, "/scan", async (p) => {
      await p.locator("[data-cam]").waitFor();
      const small = await smallTargets(p, "main button, main input, main .btn");
      assert(!small.length, `scanner: ${small.join("; ")}`);
    });
  });

  await test("A5 the scanner is a full-screen tool: slim header, sticky counts, Scan opens the camera, the result flashes and returns to the camera", async () => {
    const ctx = await newCtx(PHONE, door, { permissions: ["camera"] });
    await ctx.addInitScript(CAMERA_STUB);
    const p = await openPage(ctx);
    try {
      await p.goto(`${BASE}/scan`); await settle(p);
      await p.locator("[data-cam]").waitFor();
      // One tool only: no tabs. The big header is replaced by the slim bar.
      assert(await p.locator('[role="tablist"]').count() === 0, "tabs shown with only one tool");
      const header = await box(p, ".site-header"), top = await box(p, ".scan-top");
      assert(!header || header.display === "none" || header.h === 0, "big header hidden on the gate");
      assert(top.h <= 70 && /Sunset|Sessions/.test(await p.locator(".scan-title").innerText()) && await p.locator(".scan-top [data-change]").isVisible(), `slim header ${JSON.stringify(top)}`);
      assert(/Type a code/.test(await p.locator("#manual").innerText()), "typed codes tucked into a row");
      await p.locator("#stats").filter({ hasText: /scanned in/ }).waitFor();
      const before = await p.locator("#stats").innerText();
      const n0 = Number(before.match(/^(\d+)/)[1]);
      // Counts stay in view while scrolling.
      await p.evaluate(() => window.scrollTo(0, 400)); await p.waitForTimeout(150);
      const counts = await box(p, ".scan-counts");
      assert(counts.top >= 0 && counts.top <= 80, `counts sticky under the header ${JSON.stringify(counts)}`);
      await p.evaluate(() => window.scrollTo(0, 0));
      // Scan: the camera over the whole screen with a framing guide.
      await p.locator("[data-cam]").click();
      await p.locator("#scan-cam video").waitFor({ timeout: 10000 });
      await p.waitForFunction(() => document.querySelector("#scan-cam video")?.readyState >= 2, null, { timeout: 10000 });
      const cam = await box(p, "#scan-cam");
      assert(cam.position === "fixed" && cam.top <= 0 && cam.h >= 843 && cam.w >= 389, `camera full screen ${JSON.stringify(cam)}`);
      assert(await p.locator("#scan-cam .frame").isVisible(), "framing guide");
      // A ticket in front of the camera: ADMIT fills the screen with holder and type, then the camera is back.
      await p.evaluate((code) => { window.__qr = code; }, mine[0].code);
      await p.locator("#scan-flash.ok:not([hidden])").waitFor({ timeout: 8000 });
      const shown = await p.locator("#scan-flash").innerText();
      assert(/ADMIT/.test(shown) && /Naledi App/.test(shown) && /\S/.test(shown.split("·").pop()), `flash: ${shown}`);
      const flash = await box(p, "#scan-flash");
      assert(flash.h >= 843 && flash.w >= 389, "flash is full screen");
      await p.screenshot({ path: path.join(SHOTS, "scanner-admit.png") });
      const t0 = Date.now();
      await p.locator("#scan-flash").waitFor({ state: "hidden", timeout: 4000 });
      const shownFor = Date.now() - t0;
      assert(shownFor < 2600, `flash went away after ${shownFor} ms`);
      assert(await p.locator("#scan-cam").isVisible() && await p.locator("#scan-cam video").count() === 1, "back to the camera for the next person");
      assert(JSON.stringify(await p.evaluate(() => window.__vib)) === "[80]", `short buzz for admit: ${JSON.stringify(await p.evaluate(() => window.__vib))}`);
      assert(new RegExp(`^${n0 + 1} of`).test(await p.locator("#stats").innerText()), `counts went up: ${before} -> ${await p.locator("#stats").innerText()}`);
      assert(new RegExp(`^${n0 + 1} of`).test(await p.locator("[data-cam-count]").innerText()), "count on the camera screen");
      // The same ticket again (after the 3-second repeat guard): red, double buzz.
      await p.waitForTimeout(1700);
      await p.evaluate((code) => { window.__qr = code; }, mine[0].code);
      await p.locator("#scan-flash.no:not([hidden])").waitFor({ timeout: 8000 });
      assert(/ALREADY SCANNED/.test(await p.locator("#scan-flash").innerText()), "already scanned");
      const vib = await p.evaluate(() => window.__vib);
      assert(Array.isArray(vib[1]) && vib[1].length === 3, `double buzz for a refusal: ${JSON.stringify(vib)}`);
      await p.locator("#scan-flash").waitFor({ state: "hidden", timeout: 4000 });
      await p.locator("[data-cam-close]").click();
      assert(await p.locator("#scan-cam").isHidden(), "Done closes the camera");
      assert(/ALREADY SCANNED/.test(await p.locator("#verdict").innerText()) && /ALREADY SCANNED/.test(await p.locator("#recent").innerText()), "the result stays on the page and in Recent");
      assert(!ctx.problems.length, ctx.problems.join(" | "));
    } finally { await ctx.close(); }
    // The organiser has more than one tool there: tabs, and the box office still opens.
    await onPage(PHONE, org, "/scan", async (p) => {
      await p.locator(`[data-ev="${free.id}"]`).click().catch(() => {});
      await p.locator("[data-cam]").waitFor();
      assert(await p.locator('[role="tablist"] [role="tab"]').count() > 1, "tabs with several tools");
      await p.locator("[data-boxoffice]").click();
      await p.waitForFunction(() => !document.querySelector("[data-cam]"), null, { timeout: 8000 });
      assert(await p.locator(".site-header").isVisible(), "header back outside the gate");
    });
  });

  await test("A6 no layout shift while My tickets, the gate and the organiser dashboard load on a phone", async () => {
    for (const [c, url, ready] of [[cust, "/account#/tickets", ".ticket"], [door, "/scan", "[data-cam]"], [org, "/organisers#/", ".tabbar a"]]) {
      await onPage(PHONE, c, url, async (p) => {
        await p.locator(ready).first().waitFor();
        await p.waitForTimeout(800);
        const cls = await p.evaluate(() => window.__cls);
        assert(cls < 0.05, `${url}: layout shift ${cls.toFixed(3)}`);
      });
    }
  });

  await test("A7 the home-screen offer shows once for customers and the event team, can be dismissed and is remembered; organisers don't get it", async () => {
    const offer = (p) => p.evaluate(() => { const e = new Event("beforeinstallprompt", { cancelable: true }); e.prompt = () => { window.__prompted = true; return Promise.resolve(); }; e.userChoice = Promise.resolve({ outcome: "accepted" }); window.dispatchEvent(e); });
    const ctx = await newCtx(PHONE, cust); const p = await openPage(ctx);
    try {
      await p.goto(`${BASE}/account#/tickets`); await settle(p);
      await offer(p);
      await p.locator(".install-card").waitFor({ timeout: 4000 });
      assert(/Add TicketRoom to your home screen/.test(await p.locator(".install-card").innerText()), "wording");
      await p.waitForTimeout(400); const card = await box(p, ".install-card"), bar = await box(p, ".tabbar");
      assert(card.bottom <= bar.top + 1, "sits above the tab bar");
      await p.locator(".install-card [data-install]").click();
      assert(await p.evaluate(() => window.__prompted === true), "Add opens the browser's install");
      await p.reload(); await settle(p);
      await offer(p); await p.waitForTimeout(1800);
      assert(await p.locator(".install-card").count() === 0, "not offered twice");
    } finally { await ctx.close(); }
    await onPage(PHONE, door, "/scan", async (p) => {
      await p.locator("[data-cam]").waitFor();
      await offer(p);
      await p.locator(".install-card").waitFor({ timeout: 4000 });
      await p.locator(".install-card [data-install-no]").click();
      assert(await p.locator(".install-card").count() === 0, "Not now closes it");
      assert(await p.evaluate(() => !!localStorage.getItem("tr_install_seen")), "remembered");
    });
    await onPage(PHONE, org, "/organisers#/", async (p) => {
      await offer(p); await p.waitForTimeout(1800);
      assert(await p.locator(".install-card").count() === 0, "organisers aren't asked");
    });
  });

  await test("A8 My tickets: the next event first, swipe between tickets, a brightness hint, pull to refresh; the scanner's counts refresh the same way", async () => {
    await onPage(PHONE, cust, "/account#/tickets", async (p) => {
      await p.locator(".ticket").first().waitFor();
      const r = await p.evaluate(() => { const s = document.querySelector(".tk-swipe"); const st = getComputedStyle(s); const kids = [...s.children].map((k) => k.getBoundingClientRect()); return { snap: st.scrollSnapType, over: s.scrollWidth > s.clientWidth, sameRow: kids.length > 1 && Math.abs(kids[0].top - kids[1].top) < 2, n: kids.length, docWide: document.documentElement.scrollWidth > innerWidth + 1 }; });
      assert(r.n >= 2 && /x/.test(r.snap) && r.over && r.sameRow && !r.docWide, `swipeable row: ${JSON.stringify(r)}`);
      assert(/Ticket 1 of/.test(await p.locator(".tk-dots").innerText()), "position shown");
      await p.evaluate(() => { const s = document.querySelector(".tk-swipe"); s.scrollTo({ left: s.children[1].offsetLeft - s.children[0].offsetLeft, behavior: "instant" }); });
      await p.waitForFunction(() => /Ticket 2 of/.test(document.querySelector(".tk-dots")?.innerText || ""), null, { timeout: 3000 });
      assert(/brightness up/.test(await p.locator(".tk-bright").innerText()) && await p.locator(".tk-bright").isVisible(), "brightness hint");
      let calls = 0;
      p.on("request", (q) => { if (q.url().endsWith("/api/me/tickets")) calls++; });
      await pullDown(p);
      await p.waitForFunction(() => document.querySelector(".ticket"), null, { timeout: 8000 });
      await p.waitForTimeout(800);
      assert(calls >= 1, "pulling down loads the tickets again");
    });
    await onPage(DESK, cust, "/account#/tickets", async (p) => {
      const r = await p.evaluate(() => ({ bright: getComputedStyle(document.querySelector(".tk-bright")).display, flow: getComputedStyle(document.querySelector(".tk-swipe")).display }));
      assert(r.bright === "none" && r.flow === "block", `computer keeps the stacked tickets ${JSON.stringify(r)}`);
    });
    await onPage(PHONE, door, "/scan", async (p) => {
      await p.locator("#stats").filter({ hasText: /scanned in/ }).waitFor();
      await p.waitForTimeout(4200); // the counts are asked for at most every 4 seconds
      let calls = 0;
      p.on("request", (q) => { if (/\/api\/staff\/events\/[^/]+\/stats$/.test(q.url())) calls++; });
      await pullDown(p);
      await p.waitForTimeout(1200);
      assert(calls >= 1, "pulling down on the gate reloads the counts");
    });
  });

  await test("A9 loading shows placeholders, not a spinner; sections fade in (not with reduced motion); toasts sit above the tab bar", async () => {
    const ctx = await newCtx(PHONE, cust); const p = await openPage(ctx);
    try {
      await p.route("**/api/me/orders", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
      await p.goto(`${BASE}/account#/tickets`); await settle(p);
      await p.evaluate(() => { location.hash = "#/orders"; });
      await p.waitForTimeout(150);
      // The page stays while the next one loads; a fresh portal page starts with placeholders.
      const sk = await p.evaluate(async () => { const { spinner, render } = await import(document.querySelector('script[src*="account.js"]').src.replace("account.js", "core.js")); const d = document.createElement("div"); document.body.append(d); render(d, spinner()); const s = d.firstElementChild; const r = { cls: s.className, border: getComputedStyle(s).borderTopWidth, anim: getComputedStyle(s, "::before").animationName, h: s.getBoundingClientRect().height }; d.remove(); return r; });
      assert(/skel/.test(sk.cls) && sk.border === "0px" && sk.anim === "skel" && sk.h > 100, `placeholder blocks ${JSON.stringify(sk)}`);
      await p.waitForFunction(() => /Orders/.test(document.querySelector("main h1")?.textContent || ""), null, { timeout: 8000 });
      assert(await p.evaluate(() => document.querySelector("#main").classList.contains("view-in") && getComputedStyle(document.querySelector("#main")).animationName === "view-in"), "section fades in");
      await p.evaluate(async () => { const { toast } = await import(document.querySelector('script[src*="account.js"]').src.replace("account.js", "core.js")); toast("Saved."); });
      const t = await box(p, ".toasts"), bar = await box(p, ".tabbar");
      assert(t.bottom <= bar.top, `toast above the tab bar ${t.bottom} > ${bar.top}`);
    } finally { await ctx.close(); }
    await onPage(PHONE, cust, "/account#/tickets", async (p) => {
      await p.evaluate(() => { location.hash = "#/orders"; });
      await p.waitForFunction(() => /Orders/.test(document.querySelector("main h1")?.textContent || ""));
      const d = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#main")).animationDuration));
      assert(d < 0.01, `reduced motion: ${d}s`);
    }, { reducedMotion: "reduce" });
    // Inputs are 16 px on a phone (no zoom on focus), and double-tap zoom is off.
    await onPage(PHONE, door, "/scan", async (p) => {
      await p.locator("#mc").waitFor();
      const r = await p.evaluate(() => ({ font: getComputedStyle(document.querySelector("#mc")).fontSize, touch: getComputedStyle(document.documentElement).touchAction, tap: getComputedStyle(document.documentElement).webkitTapHighlightColor }));
      assert(r.font === "16px" && r.touch === "manipulation" && /0\)$|transparent/.test(r.tap), JSON.stringify(r));
    });
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
