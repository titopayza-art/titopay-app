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

module.exports = { emailKey, userByEmail, phoneTaken };
