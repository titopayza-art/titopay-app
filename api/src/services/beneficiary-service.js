"use strict";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { verifyRecipient } = require("./security-service");
const { writeAuditLog } = require("./audit-service");

const RELATIONSHIP_TYPES = new Set(["personal", "customer", "supplier", "employee", "payout_recipient"]);

function cleanNickname(value) {
  const nickname = String(value || "").trim();
  if (nickname.length > 80) throw new AppError(400, "Beneficiary nickname is too long");
  return nickname || null;
}

function cleanRelationshipType(value, accountType) {
  const fallback = accountType === "business" ? "customer" : "personal";
  const type = String(value || fallback).trim().toLowerCase();
  if (!RELATIONSHIP_TYPES.has(type)) throw new AppError(400, "Beneficiary type is invalid");
  return type;
}

function requestAudit(actor, action, entityId, metadata = {}) {
  return writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action,
    entityType: "beneficiary",
    entityId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata
  });
}

function beneficiarySelect(where) {
  return `
    SELECT b.id,
           b.owner_user_id AS "ownerUserId",
           b.beneficiary_user_id AS "beneficiaryUserId",
           b.nickname,
           b.favourite,
           b.relationship_type AS "relationshipType",
           b.last_paid_at AS "lastPaidAt",
           b.last_payment_amount AS "lastPaymentAmount",
           b.created_at AS "createdAt",
           b.updated_at AS "updatedAt",
           b.disabled_at AS "disabledAt",
           u.full_name AS "fullName",
           u.username,
           u.account_type AS "accountType",
           u.fica_status AS "verificationStatus",
           u.status AS "accountStatus",
           CASE WHEN u.account_type = 'business' THEN u.business_logo_url ELSE u.profile_photo_url END AS "profilePhotoUrl",
           w.wallet_number AS "walletId",
           q.id AS "qrId",
           q.reference AS "qrReference"
    FROM beneficiaries b
    JOIN users u ON u.id = b.beneficiary_user_id
    LEFT JOIN LATERAL (
      SELECT wallet_number
      FROM wallets
      WHERE user_id = u.id AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1
    ) w ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, reference
      FROM qr_codes
      WHERE user_id = u.id AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE ${where}`;
}

async function listBeneficiaries(actor, options = {}) {
  const search = String(options.search || "").trim().toLowerCase().slice(0, 120);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const values = [actor.userId];
  let where = "b.owner_user_id = $1 AND b.deleted_at IS NULL AND b.disabled_at IS NULL";
  if (search) {
    values.push(`%${search}%`);
    where += ` AND LOWER(CONCAT_WS(' ', b.nickname, u.full_name, u.username, u.email, u.phone, w.wallet_number)) LIKE $${values.length}`;
  }
  values.push(limit, offset);
  const { rows } = await pool.query(
    `${beneficiarySelect(where)}
     ORDER BY b.favourite DESC, b.last_paid_at DESC NULLS LAST, LOWER(COALESCE(b.nickname, u.full_name)), b.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return { items: rows, limit, offset, hasMore: rows.length === limit };
}

async function resolveBeneficiaryUser(actor, payload) {
  const directId = String(payload.beneficiaryUserId || payload.beneficiary_user_id || "").trim();
  if (directId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(directId)) {
      throw new AppError(400, "Beneficiary user ID is invalid");
    }
    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1 AND status = 'active' LIMIT 1", [directId]);
    if (!rows[0]) throw new AppError(404, "Beneficiary user was not found");
    return rows[0].id;
  }
  const identifier = payload.identifier || payload.recipient || payload.qrId || payload.qr_id;
  const resolved = await verifyRecipient(actor, { recipient: identifier, qrId: payload.qrId || payload.qr_id });
  if (!resolved.registered || !resolved.recipient?.userId) throw new AppError(404, "Recipient is not registered on TitoPay");
  return resolved.recipient.userId;
}

async function createBeneficiary(actor, payload = {}) {
  if (actor.userType !== "customer") throw new AppError(403, "Customer account required");
  const beneficiaryUserId = await resolveBeneficiaryUser(actor, payload);
  if (beneficiaryUserId === actor.userId) throw new AppError(400, "You cannot save yourself as a beneficiary");
  const nickname = cleanNickname(payload.nickname);
  const favourite = payload.favourite === true;
  const relationshipType = cleanRelationshipType(payload.relationshipType || payload.relationship_type, actor.accountType);
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO beneficiaries
      (id, owner_user_id, beneficiary_user_id, nickname, favourite, relationship_type)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_user_id, beneficiary_user_id)
     DO UPDATE SET nickname = COALESCE(EXCLUDED.nickname, beneficiaries.nickname),
                   favourite = EXCLUDED.favourite OR beneficiaries.favourite,
                   relationship_type = EXCLUDED.relationship_type,
                   deleted_at = NULL,
                   disabled_at = NULL,
                   disabled_by = NULL,
                   disabled_reason = NULL,
                   updated_at = NOW()
     RETURNING id`,
    [id, actor.userId, beneficiaryUserId, nickname, favourite, relationshipType]
  );
  const beneficiaryId = rows[0].id;
  await requestAudit(actor, "beneficiary_saved", beneficiaryId, { beneficiaryUserId, favourite, relationshipType });
  return getOwnedBeneficiary(actor.userId, beneficiaryId);
}

async function getOwnedBeneficiary(ownerUserId, id, { includeDisabled = false } = {}) {
  const disabled = includeDisabled ? "" : " AND b.disabled_at IS NULL";
  const { rows } = await pool.query(
    `${beneficiarySelect(`b.id = $1 AND b.owner_user_id = $2 AND b.deleted_at IS NULL${disabled}`)} LIMIT 1`,
    [id, ownerUserId]
  );
  if (!rows[0]) throw new AppError(404, "Beneficiary was not found");
  return rows[0];
}

async function updateBeneficiary(actor, id, payload = {}) {
  const current = await getOwnedBeneficiary(actor.userId, id);
  const nickname = payload.nickname === undefined ? current.nickname : cleanNickname(payload.nickname);
  const favourite = payload.favourite === undefined ? current.favourite : payload.favourite === true;
  const relationshipType = payload.relationshipType === undefined && payload.relationship_type === undefined
    ? current.relationshipType
    : cleanRelationshipType(payload.relationshipType || payload.relationship_type, actor.accountType);
  await pool.query(
    `UPDATE beneficiaries
     SET nickname=$1, favourite=$2, relationship_type=$3, updated_at=NOW()
     WHERE id=$4 AND owner_user_id=$5 AND deleted_at IS NULL AND disabled_at IS NULL`,
    [nickname, favourite, relationshipType, id, actor.userId]
  );
  await requestAudit(actor, "beneficiary_updated", id, {
    before: { nickname: current.nickname, favourite: current.favourite, relationshipType: current.relationshipType },
    after: { nickname, favourite, relationshipType }
  });
  return getOwnedBeneficiary(actor.userId, id);
}

async function deleteBeneficiary(actor, id) {
  const current = await getOwnedBeneficiary(actor.userId, id, { includeDisabled: true });
  await pool.query(
    "UPDATE beneficiaries SET deleted_at=NOW(), favourite=FALSE, updated_at=NOW() WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL",
    [id, actor.userId]
  );
  await requestAudit(actor, "beneficiary_deleted", id, { beneficiaryUserId: current.beneficiaryUserId });
}

async function recordBeneficiaryPayment(ownerUserId, beneficiaryUserId, amount, db = pool) {
  if (!ownerUserId || !beneficiaryUserId) return;
  await db.query(
    `UPDATE beneficiaries
     SET last_paid_at=NOW(), last_payment_amount=$3, updated_at=NOW()
     WHERE owner_user_id=$1 AND beneficiary_user_id=$2 AND deleted_at IS NULL AND disabled_at IS NULL`,
    [ownerUserId, beneficiaryUserId, amount]
  );
}

async function adminListBeneficiaries(options = {}) {
  const search = String(options.search || "").trim().toLowerCase().slice(0, 120);
  const limit = Math.min(250, Math.max(1, Number(options.limit) || 100));
  const values = [];
  let where = "b.deleted_at IS NULL";
  if (search) {
    values.push(`%${search}%`);
    where += ` AND LOWER(CONCAT_WS(' ', owner.full_name, owner.username, u.full_name, u.username, b.nickname)) LIKE $${values.length}`;
  }
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT b.id, b.owner_user_id, owner.full_name AS owner_name, owner.username AS owner_username,
            b.beneficiary_user_id, u.full_name AS beneficiary_name, u.username AS beneficiary_username,
            b.nickname, b.favourite, b.relationship_type, b.last_paid_at, b.last_payment_amount,
            b.created_at, b.updated_at, b.disabled_at, b.disabled_reason
     FROM beneficiaries b
     JOIN users owner ON owner.id=b.owner_user_id
     JOIN users u ON u.id=b.beneficiary_user_id
     WHERE ${where}
     ORDER BY b.created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return rows;
}

async function adminDisableBeneficiary(actor, id, reason) {
  const note = String(reason || "").trim().slice(0, 240);
  if (!note) throw new AppError(400, "Disable reason is required");
  const { rows } = await pool.query(
    `UPDATE beneficiaries
     SET disabled_at=NOW(), disabled_by=$2, disabled_reason=$3, favourite=FALSE, updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL
     RETURNING id, owner_user_id, beneficiary_user_id`,
    [id, actor.userId, note]
  );
  if (!rows[0]) throw new AppError(404, "Beneficiary relationship was not found");
  await requestAudit(actor, "beneficiary_disabled_by_admin", id, { reason: note, ...rows[0] });
  return rows[0];
}

module.exports = {
  adminDisableBeneficiary,
  adminListBeneficiaries,
  createBeneficiary,
  deleteBeneficiary,
  listBeneficiaries,
  recordBeneficiaryPayment,
  updateBeneficiary
};
