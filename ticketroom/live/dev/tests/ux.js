// UX and copy regression tests (U* and N2 in TRIAGE.md) and a crawler over
// every portal, against a local instance from dev/serve.sh.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/ux.js <dir> [port]
//
// The crawler opens every page of every portal (public site, /account,
// /organisers, /admin, /scan with the gate and the box office, /pos, /retail)
// at 390x844 and 1366x900 and fails a page on: a console error, a failed
// request or HTTP error, sideways scrolling, visible text with contrast below
// 4.5:1, an em dash or exclamation mark in visible text, raw slugs, codes or
// JSON in visible text, an empty card, a repeated id, a lower-case status
// badge, a tap target under 40 px on a phone, or a scrolling tab strip with no
// sign that there is more. Then one test per U item.
//
// TR_ONLY=U5 runs only the tests whose name starts with that (TR_ONLY=crawl:
// only the crawler). TR_UX_SHOTS=<folder> saves a screenshot of each portal's
// main page at both sizes (not part of the repository).
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
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: ux.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const SHOTS = process.env.TR_UX_SHOTS || "";
const FAIL_SHOTS = path.join(DIR, "ux-shots");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(FAIL_SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).slice(0, 2400)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const stamp = Date.now().toString(36);
const uuid = () => crypto.randomUUID();
const WIDTHS = [[390, 844], [1366, 900]];
// Words and phrases that read as generic filler, plus emoji, flags and text symbols used as icons
// (icons must be real SVG line icons; arrows in written menu paths are fine).
const HYPE = /\b(?:seamless(?:ly)?|elevate[sd]?|unlock (?:your|the|new)|effortless(?:ly)?|empower(?:s|ing)?|robust|world-class|game-chang\w*|next-level|cutting-edge|journey|vibrant|curated|unforgettable|hassle-free|one-stop|whether you're|in today's|lorem|ipsum|dummy|todo|no surprises|in seconds|look no further|like never before)\b|[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/giu;

// ---------------------------------------------------------------- accounts and data
async function signUp(name, email, password) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: name, email, password, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return c;
}
async function signedIn(email, password, portal, ctx = {}) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/login", { email, password, portal, ...ctx });
  await c.refreshCsrf();
  return c;
}

// Everything the crawler needs to reach every screen: a vendor with a till
// and products (/pos), event staff who scan and sell at the door (/scan), an
// approved retail partner (/retail), and a ticket in the customer's wallet.
async function fixtures() {
  const F = {};
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const org = await signedIn(SEED.organiser.email, SEED.organiser.password, "organiser");
  const orgId = SEED.organiser.orgId;
  const free = SEED.events.free, paid = SEED.events.paid;

  // Retail programme on, one approved partner selling in person and online.
  const site = await admin.call("GET", "/api/admin/settings");
  await admin.call("PUT", "/api/admin/settings/retail", { enabled: true, message: (site.settings || site).retail?.message || "Retail ticket sales open soon." });
  const pw = `Ux-${stamp}-pass-2026`;
  F.retail = { email: `retail+${stamp}@example.test`, password: pw };
  const shop = F.shop = await signUp("Thandi Retail", F.retail.email, pw);
  await shop.call("POST", "/api/retail/apply", { businessName: "Corner Shop Tickets", contactPhone: "0821234567", storeAddress: "12 Long Street, Cape Town", salesChannels: ["physical", "online"] }, 201);
  const partner = (await admin.call("GET", "/api/admin/retail-partners")).partners.find((p) => p.business_name === "Corner Shop Tickets" && p.status === "pending");
  await admin.call("POST", `/api/admin/retail-partners/${partner.id}/status`, { status: "approved" });

  // Gate and box office staff on the free event.
  F.staff = { email: `door+${stamp}@example.test`, password: pw };
  F.door = await signUp("Sipho Door", F.staff.email, pw);
  await org.call("POST", `/api/organiser/${orgId}/events/${free.id}/staff`, { email: F.staff.email, canScan: true, canManageTags: false, canSellTickets: true }, 201);

  // A vendor on the paid event (cashless on), with a till and two products.
  sql(DATA, "UPDATE events SET cashless_enabled = 1 WHERE id = ?", [paid.id]);
  F.vendor = { email: `bar+${stamp}@example.test`, password: pw };
  const bar = F.bar = await signUp("Lerato Bar", F.vendor.email, pw);
  const v = (await org.call("POST", `/api/organiser/${orgId}/events/${paid.id}/vendors`, { name: "Courtyard Bar" }, 201)).vendor;
  await org.call("POST", `/api/organiser/${orgId}/events/${paid.id}/vendors/${v.id}/members`, { email: F.vendor.email, role: "manager" }, 201);
  F.terminalKey = (await org.call("POST", `/api/organiser/${orgId}/events/${paid.id}/vendors/${v.id}/terminals`, { label: "Till 1" }, 201)).terminal.terminalKey;
  for (const [name, priceCents] of [["Still water", 2000], ["Lager", 4500]]) await bar.call("POST", `/api/pos/vendors/${v.id}/products`, { name, priceCents }, 201);

  // A free ticket in the customer's wallet.
  const cust = F.cust = await signedIn(SEED.customer.email, SEED.customer.password, "customer");
  const ev = await cust.call("GET", `/api/public/events/${free.slug}`);
  const tt = (ev.ticketTypes || ev.event?.ticketTypes || ev.ticket_types || [])[0];
  if (tt) await cust.call("POST", "/api/public/orders", { eventSlug: free.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: uuid() }).catch((e) => console.log(`  (customer ticket not booked: ${e.message.slice(0, 120)})`));
  // A draft with no poster and no description, seen through its preview link.
  const common = { category: "arts", venueName: "The Old Biscuit Hall", address: "375 Albert Road, Woodstock", city: "Cape Town", province: "Western Cape", isFree: true, capacity: 80,
    startsAt: new Date(Date.now() + 30 * 864e5).toISOString(), endsAt: new Date(Date.now() + 30 * 864e5 + 3 * 36e5).toISOString() };
  F.draft = (await org.call("POST", `/api/organiser/${orgId}/events`, { ...common, title: `Poetry evening ${stamp}`, summary: "Spoken word in the courtyard" }, 201)).event;
  F.draftPreview = new URL((await org.call("GET", `/api/organiser/${orgId}/events/${F.draft.id}/preview-link`)).url, BASE).searchParams.get("preview");
  Object.assign(F, { admin, org });
  return F;
}

// ---------------------------------------------------------------- the page audit (runs in the browser)
function pageAudit({ phone, portal, HYPE_SOURCE }) {
  const out = { contrast: [], words: [], raw: [], empty: [], ids: [], badges: [], tap: [], strips: [], money: [], plurals: [], side: null };
  const d = document.documentElement;
  const visible = (el) => {
    if (!el.isConnected) return false;
    // Inside a closed <details> (but not its summary): laid out, not shown.
    const shut = el.closest("details:not([open])");
    if (shut && !el.closest("summary")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity < 0.05) return false;
      if (n.hidden || n.getAttribute("aria-hidden") === "true") return false;
      if (s.clip === "rect(0px, 0px, 0px, 0px)" || (s.position === "absolute" && r.width <= 1 && r.height <= 1)) return false;
    }
    return true;
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
  // Sideways scroll
  if (d.scrollWidth > d.clientWidth + 1) {
    const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1 && getComputedStyle(e).position !== "fixed").slice(-3).map(describe);
    out.side = `scrollWidth ${d.scrollWidth} > ${d.clientWidth}: ${wide.join(", ")}`;
  }
  // Contrast of every visible text run against what is behind it.
  const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // Returns the backgrounds the element can sit on (one, or each stop of a gradient), or null over a photo.
  const backgrounds = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/url\(/.test(s.backgroundImage)) return null;
      if (/gradient/.test(s.backgroundImage)) {
        const stops = (s.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse).filter((c) => c && c[3] >= 0.5);
        if (stops.length) return stops.map((st) => layers.reduceRight((acc, l) => over(l, acc), [st[0], st[1], st[2], 1]));
      }
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
      // A positioned overlay (dialog backdrop, sticky bar) is still an ancestor; photos behind absolutely placed text are not checked.
    }
    let base = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return [base];
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.nodeValue.replace(/\s+/g, " ").trim();
    if (!text || !/[A-Za-z0-9R]/.test(text)) continue;
    const el = t.parentElement;
    if (!el || seen.has(el) || el.closest("svg, script, style, noscript, option, .sr-only, [disabled], [aria-disabled='true']")) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    let fg = parse(s.color); if (!fg) continue;
    const bgs = backgrounds(el); if (!bgs) continue;
    let worst = 99;
    for (const bg of bgs) worst = Math.min(worst, ratio(fg[3] < 1 ? over(fg, bg) : fg, bg));
    if (worst < 4.5) out.contrast.push(`${worst.toFixed(2)}:1 "${text.slice(0, 40)}" (${describe(el)})`);
  }
  // Words and punctuation the style guide rules out, raw codes and JSON.
  const txt = document.body.innerText;
  for (const m of txt.matchAll(/[^\n]{0,30}[—!][^\n]{0,30}/g)) out.words.push(`"${m[0].trim()}"`);
  for (const m of txt.matchAll(new RegExp(HYPE_SOURCE, "giu"))) out.words.push(`filler: "${m[0]}"`);
  const rawRes = [
    [/\{\s*"[A-Za-z_]+"\s*:/g, "JSON"],
    // Words joined by underscores; provider references with digits ("ch_abc_12f9") are real ids, not keys.
    [/(?<![@\w./-])[a-z]+(?:_[a-z]+)+(?![\w@-])(?![\w.-]*@)/g, "snake_case"],
    [/\[object Object\]|\bundefined\b|\bNaN\b/g, "broken value"],
    [/(?<![@\w/.-])[a-z]{3,}:[a-z0-9][\w:-]*/g, "account code"],
    [/(?<![@\w/.-])[a-z]+\.(?!(?:co|za|com|net|org|test|html|php|js|css|svg|png|pdf|txt|md|json|sqlite)\b)[a-z]+(?:[._][a-z]+)*\b(?![\w@/.+-])/g, "dotted key"],
  ];
  for (const [re, what] of rawRes) for (const m of txt.matchAll(re)) out.raw.push(`${what}: "${m[0]}"`);
  // Counts that read wrong ("1 orders") and, in the portals, money always in rands and cents.
  for (const m of txt.matchAll(/(?<![\d.R])\b1 (orders|tickets|events|people|items|organisers|approved organisers|scans|days|recipients|sales|ticket types|shops|people)\b/g)) out.plurals.push(`"${m[0]}"`);
  if (portal) for (const m of txt.matchAll(/(?<![A-Za-z0-9-])R\d{1,3}(?: \d{3})*(\.\d{2})?(?![\d%A-Za-z])/g)) if (!m[1]) out.money.push(`"${m[0]}"`);
  // Empty boxes
  for (const el of document.querySelectorAll(".card, .kpi, .table-wrap, .callout, .attn-list, .ev2-sec, .tiles > *, .grid-2 > *, .grid-3 > *")) {
    if (!visible(el) || el.matches("input, select, textarea, button, img, svg")) continue;
    const has = el.innerText.trim() || el.querySelector("img, svg, canvas, video, iframe, input, select, textarea, button, .spinner");
    const onlyHeading = el.children.length === 1 && /^H[1-4]$/.test(el.children[0].tagName);
    if (!has || onlyHeading) out.empty.push(describe(el) + (onlyHeading ? ` (only "${el.innerText.trim().slice(0, 30)}")` : ""));
  }
  // Repeated ids
  const ids = {};
  for (const el of document.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1;
  for (const [id, n] of Object.entries(ids)) if (n > 1) out.ids.push(`#${id} x${n}`);
  // Status badges in sentence case
  for (const b of document.querySelectorAll(".badge")) {
    const t = b.innerText.trim();
    if (visible(b) && /^[a-z]/.test(t)) out.badges.push(`"${t}"`);
  }
  if (phone) {
    // Tap targets of at least 40 px
    for (const el of document.querySelectorAll("button, .btn, [role=tab], .tabs a, .sidenav a, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([type=color]), .chip, .fpill")) {
      if (!visible(el) || el.closest(".sr-only, .stepper output, .chat-panel[hidden]")) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.position === "absolute" && +s.opacity === 0) continue; // a hidden native input under a styled control
      // Plain text links inside sentences are fine; only controls count.
      if (el.classList.contains("btn-link") && el.closest("p, li, td, .small, .tiny")) continue;
      if (r.height < 40 - 0.5) out.tap.push(`${Math.round(r.width)}x${Math.round(r.height)} "${(el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 24)}" (${describe(el)})`);
    }
    // A strip that scrolls sideways shows there is more.
    for (const el of document.querySelectorAll(".sidenav, .tabs, .chips")) {
      if (!visible(el) || el.scrollWidth <= el.clientWidth + 2) continue;
      const box = el.closest("[data-more]") || (el.hasAttribute("data-more") ? el : null);
      const cue = box && ["right", "left", "both"].includes(box.getAttribute("data-more"));
      if (!cue) out.strips.push(`${describe(el)} scrolls (${el.scrollWidth} > ${el.clientWidth}) with no cue`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- browser
let browser;
const EXPECTED_FAIL = [(r) => r.failure === "net::ERR_ABORTED"];
async function newCtx([width, height], cookies = []) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {} });
  if (cookies.length) await ctx.addCookies(cookies.map(([name, value]) => ({ name, value, url: BASE })));
  ctx.problems = [];
  return ctx;
}
async function openPage(ctx) {
  const p = await ctx.newPage();
  // "Failed to load resource" repeats an HTTP error, which the response check below reports (with its allow list).
  p.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) ctx.problems.push(`console: ${m.text().slice(0, 200)}`); });
  p.on("pageerror", (e) => ctx.problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  p.on("requestfailed", (r) => { const info = { url: r.url(), failure: r.failure()?.errorText }; if (!EXPECTED_FAIL.some((f) => f(info))) ctx.problems.push(`requestfailed: ${info.failure} ${info.url}`); });
  p.on("response", (r) => { if (r.status() >= 400 && !(p._allow || []).some((re) => re.test(`${r.status()} ${r.url()}`))) ctx.problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
  return p;
}
async function settle(p, extra = 350) {
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await p.waitForFunction(() => !document.documentElement.classList.contains("booting") && !document.querySelector("#main .spinner"), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(extra);
}
const cookiesOf = (c) => Object.entries(c.cookies);
async function shotTo(p, dir, name) { if (!dir) return; try { await p.screenshot({ path: path.join(dir, name.replace(/[^a-z0-9-]+/gi, "_") + ".png"), fullPage: false }); } catch {} }

// Checks the page as it is now; returns a list of problems (empty: clean).
async function auditNow(p, ctx, phone, portal = false) {
  const a = await p.evaluate(pageAudit, { phone, portal, HYPE_SOURCE: HYPE.source });
  const probs = ctx.problems.splice(0);
  const list = [];
  if (a.side) list.push(`sideways: ${a.side}`);
  for (const x of probs) list.push(x);
  for (const [k, label] of [["contrast", "contrast"], ["words", "dash or !"], ["raw", "raw"], ["empty", "empty box"], ["ids", "repeated id"], ["badges", "badge case"], ["tap", "tap target"], ["strips", "strip"], ["money", "money without cents"], ["plurals", "plural"]]) {
    if (a[k].length) list.push(`${label}: ${[...new Set(a[k])].slice(0, 6).join("; ")}${a[k].length > 6 ? ` (+${a[k].length - 6})` : ""}`);
  }
  return list;
}

// ---------------------------------------------------------------- crawl
const crawlFailures = [];
async function crawlPage(ctx, p, label, phone, { url, before, portal = !/^public /.test(label) } = {}) {
  ctx.problems.splice(0);
  if (url) { await p.goto(BASE + url, { waitUntil: "domcontentloaded" }); }
  if (before) {
    try { await before(p); }
    catch (e) {
      crawlFailures.push(`${label}\n      could not open: ${e.message.split("\n")[0]} | main: "${(await p.evaluate(() => document.querySelector("main")?.innerText || "")).replace(/\s+/g, " ").slice(0, 200)}"`);
      await shotTo(p, FAIL_SHOTS, `crawl-${label}`);
      return ["could not open"];
    }
  }
  await settle(p);
  const list = await auditNow(p, ctx, phone, portal);
  if (list.length) { crawlFailures.push(`${label}\n      ${list.join("\n      ")}`); await shotTo(p, FAIL_SHOTS, `crawl-${label}`); }
  return list;
}

async function navLinks(p) {
  return p.evaluate(() => [...new Set([...document.querySelectorAll("#sidenav a[href^='#/'], .side-foot a[href^='#/']")].map((a) => a.getAttribute("href")))]);
}

async function crawl(F, sessions) {
  const PUBLIC = ["/", `/events/${SEED.events.free.slug}`, `/events/${SEED.events.paid.slug}`, `/events/${SEED.events.paid.slug}/tickets`, `/events/${SEED.events.free.slug}/tickets`,
    "/sell", "/help", "/about", "/contact", "/careers", "/partners", "/advertise", "/safety", "/retail", "/legal/terms", "/signin", "/subscribe", "/nope-404",
    // Signed out, the portals open their sign-in box.
    "/account", "/organisers", "/admin", "/scan", "/pos", `/events/${F.draft.slug}?preview=${encodeURIComponent(F.draftPreview)}`];
  const portals = [
    { key: "customer", url: "/account", cookies: sessions.customer, main: "#/tickets" },
    { key: "organiser", url: "/organisers", cookies: sessions.organiser, main: "#/", extra: ["#/events/new", `#/events/${SEED.events.paid.id}`] },
    { key: "admin", url: "/admin", cookies: sessions.admin, main: "#/" },
  ];
  for (const size of WIDTHS) {
    const phone = size[0] < 600;
    const tag = `@${size[0]}`;
    // Public pages, signed out.
    {
      const ctx = await newCtx(size); const p = await openPage(ctx);
      p._allow = [/^404 .*\/nope-404/];
      for (const url of PUBLIC) {
        await crawlPage(ctx, p, `public ${url} ${tag}`, phone, { url });
        if (url === "/") await shotTo(p, SHOTS, `public-home-${size[0]}`);
        if (url.endsWith("/tickets") && url.includes(SEED.events.free.slug)) await shotTo(p, SHOTS, `public-free-tickets-${size[0]}`);
      }
      await ctx.close();
    }
    // Portals with a side menu: every menu entry.
    for (const portal of portals) {
      const ctx = await newCtx(size, portal.cookies); const p = await openPage(ctx);
      await crawlPage(ctx, p, `${portal.key} ${portal.main} ${tag}`, phone, { url: portal.url + portal.main });
      await shotTo(p, SHOTS, `${portal.key}-${size[0]}`);
      const links = (await navLinks(p)).filter((h) => h !== portal.main);
      for (const h of [...links, ...(portal.extra || [])]) await crawlPage(ctx, p, `${portal.key} ${h} ${tag}`, phone, { url: portal.url + h });
      await ctx.close();
    }
    // Event team: choose the event, the gate, the box office.
    {
      const ctx = await newCtx(size, sessions.staff); const p = await openPage(ctx);
      await crawlPage(ctx, p, `scan choose event ${tag}`, phone, { url: "/scan" });
      await crawlPage(ctx, p, `scan gate ${tag}`, phone, { before: async () => { await p.locator(`[data-ev="${SEED.events.free.id}"]`).click(); await p.locator("#verdict").waitFor(); } });
      await shotTo(p, SHOTS, `scan-gate-${size[0]}`);
      await crawlPage(ctx, p, `scan box office ${tag}`, phone, { before: async () => { await p.locator("[data-boxoffice]").click(); } });
      await shotTo(p, SHOTS, `scan-boxoffice-${size[0]}`);
      await ctx.close();
    }
    // Vendor till: activation, then Sell, Sales and Summary.
    {
      const ctx = await newCtx(size, sessions.vendor); const p = await openPage(ctx);
      await crawlPage(ctx, p, `pos activate ${tag}`, phone, { url: "/pos" });
      await p.evaluate((k) => localStorage.setItem("tr_terminal_key", k), F.terminalKey);
      await crawlPage(ctx, p, `pos sell ${tag}`, phone, { url: "/pos" });
      await shotTo(p, SHOTS, `pos-${size[0]}`);
      for (const v of ["history", "summary"]) await crawlPage(ctx, p, `pos ${v} ${tag}`, phone, { before: async () => { await p.locator(`[data-view="${v}"]`).click(); } });
      await ctx.close();
    }
    // Retail partner: the partner page and the counter (box office in retail mode).
    {
      const ctx = await newCtx(size, sessions.retail); const p = await openPage(ctx);
      await crawlPage(ctx, p, `retail partner ${tag}`, phone, { url: "/retail", before: async () => { await p.locator("[data-sell]").first().waitFor({ timeout: 10000 }); await p.locator("#retail-state").scrollIntoViewIfNeeded(); } });
      await shotTo(p, SHOTS, `retail-${size[0]}`);
      await crawlPage(ctx, p, `retail counter ${tag}`, phone, { before: async () => { await p.locator("[data-sell]").first().click(); } });
      await ctx.close();
    }
  }
}

// ---------------------------------------------------------------- run
(async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  const F = await fixtures();
  const sessions = {};
  // One sign-in per account (sign-in codes and attempts are rate limited).
  Object.assign(sessions, { customer: cookiesOf(F.cust), organiser: cookiesOf(F.org), admin: cookiesOf(F.admin), staff: cookiesOf(F.door), vendor: cookiesOf(F.bar), retail: cookiesOf(F.shop) });

  await test("crawl: every portal page at 390 and 1366 is clean", async () => {
    await crawl(F, sessions);
    fs.writeFileSync(path.join(DIR, "ux-crawl.txt"), crawlFailures.join("\n") + "\n");
    assert(!crawlFailures.length, `${crawlFailures.length} page(s):\n  ${crawlFailures.join("\n  ")}`);
  });

  // ---------------------------------------------------------------- one test per item
  const PHONE = WIDTHS[0], DESK = WIDTHS[1];
  async function onPage(size, cookies, url, fn) {
    const ctx = await newCtx(size, cookies); const p = await openPage(ctx);
    try { await p.goto(BASE + url, { waitUntil: "domcontentloaded" }); await settle(p); return await fn(p, ctx); }
    finally { await ctx.close(); }
  }
  const ratioOf = (p, fgSel, bgSel) => p.evaluate(([f, b]) => {
    const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c) => { const g = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * g(c[0]) + 0.7152 * g(c[1]) + 0.0722 * g(c[2]); };
    const [x, y] = [lum(parse(f)), lum(parse(b))].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }, [fgSel, bgSel]);
  const preview = `/events/${F.draft.slug}?preview=${encodeURIComponent(F.draftPreview)}`;

  await test("U1 the sticky header never covers a field scrolled into view", () => onPage(PHONE, [], "/contact", async (p) => {
    const r = await p.evaluate(() => {
      const fields = [...document.querySelectorAll("main input, main textarea")].filter((x) => x.offsetParent);
      const el = fields[fields.length - 1];
      el.scrollIntoView({ block: "start" });
      return { pad: getComputedStyle(document.documentElement).scrollPaddingTop, top: el.getBoundingClientRect().top, header: document.querySelector(".site-header").getBoundingClientRect().bottom };
    });
    assert(r.pad !== "auto" && r.top >= r.header, JSON.stringify(r));
  }));

  await test("U3 the scanner's sign-in box is readable (light dialog on the dark venue page)", () => onPage(PHONE, [], "/scan", async (p) => {
    await p.locator("dialog[open]").waitFor();
    const low = (await p.evaluate(pageAudit, { phone: true })).contrast;
    assert(!low.length, low.join("; "));
    const forgot = await p.evaluate(() => { const d = document.querySelector("dialog[open]"); const f = d.querySelector("[data-forgot]"); return f ? [getComputedStyle(f).color, getComputedStyle(d).backgroundColor] : null; });
    assert(forgot && (await ratioOf(p, forgot[0], forgot[1])) >= 4.5, `Forgot password? ${forgot}`);
  }));

  await test("U4 free checkout has no payment step, fees, promo box or 'By paying'", () => onPage(PHONE, [], `/events/${SEED.events.free.slug}/tickets`, async (p) => {
    const steps = await p.locator(".tix-steps li").allInnerTexts();
    assert(!steps.some((s) => /^Pay$/.test(s.trim())), `steps: ${steps.join(" / ")}`);
    await p.locator("button", { hasText: "+" }).first().click();
    const cart = await p.locator(".tix-cart").innerText();
    assert(!/Booking fee/.test(cart) && /Free/.test(cart), cart.replace(/\s+/g, " "));
    await p.locator("button:visible", { hasText: /^Continue/ }).first().click();
    await p.locator("#pay").waitFor();
    const box = await p.locator("#box").innerText();
    assert(!(await p.locator("#promo").count()), "promo code box shown");
    assert(!/By paying|Service fee|Subtotal/.test(box) && /By registering/.test(box), box.replace(/\s+/g, " ").slice(0, 400));
  }));

  await test("U5 amber labels and date badges are readable on white", () => onPage(PHONE, [], "/", async (p) => {
    const pairs = await p.evaluate(() => [...document.querySelectorAll(".event-card .cat-label, .datebadge span")].slice(0, 6).map((e) => {
      let b = e; while (b && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(b).backgroundColor)) b = b.parentElement;
      return [getComputedStyle(e).color, getComputedStyle(b).backgroundColor, e.textContent];
    }));
    assert(pairs.length, "no event cards");
    for (const [f, b, t] of pairs) { const r = await ratioOf(p, f, b); assert(r >= 4.5, `"${t}" ${r.toFixed(2)}:1`); }
  }));

  await test("U6 an event with no poster or description: a marked poster, no empty Details card", () => onPage(DESK, [], preview, async (p) => {
    const r = await p.evaluate(() => ({ mark: document.querySelector(".ev2-banner .poster-mark")?.innerText || "", heads: [...document.querySelectorAll(".ev2-sec h2")].map((h) => h.textContent) }));
    assert(/Arts & theatre/i.test(r.mark), `poster mark: "${r.mark}"`);
    assert(!r.heads.includes("Details"), `sections: ${r.heads.join(", ")}`);
  }));

  await test("U7 categories are shown by name, not as raw keys", async () => {
    await onPage(DESK, sessions.organiser, "/organisers#/events/new", async (p) => {
      await p.locator("#category").waitFor();
      const opts = await p.locator("#category option").allInnerTexts();
      assert(opts.includes("Arts & theatre") && !opts.some((o) => /^[a-z]/.test(o)), opts.join(", "));
    });
    await onPage(DESK, [], `/events/${SEED.events.paid.slug}`, async (p) => {
      const t = await p.locator(".cat-badge").innerText();
      assert(/^music$/i.test(t.trim()) && (await p.locator(".cat-badge").evaluate((e) => e.textContent.trim())) === "Music", t);
    });
  });

  await test("U8/N2 at 390 the ticket fits the screen and the Help button never sits on the QR code", () => onPage(PHONE, sessions.customer, "/account#/tickets", async (p) => {
    await p.locator(".ticket .t-qr img").first().waitFor();
    await p.waitForTimeout(400);
    const r = await p.evaluate(() => {
      const t = document.querySelector(".ticket");
      t.scrollIntoView({ block: "start" });
      const box = (e) => { const b = e?.getBoundingClientRect(); return b && { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
      return { ticket: box(t), qr: box(t.querySelector(".t-qr")), fab: box(document.querySelector(".chat-fab")), fabPos: document.querySelector(".chat-fab") ? getComputedStyle(document.querySelector(".chat-fab")).position : null, vh: innerHeight };
    });
    assert(r.ticket.h <= 844 - 64 - 56, `ticket is ${Math.round(r.ticket.h)}px tall`);
    assert(r.qr.bottom <= r.vh, `QR code runs off the screen (${Math.round(r.qr.bottom)} > ${r.vh})`);
    const over = r.fab && r.fabPos === "fixed" && !(r.fab.right < r.qr.left || r.fab.left > r.qr.right || r.fab.bottom < r.qr.top || r.fab.top > r.qr.bottom);
    assert(!over, `Help button over the QR code: ${JSON.stringify(r)}`);
  }));

  await test("U9 keyboard focus on an amber button is clearly visible", () => onPage(DESK, [], "/sell", async (p) => {
    await p.keyboard.press("Tab");
    const r = await p.evaluate(() => { const b = document.querySelector("main .btn-primary"); b.focus(); const s = getComputedStyle(b); return { visible: b.matches(":focus-visible"), style: s.outlineStyle, ring: s.outlineColor, bg: s.backgroundColor }; });
    assert(r.visible && r.style !== "none", JSON.stringify(r));
    const c = await ratioOf(p, r.ring, r.bg);
    assert(c >= 3, `focus ring ${r.ring} on ${r.bg}: ${c.toFixed(2)}:1`);
  }));

  // The sideways menu strip became a bottom tab bar on phones (tests/app.js A3):
  // nothing is hidden off the edge any more, and Account opens every section.
  await test("U11 the portal menu on a phone shows everything there is (tab bar, then Account)", () => onPage(PHONE, sessions.customer, "/account#/tickets", async (p) => {
    const r = await p.evaluate(() => ({ strip: getComputedStyle(document.querySelector(".side") || document.querySelector("#sidenav")).display, tabs: [...document.querySelectorAll(".tabbar a, .tabbar button")].map((e) => e.innerText.trim()), over: document.querySelector(".tabbar").scrollWidth > document.querySelector(".tabbar").clientWidth + 1 }));
    assert(r.strip === "none" && r.tabs.length === 4 && r.tabs[3] === "Account" && !r.over, JSON.stringify(r));
    await p.locator(".tabbar .tab-more").click();
    const menu = await p.$$eval("dialog[open] .sheet-nav a", (as) => as.map((a) => a.getAttribute("href")));
    const all = await p.$$eval("#sidenav a", (as) => as.map((a) => a.getAttribute("href")));
    assert(all.every((h) => menu.includes(h)), `missing from Account: ${all.filter((h) => !menu.includes(h))}`);
  }));

  await test("U13 the preview bar stays below the sticky header", () => onPage(PHONE, [], preview, async (p) => {
    await p.locator(".preview-bar").waitFor();
    await p.evaluate(() => window.scrollTo(0, 600)); await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({ bar: document.querySelector(".preview-bar").getBoundingClientRect().top, header: document.querySelector(".site-header").getBoundingClientRect().bottom }));
    assert(r.bar >= r.header - 1, JSON.stringify(r));
  }));

  await test("U15 a search with no results says so and offers to clear it", () => onPage(DESK, [], "/?q=zzqxv", async (p) => {
    await p.locator("[data-no-results]").waitFor({ timeout: 8000 });
    const t = await p.locator("[data-no-results]").innerText();
    assert(/No events found for "zzqxv"/.test(t), t);
    await p.locator("[data-clear-search]").click(); await settle(p);
    assert(await p.locator(".event-card").count(), "events not back after clearing");
  }));

  await test("U17 portals use one money format and correct plurals", async () => {
    await onPage(DESK, sessions.admin, "/admin#/", async (p) => {
      const t = await p.locator("main").innerText();
      assert(!/\b1 orders\b|\b1 approved organisers\b/.test(t), t.match(/.{0,20}\b1 \w+s\b.{0,10}/)?.[0]);
    });
    await onPage(DESK, sessions.organiser, "/organisers#/", async (p) => {
      const t = await p.locator("main").innerText();
      const bare = t.match(/(?<![A-Za-z0-9-])R\d{1,3}(?: \d{3})*(?![.\dA-Za-z])/g);
      assert(!bare, `amounts without cents: ${bare}`);
    });
  });

  await test("U18 the poster file picker is styled like the other buttons", () => onPage(DESK, sessions.organiser, "/organisers#/events/new", async (p) => {
    const r = await p.evaluate(() => { const i = document.querySelector('main input[type="file"]'); if (!i) return null; const s = getComputedStyle(i, "::file-selector-button"); return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, weight: s.fontWeight }; });
    assert(r && r.radius === "10px" && Number(r.weight) >= 700, JSON.stringify(r));
  }));

  await test("U19/U26 the sell page: calm wording, six tiles, cashless told once", () => onPage(DESK, [], "/sell", async (p) => {
    // The site notice (admin-set, shown on public pages) is not part of the sell page copy.
    const t = await p.locator("main").evaluate((m) => { const c = m.cloneNode(true); c.querySelector(".site-banner")?.remove(); return c.innerText; });
    assert(!/no surprises|in seconds|sorted/i.test(t), t.match(/.{0,30}(no surprises|in seconds|sorted).{0,20}/i)?.[0]);
    const tiles = await p.locator(".tiles > *:visible").count();
    assert(tiles % 3 === 0, `${tiles} tiles leave an orphan`);
    const mentions = (t.match(/cashless/gi) || []).length;
    assert(mentions <= 4, `cashless mentioned ${mentions} times`);
  }));

  await test("U21 the organiser dashboard greets the person, with one Create event button", () => onPage(DESK, sessions.organiser, "/organisers#/", async (p) => {
    const me = await F.org.call("GET", "/api/auth/me");
    const first = String(me.user.full_name || me.user.fullName).split(/\s+/)[0];
    const h1 = (await p.locator("main h1").first().innerText()).trim();
    assert(h1 === `Hi, ${first}`, h1);
    const n = await p.locator("a:visible, button:visible", { hasText: /^\+?\s*Create event$/ }).count();
    assert(n === 1, `${n} visible Create event buttons`);
  }));

  await test("U22 opening hours and badges: no en dashes, badges in sentence case", async () => {
    await onPage(DESK, [], "/contact", async (p) => {
      const t = await p.evaluate(() => document.body.innerText);
      assert(!/\d(am|pm)?\s?–\s?\d|[A-Z][a-z]{2}–[A-Z]/.test(t), t.match(/.{0,20}–.{0,20}/)?.[0]);
    });
    await onPage(DESK, sessions.organiser, "/organisers#/", async (p) => {
      const b = await p.locator(".badge").allInnerTexts();
      assert(b.length && b.every((x) => /^[A-Z0-9]/.test(x.trim())), b.join(", "));
    });
  });

  await test("U23 a free event's page shows no internal codes and no refund line", () => onPage(DESK, [], `/events/${SEED.events.free.slug}`, async (p) => {
    const t = await p.locator("main").innerText();
    assert(!/\bEV-[A-Z0-9]|\bORG-[A-Z0-9]|Refund policy|non-refundable/i.test(t), t.match(/.{0,30}(EV-|ORG-|Refund policy|non-refundable).{0,30}/i)?.[0]);
  }));

  await test("U24 the audit log and ledger read as words, not JSON and account codes", async () => {
    await onPage(DESK, sessions.admin, "/admin#/audit", async (p) => {
      const t = await p.locator("main").innerText();
      assert(!/\{"/.test(t) && /[A-Za-z]: /.test(t), t.match(/.{0,40}\{".{0,40}/)?.[0] || "no details shown");
    });
    await onPage(DESK, sessions.admin, "/admin#/", async (p) => {
      const t = await p.locator("main").innerText();
      assert(!/resale:sellers|payable:/.test(t) && /Resale sellers/.test(t), t.slice(0, 300));
    });
  });

  await test("copy: no filler words, emoji, exclamation marks or em dashes in the live package's visible strings", () => {
    // Every page, script, email template, legal text and help answer, with code comments left out.
    const root = path.resolve(__dirname, "../../public_html");
    const hits = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(html|js|php|json|txt)$/.test(f) && !/jsQR|\.min\./.test(f)) check(p); } };
    const check = (file) => fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*|#).*$/, "").replace(/\s\/\/ .*$/, "");
      if (!code.trim()) return;
      const bad = [...code.matchAll(HYPE)].map((m) => m[0]);
      if (/—/.test(code)) bad.push("em dash");
      if (/[a-z)]![\s"'`<\\]/i.test(code.replace(/!=/g, ""))) bad.push("!");
      if (bad.length) hits.push(`${path.relative(root, file)}:${i + 1} ${bad.join(", ")}: ${code.trim().slice(0, 90)}`);
    });
    walk(root);
    assert(!hits.length, `${hits.length} line(s):\n  ${hits.slice(0, 30).join("\n  ")}`);
  });

  await test("Help: the floating button and the panel use the support headset, labelled Help and support", async () => {
    const HEADSET = "M4 14v-2a8 8 0 0 1 16 0v2";
    let seen = 0;
    for (const size of WIDTHS) for (const [url, cookies] of [["/", []], ["/account#/tickets", sessions.customer], ["/organisers#/", sessions.organiser], ["/admin#/", sessions.admin], ["/scan", sessions.staff], ["/pos", sessions.vendor], ["/retail", sessions.retail]]) {
      await onPage(size, cookies, url, async (p) => {
        const fab = p.locator(".chat-fab");
        if (!(await fab.count())) return;
        seen++;
        const r = await fab.evaluate((b, d) => ({ label: b.getAttribute("aria-label"), icon: !!b.querySelector(`svg path[d="${d}"]`), bubble: !!b.querySelector('svg path[d^="M21 12a8 8"]'), h: b.getBoundingClientRect().height }), HEADSET);
        assert(r.label === "Help and support" && r.icon && !r.bubble, `${url} @${size[0]}: ${JSON.stringify(r)}`);
        assert(r.h >= 40, `${url} @${size[0]}: button ${r.h}px tall`);
        await fab.click();
        const head = await p.locator(".chat-panel > header").evaluate((h, d) => ({ icon: !!h.querySelector(`svg path[d="${d}"]`), text: h.innerText }), HEADSET);
        assert(head.icon && /Help and support/.test(head.text), `${url} panel header: ${JSON.stringify(head)}`);
      });
    }
    assert(seen >= 4, `the Help button showed on only ${seen} page(s)`);
  });

  await test("U25 green badges are readable and the line-up example uses no real artists", async () => {
    await onPage(DESK, sessions.organiser, "/organisers#/", async (p) => {
      const c = await p.locator(".badge.good").first().evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
      const r = await ratioOf(p, c[0], c[1]);
      assert(r >= 4.5, `badge ${r.toFixed(2)}:1`);
    });
    await onPage(DESK, sessions.organiser, "/organisers#/events/new", async (p) => {
      const ph = await p.locator("#lineup").getAttribute("placeholder");
      assert(!/Black Coffee|Sjava|Maphorisa/.test(ph), ph);
    });
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
