// Test events (Admin portal, Test event): a free event the TicketRoom team
// makes to try the whole journey on the real site. Against a local instance
// from dev/serve.sh:
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/testevent.js <dir> [port]
//
// TE1 create (staff only, audited), TE2 never listed publicly, TE3 booking
// (signed in and guest) with TEST EVENT on the pages, emails, My tickets and
// the saved image, TE4 transfer and waitlist, TE5 the gate admits with TEST
// EVENT (event team and admin, /scan?test=), TE6 practice scans, practice
// tickets and reset, TE7 KPIs and reports unchanged, TE8 delete is complete
// and cannot touch a real event, TE9 deleted 7 days after it ends.
// TR_ONLY=TE5 runs the tests whose name starts with that. TR_JOURNEY_DIR=<dir>
// also saves numbered phone-size screenshots of the journey there.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { Client, outbox, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.TR_JOURNEY_DIR ? path.resolve(process.env.TR_JOURNEY_DIR) : null;
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: testevent.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).split("\n")[0].slice(0, 400)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const one = (q, p = []) => sql(DATA, q, p)[0];
const count = (q, p = []) => Number(Object.values(one(q, p))[0]);
const stamp = Date.now().toString(36);
const uuid = () => crypto.randomUUID();
const PRELUDE = `error_reporting(E_ALL); require $argv[1] . '/public_html/api/bootstrap.php'; tr_load(); tr_load_routes();
function out($v) { echo json_encode($v, JSON_UNESCAPED_SLASHES); }
`;
const php = (code, ...args) => { const o = execFileSync("php", ["-r", PRELUDE + code, DIR, ...args.map(String)], { encoding: "utf8" }); try { return JSON.parse(o || "null"); } catch { return o; } };

async function signUp(email, name = "Test Friend") {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: name, email, password: `Tst-${crypto.randomBytes(12).toString("base64url")}`, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return c;
}
async function guest() { const c = new Client(BASE, DATA); await c.refreshCsrf(); return c; }
const book = (c, ev, ttId, qty = 1, extra = {}) => c.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ttId, quantity: qty }], idempotencyKey: uuid(), ...extra });
const kpis = async (admin) => { const d = await admin.call("GET", "/api/admin/dashboard"); return { users: d.users, organisers: d.organisers, events: d.events, sales: d.sales }; };
// Every table that can hold something of an event, and how to find its rows.
const OWNED = {
  orders: "SELECT count(*) FROM orders WHERE event_id = ?", order_items: "SELECT count(*) FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)",
  tickets: "SELECT count(*) FROM tickets WHERE event_id = ?", ticket_types: "SELECT count(*) FROM ticket_types WHERE event_id = ?",
  transfers: "SELECT count(*) FROM ticket_transfers WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = ?)", waitlist: "SELECT count(*) FROM waitlist_entries WHERE event_id = ?",
  scans: "SELECT count(*) FROM admission_log WHERE event_id = ?", replaced: "SELECT count(*) FROM replaced_codes WHERE event_id = ?", staff: "SELECT count(*) FROM event_staff WHERE event_id = ?",
  outbox: "SELECT count(*) FROM message_outbox WHERE event_id = ?", events: "SELECT count(*) FROM events WHERE id = ?",
};
const owned = (id) => Object.fromEntries(Object.entries(OWNED).map(([k, q]) => [k, count(q, [id])]));

let browser;
async function ctxFor(client, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {} });
  if (client) await ctx.addCookies(Object.entries(client.cookies).map(([name, value]) => ({ name, value, url: BASE })));
  return ctx;
}
const settle = (p) => p.waitForLoadState("networkidle").catch(() => {});
async function shot(p, name) {
  if (!SHOTS) return;
  // A clean picture: the site's announcement is dismissed as a visitor would.
  const hide = p.locator(".site-banner [data-hide]");
  if (await hide.count()) await hide.first().click().catch(() => {});
  await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }

(async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const org = new Client(BASE, DATA); await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  // Real accounts are made before the KPIs are noted (they are real people).
  const friendEmail = `te-friend+${stamp}@example.test`, scannerEmail = `te-scanner+${stamp}@example.test`;
  const friend = await signUp(friendEmail);
  const scanner = await signUp(scannerEmail, "Gate Helper");
  const realEv = { id: SEED.events.free.id, slug: SEED.events.free.slug };
  const realTt = one("SELECT id FROM ticket_types WHERE event_id = ? LIMIT 1", [realEv.id]).id;
  // A real booking and scan, to prove nothing of a real event is touched.
  const realOrder = (await book(friend, realEv, realTt)).order;
  const realTicket = one("SELECT t.* FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.reference = ?", [realOrder.reference]);
  const realScan = await org.call("POST", "/api/staff/scan", { eventId: realEv.id, payload: realTicket.code });
  const realScans = count("SELECT count(*) FROM admission_log WHERE event_id = ?", [realEv.id]);
  const before = await kpis(admin);
  const adminEventsBefore = (await admin.call("GET", "/api/admin/events")).events.length;
  const title = `TicketRoom test event ${stamp}`;
  let ev, tt1, tt2, custOrder, guestOrder, guestEmail;

  await test("TE1 create: staff only, a free published event of the built-in test organiser, with a poster, audited", async () => {
    await cust.call("POST", "/api/admin/test-events", {}, 403).catch(async () => { await cust.call("POST", "/api/admin/test-events", {}, 401); });
    await org.call("GET", "/api/admin/test-events", undefined, 403).catch(async () => { await org.call("GET", "/api/admin/test-events", undefined, 401); });
    const r = await admin.call("POST", "/api/admin/test-events", { title, quantity: 2, perPerson: 4, secondTicketName: "VIP test ticket", secondQuantity: 10 }, 201);
    ev = r.event;
    const row = one("SELECT e.*, o.is_test AS org_test, o.status AS org_status, o.name AS org_name FROM events e JOIN organisers o ON o.id = e.organiser_id WHERE e.id = ?", [ev.id]);
    assert(row.is_test === 1 && row.is_free === 1 && row.status === "published", `event flags ${JSON.stringify({ t: row.is_test, f: row.is_free, s: row.status })}`);
    assert(row.org_test === 1 && row.org_status === "approved" && row.org_name === "TicketRoom Test", `organiser ${row.org_name} ${row.org_status}`);
    const start = new Date(row.starts_at).getTime(), end = new Date(row.ends_at).getTime();
    assert(Math.abs(start - (Date.now() + 2 * 3600e3)) < 5 * 60e3 && Math.abs(end - (Date.now() + 6 * 3600e3)) < 5 * 60e3, `default times ${row.starts_at} ${row.ends_at}`);
    assert(/^ticketroom-test-event-[0-9a-f]{16}$/.test(row.slug), `private link ${row.slug}`);
    const types = sql(DATA, "SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order", [ev.id]);
    assert(types.length === 2 && types.every((t) => t.price_cents === 0) && types[0].quantity_total === 2 && types[0].per_order_limit === 4, `ticket types ${JSON.stringify(types.map((t) => [t.name, t.price_cents, t.quantity_total]))}`);
    [tt1, tt2] = types.map((t) => t.id);
    assert(row.image_upload_id, "no poster");
    const img = await fetch(`${BASE}/media/${row.image_upload_id}`);
    assert(img.status === 200 && /image\/png/.test(img.headers.get("content-type")), `poster ${img.status}`);
    assert(count("SELECT count(*) FROM audit_log WHERE action = 'test_event.created' AND entity_id = ?", [ev.id]) === 1, "not audited");
    // A second one reuses the same built-in organiser.
    const r2 = await admin.call("POST", "/api/admin/test-events", { title: `Second ${title}`, startsAt: new Date(Date.now() + 3600e3).toISOString(), endsAt: new Date(Date.now() + 5 * 3600e3).toISOString() }, 201);
    assert(count("SELECT count(*) FROM organisers WHERE is_test = 1") === 1, "a second test organiser was made");
    await admin.call("DELETE", `/api/admin/test-events/${r2.event.id}`, { confirm: "DELETE" });
  });

  await test("TE1 admin page: sidebar item, private link with Copy and an on-page QR code", async () => {
    const ctx = await ctxFor(admin); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/admin#/test-event`); await settle(p);
      await p.locator(`[data-te="${ev.id}"] [data-te-qr] svg`).waitFor({ timeout: 10000 });
      const nav = await p.locator('#sidenav a[href="#/test-event"]').count();
      const link = await p.locator(`[data-te="${ev.id}"] input[readonly]`).inputValue();
      const copy = await p.locator(`[data-te="${ev.id}"] [data-te-copy]`).count();
      const icon = await p.evaluate(() => getComputedStyle(document.querySelector('#sidenav a[href="#/test-event"]')).getPropertyValue("--ico").includes("svg"));
      assert(nav === 1 && icon, "no sidebar item with an icon");
      assert(link === `${BASE}/events/${ev.slug}` && copy === 1, `link ${link}`);
      await p.evaluate(() => window.scrollTo(0, 0));
      await shot(p, "01-admin-test-event");
    } finally { await ctx.close(); }
  });

  await test("TE2 never listed: public API listings, filters, trending, recently viewed, home and search pages", async () => {
    const anon = await guest();
    const queries = ["", "?q=" + encodeURIComponent(title), "?q=TicketRoom", "?free=1", "?categories=other", "?city=Johannesburg", "?province=Gauteng", "?when=today", "?when=week", "?when=month", "?near=Johannesburg&km=100", "?offset=0&maxPrice=0"];
    for (const q of queries) {
      const r = await anon.call("GET", `/api/public/events${q}`);
      assert(!r.events.some((e) => e.id === ev.id || e.slug === ev.slug), `listed in /api/public/events${q}`);
      assert(!(r.cities || []).some((c) => c.city === "Johannesburg"), `city filter shows the test event's city (${q})`);
    }
    const tr = await anon.call("GET", "/api/public/artists/trending");
    assert(!JSON.stringify(tr).includes(ev.slug), "in trending artists");
    const v = await cust.call("POST", `/api/public/events/${ev.slug}/view`, {});
    assert(v.saved === false, "saved to recently viewed");
    const rv = await cust.call("GET", "/api/public/recently-viewed");
    assert(!JSON.stringify(rv).includes(ev.slug), "in recently viewed");
    // Reachable only by its private link.
    const d = await anon.call("GET", `/api/public/events/${ev.slug}`);
    assert(d.event.is_test === 1 && d.event.salesOpen, "the private link does not open it");
    for (const pth of ["/sitemap.xml", "/robots.txt"]) { const t = await (await fetch(BASE + pth)).text(); assert(!t.includes(ev.slug), `${pth} names it`); }
    const ctx = await ctxFor(null, 1366); const p = await ctx.newPage();
    try {
      for (const u of ["/", `/?q=${encodeURIComponent("TicketRoom test")}`, "/?free=1", "/organisers", "/sell"]) {
        await p.goto(BASE + u); await settle(p); await p.waitForTimeout(400);
        const html = await p.content();
        assert(!html.includes(title) && !html.includes(ev.slug), `page ${u} shows the test event`);
      }
    } finally { await ctx.close(); }
    // Marketing: never in abandoned-checkout mail or an organiser audience.
    assert(count("SELECT count(*) FROM organiser_members WHERE organiser_id = (SELECT organiser_id FROM events WHERE id = ?)", [ev.id]) === 0, "the test organiser has members");
  });

  await test("TE3 booking signed in: event page, tickets page and order page say TEST EVENT; email labelled; My tickets and saved image", async () => {
    const ctx = await ctxFor(cust); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/events/${ev.slug}`); await settle(p);
      assert(/TEST EVENT/.test(await p.locator("[data-test-event]").first().innerText()), "no TEST EVENT band on the event page");
      assert(await p.locator('meta[name="robots"][content="noindex"]').count() === 1, "event page is indexable");
      await shot(p, "02-event-page");
      await p.goto(`${BASE}/events/${ev.slug}/tickets`); await settle(p);
      assert(await p.locator("[data-test-event]").count() >= 1, "no TEST EVENT band on the tickets page");
      await p.locator("button", { hasText: "+" }).first().click();
      await shot(p, "03-choose-tickets");
      const since = new Date(Date.now() - 1000).toISOString();
      await p.locator("button:visible", { hasText: /^Continue/ }).first().click();
      await Promise.race([p.waitForURL(/\/orders\//, { timeout: 15000 }), p.locator("#pay button[type=submit]").waitFor({ timeout: 15000 })]);
      if (!/\/orders\//.test(p.url())) await p.locator("#pay button[type=submit]").click();
      await p.waitForURL(/\/orders\//, { timeout: 15000 }); await settle(p);
      const ref = p.url().match(/\/orders\/([^?#]+)/)[1];
      custOrder = one("SELECT * FROM orders WHERE reference = ?", [ref]);
      assert(custOrder.status === "paid" && custOrder.total_cents === 0 && custOrder.test === 0, `order ${JSON.stringify(custOrder)}`);
      assert(/TEST EVENT/.test(await p.locator("main").innerText()), "order page has no TEST EVENT label");
      const mail = sql(DATA, "SELECT subject, body, event_id FROM message_outbox WHERE lower(to_address) = lower(?) AND created_at > ? ORDER BY created_at DESC", [SEED.customer.email, since])[0];
      assert(mail && /^\[TEST EVENT\]/.test(mail.subject) && /^TEST EVENT:/.test(mail.body) && mail.event_id === ev.id, `email ${JSON.stringify(mail && { s: mail.subject, e: mail.event_id })}`);
      // My tickets, and the saved ticket image carries the band.
      await p.goto(`${BASE}/account#/tickets`); await settle(p);
      await p.locator(".ticket [data-test-event]").first().waitFor({ timeout: 10000 });
      await p.evaluate(() => window.scrollTo(0, 0));
      await shot(p, "07-my-tickets");
      const box = p.locator('[data-wallet][data-test-event="1"]').first();
      await box.locator("[data-img]").waitFor();
      const [dl] = await Promise.all([p.waitForEvent("download"), box.locator("[data-img]").click()]);
      const file = path.join(DIR, `te-ticket-${stamp}.png`);
      await dl.saveAs(file);
      const heights = await p.evaluate(async () => {
        const { ticketPng } = await import("/assets/core.js");
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
        const h = async (o) => { const b = await ticketPng(svg, { title: "T", when: "W", place: "P", code: "C", rows: [["Ticket", "x"]], ...o }); const i = await createImageBitmap(b); return i.height; };
        return [await h({}), await h({ testEvent: true })];
      });
      assert(fs.statSync(file).size > 1000 && heights[1] - heights[0] === 96, `saved image band ${heights}`);
      if (SHOTS) {
        const pg = await ctx.newPage(); await pg.setViewportSize({ width: 390, height: 844 });
        await pg.setContent(`<body style="margin:0;background:#EEF2F9"><img src="data:image/png;base64,${fs.readFileSync(file).toString("base64")}" style="width:390px;display:block"></body>`);
        await shot(pg, "08-saved-ticket-image"); await pg.close();
        const htmlMail = php("out(email_html($argv[2], $argv[3]));", mail.subject, mail.body);
        await pg.close().catch(() => {});
        const pm = await ctx.newPage(); await pm.setViewportSize({ width: 390, height: 844 }); await pm.setContent(htmlMail); await shot(pm, "06-confirmation-email"); await pm.close();
      }
    } finally { await ctx.close(); }
  });

  await test("TE3 booking as a guest: order page and email labelled TEST EVENT", async () => {
    guestEmail = `te-guest+${stamp}@example.test`;
    const ctx = await ctxFor(null); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/events/${ev.slug}/tickets`); await settle(p);
      // The second (VIP) ticket type, so the first one is left for the waitlist test.
      await p.locator("button", { hasText: "+" }).nth(1).click();
      await p.locator("button:visible", { hasText: /^Continue/ }).first().click();
      await p.locator("#pay").waitFor();
      await p.fill("#g-name", "Guest Tester"); await p.fill("#g-email", guestEmail); await p.fill("#g-email2", guestEmail);
      await shot(p, "04-checkout-details");
      await p.locator("#pay button[type=submit]").click();
      await p.waitForURL(/\/orders\//, { timeout: 15000 }); await settle(p);
      await p.locator(".ticket").first().waitFor({ timeout: 15000 });
      assert(await p.locator(".ticket [data-test-event]").count() >= 1 && /TEST EVENT/.test(await p.locator("main").innerText()), "guest order page has no TEST EVENT label");
      await p.evaluate(() => window.scrollTo(0, 0));
      await shot(p, "05-order-confirmed");
      guestOrder = one("SELECT * FROM orders WHERE reference = ?", [p.url().match(/\/orders\/([^?#]+)/)[1]]);
      const m = outbox(DATA, guestEmail, /^TEST EVENT: [\s\S]*View your tickets: (\S+)/);
      assert(m, "guest email");
      const subj = one("SELECT subject FROM message_outbox WHERE lower(to_address) = lower(?) ORDER BY created_at DESC LIMIT 1", [guestEmail]).subject;
      assert(/^\[TEST EVENT\] Your free ticket/.test(subj), `subject ${subj}`);
    } finally { await ctx.close(); }
  });

  await test("TE4 transfer and waitlist work as for a real free event", async () => {
    const t = one("SELECT * FROM tickets WHERE order_id = ? LIMIT 1", [custOrder.id]);
    const tr = await cust.call("POST", `/api/me/tickets/${t.id}/transfer`, { toEmail: friendEmail });
    const offer = one("SELECT subject, event_id FROM message_outbox WHERE lower(to_address) = lower(?) ORDER BY created_at DESC LIMIT 1", [friendEmail]);
    assert(/^\[TEST EVENT\]/.test(offer.subject) && offer.event_id === ev.id, `transfer email ${JSON.stringify(offer)}`);
    await friend.call("POST", "/api/me/transfers/claim", { transferId: tr.transfer?.id || tr.id });
    const now = one("SELECT owner_user_id, code FROM tickets WHERE id = ?", [t.id]);
    assert(now.code !== t.code && now.owner_user_id === one("SELECT id FROM users WHERE lower(email) = lower(?)", [friendEmail]).id, "transfer did not move the ticket");
    // Sell out the first type (2 tickets): one more for the customer, then the waitlist.
    await book(cust, ev, tt1, 1);
    const left = one("SELECT quantity_total - quantity_sold - quantity_held AS n FROM ticket_types WHERE id = ?", [tt1]).n;
    assert(left === 0, `not sold out (${left} left)`);
    await book(scanner, ev, tt1, 1, {}).then(() => { throw new Error("booked a sold-out ticket"); }, (e) => assert(/409/.test(e.message), e.message));
    const w = await scanner.call("POST", `/api/public/events/${ev.slug}/waitlist`, { ticketTypeId: tt1 }, 201);
    assert(w.waitlist && ["waiting", "offered"].includes(w.waitlist.status), `waitlist ${JSON.stringify(w)}`);
  });

  await test("TE5 the gate: event team and the admin (/scan?test=) ADMIT with TEST EVENT; real events and sandbox test tickets unchanged", async () => {
    await admin.call("POST", `/api/admin/test-events/${ev.id}/staff`, { email: scannerEmail });
    await admin.call("POST", `/api/admin/test-events/${ev.id}/staff`, { email: ADMIN_EMAIL }, 409);
    assert(count("SELECT count(*) FROM audit_log WHERE action = 'test_event.staff_added' AND entity_id = ?", [ev.id]) === 1, "staff add not audited");
    const evs = (await scanner.call("GET", "/api/staff/events")).events;
    assert(evs.some((e) => e.id === ev.id && e.can_scan), "the event team member does not see the test event");
    const t = one("SELECT * FROM tickets WHERE order_id = ? AND status = 'valid' LIMIT 1", [guestOrder.id]);
    // The event team member at /scan: choose the event, ADMIT, then ALREADY SCANNED.
    const ctx = await ctxFor(scanner); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/scan`); await settle(p);
      await p.locator(`[data-ev="${ev.id}"]`).waitFor({ timeout: 10000 });
      await shot(p, "09-scanner-choose-event");
      await p.locator(`[data-ev="${ev.id}"]`).click();
      await p.locator("#mc").waitFor();
      await p.fill("#mc", t.code); await p.press("#mc", "Enter");
      await p.waitForFunction(() => /ADMIT/.test(document.querySelector("#verdict")?.innerText || ""), null, { timeout: 10000 });
      const v1 = await p.locator("#verdict").innerText();
      assert(/ADMIT/.test(v1) && /TEST EVENT/.test(v1), `first scan: ${v1}`);
      await p.locator("#verdict").scrollIntoViewIfNeeded(); await shot(p, "10-scanner-admit");
      await p.fill("#mc", t.code); await p.press("#mc", "Enter");
      await p.waitForFunction(() => /ALREADY/.test(document.querySelector("#verdict")?.innerText || ""), null, { timeout: 10000 });
      assert(/ALREADY SCANNED/.test(await p.locator("#verdict").innerText()), "second scan");
      await p.locator("#verdict").scrollIntoViewIfNeeded(); await shot(p, "11-scanner-already-scanned");
    } finally { await ctx.close(); }
    // The admin: /scan?test=<id> opens straight on the event and admits.
    const t2 = one("SELECT t.* FROM tickets t WHERE t.event_id = ? AND t.status = 'valid' ORDER BY created_at LIMIT 1", [ev.id]);
    const actx = await ctxFor(admin); const ap = await actx.newPage();
    try {
      await ap.goto(`${BASE}/scan?test=${ev.id}`); await settle(ap);
      await ap.locator("#mc").waitFor({ timeout: 10000 });
      await ap.fill("#mc", t2.code); await ap.press("#mc", "Enter");
      await ap.waitForFunction(() => !/READY/.test(document.querySelector("#verdict")?.innerText || "READY"), null, { timeout: 10000 });
      const v = await ap.locator("#verdict").innerText();
      assert(/ADMIT/.test(v) && /TEST EVENT/.test(v), `admin scan: ${v}`);
      // Without ?test= the scanner is still not for staff accounts.
      await ap.goto(`${BASE}/scan`); await settle(ap);
      assert(/isn't for this account/.test(await ap.locator("main").innerText()), "the scanner accepts a staff account without ?test=");
    } finally { await actx.close(); }
    // Through the API: the admin may scan test events only.
    const adminEvents = (await admin.call("GET", "/api/staff/events")).events;
    assert(adminEvents.length && adminEvents.every((e) => e.is_test === 1), "the admin's scanner lists a real event");
    await admin.call("POST", "/api/staff/scan", { eventId: realEv.id, payload: realTicket.code }, 404);
    // Real events answer as before (no TEST EVENT).
    assert(realScan.outcome === "admitted" && !("testEvent" in realScan), `real scan ${JSON.stringify(realScan)}`);
  });

  await test("TE6 practice scans, practice tickets and reset scans (admin only, audited, test events only)", async () => {
    const ps = (kind, code) => admin.call("POST", `/api/admin/test-events/${ev.id}/practice-scan`, { kind, code });
    const pt = await admin.call("POST", `/api/admin/test-events/${ev.id}/practice-tickets`, {}, 201);
    assert(pt.tickets.filter((t) => t.status === "valid" && t.svg && t.svg.includes("<svg")).length === 4, `practice tickets ${pt.tickets.length}`);
    const valid = await ps("valid");
    assert(valid.result.outcome === "admitted" && valid.result.testEvent === true, `valid ${JSON.stringify(valid.result)}`);
    const again = await ps("again");
    assert(again.result.outcome === "already_used" && again.result.admittedAt, `again ${JSON.stringify(again.result)}`);
    assert((await ps("madeup")).result.outcome === "invalid", "made-up code");
    assert((await ps("replaced")).result.outcome === "replaced", "replaced code");
    assert((await ps("wrong_event")).result.outcome === "wrong_event", "wrong event");
    const code = one("SELECT code FROM tickets WHERE event_id = ? AND status = 'valid' AND holder_name LIKE 'Practice ticket%' LIMIT 1", [ev.id]).code;
    const typed = await ps("typed", code);
    assert(["admitted", "already_used"].includes(typed.result.outcome) && typed.result.testEvent, `typed ${JSON.stringify(typed.result)}`);
    // The real ticket used for "another event" is unchanged.
    assert(one("SELECT status, code FROM tickets WHERE id = ?", [realTicket.id]).status === "used", "real ticket changed");
    const used = count("SELECT count(*) FROM tickets WHERE event_id = ? AND status = 'used'", [ev.id]);
    const reset = await admin.call("POST", `/api/admin/test-events/${ev.id}/reset-scans`, {});
    assert(reset.reset === used && count("SELECT count(*) FROM tickets WHERE event_id = ? AND status = 'used'", [ev.id]) === 0, `reset ${reset.reset} of ${used}`);
    assert(count("SELECT count(*) FROM audit_log WHERE action IN ('test_event.practice_scan','test_event.practice_tickets','test_event.scans_reset') AND entity_id = ?", [ev.id]) >= 8, "practice not audited");
    // Never for a real event, never for anyone but an admin.
    for (const [m, u, b] of [["POST", `/api/admin/test-events/${realEv.id}/practice-scan`, { kind: "valid" }], ["POST", `/api/admin/test-events/${realEv.id}/practice-tickets`, {}], ["POST", `/api/admin/test-events/${realEv.id}/reset-scans`, {}], ["POST", `/api/admin/test-events/${realEv.id}/staff`, { email: scannerEmail }]]) await admin.call(m, u, b, 404);
    await cust.call("POST", `/api/admin/test-events/${ev.id}/reset-scans`, {}, 403).catch(() => cust.call("POST", `/api/admin/test-events/${ev.id}/reset-scans`, {}, 401));
    // The panel in the admin portal shows the answer as the scanner would.
    const ctx = await ctxFor(admin); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/admin#/test-event`); await settle(p);
      const box = p.locator(`[data-te="${ev.id}"]`);
      await box.locator('[data-te-scan="valid"]').click();
      await p.waitForFunction((id) => /ADMIT/.test(document.querySelector(`[data-te="${id}"] [data-te-verdict]`)?.innerText || ""), ev.id, { timeout: 10000 });
      assert(/TEST EVENT/.test(await box.locator("[data-te-verdict]").innerText()), "panel verdict has no TEST EVENT");
      await box.locator("[data-te-practice]").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await shot(p, "12-practice-scans");
      await box.locator("[data-te-print]").click();
      await p.locator("[data-practice-tickets] .ticket").first().waitFor({ timeout: 10000 });
      assert(await p.locator("[data-practice-tickets] .ticket svg").count() === 4, "printable page does not have 4 QR tickets");
    } finally { await ctx.close(); }
  });

  await test("TE7 KPIs, admin lists and reports leave test events out", async () => {
    const after = await kpis(admin);
    assert(JSON.stringify(after) === JSON.stringify(before), `dashboard changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    const evs = (await admin.call("GET", "/api/admin/events")).events;
    assert(!evs.some((e) => e.id === ev.id) && evs.length === adminEventsBefore, "test event in All events");
    const orgs = (await admin.call("GET", "/api/admin/organisers")).organisers;
    assert(!orgs.some((o) => o.name === "TicketRoom Test"), "test organiser in Organiser accounts");
    // Organiser audiences (marketing) never include it.
    const aud = php("out(count(org_audience($argv[2], 'email', [])));", one("SELECT organiser_id FROM events WHERE id = ?", [ev.id]).organiser_id);
    assert(aud === 0, `audience ${aud}`);
    // Finance: free test events add no payments, refunds, payouts or ledger entries.
    assert(count("SELECT count(*) FROM payments WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)", [ev.id]) === 0, "payments");
    assert(count("SELECT count(*) FROM ledger_entries WHERE account LIKE ?", [`%${one("SELECT organiser_id FROM events WHERE id = ?", [ev.id]).organiser_id}%`]) === 0, "ledger");
  });

  await test("TE8 delete: confirm needed, everything of the test event goes, a real event cannot be deleted", async () => {
    const was = owned(ev.id);
    assert(was.orders && was.tickets && was.transfers && was.waitlist && was.scans && was.outbox && was.staff && was.replaced, `nothing to delete? ${JSON.stringify(was)}`);
    const guestId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [guestEmail]).id;
    const poster = one("SELECT image_upload_id FROM events WHERE id = ?", [ev.id]).image_upload_id;
    await admin.call("DELETE", `/api/admin/test-events/${ev.id}`, {}, 422).catch(() => admin.call("DELETE", `/api/admin/test-events/${ev.id}`, {}, 400));
    await admin.call("DELETE", `/api/admin/test-events/${realEv.id}`, { confirm: "DELETE" }, 404);
    const r = await admin.call("DELETE", `/api/admin/test-events/${ev.id}`, { confirm: "DELETE" });
    assert(r.deleted, "not deleted");
    const now = owned(ev.id);
    assert(Object.values(now).every((n) => n === 0), `left behind: ${JSON.stringify(now)}`);
    assert(!one("SELECT id FROM users WHERE id = ?", [guestId]), "the guest account made for it is still there");
    assert(!one("SELECT id FROM uploads WHERE id = ?", [poster]), "poster upload left");
    assert((await fetch(`${BASE}/api/public/events/${ev.slug}`)).status === 404, "event page still opens");
    assert(count("SELECT count(*) FROM audit_log WHERE action = 'test_event.deleted' AND entity_id = ?", [ev.id]) === 1, "delete not audited");
    // Real data untouched: the real event, its booking and scans, the real accounts.
    assert(count("SELECT count(*) FROM events WHERE id = ?", [realEv.id]) === 1 && count("SELECT count(*) FROM admission_log WHERE event_id = ?", [realEv.id]) === realScans, "real event or its scans changed");
    assert(one("SELECT status FROM tickets WHERE id = ?", [realTicket.id]).status === "used", "real ticket changed");
    assert(one("SELECT id FROM users WHERE lower(email) = lower(?)", [friendEmail]), "a real account was deleted");
    // The database itself refuses to delete a real event or a real scan.
    for (const q of ["DELETE FROM events WHERE id = ?", "DELETE FROM admission_log WHERE event_id = ?"]) {
      const said = php("try { q($argv[2], [$argv[3]]); out('deleted'); } catch (Throwable $e) { out($e->getMessage()); }", q, realEv.id);
      assert(/only test events|append-only/.test(said), `${q} was not refused: ${said}`);
    }
    assert(JSON.stringify(await kpis(admin)) === JSON.stringify(before), "KPIs changed after the delete");
  });

  await test("TE9 test events are deleted on their own 7 days after they end (and not before)", async () => {
    const mk = async (t) => (await admin.call("POST", "/api/admin/test-events", { title: t }, 201)).event;
    const old = await mk(`Old ${title}`), recent = await mk(`Recent ${title}`);
    await book(cust, old, one("SELECT id FROM ticket_types WHERE event_id = ? LIMIT 1", [old.id]).id);
    const at = (d) => new Date(Date.now() + d * 86400e3).toISOString();
    sql(DATA, "UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?", [at(-9), at(-8), old.id]);
    sql(DATA, "UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?", [at(-7), at(-6), recent.id]);
    const n = php("out(test_events_cleanup());");
    assert(n === 1, `cleanup removed ${n}`);
    assert(Object.values(owned(old.id)).every((x) => x === 0), "the old test event was not fully deleted");
    assert(count("SELECT count(*) FROM events WHERE id = ?", [recent.id]) === 1, "a test event that ended 6 days ago was deleted");
    assert(count("SELECT count(*) FROM audit_log WHERE action = 'test_event.deleted' AND entity_id = ? AND actor_role = 'system'", [old.id]) === 1, "auto delete not audited");
    assert(php("out(array_column(jobs(), 0));").includes("test-events"), "no background job");
    await admin.call("DELETE", `/api/admin/test-events/${recent.id}`, { confirm: "DELETE" });
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
