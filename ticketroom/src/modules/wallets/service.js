// Linked external wallets (TitoPay). TicketRoom never sees the wallet's
// balance or PIN: it holds only a partner token, encrypted at rest, that lets
// it request payments the wallet holder must approve in the TitoPay app.
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { encrypt, decrypt } = require("../../lib/crypto");
const { conflict, notFound } = require("../../lib/errors");
const client = require("../titopay/client");

const MAX_OTP_ATTEMPTS = 5;
const maskPhone = (p) => `${p.slice(0, 5)}*****${p.slice(-2)}`;

async function list(userId) {
  const { rows } = await db.query(
    "SELECT id, provider, display_handle, status, linked_at FROM wallet_links WHERE user_id = $1 AND status = 'active' ORDER BY linked_at DESC", [userId]);
  return rows;
}

async function activeToken(userId) {
  const { rows } = await db.query("SELECT token_enc FROM wallet_links WHERE user_id = $1 AND provider = 'titopay' AND status = 'active'", [userId]);
  return rows[0] ? decrypt(rows[0].token_enc) : null;
}

async function startLink(user, msisdn) {
  const { rows: existing } = await db.query("SELECT 1 FROM wallet_links WHERE user_id = $1 AND provider = 'titopay' AND status = 'active'", [user.id]);
  if (existing[0]) throw conflict("A TitoPay wallet is already linked. Unlink it first to link another.", "wallet_already_linked");
  const r = await client.startLink(msisdn, user.id);
  const { rows } = await db.query(
    `INSERT INTO wallet_link_requests (user_id, provider, external_request_id, phone_masked, expires_at)
     VALUES ($1,'titopay',$2,$3,$4) RETURNING id, expires_at`,
    [user.id, r.requestId, maskPhone(msisdn), r.expiresAt || new Date(Date.now() + 10 * 60e3)]);
  return { linkRequestId: rows[0].id, expiresAt: rows[0].expires_at, sentTo: maskPhone(msisdn), ...(r.devOtp && !require("../../config").isProd ? { devOtp: r.devOtp } : {}) };
}

async function confirmLink(user, linkRequestId, otp) {
  const { rows } = await db.query("SELECT * FROM wallet_link_requests WHERE id = $1 AND user_id = $2", [linkRequestId, user.id]);
  const req = rows[0];
  if (!req) throw notFound("Link request not found.");
  if (req.status !== "pending") throw conflict("This link request is no longer active. Start again.", "link_closed");
  if (new Date(req.expires_at) < new Date()) {
    await db.query("UPDATE wallet_link_requests SET status = 'expired' WHERE id = $1", [req.id]);
    throw conflict("The code has expired. Start again.", "link_expired");
  }
  if (req.attempts >= MAX_OTP_ATTEMPTS) throw conflict("Too many wrong codes. Start again.", "link_locked");
  await db.query("UPDATE wallet_link_requests SET attempts = attempts + 1 WHERE id = $1", [req.id]);
  let r;
  try {
    r = await client.confirmLink(req.external_request_id, otp);
  } catch (err) {
    if (err.status === 409) throw conflict(err.message || "That code is not correct.", err.code || "otp_incorrect");
    throw err;
  }
  return db.withTx(async (c) => {
    await c.query("UPDATE wallet_link_requests SET status = 'confirmed' WHERE id = $1", [req.id]);
    const { rows: link } = await c.query(
      `INSERT INTO wallet_links (user_id, provider, external_wallet_id, token_enc, display_handle) VALUES ($1,'titopay',$2,$3,$4)
       RETURNING id, provider, display_handle, status, linked_at`,
      [user.id, r.walletId, encrypt(r.walletToken), r.displayHandle || req.phone_masked]);
    await audit.record(c, { actor: user, action: "wallet.linked", entityType: "wallet_link", entityId: link[0].id, details: { provider: "titopay" } });
    return link[0];
  });
}

async function unlink(user, linkId) {
  const { rows } = await db.query("SELECT * FROM wallet_links WHERE id = $1 AND user_id = $2 AND status = 'active'", [linkId, user.id]);
  if (!rows[0]) throw notFound("Linked wallet not found.");
  // Revoke at TitoPay first; if TitoPay is unreachable we still stop using
  // the token locally, and the audit entry records that remote revoke failed.
  let remote = "revoked";
  try { await client.revokeLink(decrypt(rows[0].token_enc)); } catch (err) { remote = `failed: ${err.message}`; }
  await db.query("UPDATE wallet_links SET status = 'revoked', revoked_at = now() WHERE id = $1", [linkId]);
  await audit.record(null, { actor: user, action: "wallet.unlinked", entityType: "wallet_link", entityId: linkId, details: { remote } });
  return { remote };
}

module.exports = { list, activeToken, startLink, confirmLink, unlink };
