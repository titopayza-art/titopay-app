// Small helpers shared by seed.js and smoke.js: an API client with its own
// cookie jar and CSRF token, and a reader for the local outbox (SQLite).
const { execFileSync } = require("child_process");

const ADMIN_EMAIL = "hello@ticketroom.co.za";

const DBQ = require("path").join(__dirname, "dbq.php");
// Reads the newest outbox message to an address and returns the first match
// of `re` in its body. Goes through dev/dbq.php: SQLite or MySQL, whichever
// the test site uses.
function outbox(dataDir, to, re, { after = "" } = {}) {
  const bodies = sql(dataDir, "SELECT body FROM message_outbox WHERE lower(to_address) = lower(?) AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 10", [to, after]).map((r) => r.body);
  for (const b of bodies) { const m = b.match(re); if (m) return m; }
  throw new Error(`No outbox message to ${to} matching ${re}`);
}
// Runs one SQL statement against the local database (tests only).
function sql(dataDir, query, params = []) {
  return JSON.parse(execFileSync("php", [DBQ, dataDir, query, JSON.stringify(params)], { encoding: "utf8" }) || "[]");
}
// "sqlite" or "mysql": the database of the local test site.
function driver(dataDir) { return execFileSync("php", [DBQ, dataDir, "--driver"], { encoding: "utf8" }).trim(); }

class Client {
  constructor(base, dataDir) { this.base = base; this.data = dataDir; this.cookies = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
  async call(method, path, body, expect, headers = {}) {
    const h = { origin: this.base, ...headers };
    if (this.csrf) h["x-csrf-token"] = this.csrf;
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] ||= "application/json"; }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === "" || /Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    const ok = expect ? res.status === expect : res.status < 300;
    if (!ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json)}`);
    this.status = res.status;
    return json;
  }
  async refreshCsrf() { const me = await this.call("GET", "/api/auth/me"); this.csrf = me.csrfToken || null; return me; }
  async login(email, password, portal) {
    const r = await this.call("POST", "/api/auth/login", { email, password, portal });
    if (r.mfaRequired) throw new Error("unexpected MFA for " + email);
    await this.refreshCsrf();
    return r;
  }
  async staffLogin(email, password) {
    const since = new Date(Date.now() - 2000).toISOString();
    const r = await this.call("POST", "/api/auth/login", { email, password, portal: "admin" });
    if (!r.mfaRequired) throw new Error("staff sign-in did not ask for a code");
    const code = outbox(this.data, email, /\b(\d{6})\b/, { after: since })[1];
    await this.call("POST", "/api/auth/staff-code/verify", { challenge: r.challenge, code });
    await this.refreshCsrf();
  }
}

module.exports = { Client, outbox, sql, ADMIN_EMAIL, driver, DBQ };
