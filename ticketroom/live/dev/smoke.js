// Browser smoke test for a local copy of the live package started with
// dev/serve.sh (which also seeds the accounts and events this test uses).
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/smoke.js <dir> [port]
//
// <dir> is the folder given to serve.sh (seed.json and ticketroom-data are read
// from it). Playwright comes from ticketroom/node_modules (set NODE_PATH if it
// lives elsewhere); Chromium from TR_CHROME or /opt/pw-browsers.
//
// Every page is opened at 390 px and 1366 px wide and fails the run on: a
// console error, a failed request or HTTP error that is not on the expected
// list, or sideways scrolling. Then: a sandbox paid checkout and a free guest
// checkout end to end, the free ticket scanned at /scan, and the portal
// separation checks (P1 in TRIAGE.md).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Client, outbox, sql, ADMIN_EMAIL } = require("./lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: smoke.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const SHOTS = path.join(DIR, "smoke-shots");
fs.mkdirSync(SHOTS, { recursive: true });

// TR_QUICK=1: one width and the first two pages of each list (for iterating on the flows).
const QUICK = process.env.TR_QUICK === "1";
const WIDTHS = QUICK ? [390] : [390, 1366];
const few = (list) => (QUICK ? list.slice(0, 2) : list);
const results = [];
let failures = 0;
const ok = (name, detail = "") => { results.push(["PASS", name, detail]); console.log(`PASS  ${name}${detail ? "  " + detail : ""}`); };
const bad = (name, detail) => { failures++; results.push(["FAIL", name, detail]); console.log(`FAIL  ${name}  ${detail}`); };
const check = (cond, name, detail = "") => (cond ? ok(name, cond === true ? "" : String(cond)) : bad(name, detail || "condition false"));
// A problem in the live code that TRIAGE.md already records as STILL APPLIES:
// reported as KNOWN (with its triage ID) instead of failing the run, so the
// harness stays green until it is fixed. TR_STRICT=1 makes them fail.
let known = 0;
const knownIssue = (cond, name, id, detail = "") => {
  if (cond) return ok(name);
  if (process.env.TR_STRICT === "1") return bad(`${name} [${id}]`, detail);
  known++; results.push(["KNOWN", name, detail]); console.log(`KNOWN ${name}  [${id} in TRIAGE.md] ${detail}`);
};

// Requests that are allowed to fail, with the reason.
const EXPECTED = [
  // Navigating away (or location.replace) cancels requests still in flight.
  (r) => r.failure === "net::ERR_ABORTED",
];

// ---------------------------------------------------------------- browser
let browser;
async function newCtx(width) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
  // The cookie banner would cover the page; answer it the way a visitor would.
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {} });
  ctx.problems = [];
  ctx.on("page", (p) => watch(ctx, p));
  return ctx;
}
function watch(ctx, page) {
  if (page._watched) return;
  page._watched = true;
  page.on("console", (m) => { if (m.type() === "error") ctx.problems.push(`console: ${m.text()} @ ${page.url()}`); });
  page.on("pageerror", (e) => ctx.problems.push(`pageerror: ${e.message} @ ${page.url()}`));
  page.on("requestfailed", (r) => {
    const info = { url: r.url(), failure: r.failure()?.errorText };
    if (!EXPECTED.some((f) => f(info))) ctx.problems.push(`requestfailed: ${info.failure} ${info.url}`);
  });
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 400 && !(page._allow || []).some((re) => re.test(`${s} ${r.url()}`))) ctx.problems.push(`HTTP ${s} ${r.request().method()} ${r.url()}`);
  });
}
async function page(ctx) { const p = await ctx.newPage(); watch(ctx, p); return p; }
function takeProblems(ctx) { const p = ctx.problems.splice(0); return p; }

async function settle(p) {
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(300);
}
async function noSideways(p) {
  return p.evaluate(() => {
    const d = document.documentElement;
    if (d.scrollWidth <= d.clientWidth + 1) return null;
    // Name the widest offenders to make the failure actionable.
    const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1 && getComputedStyle(e).position !== "fixed")
      .slice(-3).map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""}`);
    return `scrollWidth ${d.scrollWidth} > ${d.clientWidth}: ${wide.join(", ")}`;
  });
}
async function shot(p, name) { try { await p.screenshot({ path: path.join(SHOTS, name.replace(/[^a-z0-9-]+/gi, "_") + ".png"), fullPage: false }); } catch {} }

// Opens a page and checks it: loads, no sideways scroll, no console/request errors.
async function visit(ctx, p, url, name, { expectText } = {}) {
  takeProblems(ctx);
  await p.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await settle(p);
  if (url.includes("#")) await p.waitForTimeout(400);
  const side = await noSideways(p);
  const probs = takeProblems(ctx);
  const text = expectText ? await p.evaluate(() => document.body.innerText) : "";
  const missing = expectText && !expectText.test(text);
  if (side || probs.length || missing) {
    await shot(p, name);
    bad(name, [side, ...probs, missing ? `text ${expectText} not found` : ""].filter(Boolean).join(" | "));
  } else ok(name);
}

// ---------------------------------------------------------------- sign in through the UI
async function uiSignIn(p, { email, password, staff = false }) {
  const dlg = p.locator("dialog[open]").last();
  if (!(await dlg.locator("#a-email").count())) {
    // The portal's welcome card: its "Sign in" button opens the dialog.
    await p.locator("main button, main a.btn", { hasText: /^Sign in$/ }).first().click();
  }
  await dlg.locator("#a-email").fill(email);
  await dlg.locator("#a-pass").fill(password);
  const since = new Date(Date.now() - 1000).toISOString();
  await dlg.locator("button[type=submit]", { hasText: "Sign in" }).click();
  if (staff) {
    await dlg.locator("#login-code").waitFor();
    let code;
    for (let i = 0; i < 20 && !code; i++) { try { code = outbox(DATA, email, /\b(\d{6})\b/, { after: since })[1]; } catch { await p.waitForTimeout(200); } }
    await dlg.locator("#login-code").fill(code);
    await dlg.locator("button[type=submit]").click();
  }
  await p.waitForFunction(() => !document.querySelector("dialog[open] #a-email") && !document.querySelector("dialog[open] #login-code"), null, { timeout: 15000 });
  await settle(p);
}

// ---------------------------------------------------------------- the run
const PUBLIC = [
  ["/", "home", /Upcoming events/i],
  [`/events/${SEED.events.free.slug}`, "event page (free)", new RegExp(SEED.events.free.title, "i")],
  [`/events/${SEED.events.paid.slug}`, "event page (paid)", /R150/],
  [`/events/${SEED.events.paid.slug}/tickets`, "ticket page (paid)", /Choose tickets/i],
  ["/sell", "sell", null], ["/help", "help", null], ["/legal/terms", "terms", null], ["/contact", "contact", null],
];
const CUSTOMER_PAGES = ["#/tickets", "#/orders", "#/transfers", "#/wallet", "#/saved", "#/settings"];
const ORGANISER_PAGES = ["#/", "#/events", "#/verification", "#/finance", "#/marketing", "#/team", "#/settings", "#/events/new"];
const ADMIN_PAGES = ["#/", "#/organisers", "#/events", "#/verification", "#/users", "#/payments", "#/integrations", "#/outbox", "#/audit", "#/site", "#/staff"];

async function run() {
  browser = await chromium.launch({ executablePath: CHROME });

  // 1. Public pages, signed out.
  for (const w of WIDTHS) {
    const ctx = await newCtx(w); const p = await page(ctx);
    for (const [url, name, re] of few(PUBLIC)) await visit(ctx, p, url, `public ${name} @${w}`, { expectText: re || undefined });
    await ctx.close();
  }

  // 2. Each portal: sign in through its own sign-in box, then its main pages at both widths.
  const portals = [
    { key: "customer", url: "/account", who: SEED.customer, pages: CUSTOMER_PAGES },
    { key: "organiser", url: "/organisers", who: SEED.organiser, pages: [...ORGANISER_PAGES, `#/events/${SEED.events.paid.id}`] },
    { key: "admin", url: "/admin", who: { email: ADMIN_EMAIL, password: ADMIN_PW }, staff: true, pages: ADMIN_PAGES },
  ];
  for (const portal of portals) {
    const ctx = await newCtx(1366); const p = await page(ctx);
    takeProblems(ctx);
    await p.goto(BASE + portal.url); await settle(p);
    try {
      await uiSignIn(p, { ...portal.who, staff: portal.staff });
      const probs = takeProblems(ctx);
      check(!probs.length, `${portal.key} sign-in at ${portal.url}`, probs.join(" | "));
    } catch (e) { await shot(p, `signin-${portal.key}`); bad(`${portal.key} sign-in at ${portal.url}`, e.message.split("\n")[0]); await ctx.close(); continue; }
    const cookies = await ctx.cookies();
    await ctx.close();
    for (const w of WIDTHS) {
      const c2 = await newCtx(w); await c2.addCookies(cookies); const p2 = await page(c2);
      for (const h of few(portal.pages)) await visit(c2, p2, portal.url + h, `${portal.key} ${h} @${w}`);
      await c2.close();
    }
    portal.cookies = cookies;
  }
  const byKey = Object.fromEntries(portals.map((x) => [x.key, x]));

  // 3. Paid checkout, signed in as the customer, through the sandbox payment page.
  {
    const ctx = await newCtx(390); await ctx.addCookies(byKey.customer.cookies || []); const p = await page(ctx);
    try {
      await p.goto(`${BASE}/events/${SEED.events.paid.slug}/tickets`); await settle(p);
      await p.locator("button", { hasText: "+" }).first().click();
      await p.locator("button:visible", { hasText: /^Continue/ }).first().click();
      await p.locator("#pay").waitFor();
      await p.locator("#pay button[type=submit]").click();
      await p.waitForURL(/\/pay\?/, { timeout: 15000 }); await settle(p);
      check(!(await noSideways(p)), "sandbox pay page fits 390px");
      await p.locator("[data-outcome=paid]").click();
      await p.waitForURL(/\/orders\//, { timeout: 15000 }); await settle(p);
      await p.locator(".ticket").first().waitFor({ timeout: 15000 });
      const txt = await p.evaluate(() => document.body.innerText);
      const ref = p.url().match(/\/orders\/([^?#]+)/)[1];
      const order = sql(DATA, "SELECT status, total_cents, test FROM orders WHERE reference = ?", [ref])[0];
      const probs = takeProblems(ctx);
      check(order && order.status === "paid" && /TEST TICKET/.test(txt) && !probs.length, "paid sandbox checkout (customer)", `order ${ref} ${JSON.stringify(order)} ${probs.join(" | ")}`);
      SEED.paidOrder = ref;
    } catch (e) { await shot(p, "paid-checkout"); bad("paid sandbox checkout (customer)", e.message.split("\n")[0] + " " + takeProblems(ctx).join(" | ")); }
    await ctx.close();
  }

  // 4. Free checkout as a guest.
  let freeCode;
  {
    const ctx = await newCtx(1366); const p = await page(ctx);
    const email = `guest+${Date.now().toString(36)}@example.test`;
    try {
      await p.goto(`${BASE}/events/${SEED.events.free.slug}/tickets`); await settle(p);
      await p.locator("button", { hasText: "+" }).first().click();
      await p.locator("button:visible", { hasText: /^Continue/ }).first().click();
      await p.locator("#pay").waitFor();
      await p.fill("#g-name", "Guest Tester");
      await p.fill("#g-email", email);
      await p.fill("#g-email2", email);
      await p.locator("#pay button[type=submit]").click();
      await p.waitForURL(/\/orders\//, { timeout: 15000 }); await settle(p);
      await p.locator(".ticket").first().waitFor({ timeout: 15000 });
      freeCode = (await p.locator(".tk-code").first().innerText()).trim();
      const probs = takeProblems(ctx);
      check(freeCode && !probs.length, "free checkout (guest)", `${freeCode} ${probs.join(" | ")}`);
      check(!(await noSideways(p)), "order page fits 1366px");
    } catch (e) { await shot(p, "free-checkout"); bad("free checkout (guest)", e.message.split("\n")[0] + " " + takeProblems(ctx).join(" | ")); }
    await ctx.close();
  }

  // 5. The organiser scans the free ticket at /scan (typed code), then again.
  if (freeCode) {
    const ctx = await newCtx(390); const p = await page(ctx);
    // A phone without a camera: the typed code is the fallback.
    try {
      await p.goto(`${BASE}/scan`); await settle(p);
      await uiSignIn(p, SEED.organiser);
      await p.locator(`[data-ev="${SEED.events.free.id}"]`).click().catch(() => {});
      await p.locator("#mc").waitFor();
      await p.fill("#mc", freeCode); await p.press("#mc", "Enter");
      await p.waitForFunction(() => !/READY/.test(document.querySelector("#verdict")?.innerText || "READY"), null, { timeout: 10000 });
      const v1 = (await p.locator("#verdict").innerText()).trim();
      await p.fill("#mc", freeCode); await p.press("#mc", "Enter");
      await p.waitForFunction(() => /ALREADY/.test(document.querySelector("#verdict")?.innerText || ""), null, { timeout: 10000 }).catch(() => {});
      const v2 = (await p.locator("#verdict").innerText()).trim();
      const side = await noSideways(p);
      const probs = takeProblems(ctx);
      check(/ADMIT/.test(v1) && !probs.length && !side, "scan free ticket at /scan: ADMIT", `${v1.replace(/\s+/g, " ")} ${side || ""} ${probs.join(" | ")}`);
      check(/ALREADY SCANNED/.test(v2), "scan same ticket again: ALREADY SCANNED", v2.replace(/\s+/g, " "));
      const dbt = sql(DATA, "SELECT status FROM tickets WHERE code = ?", [freeCode])[0];
      check(dbt && dbt.status === "used", "ticket marked used in the database", JSON.stringify(dbt));
    } catch (e) { await shot(p, "scan"); bad("scan at /scan", e.message.split("\n")[0] + " " + takeProblems(ctx).join(" | ")); }
    await ctx.close();
  }

  await portalChecks(byKey);
  await browser.close();
}

// ---------------------------------------------------------------- P1: portals don't clash
async function portalChecks(byKey) {
  const api = async (cookies, method, url, body) => {
    const c = new Client(BASE, DATA);
    for (const k of cookies || []) c.cookies[k.name] = k.value;
    if (method !== "GET") await c.refreshCsrf();
    try { await c.call(method, url, body); return c.status; } catch (e) { return +(e.message.match(/-> (\d+)/) || [])[1]; }
  };
  const orgId = SEED.organiser.orgId;
  // (e) one portal's API refuses the others' sessions.
  const cases = [
    ["customer", "GET", `/api/organiser/${orgId}/events`, [403, 404]], ["customer", "GET", "/api/admin/dashboard", 403], ["customer", "GET", "/api/admin/integrations", 403],
    ["organiser", "GET", "/api/me/tickets", 403], ["organiser", "GET", "/api/admin/dashboard", 403], ["organiser", "GET", "/api/me/orders", 403],
    ["admin", "GET", "/api/me/tickets", 403], ["admin", "GET", `/api/organiser/${orgId}/events`, [403, 404]],
  ];
  for (const [who, m, url, want] of cases) {
    const got = await api(byKey[who].cookies, m, url);
    const want2 = [].concat(want);
    check(want2.includes(got), `P1(e) ${who} session -> ${m} ${url} is refused (${want2.join("/")})`, `got ${got}`);
  }

  // (a) each sign-in box admits only its account types, with a clear message.
  const wrong = [
    ["customer", "organiser", /customer account/i], ["organiser", "customer", /organiser account/i],
    ["customer", "admin", /Access denied/i], ["organiser", "admin", /Access denied/i],
  ];
  for (const [who, portal, re] of wrong) {
    const c = new Client(BASE, DATA);
    let msg = "";
    try { await c.call("POST", "/api/auth/login", { email: SEED[who].email, password: SEED[who].password, portal }); msg = "signed in"; } catch (e) { msg = e.message; }
    check(re.test(msg) && !Object.keys(c.cookies).length, `P1(a) ${who} account on the ${portal} sign-in is refused`, msg.slice(0, 160));
  }
  // Every session on every portal page: no script errors, and a page that says
  // what it is for (a wrong-account page, a sign-in, or the portal itself).
  const PAGES = ["/account", "/organisers", "/admin", "/scan", "/pos", "/retail"];
  const HOME = { customer: "/account", organiser: "/organisers", admin: "/admin" };
  for (const who of ["customer", "organiser", "admin"]) {
    for (const url of PAGES) {
      const ctx = await newCtx(390); await ctx.addCookies(byKey[who].cookies || []); const p = await page(ctx);
      takeProblems(ctx);
      await p.goto(BASE + url); await settle(p); await p.waitForTimeout(300);
      const probs = takeProblems(ctx).filter((x) => !/HTTP 40[13] /.test(x));
      const main = (await p.evaluate(() => document.querySelector("main")?.innerText || "")).trim();
      const wrongBox = /isn't for this account|separate account|not for your kind of account/i.test(main);
      const name = `P1(a) ${who} session on ${url}: ${HOME[who] === url ? "its portal" : "clear message, no script error"}`;
      const good = !probs.length && main.length > 20;
      const detail = `${probs.join(" | ")} main: "${main.replace(/\s+/g, " ").slice(0, 140)}"`;
      if (who === "admin" && url === "/scan") knownIssue(good && wrongBox, name, "P1(a)", detail);
      else check(good, name, detail);
      if (who === "organiser" && url === "/account" || who === "customer" && url === "/organisers") check(wrongBox, `P1(a) ${who} session on ${url} shows the wrong-account page`, main.slice(0, 140));
      await ctx.close();
    }
  }

  // (b) two tabs, one browser: the session cookie is shared by every portal.
  {
    const ctx = await newCtx(1366);
    const a = await page(ctx); const b = await page(ctx);
    await a.goto(`${BASE}/account#/tickets`); await settle(a);
    await uiSignIn(a, SEED.customer);
    await b.goto(`${BASE}/organisers`); await settle(b);
    const bText = await b.evaluate(() => document.body.innerText);
    // Signing in on the organiser tab replaces the customer session in the whole browser.
    const orgBox = /isn't for this account/i.test(bText);
    check(orgBox, "P1(b) customer signed in: organiser tab shows the wrong-account page (not organiser data)");
    await b.locator("[data-out]").click().catch(() => {}); await settle(b);
    await uiSignIn(b, SEED.organiser).catch(() => {});
    // The customer tab, not reloaded, moves to another page of its portal: its
    // calls now carry the organiser session and must not show organiser data.
    takeProblems(ctx);
    await a.evaluate(() => { location.hash = "#/orders"; }); await settle(a); await a.waitForTimeout(500);
    const stale = await a.evaluate(() => document.querySelector("main")?.innerText || "");
    const staleProbs = takeProblems(ctx);
    check(!stale.includes(SEED.organiser.organisation), "P1(b) stale customer tab after organiser sign-in elsewhere shows no organiser data",
      `main: "${stale.replace(/\s+/g, " ").slice(0, 160)}" ${staleProbs.join(" | ")}`);
    // Better: the tab notices the switch and shows the wrong-account page instead
    // of keeping the customer's last page on screen with a failed call behind it.
    knownIssue(/isn't for this account/i.test(stale) && !staleProbs.length, "P1(b) stale customer tab notices the session switched", "P1(b)",
      `${staleProbs.map((x) => x.split("\n")[0]).join(" | ")}; main still shows: "${stale.replace(/\s+/g, " ").slice(0, 100)}"`);
    await a.reload(); await settle(a);
    const aText = await a.evaluate(() => document.body.innerText);
    const switched = /isn't for this account/i.test(aText);
    check(switched, "P1(b) customer tab after organiser sign-in elsewhere: shows wrong-account page, no data mixing", switched ? "" : aText.slice(0, 200));
    // Sign out from one tab signs every tab out.
    await b.evaluate(async () => { const me = await (await fetch("/api/auth/me")).json(); await fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": me.csrfToken } }); });
    await a.reload(); await settle(a);
    const out = await a.evaluate(() => fetch("/api/auth/me").then((r) => r.json()).then((j) => j.user));
    check(out === null, "P1(b) sign out in one tab signs the browser out everywhere");
    // The customer's saved tickets (with QR codes) should not outlive the session
    // on a shared phone; the signed-out welcome page shows them when offline.
    const cached = await a.evaluate(() => { try { return JSON.parse(localStorage.getItem("tr_wallet_v1") || "null"); } catch { return null; } });
    knownIssue(!cached, "P1(b)/T14 signed out: no saved tickets with QR codes left in the browser", "T14",
      cached ? `tr_wallet_v1 still holds ${cached.tickets?.length ?? 0} ticket(s), ${cached.tickets?.filter((t) => t.qrData).length ?? 0} with QR` : "");
    takeProblems(ctx);
    await ctx.close();
  }

  // (c) one person, several roles: the customer is added to the free event's
  // team (scanner). They scan at /scan, keep only their own tickets in
  // /account, and still cannot reach the organiser's API.
  {
    const org = new Client(BASE, DATA);
    await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
    await org.call("POST", `/api/organiser/${orgId}/events/${SEED.events.free.id}/staff`, { email: SEED.customer.email, canScan: true, canManageTags: false }, 201);
    const cust = new Client(BASE, DATA);
    await cust.login(SEED.customer.email, SEED.customer.password, "scanner");
    const evs = (await cust.call("GET", "/api/staff/events")).events;
    check(evs.some((e) => e.id === SEED.events.free.id && e.can_scan), "P1(c) customer added as event staff sees the event in the scanner");
    check(!evs.some((e) => e.id === SEED.events.paid.id), "P1(c) ...but not the organiser's other events");
    const mine = (await cust.call("GET", "/api/me/tickets")).tickets;
    const custId = (await cust.refreshCsrf()).user.id;
    const owned = sql(DATA, "SELECT id FROM tickets WHERE owner_user_id = ? AND status <> 'revoked'", [custId]).map((r) => r.id).sort();
    const listed = mine.map((t) => t.id).sort();
    check(JSON.stringify(owned) === JSON.stringify(listed), "P1(c) customer portal still lists exactly their own tickets", `listed ${listed.length}, owned ${owned.length}`);
    let code;
    try { await cust.call("GET", `/api/organiser/${orgId}/events`); code = 200; } catch (e) { code = +(e.message.match(/-> (\d+)/) || [])[1]; }
    check(code === 403 || code === 404, "P1(c) event staff (customer) cannot call the organiser API", `got ${code}`);
    const me = await cust.refreshCsrf();
    check(me.user && (me.user.accountType || me.user.account_type) === "customer", "P1(c) the person stays one customer account with a scanner role", JSON.stringify(me.user && { type: me.user.accountType, staffEvents: (me.user.staff_events || []).length }));
  }

  // (d) a portal's header never links into a portal its account cannot use.
  const headerLinks = async (cookies, url) => {
    const ctx = await newCtx(1366); await ctx.addCookies(cookies || []); const p = await page(ctx);
    await p.goto(BASE + url); await settle(p);
    const hrefs = await p.evaluate(() => [...document.querySelectorAll("#header a[href], #sidenav a[href]")].map((a) => a.getAttribute("href")));
    takeProblems(ctx); await ctx.close();
    return hrefs;
  };
  const forbid = { customer: ["/admin"], organiser: ["/admin", "/account"], admin: ["/account", "/organisers", "/scan", "/pos"] };
  for (const [who, url] of [["customer", "/account"], ["organiser", "/organisers"], ["admin", "/admin"]]) {
    const hrefs = await headerLinks(byKey[who].cookies, url);
    const hit = hrefs.filter((h) => forbid[who].some((f) => h === f || h.startsWith(f + "#") || h.startsWith(f + "/")));
    check(!hit.length, `P1(d) ${who} portal header/side links stay in reach (${hrefs.length} links)`, hit.join(", "));
  }

  // (f) the scanner's dark theme does not leak into its sign-in dialog.
  {
    const ctx = await newCtx(390); const p = await page(ctx);
    await p.goto(`${BASE}/scan`); await settle(p);
    const c = await p.evaluate(() => {
      const d = document.querySelector("dialog[open]"); if (!d) return null;
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      let bgEl = d; while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement;
      const bg = rgb(getComputedStyle(bgEl || document.body).backgroundColor);
      const out = {};
      for (const sel of ["label", "[data-forgot]", ".dialog-body p, .dialog-body .callout"]) { const e = d.querySelector(sel); if (e) out[sel] = +ratio(rgb(getComputedStyle(e).color), bg).toFixed(2); }
      return out;
    });
    const lowest = c ? Math.min(...Object.values(c)) : 0;
    knownIssue(c && lowest >= 4.5, "P1(f) scanner sign-in dialog text contrast >= 4.5:1", "U3", JSON.stringify(c));
    takeProblems(ctx); await ctx.close();
  }
}

run().then(() => {
  const pass = results.filter((r) => r[0] === "PASS").length;
  console.log(`\n${pass} passed, ${failures} failed, ${known} known live issues (see TRIAGE.md). Screenshots of failures: ${SHOTS}`);
  process.exit(failures ? 1 : 0);
}).catch(async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
