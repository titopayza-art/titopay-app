// Regression tests for the ticket, checkout and gate fixes (T1-T14 and P1 (a),
// (b) in TRIAGE.md), against a local instance from dev/serve.sh.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/tickets.js <dir> [port]
//
// Each test sets up its own events (copies of the seeded free event, changed
// through the database) so the seeded events stay as smoke.js expects them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");
const { Client, outbox, sql, driver, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: tickets.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const DB = path.join(DATA, "ticketroom.sqlite");

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY; // e.g. TR_ONLY=T11 runs just the tests whose name starts with that
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).split("\n")[0].slice(0, 400)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const one = (q, p = []) => sql(DATA, q, p)[0];
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
const H = 3600e3;
const stamp = Date.now().toString(36);
let n = 0;
const uniq = (p) => `${p}-${stamp}-${++n}`;

// Copies a row with some columns changed (a direct database write, tests only).
function cloneRow(table, id, changes) {
  const r = { ...sql(DATA, `SELECT * FROM ${table} WHERE id = ?`, [id])[0], ...changes };
  insertRow(table, r);
}
function insertRow(table, row) {
  sql(DATA, `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
}
const uuid = () => crypto.randomUUID();

// A published copy of the seeded free event, with one free ticket type.
function freeEvent({ startsIn = 3 * H, endsIn = 7 * H, kind = "general", age = null, limit = 4, total = 100, paid = false } = {}) {
  const id = uuid(), slug = uniq("tt-event"), ttId = uuid();
  const from = paid ? SEED.events.paid.id : SEED.events.free.id;
  cloneRow("events", from, { id, slug, ref: `EV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, title: `Ticket tests ${slug}`,
    starts_at: iso(startsIn), ends_at: iso(endsIn), sales_start_at: null, sales_end_at: null, age_restriction: age, capacity: 1000, presale_queue_enabled: 0 });
  const tt = one("SELECT id FROM ticket_types WHERE event_id = ? LIMIT 1", [from]);
  cloneRow("ticket_types", tt.id, { id: ttId, event_id: id, kind, quantity_total: total, quantity_sold: 0, quantity_held: 0, per_order_limit: limit, release_after: null, status: "on_sale" });
  return { id, slug, ttId };
}

async function signUp(email, password) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: "Second Customer", email, password, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return c;
}
async function guest() { const c = new Client(BASE, DATA); await c.refreshCsrf(); return c; }
const book = (c, ev, body = {}) => c.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.ttId, quantity: 1 }], idempotencyKey: uuid(), ...body });
const ticketsOf = (ref) => sql(DATA, "SELECT t.* FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.reference = ? ORDER BY t.created_at", [ref]);
let org, cust, admin;
const scan = (ev, payload, extra = {}) => org.call("POST", "/api/staff/scan", { eventId: ev.id, payload, ...extra });

(async () => {
  org = new Client(BASE, DATA); await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const orgId = SEED.organiser.orgId;
  const friendEmail = `friend+${stamp}@example.test`;
  const friend = await signUp(friendEmail, `Tst-${crypto.randomBytes(12).toString("base64url")}`);

  await test("T1 transfer: the sender's old typed code scans as replaced, the new code admits", async () => {
    const ev = freeEvent();
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    const tr = await cust.call("POST", `/api/me/tickets/${t.id}/transfer`, { toEmail: friendEmail });
    await friend.call("POST", "/api/me/transfers/claim", { transferId: tr.transfer?.id || tr.id });
    const now = one("SELECT code, qr_version FROM tickets WHERE id = ?", [t.id]);
    assert(now.code !== t.code, "the code did not change on transfer");
    const old = await scan(ev, t.code);
    assert(old.outcome === "replaced", `old typed code: ${old.outcome} (${old.message})`);
    const fresh = await scan(ev, now.code);
    assert(fresh.outcome === "admitted", `new code: ${fresh.outcome}`);
  });

  await test("T1 admin reissue and gate pass reissue: the old typed code no longer works", async () => {
    const ev = freeEvent();
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    await admin.call("POST", `/api/admin/tickets/${t.id}/reissue`, { reason: "Lost phone (test)" });
    const r = await scan(ev, t.code);
    assert(r.outcome !== "admitted", `old code after reissue: ${r.outcome}`);
    const look = await admin.call("GET", `/api/admin/tickets/${t.code}`);
    assert(look.ticket.id === t.id, "admin lookup by the old code does not find the ticket");
    const gid = uuid(), code = "P" + crypto.randomBytes(9).toString("hex").toUpperCase().replace(/[01IO]/g, "Z").slice(0, 9);
    const userId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [SEED.organiser.email]).id;
    insertRow("gate_passes", { id: gid, event_id: ev.id, code, qr_version: 1, holder_name: "Crew Member", role: "crew", reentry: 1, status: "active", link_token_hash: crypto.randomBytes(16).toString("hex"), scans: 0, created_by: userId, created_at: iso(0), updated_at: iso(0) });
    await org.call("POST", `/api/organiser/${orgId}/events/${ev.id}/passes/${gid}/reissue`, {});
    const p = await scan(ev, code);
    assert(p.outcome !== "admitted", `old pass code after reissue: ${p.outcome}`);
  });

  await test("T2 offline list: no ticket codes in clear, and a QR with a made-up signature is refused offline", async () => {
    const ev = freeEvent();
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    const pack = await org.call("GET", `/api/staff/events/${ev.id}/offline-pack`);
    assert(!JSON.stringify(pack.tickets).includes(t.code), "the offline list carries the ticket code in clear");
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies(Object.entries(org.cookies).map(([name, value]) => ({ name, value, url: BASE })));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/help`);
      const out = await page.evaluate(async ({ ev, code }) => {
        const off = await import("/assets/scan-offline.js");
        await off.start({ id: ev.id, starts_at: ev.starts, ends_at: ev.ends });
        const forged = await off.check(`TR1.${code}.1.${"A".repeat(22)}`);
        off.stop();
        return forged?.outcome;
      }, { ev: { id: ev.id, starts: pack.event.starts_at, ends: pack.event.ends_at }, code: t.code });
      assert(out && out !== "admitted", `forged QR offline: ${out}`);
    } finally { await browser.close(); }
  });

  await test("T3 open refund: no transfer, no resale, no entry", async () => {
    const ev = freeEvent();
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    const orderId = one("SELECT id FROM orders WHERE reference = ?", [o.reference]).id;
    insertRow("refunds", { id: uuid(), reference: uniq("RF"), order_id: orderId, amount_cents: 1000, fee_refund_cents: 0, kind: "customer", reason: "test", ticket_ids: JSON.stringify([t.id]), status: "requested", created_at: iso(0), updated_at: iso(0) });
    let msg = "";
    try { await cust.call("POST", `/api/me/tickets/${t.id}/transfer`, { toEmail: friendEmail }); msg = "allowed"; } catch (e) { msg = e.message; }
    assert(/refund_in_progress/.test(msg), `transfer: ${msg.slice(0, 160)}`);
    try { await cust.call("POST", `/api/me/tickets/${t.id}/resale`, { priceCents: 1000 }); msg = "allowed"; } catch (e) { msg = e.message; }
    assert(/refund_in_progress/.test(msg), `resale: ${msg.slice(0, 160)}`);
    const r = await scan(ev, t.code);
    assert(r.outcome === "refund_pending", `scan: ${r.outcome}`);
  });

  await test("T4 guest checkout with someone else's account email: no tickets or QR for the stranger, no count", async () => {
    const ev = freeEvent({ limit: 1 });
    await book(cust, ev);
    const g = await guest();
    let msg = "";
    try { await book(g, ev, { guest: { fullName: "Stranger", email: SEED.customer.email } }); msg = "booked"; } catch (e) { msg = e.message; }
    assert(/limit_exceeded/.test(msg) && !/already have/.test(msg), `limit message: ${msg.slice(0, 200)}`);
    const ev2 = freeEvent();
    const r = await book(await guest(), ev2, { guest: { fullName: "Stranger", email: SEED.customer.email } });
    const view = await g.call("GET", `/api/public/orders/${r.order.reference}?k=${encodeURIComponent(r.accessKey || "")}`);
    assert(view.tickets.length === 0 && view.ticketsHidden === true, `order link shows ${view.tickets.length} ticket(s)`);
    const t = ticketsOf(r.order.reference)[0];
    let qr = 0; try { await g.call("GET", `/api/public/orders/${r.order.reference}/tickets/${t.id}/qr.svg?k=${encodeURIComponent(r.accessKey)}`); qr = 200; } catch (e) { qr = Number(/-> (\d+)/.exec(e.message)?.[1]); }
    assert(qr === 404, `QR through the stranger's link: HTTP ${qr}`);
    // Booked for an organiser's email: the organiser's own email has a link that shows them.
    const ev3 = freeEvent();
    const since = new Date(Date.now() - 2000).toISOString();
    const r3 = await book(await guest(), ev3, { guest: { fullName: "Organiser", email: SEED.organiser.email } });
    const link = outbox(DATA, SEED.organiser.email, new RegExp(`/orders/${r3.order.reference}\\?k=([^\\s]+)`), { after: since });
    const own = await (await guest()).call("GET", `/api/public/orders/${r3.order.reference}?k=${link[1]}`);
    assert(own.tickets.length === 1, `the owner's emailed link shows ${own.tickets.length} ticket(s)`);
  });

  await test("T5 free limit counts the same mailbox, and a listing being paid for can be taken off", async () => {
    const ev = freeEvent({ limit: 2 });
    const base = `alias${stamp}`;
    await book(await guest(), ev, { items: [{ ticketTypeId: ev.ttId, quantity: 2 }], guest: { fullName: "Alias One", email: `${base}+one@gmail.com` } });
    let msg = "";
    try { await book(await guest(), ev, { guest: { fullName: "Alias Two", email: `${base.slice(0, 3)}.${base.slice(3)}+two@gmail.com` } }); msg = "booked"; } catch (e) { msg = e.message; }
    assert(/limit_exceeded/.test(msg), `alias of the same Gmail mailbox: ${msg.slice(0, 160)}`);
    // A listing that is "held" (someone paying): the seller can still ask to take it off.
    const ev2 = freeEvent();
    const o = (await book(cust, ev2)).order;
    const t = ticketsOf(o.reference)[0];
    const sellerId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [SEED.customer.email]).id;
    const lid = uuid();
    const buyerOrder = one("SELECT id FROM orders WHERE reference = ?", [o.reference]).id;
    const held = uuid();
    cloneRow("orders", buyerOrder, { id: held, reference: uniq("TR"), idempotency_key: uuid(), status: "pending_payment", expires_at: iso(-60e3), total_cents: 1000, subtotal_cents: 1000, resale_listing_id: lid, user_id: one("SELECT id FROM users WHERE lower(email) = lower(?)", [friendEmail]).id });
    insertRow("resale_listings", { id: lid, reference: uniq("RS"), ticket_id: t.id, event_id: ev2.id, ticket_type_id: ev2.ttId, seller_id: sellerId, price_cents: 1000, face_value_cents: 1000, payout_method: "eft", status: "held", held_order_id: held, created_at: iso(0), updated_at: iso(0) });
    const r = await cust.call("POST", `/api/me/resale/${lid}/cancel`, {});
    assert(r.listing.withdrawRequested, "withdrawal not recorded");
    // The unpaid hold lapses (released when the next booking for the event comes in): the listing comes off.
    await book(await guest(), ev2, { guest: { fullName: "Next Buyer", email: `next${stamp}@example.test` } });
    const l = one("SELECT status FROM resale_listings WHERE id = ?", [lid]);
    assert(l.status === "cancelled", `listing after the hold lapsed: ${l.status}`);
  });

  await test("T6 multi-day pass: once a day, again on the next day", async () => {
    const ev = freeEvent({ kind: "multi_day" });
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    const a = await scan(ev, t.code);
    assert(a.outcome === "admitted", `day 1: ${a.outcome}`);
    const b = await scan(ev, t.code);
    assert(b.outcome === "already_used" && /today/.test(b.message), `day 1 again: ${b.outcome} ${b.message}`);
    // Make the first entry yesterday's.
    sql(DATA, "UPDATE ticket_entry_days SET day = '2000-01-01' WHERE ticket_id = ?", [t.id]);
    const c = await scan(ev, t.code);
    assert(c.outcome === "admitted", `next day: ${c.outcome}`);
    const mine = await cust.call("GET", "/api/me/tickets");
    assert(mine.tickets.find((x) => x.id === t.id)?.qrPayload, "the pass lost its QR code after the first day");
  });

  await test("T7 date boxes are South African time in any browser zone", async () => {
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const ctx = await browser.newContext({ timezoneId: "America/New_York" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/help`);
      const r = await page.evaluate(async () => {
        const core = await import("/assets/core.js");
        return { shown: core.toLocalInput("2026-12-01T10:00:00Z"), saved: core.fromLocalInput ? core.fromLocalInput("2026-12-01T12:00") : null };
      });
      assert(r.shown === "2026-12-01T12:00", `toLocalInput: ${r.shown}`);
      assert(r.saved === "2026-12-01T10:00:00.000Z", `fromLocalInput: ${r.saved}`);
    } finally { await browser.close(); }
  });

  await test("T8 switching event keeps unsynced offline scans; a late sync keeps the gate time", async () => {
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/help`);
      const left = await page.evaluate(async () => {
        const off = await import("/assets/scan-offline.js");
        const db = await new Promise((res, rej) => { const r = indexedDB.open("ticketroom-scan", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = rej; });
        await new Promise((res) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put([{ id: "x1", payload: "ABCDEFGHJK", at: new Date().toISOString() }], "queue:other-event"); tx.objectStore("kv").put({ format: 2, tickets: [] }, "pack:other-event"); tx.oncomplete = res; });
        db.close();
        await off.forgetOthers("this-event");
        const db2 = await new Promise((res) => { const r = indexedDB.open("ticketroom-scan", 1); r.onsuccess = () => res(r.result); });
        const keys = await new Promise((res) => { const q = db2.transaction("kv").objectStore("kv").getAllKeys(); q.onsuccess = () => res(q.result); });
        db2.close();
        return keys;
      });
      assert(left.includes("queue:other-event"), `unsynced scans were deleted (keys left: ${left.join(", ")})`);
      assert(!left.includes("pack:other-event"), "the other event's ticket list was kept");
    } finally { await browser.close(); }
    // An event that ended 8 hours ago, scanned offline at the gate 9 hours ago, synced now.
    const ev = freeEvent({ startsIn: -12 * H, endsIn: -8 * H });
    const o = (await book(cust, ev).catch(() => null))?.order;
    let code;
    if (o) code = ticketsOf(o.reference)[0].code;
    else {
      // Sales are closed for a past event: issue the ticket through a copy of another order.
      const ev2 = freeEvent();
      const o2 = (await book(cust, ev2)).order;
      const t2 = ticketsOf(o2.reference)[0];
      code = "Q" + crypto.randomBytes(9).toString("hex").toUpperCase().replace(/[01IO]/g, "Z").slice(0, 9);
      sql(DATA, "UPDATE tickets SET event_id = ?, ticket_type_id = ?, code = ? WHERE id = ?", [ev.id, ev.ttId, code, t2.id]);
    }
    const r = await org.call("POST", "/api/staff/scan/sync", { eventId: ev.id, scans: [{ id: "s1", payload: code, gate: "North", at: iso(-9 * H) }] });
    assert(r.results[0].outcome === "admitted", `late sync: ${r.results[0].outcome}`);
  });

  await test("T9 a lapsed reservation does not block the next booking", async () => {
    const ev = freeEvent({ total: 1 });
    const o = (await book(cust, ev)).order;
    // Turn it into an unpaid reservation that ran out a minute ago.
    sql(DATA, "UPDATE orders SET status = 'pending_payment', expires_at = ? WHERE reference = ?", [iso(-60e3), o.reference]);
    sql(DATA, "DELETE FROM tickets WHERE order_id = (SELECT id FROM orders WHERE reference = ?)", [o.reference]);
    sql(DATA, "UPDATE ticket_types SET quantity_sold = 0, quantity_held = 1 WHERE id = ?", [ev.ttId]);
    const r = await book(await guest(), ev, { guest: { fullName: "Next In", email: `nextin${stamp}@example.test` } });
    assert(r.order.status === "paid", `booking: ${r.order.status}`);
  });

  await test("T10 a waitlist place survives a payment that is not completed", async () => {
    // A paid event with one place, held for the customer at the front of the waitlist (an open offer).
    const ev = freeEvent({ total: 1, paid: true });
    sql(DATA, "UPDATE ticket_types SET quantity_held = 1 WHERE id = ?", [ev.ttId]);
    const token = crypto.randomBytes(24).toString("base64url");
    const w = { id: uuid() };
    insertRow("waitlist_entries", { id: w.id, event_id: ev.id, ticket_type_id: ev.ttId, user_id: one("SELECT id FROM users WHERE lower(email) = lower(?)", [friendEmail]).id, status: "offered", offer_kind: "primary",
      offer_token_hash: crypto.createHash("sha256").update(token).digest("hex"), offered_at: iso(0), offer_expires_at: iso(30 * 60e3), created_at: iso(0), updated_at: iso(0) });
    // The offer goes to checkout, and that checkout is then abandoned (its reservation runs out).
    let started = true;
    try { await book(friend, ev, { waitlistOffer: token }); } catch (e) { started = e.message; }
    const ord = one("SELECT id, status FROM orders WHERE id = (SELECT order_id FROM waitlist_entries WHERE id = ?)", [w.id]);
    if (ord && ord.status === "pending_payment") sql(DATA, "UPDATE orders SET expires_at = ? WHERE id = ?", [iso(-20 * 60e3), ord.id]);
    try { await book(await guest(), ev, { guest: { fullName: "Later", email: `later${stamp}@example.test` } }); } catch { /* still held for the waitlist */ }
    const entry = one("SELECT status FROM waitlist_entries WHERE id = ?", [w.id]);
    const tt = one("SELECT quantity_held FROM ticket_types WHERE id = ?", [ev.ttId]);
    assert(started === true, `the waitlist checkout did not start: ${started}`);
    assert(entry.status === "offered" && tt.quantity_held === 1, `after the abandoned payment: entry ${entry.status}, places held ${tt.quantity_held}`);
  });

  await test("T11 a sale landing during a quantity edit cannot leave sales above the total, and the organiser is told why", async () => {
    // A draft event (ticket types of published events go through review).
    const evId = uuid(), ttId = uuid();
    cloneRow("events", SEED.events.free.id, { id: evId, slug: uniq("tt-draft"), ref: `EV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, status: "draft", title: "Draft for T11" });
    const tt = one("SELECT id FROM ticket_types WHERE event_id = ? LIMIT 1", [SEED.events.free.id]);
    cloneRow("ticket_types", tt.id, { id: ttId, event_id: evId, quantity_total: 10, quantity_sold: 2, quantity_held: 0, release_after: null });
    // Another booking holds the database while the edit reads, then sells 4 more.
    // SQLite: an IMMEDIATE transaction; MySQL: the site's write lock and a transaction.
    const php = driver(DATA) === "mysql"
      ? `$GLOBALS['TR_CONFIG'] = require $argv[1] . '/config.php'; function cfg($k = null, $d = null) { $c = $GLOBALS['TR_CONFIG']; foreach (explode('.', (string) $k) as $p) { if (!is_array($c) || !array_key_exists($p, $c)) return $d; $c = $c[$p]; } return $c; }
require $argv[3]; $db = db_connect_mysql(); mysql_lock($db); $db->exec('START TRANSACTION'); fwrite(STDOUT, "locked\\n"); usleep(1500000);
$db->prepare('UPDATE ticket_types SET quantity_sold = 6 WHERE id = ?')->execute([$argv[2]]); $db->exec('COMMIT'); mysql_unlock($db);`
      : `$db = new PDO('sqlite:' . $argv[1] . '/ticketroom.sqlite'); $db->exec('PRAGMA busy_timeout = 10000'); $db->exec('BEGIN IMMEDIATE'); fwrite(STDOUT, "locked\\n"); usleep(1500000);
$db->prepare('UPDATE ticket_types SET quantity_sold = 6 WHERE id = ?')->execute([$argv[2]]); $db->exec('COMMIT');`;
    const locker = spawn("php", ["-r", php, DATA, ttId, path.join(__dirname, "../../public_html/api/lib/mysql.php")]);
    let lockErr = "";
    locker.stderr.on("data", (d) => { lockErr += d; });
    await new Promise((res, rej) => { locker.stdout.once("data", res); locker.once("exit", (c) => rej(new Error(`lock helper ended (${c}): ${lockErr}`))); locker.once("error", rej); });
    let msg = "";
    try { await org.call("PATCH", `/api/organiser/${orgId}/events/${evId}/ticket-types/${ttId}`, { quantityTotal: 3 }); msg = "saved"; } catch (e) { msg = e.message; }
    if (locker.exitCode === null) await new Promise((res) => locker.once("exit", res));
    const row = one("SELECT quantity_total, quantity_sold FROM ticket_types WHERE id = ?", [ttId]);
    assert(row.quantity_total >= row.quantity_sold, `total ${row.quantity_total} below sold ${row.quantity_sold} (${msg.slice(0, 120)})`);
    // The organiser is told what happened, not a generic "not allowed in the current state".
    assert(/quantity_below_sold/.test(msg) && /booked while you were editing/.test(msg), `edit answer: ${msg.slice(0, 200)}`);
  });

  await test("T12 the gate is told the event's age rule", async () => {
    const ev = freeEvent({ age: "18+" });
    const list = await org.call("GET", "/api/staff/events");
    assert(list.events.find((e) => e.id === ev.id)?.age_restriction === "18+", "the scanner's event list has no age rule");
    const o = (await book(cust, ev)).order;
    const r = await scan(ev, ticketsOf(o.reference)[0].code);
    assert(r.outcome === "admitted" && r.ageRestriction === "18+", `scan answer: ${JSON.stringify(r).slice(0, 160)}`);
  });

  await test("T13 the printed band code does not open the gate; viewers don't see band codes", async () => {
    const ev = freeEvent();
    const o = (await book(cust, ev)).order;
    const t = ticketsOf(o.reference)[0];
    const display = "B" + crypto.randomBytes(8).toString("hex").toUpperCase().replace(/[01IO]/g, "Z").slice(0, 7);
    insertRow("tags", { id: uuid(), tag_type: "nfc_wristband", token_hash: crypto.randomBytes(16).toString("hex"), display_code: display, security_level: "uid_only", event_id: ev.id, user_id: t.owner_user_id, ticket_id: t.id, status: "active", created_at: iso(0), updated_at: iso(0) });
    const r = await scan(ev, undefined, { tagInput: `${display.slice(0, 4)}-${display.slice(4)}` });
    assert(r.outcome !== "admitted", `printed band code at the gate: ${r.outcome}`);
    const userId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [SEED.organiser.email]).id;
    sql(DATA, "UPDATE organiser_members SET role = 'viewer' WHERE organiser_id = ? AND user_id = ?", [orgId, userId]);
    try {
      const list = await org.call("GET", `/api/organiser/${orgId}/events/${ev.id}/tags`);
      assert(!JSON.stringify(list).includes(display.slice(4)) || !JSON.stringify(list).includes(display.slice(0, 4)), "a viewer sees the full band code");
    } finally { sql(DATA, "UPDATE organiser_members SET role = 'owner' WHERE organiser_id = ? AND user_id = ?", [orgId, userId]); }
  });

  // ---------------------------------------------------------------- browser: T14 and P1
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctxFor = async (c) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {} });
    if (c) await ctx.addCookies(Object.entries(c.cookies).map(([name, value]) => ({ name, value, url: BASE })));
    return ctx;
  };
  const settle = async (p) => { await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(400); };
  try {
    await test("P1(a) a staff session on /scan gets the wrong-portal page, with no script error", async () => {
      const ctx = await ctxFor(admin); const p = await ctx.newPage();
      const errors = []; p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(`${BASE}/scan`); await settle(p);
      const main = await p.evaluate(() => document.querySelector("main")?.innerText || "");
      await ctx.close();
      assert(!errors.length && /isn't for this account/.test(main), `errors: ${errors.join(" | ")} main: ${main.slice(0, 120)}`);
    });

    await test("P1(b) an open customer tab notices a sign-out and a sign-in as someone else", async () => {
      const c = new Client(BASE, DATA); await c.login(SEED.customer.email, SEED.customer.password, "customer");
      const ctx = await ctxFor(c); const a = await ctx.newPage(); const b = await ctx.newPage();
      await a.goto(`${BASE}/account#/tickets`); await settle(a);
      await b.goto(`${BASE}/help`); await settle(b);
      await b.evaluate(async () => { const core = await import("/assets/core.js"); await core.me(); await core.signOut(); });
      await a.waitForTimeout(800);
      const out = await a.evaluate(() => document.querySelector("main")?.innerText || "");
      assert(/signed out/i.test(out), `after sign-out elsewhere: ${out.slice(0, 120)}`);
      // Signed in as the organiser in the other tab: the customer tab says so (and shows nothing of either).
      const o = new Client(BASE, DATA); await o.login(SEED.organiser.email, SEED.organiser.password, "organiser");
      await ctx.addCookies(Object.entries(o.cookies).map(([name, value]) => ({ name, value, url: BASE })));
      await b.reload(); await settle(b);
      await a.bringToFront(); await a.evaluate(() => window.dispatchEvent(new Event("focus"))); await a.waitForTimeout(800);
      const now = await a.evaluate(() => document.querySelector("main")?.innerText || "");
      assert(/isn't for this account/.test(now) && !now.includes(SEED.organiser.organisation), `after organiser sign-in elsewhere: ${now.slice(0, 160)}`);
      await ctx.close();
    });

    await test("T14 sign-out clears saved tickets and the scanner's offline lists, keeping unsynced scans", async () => {
      const c = new Client(BASE, DATA); await c.login(SEED.customer.email, SEED.customer.password, "customer");
      const ctx = await ctxFor(c); const p = await ctx.newPage();
      await p.goto(`${BASE}/account#/tickets`); await settle(p); await p.waitForTimeout(1000);
      await p.evaluate(async () => {
        const db = await new Promise((res) => { const r = indexedDB.open("ticketroom-scan", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); });
        await new Promise((res) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put({ format: 2, tickets: [["x"]] }, "pack:e1"); tx.objectStore("kv").put([{ id: "q" }], "queue:e1"); tx.oncomplete = res; });
        db.close();
      });
      const before = await p.evaluate(() => !!localStorage.getItem("tr_wallet_v1"));
      // The sign-out button in the menu (the same one the side panel and header use).
      await p.evaluate(() => document.querySelector("[data-signout-side], [data-signout]").click()); await p.waitForURL(`${BASE}/`); await settle(p);
      const after = await p.evaluate(async () => {
        const db = await new Promise((res) => { const r = indexedDB.open("ticketroom-scan", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); });
        const keys = await new Promise((res) => { const q = db.transaction("kv").objectStore("kv").getAllKeys(); q.onsuccess = () => res(q.result); });
        db.close();
        return { wallet: localStorage.getItem("tr_wallet_v1"), keys };
      });
      await ctx.close();
      assert(before, "the test customer had no saved tickets to clear (setup)");
      assert(!after.wallet, "saved tickets with QR codes are still in the browser");
      assert(!after.keys.includes("pack:e1") && after.keys.includes("queue:e1"), `scanner data after sign-out: ${after.keys.join(", ")}`);
    });
  } finally { await browser.close(); }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
