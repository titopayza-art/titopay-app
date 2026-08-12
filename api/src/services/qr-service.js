const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { createTransaction } = require("./transaction-service");

async function persistQr({ userId, codeType, amount = null, label = null, metadata = {}, expiresAt = null }) {
  const id = uuidv4();
  const reference = `QR-${Date.now()}`;
  const payload = {
    id,
    userId,
    codeType,
    amount,
    currency: "ZAR",
    reference,
    label,
    metadata
  };
  const imageSvg = await QRCode.toString(JSON.stringify(payload), {
    type: "svg",
    margin: 1,
    color: { dark: "#0057FF", light: "#FFFFFF" }
  });
  const imageDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
    margin: 1,
    color: { dark: "#0057FF", light: "#FFFFFF" }
  });
  await pool.query(
    `INSERT INTO qr_codes
      (id, user_id, code_type, label, amount, reference, payload, image_svg, image_data_url, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, userId, codeType, label, amount, reference, JSON.stringify(payload), imageSvg, imageDataUrl, expiresAt]
  );
  return {
    id,
    reference,
    codeType,
    amount,
    label,
    imageSvg,
    imageDataUrl,
    payload
  };
}

async function createQr(actor, payload) {
  const qr = await persistQr({
    userId: actor.userId,
    codeType: payload.codeType || "merchant",
    amount: payload.amount ?? null,
    label: payload.label ?? null,
    metadata: payload.metadata || {},
    expiresAt: payload.expiresAt || null
  });
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_created",
    entityType: "qr_code",
    entityId: qr.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { codeType: qr.codeType }
  });
  return qr;
}

async function getMerchantQrs(userId) {
  const { rows } = await pool.query(
    `SELECT id, code_type AS "codeType", label, amount, reference, image_data_url AS "imageDataUrl", created_at AS "createdAt"
     FROM qr_codes
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getQrHistory(userId) {
  const { rows } = await pool.query(
    `SELECT id, service_code AS "serviceCode", amount, fee, total, status, recipient_reference AS "recipientReference", created_at AS "createdAt"
     FROM transactions
     WHERE user_id = $1 AND qr_code_id IS NOT NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function payQr(actor, payload) {
  // A camera scan hands over the QR's full JSON payload; a typed entry hands
  // over the UUID. Accept both — and refuse a TitoPay EVENT TICKET by name.
  // Tickets and payment QRs are separate instruments: a ticket must never be
  // payable, and a payment QR must never admit anyone through a gate. Anything
  // else that is not a UUID answers a clean 404 instead of a database error.
  let qrId = String(payload.qrId || "").trim();
  if (qrId.startsWith("{")) {
    let parsed = null;
    try { parsed = JSON.parse(qrId); } catch { parsed = null; }
    if (parsed && parsed.type === "titopay_ticket") {
      throw new AppError(400, "This is a TitoPay event ticket, not a payment QR. Nothing can be paid with it — present it at the event entrance instead.");
    }
    qrId = parsed && parsed.id ? String(parsed.id).trim() : "";
  }
  if (!UUID_PATTERN.test(qrId)) throw new AppError(404, "QR code not found");
  const { rows } = await pool.query(
    `SELECT q.*, u.username, m.id AS merchant_row_id
     FROM qr_codes q
     JOIN users u ON u.id = q.user_id
     LEFT JOIN merchants m ON m.user_id = q.user_id
     WHERE q.id = $1
     LIMIT 1`,
    [qrId]
  );
  const qr = rows[0];
  if (!qr) throw new AppError(404, "QR code not found");
  if (qr.status && qr.status !== "active") throw new AppError(409, "This QR code is no longer available for payment");
  if (qr.expires_at && new Date(qr.expires_at).getTime() < Date.now()) throw new AppError(410, "This QR code has expired");
  if (qr.code_type === "dynamic") {
    const existing = await pool.query(
      "SELECT id, reference FROM transactions WHERE qr_code_id = $1 AND status IN ('completed', 'pending') LIMIT 1",
      [qr.id]
    );
    if (existing.rows[0]) throw new AppError(409, "This QR code has already been paid");
  }
  const amount = Number(payload.amount ?? qr.amount ?? 0);
  if (amount <= 0) throw new AppError(400, "Amount must be greater than zero");
  const tx = await createTransaction(actor, {
    serviceCode: "qr_payment",
    amount,
    recipient: qr.username,
    idempotencyKey: payload.idempotencyKey,
    merchantReceivesFee: false,
    metadata: { qrId: qr.id, qrReference: qr.reference, merchantUserId: qr.user_id, qrPaymentFee: 0.50 }
  });
  await pool.query(
    "UPDATE transactions SET qr_code_id = $2, merchant_id = $3 WHERE id = $1",
    [tx.transactionId, qr.id, qr.merchant_row_id || null]
  );
  if (qr.code_type === "dynamic") {
    await pool.query("UPDATE qr_codes SET status = 'paid', updated_at = NOW() WHERE id = $1", [qr.id]);
  }
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_paid",
    entityType: "transaction",
    entityId: tx.transactionId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { qrId, amount }
  });
  return {
    transactionId: tx.transactionId,
    qrId,
    amount,
    fee: tx.fee,
    total: tx.total,
    netAmount: tx.netAmount,
    status: "completed",
    reference: tx.reference
  };
}

function qrResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    codeType: row.code_type || row.codeType,
    amount: row.amount,
    label: row.label,
    imageSvg: row.image_svg || row.imageSvg,
    imageDataUrl: row.image_data_url || row.imageDataUrl,
    payload: row.payload
  };
}

async function ensureProfileQr(actor) {
  const isBusiness = actor.accountType === "business";
  const table = isBusiness ? "business_qr_codes" : "user_qr_codes";
  const lookupColumn = isBusiness ? "user_id" : "user_id";
  const { rows } = await pool.query(
    `SELECT q.*
     FROM ${table} p
     JOIN qr_codes q ON q.id = p.qr_code_id
     WHERE p.${lookupColumn} = $1 AND p.status = 'active'
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [actor.userId]
  );
  if (rows[0]) return qrResponse(rows[0]);

  const qr = await persistQr({
    userId: actor.userId,
    codeType: "static",
    label: isBusiness ? "TitoPay Business Profile QR" : "TitoPay Profile QR",
    metadata: { profileQr: true, accountType: actor.accountType || "personal" }
  });
  await pool.query(
    `INSERT INTO ${table} (id, user_id, qr_code_id, status)
     VALUES ($1,$2,$3,'active')`,
    [uuidv4(), actor.userId, qr.id]
  );
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "profile_qr_created",
    entityType: "qr_code",
    entityId: qr.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { accountType: actor.accountType || "personal" }
  });
  return qr;
}

async function shareQr(actor, payload = {}) {
  if (!payload.qrId) throw new AppError(400, "QR ID is required");
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_shared",
    entityType: "qr_code",
    entityId: payload.qrId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { channel: payload.channel || "web_share" }
  });
  return { ok: true };
}

module.exports = {
  createQr,
  getMerchantQrs,
  getQrHistory,
  payQr,
  ensureProfileQr,
  shareQr
};
