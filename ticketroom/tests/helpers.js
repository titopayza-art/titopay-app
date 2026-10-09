// Test harness: a fresh PostgreSQL database per test file, the real app on an
// ephemeral port, the SIMULATED provider, and a cookie-aware HTTP client.
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_DISABLED = "true";
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || "postgres://ticketroom:ticketroom_dev@127.0.0.1:5432/postgres";
const DB_NAME = process.env.TEST_DATABASE_NAME || "ticketroom_test";
process.env.DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);

const { Client } = require("pg");
const path = require("path");
const os = require("os");
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `ticketroom-test-uploads-${process.pid}`);
const config = require("../src/config");
const db = require("../src/lib/db");
const migrate = require("../src/db/migrate");
const { hashSecret, randomCode } = require("../src/lib/crypto");

let server;
let baseUrl;

async function setup() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  await migrate.up({ log: () => {} });
  const { createApp } = require("../src/app");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = baseUrl;
  return baseUrl;
}

async function teardown() {
  await new Promise((r) => server.close(r));
  await db.close();
}

class HttpClient {
  constructor() { this.cookies = new Map(); this.csrf = null; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(method, p, body, { headers = {}, raw, csrf = true, contentType } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (body !== undefined && !raw) { h["content-type"] = contentType || "application/json"; }
    if (raw) h["content-type"] = contentType;
    if (csrf && this.csrf && method !== "GET") h["x-csrf-token"] = this.csrf;
    const res = await fetch(baseUrl + p, { method, headers: h, body: raw ? raw : body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (v) this.cookies.set(pair.slice(0, i), v); else this.cookies.delete(pair.slice(0, i));
    }
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  }
  async refreshCsrf() { const r = await this.req("GET", "/api/auth/me"); this.csrf = r.body.csrfToken; return r.body.user; }
  get(p, o) { return this.req("GET", p, undefined, o); }
  post(p, b = {}, o) { return this.req("POST", p, b, o); }
  patch(p, b = {}, o) { return this.req("PATCH", p, b, o); }
  put(p, b = {}, o) { return this.req("PUT", p, b, o); }
  del(p, o) { return this.req("DELETE", p, undefined, o); }
}

const PASSWORD = "correct-horse-battery";
let n = 0;
async function user({ roles = [], email, name = "Test User", phone = null, verified = true } = {}) {
  n += 1;
  const e = email || `user${n}-${randomCode(5).toLowerCase()}@test.local`;
  const { rows } = await db.query("INSERT INTO users (email, full_name, phone, password_hash, email_verified_at) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [e, name, phone, hashSecret(PASSWORD), verified ? new Date() : null]);
  for (const r of roles) await db.query("INSERT INTO platform_roles (user_id, role) VALUES ($1,$2)", [rows[0].id, r]);
  const c = new HttpClient();
  const login = await c.post("/api/auth/login", { email: e, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  await c.refreshCsrf();
  c.user = rows[0];
  return c;
}

// An approved organiser with a published event (ends in the future unless told otherwise).
async function organiserWithEvent(owner, { capacity = 100, types = [["General", 10000, 100]], startsInDays = 10, cashless = false, durationHours = 5, startsAt } = {}) {
  const { rows: o } = await db.query(
    "INSERT INTO organisers (name, slug, contact_email, status, approved_at) VALUES ($1,$2,'org@test.local','approved', now()) RETURNING *",
    [`Org ${randomCode(4)}`, `org-${randomCode(6).toLowerCase()}`]);
  await db.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,'owner')", [o[0].id, owner.user.id]);
  const event = await addEvent(o[0].id, { capacity, types, startsInDays, cashless, durationHours, startsAt });
  return { organiser: o[0], ...event };
}

async function addEvent(organiserId, { capacity = 100, types = [["General", 10000, 100]], startsInDays = 10, cashless = false, durationHours = 5, startsAt } = {}) {
  const start = startsAt || new Date(Date.now() + startsInDays * 864e5);
  const end = new Date(start.getTime() + durationHours * 3600e3);
  const { rows: e } = await db.query(
    `INSERT INTO events (organiser_id, slug, title, category, venue_name, city, starts_at, ends_at, capacity, status, cashless_enabled)
     VALUES ($1,$2,$3,'music','Test Venue','Johannesburg',$4,$5,$6,'published',$7) RETURNING *`,
    [organiserId, `ev-${randomCode(8).toLowerCase()}`, `Event ${randomCode(4)}`, start, end, capacity, cashless]);
  const ticketTypes = [];
  for (const [name, price, qty] of types) {
    const { rows } = await db.query("INSERT INTO ticket_types (event_id, name, price_cents, quantity_total) VALUES ($1,$2,$3,$4) RETURNING *", [e[0].id, name, price, qty]);
    ticketTypes.push(rows[0]);
  }
  return { event: e[0], ticketTypes };
}

// Simulates the buyer completing (or not) the hosted payment page.
async function completePayment(redirectUrl, action = "approve") {
  const ref = redirectUrl.split("/").pop();
  const r = await fetch(`${baseUrl}/sim/pay/${ref}/${action}`, { method: "POST", redirect: "manual" });
  if (r.status !== 303) throw new Error(`simulator returned ${r.status}`);
  return ref;
}

async function buy(c, event, items, extra = {}) {
  const r = await c.post("/api/public/orders", { eventSlug: event.slug, items, idempotencyKey: `k-${randomCode(12)}`, ...extra });
  return r;
}

async function buyAndPay(c, event, items, extra = {}) {
  const r = await buy(c, event, items, extra);
  if (r.status !== 201) throw new Error(`order failed ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.payment?.redirectUrl) await completePayment(r.body.payment.redirectUrl);
  const o = await c.get(`/api/public/orders/${r.body.order.reference}`);
  return o.body;
}

async function ticketsOf(c) { return (await c.get("/api/me/tickets")).body.tickets; }

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

module.exports = { setup, teardown, user, organiserWithEvent, addEvent, completePayment, buy, buyAndPay, ticketsOf, one, db, config, HttpClient, PASSWORD, get baseUrl() { return baseUrl; } };
