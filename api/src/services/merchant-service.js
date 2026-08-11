const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { generateUniqueWalletNumber } = require("../lib/wallet-id");
const { writeAuditLog } = require("./audit-service");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");

function merchantReference() {
  return `TPM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function getMerchantForUser(userId) {
  const { rows } = await pool.query(
    `SELECT m.*, u.full_name, u.username, u.email, u.phone
     FROM merchants m
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function createMerchant(actor, payload) {
  if (actor.accountType !== "business") throw new AppError(403, "Business account required");
  const existing = await getMerchantForUser(actor.userId);
  if (existing) return existing;
  const businessName = String(payload.businessName || payload.business_name || "").trim();
  if (!businessName) throw new AppError(400, "businessName is required");
  const id = uuidv4();
  await pool.query(
    `INSERT INTO merchants
      (id, user_id, business_name, merchant_id, status, verification_status, payment_link_base)
     VALUES ($1,$2,$3,$4,'active','pending',$5)`,
    [id, actor.userId, businessName, merchantReference(), payload.paymentLinkBase || null]
  );
  const walletNumber = await generateUniqueWalletNumber(pool);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'merchant','ZAR',0,0,'active')
     ON CONFLICT (user_id, kind) DO NOTHING`,
    [uuidv4(), walletNumber, actor.userId]
  );
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "merchant_created",
    entityType: "merchant",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: {}
  });
  return getMerchantForUser(actor.userId);
}

async function listMerchants() {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.full_name, u.username, u.email, u.phone
       FROM merchants m
       JOIN users u ON u.id = m.user_id
       ORDER BY m.created_at DESC`
    );
    return rows;
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("merchants.listMerchants", error);
    return [];
  }
}

async function verifyMerchant(id, actor) {
  const { rows } = await pool.query(
    `UPDATE merchants
     SET verification_status = 'verified', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, "Merchant not found");
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "merchant_verified",
    entityType: "merchant",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: {}
  });
  return rows[0];
}

module.exports = {
  getMerchantForUser,
  createMerchant,
  listMerchants,
  verifyMerchant
};
