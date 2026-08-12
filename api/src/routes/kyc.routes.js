const express = require("express");
const { randomUUID } = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { requireAuth } = require("../middleware/auth");
const { getMe } = require("../services/auth-service");
const { writeAuditLog } = require("../services/audit-service");
const { queueEmail } = require("../services/email-centre-service");

const router = express.Router();

router.use(requireAuth);

function requireCustomer(req) {
  if (req.auth.userType !== "customer") {
    throw new AppError(403, "Customer verification access required");
  }
}

router.get("/fica", async (req, res, next) => {
  try {
    requireCustomer(req);
    const { rows } = await pool.query(
      `SELECT id, review_type, status, risk_rating, notes, document_reference, reviewed_at, created_at, updated_at
       FROM kyc_reviews
       WHERE user_id = $1
         AND review_type = 'FICA'
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.auth.userId]
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.post("/fica", async (req, res, next) => {
  try {
    requireCustomer(req);
    const documentReference = boundedText(req.body.documentReference, "Document reference", { min: 1, max: 500 });
    const documentType = requireEnum(
      req.body.documentType || "identity_document",
      ["identity_document", "proof_of_address", "business_registration", "bank_confirmation", "other"],
      "Document type"
    );
    // What a complete FICA pack is depends on who is submitting: a business
    // must include its CIPC company registration documents alongside the
    // responsible person's identity; a personal profile needs only identity and
    // address. Enforced here so a client cannot skip it. (A submission whose
    // PRIMARY document is the business registration itself is naturally exempt.)
    const submitter = await getMe(req.auth.userId, "customer");
    const metadata = req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};
    const companyRegistration = metadata.companyRegistration && typeof metadata.companyRegistration === "object" ? metadata.companyRegistration : null;
    const isBusinessSubmitter = String(submitter.accountType || "").toLowerCase() === "business";
    if (
      isBusinessSubmitter &&
      documentType !== "business_registration" &&
      !(companyRegistration && String(companyRegistration.name || "").trim())
    ) {
      throw new AppError(400, "CIPC company registration documents are required for business FICA verification");
    }
    // The typed identifiers the reviewer verifies the documents AGAINST.
    // Uploads alone made every review a squint at a photo; the number and
    // address are now first-class fields on the submission.
    if (documentType === "identity_document") {
      const identityKind = String(metadata.identityKind || "South African ID");
      const idNumber = String(metadata.idNumber || "").replace(/\s+/g, "");
      if (/south african id/i.test(identityKind)) {
        if (!/^\d{13}$/.test(idNumber)) {
          throw new AppError(400, "Enter the 13-digit South African ID number exactly as on the document");
        }
      } else if (!/^[A-Za-z0-9-]{5,20}$/.test(idNumber)) {
        throw new AppError(400, "Enter the passport or permit number (5 to 20 letters and digits)");
      }
      metadata.idNumber = idNumber;
      const address = String(metadata.address || "").trim();
      if (address.length < 10 || address.length > 400) {
        throw new AppError(400, `Enter the ${isBusinessSubmitter ? "business" : "residential"} address (at least 10 characters)`);
      }
      metadata.address = address;
      if (isBusinessSubmitter) {
        const registrationNumber = String(metadata.companyRegistrationNumber || "").trim();
        if (!/^[0-9A-Za-z/\- ]{5,30}$/.test(registrationNumber)) {
          throw new AppError(400, "Enter the company registration number as issued by CIPC (e.g. 2020/123456/07)");
        }
        metadata.companyRegistrationNumber = registrationNumber;
      }
    }
    const reviewId = randomUUID();
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO kyc_reviews
          (id, user_id, review_type, status, notes, document_reference)
         VALUES ($1,$2,'FICA','pending',$3,$4)`,
        [
          reviewId,
          req.auth.userId,
          JSON.stringify({
            documentType,
            metadata
          }),
          documentReference
        ]
      );
      await pool.query("UPDATE users SET fica_status = 'submitted', updated_at = NOW() WHERE id = $1", [req.auth.userId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await writeAuditLog({
      actorType: "customer",
      actorId: req.auth.userId,
      action: "fica_submitted",
      entityType: "kyc_review",
      entityId: reviewId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: { documentReference }
    });
    const user = await getMe(req.auth.userId, "customer");
    if (user.email) {
      await queueEmail({recipient:user.email,templateKey:"kyc_submitted",userId:req.auth.userId,variables:{fullName:user.fullName,email:user.email,kycStatus:"submitted",accountType:user.accountType},idempotencyKey:`kyc-submitted:${reviewId}`})
        .catch((error)=>console.error("[kyc] email queue failed",{reviewId,message:error.message}));
    }
    res.status(201).json({ ok: true, reviewId, ficaStatus: user.ficaStatus, user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
