// Load test for a TicketRoom site on nginx + PHP-FPM (+ MySQL).
//
//   node dev/loadtest.js <base url> <ticketroom-data dir> [browse|rush|oversell|all]
//
// Each virtual visitor has its own address (X-Forwarded-For, which the test
// nginx trusts from 127.0.0.1 only), its own session and CSRF token, as in a
// real on-sale. Tests only: never point this at the live site.
//   browse    many visitors loading the event list and an event page
//   rush      many different buyers booking a free event at once
//   oversell  more buyers than tickets: exactly the tickets on sale are issued
const crypto = require("crypto");
const { sql } = require("./lib");

const BASE = process.argv[2] || "http://localhost:8080";
const DATA = process.argv[3];
const MODE = process.argv[4] || "all";
const SEED = require(require("path").join(DATA, "..", "seed.json"));

const ip = () => `10.${crypto.randomInt(255)}.${crypto.randomInt(255)}.${1 + crypto.randomInt(254)}`;
function pct(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

class Visitor {
  constructor() { this.ip = ip(); this.cookies = {}; this.csrf = null; }
  async call(method, path, body) {
    const h = { origin: BASE, "x-forwarded-for": this.ip };
    if (this.csrf) h["x-csrf-token"] = this.csrf;
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (ck) h.cookie = ck;
    if (body) h["content-type"] = "application/json";
    const t = performance.now();
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t, json: text.startsWith("{") ? JSON.parse(text) : null };
  }
}

// Runs `task` with `conc` visitors for `seconds` (or until `total` tasks); returns stats.
async function run(name, conc, { seconds = 0, total = 0 }, task) {
  const lat = []; const codes = {}; let done = 0; let started = 0;
  const end = Date.now() + seconds * 1000;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while ((seconds && Date.now() < end) || (total && started < total)) {
      started++;
      try { const r = await task(); for (const x of [].concat(r)) { lat.push(x.ms); codes[x.status] = (codes[x.status] || 0) + 1; } }
      catch (e) { codes.error = (codes.error || 0) + 1; }
      done++;
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  const out = { name, concurrency: conc, seconds: +secs.toFixed(1), requests: lat.length, perSecond: +(lat.length / secs).toFixed(0), tasksPerSecond: +(done / secs).toFixed(1), p50: +pct(lat, 50).toFixed(0), p95: +pct(lat, 95).toFixed(0), p99: +pct(lat, 99).toFixed(0), codes };
  console.log(JSON.stringify(out));
  return out;
}

function ticketType(eventId) { return sql(DATA, "SELECT id FROM ticket_types WHERE event_id = ? ORDER BY sort_order LIMIT 1", [eventId])[0].id; }
// Opens exactly n more places, on the ticket type and on the event (capacity
// counts places across all its ticket types).
function setCapacity(evId, ttId, n) {
  sql(DATA, "UPDATE ticket_types SET quantity_total = quantity_sold + quantity_held + ? WHERE id = ?", [n, ttId]);
  const used = Number(sql(DATA, "SELECT COALESCE(SUM((quantity_sold + quantity_held) * admits), 0) AS n FROM ticket_types WHERE event_id = ?", [evId])[0].n);
  sql(DATA, "UPDATE events SET capacity = ? WHERE id = ?", [used + n, evId]);
}

async function book(ev, ttId) {
  const v = new Visitor();
  const me = await v.call("GET", "/api/auth/me");
  v.csrf = me.json && me.json.csrfToken;
  const email = `load-${crypto.randomBytes(6).toString("hex")}@example.test`;
  const o = await v.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ttId, quantity: 1 }], idempotencyKey: crypto.randomUUID(), guest: { fullName: "Load Test", email } });
  return [me, o];
}

(async () => {
  const ev = SEED.events.free;
  const ttId = ticketType(ev.id);
  const results = [];
  if (MODE === "browse" || MODE === "all") {
    for (const c of [50, 200]) {
      results.push(await run(`browse x${c}`, c, { seconds: 20 }, async () => {
        const v = new Visitor();
        return [await v.call("GET", "/api/public/events"), await v.call("GET", `/api/public/events/${ev.slug}`)];
      }));
    }
  }
  if (MODE === "rush" || MODE === "all") {
    setCapacity(ev.id, ttId, 1000000);
    for (const c of [50, 200]) {
      const before = Number(sql(DATA, "SELECT count(*) AS n FROM tickets WHERE ticket_type_id = ?", [ttId])[0].n);
      const r = await run(`booking rush x${c}`, c, { seconds: 30 }, () => book(ev, ttId));
      const after = Number(sql(DATA, "SELECT count(*) AS n FROM tickets WHERE ticket_type_id = ?", [ttId])[0].n);
      r.ticketsIssued = after - before;
      r.ordersPerSecond = +(r.ticketsIssued / r.seconds).toFixed(1);
      console.log(`  tickets issued: ${r.ticketsIssued} (${r.ordersPerSecond} bookings a second)`);
      results.push(r);
    }
  }
  if (MODE === "oversell" || MODE === "all") {
    setCapacity(ev.id, ttId, 300);
    const base = Number(sql(DATA, "SELECT count(*) AS n FROM tickets WHERE ticket_type_id = ?", [ttId])[0].n);
    const r = await run("oversell 1000 buyers for 300 tickets x200", 200, { total: 1000 }, () => book(ev, ttId));
    const issued = Number(sql(DATA, "SELECT count(*) AS n FROM tickets WHERE ticket_type_id = ?", [ttId])[0].n) - base;
    const left = Number(sql(DATA, "SELECT quantity_total - quantity_sold - quantity_held AS n FROM ticket_types WHERE id = ?", [ttId])[0].n);
    r.ticketsIssued = issued; r.placesLeft = left;
    console.log(`  oversell check: ${issued} tickets issued for 300 on sale, ${left} left: ${issued === 300 && left === 0 ? "EXACT, no overselling" : "WRONG"}`);
    results.push(r);
  }
  require("fs").writeFileSync(require("path").join(DATA, "..", "loadtest-results.json"), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
