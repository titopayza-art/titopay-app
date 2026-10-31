// One person, one account. "Jane.Doe+tickets@gmail.com" and
// "janedoe@gmail.com" are the same inbox, so they share a key: the part after
// a "+" is dropped everywhere, and Gmail also ignores dots. The database
// computes the same key (tr.email_key, migration 012) on every insert.
const db = require("./db");

function emailKey(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  let local = e.slice(0, at).split("+")[0];
  let domain = e.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return `${local}@${domain}`;
}

// The account behind an email, if any (deleted accounts don't count). A full
// account wins over a guest one.
async function userByEmail(q, email) {
  const { rows } = await (q || db).query(
    "SELECT * FROM users WHERE (email_key = $1 OR lower(email) = $2) AND status <> 'deleted' ORDER BY guest, created_at LIMIT 1",
    [emailKey(email), String(email || "").trim().toLowerCase()]);
  return rows[0] || null;
}

// Is this mobile number already on another (full, active) account?
async function phoneTaken(q, phone, exceptUserId) {
  if (!phone) return false;
  const { rows } = await (q || db).query(
    "SELECT 1 FROM users WHERE phone = $1 AND status = 'active' AND NOT guest AND id IS DISTINCT FROM $2::uuid LIMIT 1", [phone, exceptUserId || null]);
  return !!rows[0];
}

// ---------------------------------------------------------------- account types
// One account, one portal. Customers buy tickets, organisers run events,
// staff run TicketRoom; each signs in on its own portal only.
const ACCOUNT_PORTALS = { customer: "/account", organiser: "/organisers", staff: "/admin" };
// Which accounts each sign-in box accepts ("site" is the public website).
const PORTAL_ACCEPTS = { site: ["customer", "organiser"], customer: ["customer"], organiser: ["organiser"], admin: ["staff"], scanner: ["customer", "organiser"] };
// Works with a users row (account_type) and with req.user (accountType).
const accountType = (u) => String(u?.account_type || u?.accountType || "customer");
// Where an emailed link for this account opens: its own portal.
const portalLink = (u, hash) => `${require("../config").publicBaseUrl}${ACCOUNT_PORTALS[accountType(u)] || "/account"}#/${hash}`;

// The platform owner: the first administrator (kept in platform_meta). If it
// was never recorded (a database set up before migration 013 had an admin),
// the first admin is recorded now, like the PHP edition's upgrade step.
async function ownerId(q) {
  q = q || db;
  const { rows } = await q.query("SELECT value FROM platform_meta WHERE key = 'owner_user_id'");
  if (rows[0]) return rows[0].value;
  const { rows: made } = await q.query(
    `INSERT INTO platform_meta (key, value)
     SELECT 'owner_user_id', u.id::text FROM users u JOIN platform_roles r ON r.user_id = u.id AND r.role = 'admin' ORDER BY u.created_at LIMIT 1
     ON CONFLICT (key) DO NOTHING RETURNING value`);
  if (made[0]) return made[0].value;
  const { rows: again } = await q.query("SELECT value FROM platform_meta WHERE key = 'owner_user_id'");
  return again[0]?.value || null;
}

module.exports = { emailKey, userByEmail, phoneTaken, ACCOUNT_PORTALS, PORTAL_ACCEPTS, accountType, portalLink, ownerId };
