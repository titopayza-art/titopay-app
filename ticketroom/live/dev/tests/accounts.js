// Deleting and restoring customer and organiser accounts (Admin > Customers &
// organisers), D1-D3:
//   D1 delete: signed out at once, cannot sign in, listed under Deleted, every
//      order and ticket kept, the original email kept in the audit log
//   D2 the email is free again (placeholder address), and nothing is queued to it
//   D3 restore: the original email comes back and the person can sign in again
//
//   node tests/accounts.js <dir from serve.sh> [port]
const path = require("path");
const { Client, sql, ADMIN_EMAIL } = require("../lib");

const DIR = process.argv[2];
if (!DIR) { console.error("usage: accounts.js <dir from serve.sh> [port]"); process.exit(2); }
const BASE = `http://localhost:${process.argv[3] || 8787}`;
const DATA = path.join(DIR, "ticketroom-data");
const SEED = require(path.join(DIR, "seed.json"));
const PW = process.env.TR_TEST_ADMIN_PASSWORD;
let passes = 0, failures = 0;
async function test(name, fn) { try { await fn(); passes++; console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, PW);
  const cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  const id = sql(DATA, "SELECT id FROM users WHERE lower(email) = lower(?)", [SEED.customer.email])[0].id;
  const count = (q) => Number(sql(DATA, q, [id])[0].n);
  const orders = count("SELECT count(*) AS n FROM orders WHERE user_id = ?"), tickets = count("SELECT count(*) AS n FROM tickets WHERE owner_user_id = ?");

  await test("D1 delete: signed out, cannot sign in, listed under Deleted, orders and tickets kept, original email in the audit log", async () => {
    await admin.call("POST", `/api/admin/users/${id}/delete`, { reason: "Asked to close the account" });
    let out = false; try { await cust.call("GET", "/api/me/tickets"); } catch { out = true; }
    assert(out, "the session still works");
    let signIn = true; try { await new Client(BASE, DATA).login(SEED.customer.email, SEED.customer.password, "customer"); } catch { signIn = false; }
    assert(!signIn, "a deleted account can still sign in");
    const del = await admin.call("GET", "/api/admin/users?type=deleted"), all = await admin.call("GET", "/api/admin/users");
    assert(del.users.some((u) => u.id === id) && !all.users.some((u) => u.id === id), "not listed under Deleted only");
    assert(count("SELECT count(*) AS n FROM orders WHERE user_id = ?") === orders && count("SELECT count(*) AS n FROM tickets WHERE owner_user_id = ?") === tickets, "orders or tickets changed");
    const a = sql(DATA, "SELECT details FROM audit_log WHERE action = 'user.deleted' AND entity_id = ?", [id])[0];
    assert(a && String(a.details).includes(SEED.customer.email), "the original email is not in the audit log");
  });

  await test("D2 the address is a placeholder now and nothing is queued to it", async () => {
    const u = sql(DATA, "SELECT email FROM users WHERE id = ?", [id])[0];
    assert(u.email.endsWith("@deleted.ticketroom.invalid"), `email is ${u.email}`);
    assert(count("SELECT count(*) AS n FROM message_outbox WHERE lower(to_address) LIKE '%@deleted.ticketroom.invalid' AND user_id = ?") === 0, "a message was queued to the placeholder");
  });

  await test("D3 restore: the original email comes back and the person can sign in", async () => {
    await admin.call("POST", `/api/admin/users/${id}/restore`, { reason: "Opened by mistake" });
    const u = sql(DATA, "SELECT status, email FROM users WHERE id = ?", [id])[0];
    assert(u.status === "active" && u.email.toLowerCase() === SEED.customer.email.toLowerCase(), JSON.stringify(u));
    await new Client(BASE, DATA).login(SEED.customer.email, SEED.customer.password, "customer");
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
