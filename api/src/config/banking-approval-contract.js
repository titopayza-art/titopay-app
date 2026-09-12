"use strict";

// WHAT COUNTS AS AN APPROVAL, AND WHY A DATABASE ROW IS NOT ENOUGH.
//
// THE LIMITATION THIS EXISTS TO NARROW.
//
// Gate 6 asks whether a capability has been approved. Until now it asked the
// database, and the database answered, which meant anybody who could write to
// `banking_capability_approvals` could approve a bank rail: a psql prompt, a
// restored backup, a SQL injection somewhere else in the platform, a migration
// run by mistake. The row carried `approved_by` and `approval_reference`
// columns, but nothing checked them, so an approval with both left NULL passed
// exactly like one a compliance officer had signed.
//
// This file makes the database necessary but not sufficient. An approval now
// has to satisfy three things the database alone cannot supply:
//
//   1. ATTRIBUTION. Who approved it, when, and against what external document.
//      A row with no approver and no reference is not an approval; it is a row.
//   2. A SIGNATURE, keyed by a secret that lives in the SERVER environment and
//      never in the database. Somebody with full database write access still
//      cannot mint one, because the key is not in there to steal.
//   3. FOR PRODUCTION, TWO PEOPLE. A production approval must name a second,
//      DIFFERENT admin who countersigned it, with their own signature.
//
// THE BOUNDARY THIS DOES NOT CROSS, STATED PLAINLY.
//
// Signing is HMAC with a shared server-side key, not public-key cryptography
// with per-person keys. So the two-person rule is enforceable in the DATA
// (two distinct admin identities, two distinct valid signatures) and not in the
// CEREMONY: one person holding the signing key could produce both. Closing that
// properly needs per-approver keys or an external signing service, which is a
// product feature, and inventing one against an imagined workflow would be
// worse than naming the gap. It is named here, tested, and left.
//
// WHAT IS DELIBERATELY ABSENT: any way to create an approval from a route, a
// console, or an API. There is none, and adding one is not a small change. The
// signing helper below exists so the contract can be tested and so a future
// server-side operator tool has something correct to call.
//
// NO SECRET IS EVER STORED IN AN APPROVAL. The material signed below is the
// approval's own identifying facts. The key never appears in the row, in a log,
// in an error or in any report.

const crypto = require("crypto");

const SIGNATURE_ALGORITHM = "HMAC-SHA256";

// Environments in which a production-grade two-person rule applies. Only one
// today, and it is a list rather than a comparison so the rule extends to any
// future real-money environment by editing one line.
const TWO_PERSON_ENVIRONMENTS = Object.freeze(["production"]);

const REASONS = Object.freeze({
  MISSING: "APPROVAL_MISSING",
  NOT_APPROVED: "APPROVAL_NOT_GRANTED",
  REVOKED: "APPROVAL_REVOKED",
  NO_APPROVER: "APPROVAL_HAS_NO_APPROVER",
  NO_REFERENCE: "APPROVAL_HAS_NO_EXTERNAL_REFERENCE",
  BAD_REFERENCE: "APPROVAL_REFERENCE_MALFORMED",
  NO_TIMESTAMP: "APPROVAL_HAS_NO_TIMESTAMP",
  FUTURE_TIMESTAMP: "APPROVAL_TIMESTAMP_IN_FUTURE",
  NO_SIGNING_KEY: "APPROVAL_SIGNING_KEY_ABSENT",
  UNSIGNED: "APPROVAL_UNSIGNED",
  BAD_ALGORITHM: "APPROVAL_SIGNATURE_ALGORITHM_UNKNOWN",
  BAD_SIGNATURE: "APPROVAL_SIGNATURE_INVALID",
  NO_COUNTERSIGNER: "APPROVAL_NOT_COUNTERSIGNED",
  SAME_PERSON: "APPROVAL_COUNTERSIGNED_BY_SAME_PERSON",
  BAD_COUNTERSIGNATURE: "APPROVAL_COUNTERSIGNATURE_INVALID"
});

// An external approval reference points at something OUTSIDE this system: a
// signed agreement, a board minute, a regulator's letter, a ticket in whatever
// system records decisions. It is deliberately not a UUID, because a UUID is
// what this database generates and the whole point is that the authority lives
// elsewhere.
//
// The shape is checked, never the existence: this code cannot open a filing
// cabinet. What it CAN do is refuse a reference that is obviously a placeholder.
const REFERENCE_MIN_LENGTH = 8;
const REFERENCE_MAX_LENGTH = 200;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_REFERENCES = Object.freeze([
  "n/a", "na", "none", "tbc", "tbd", "test", "testing", "pending",
  "approved", "ok", "yes", "temp", "temporary", "placeholder", "xxx", "todo"
]);

function isUuid(value) {
  return UUID_SHAPE.test(String(value || "").trim());
}

// A reference that is a bare UUID, a placeholder word, or too short to identify
// anything is refused. It is a weak check by nature, and it is still worth
// having: the failure it catches is somebody typing "approved" into the box.
function validateReference(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return { ok: false, reason: REASONS.NO_REFERENCE };
  if (text.length < REFERENCE_MIN_LENGTH || text.length > REFERENCE_MAX_LENGTH) {
    return { ok: false, reason: REASONS.BAD_REFERENCE };
  }
  if (isUuid(text)) return { ok: false, reason: REASONS.BAD_REFERENCE };
  if (PLACEHOLDER_REFERENCES.includes(text.toLowerCase())) {
    return { ok: false, reason: REASONS.BAD_REFERENCE };
  }
  return { ok: true, reason: null, reference: text };
}

// The facts a signature commits to. Order is fixed and the separator cannot
// appear in a UUID or an ISO timestamp, so two different approvals can never
// produce the same material by rearranging their fields.
//
// `approvedAt` is normalised to an ISO string because the database returns a
// Date and a caller may hand in a string; a signature that depended on which
// one it got would be unverifiable half the time.
function canonicalMaterial({ provider, capability, environment, approvedBy, approvalReference, approvedAt }) {
  const timestamp = approvedAt instanceof Date
    ? approvedAt.toISOString()
    : String(approvedAt || "");
  return [
    "titopay-banking-approval-v1",
    String(provider || ""),
    String(capability || ""),
    String(environment || ""),
    String(approvedBy || ""),
    String(approvalReference || ""),
    timestamp
  ].join("\n");
}

// The countersignature commits to the SAME material plus the countersigner, so
// it cannot be lifted from one approval and pasted onto another, and cannot be
// replayed as the primary signature.
function canonicalCountersignatureMaterial(fields, countersignedBy) {
  return `${canonicalMaterial(fields)}\ncountersigned-by\n${String(countersignedBy || "")}`;
}

function sign(material, key) {
  return crypto.createHmac("sha256", String(key)).update(material).digest("hex");
}

// Constant time, and length-safe: `timingSafeEqual` throws on a length
// mismatch, which would itself be a timing signal.
function signaturesMatch(expected, supplied) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(supplied || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

// The signing key, from the SERVER environment only. Never from the database,
// never from stored configuration, and never returned to a caller.
//
// Absent means every approval is unverifiable, which means gate 6 is shut for
// every capability. That is the fail-closed direction: a server that has not
// been given the key cannot approve anything, rather than approving everything.
function signingKey(env = process.env) {
  const key = String(env.BANKING_APPROVAL_SIGNING_KEY || "").trim();
  return key.length >= 32 ? key : "";
}

/**
 * Does this approval row actually approve anything?
 *
 * Returns a decision, never a boolean, so a refusal always carries the reason
 * an operator needs. No part of the return value contains a secret: the key is
 * used and discarded, and signatures are compared rather than reported.
 *
 * @param {object|null} row a banking_capability_approvals row
 * @param {object} options
 * @param {object} options.env       environment, for the signing key
 * @param {Date}   options.now       injectable clock, for testing
 * @returns {{approved: boolean, reason: string|null, attribution: object}}
 */
function verifyApproval(row, { env = process.env, now = new Date() } = {}) {
  const refuse = (reason, attribution = {}) => ({ approved: false, reason, attribution });

  if (!row || typeof row !== "object") return refuse(REASONS.MISSING);
  if (!row.approved) return refuse(REASONS.NOT_APPROVED);
  if (row.revoked_at) {
    return refuse(REASONS.REVOKED, {
      revokedAt: row.revoked_at, revokedBy: row.revoked_by || null,
      revocationReason: row.revocation_reason || null
    });
  }

  // 1. ATTRIBUTION. Who, when, and against what.
  if (!isUuid(row.approved_by)) return refuse(REASONS.NO_APPROVER);

  const reference = validateReference(row.approval_reference);
  if (!reference.ok) return refuse(reference.reason);

  if (!row.approved_at) return refuse(REASONS.NO_TIMESTAMP);
  const approvedAt = row.approved_at instanceof Date ? row.approved_at : new Date(row.approved_at);
  if (Number.isNaN(approvedAt.getTime())) return refuse(REASONS.NO_TIMESTAMP);
  // A future timestamp is either a clock problem or a forgery attempt. One
  // minute of tolerance, for clock skew between a server and a database.
  if (approvedAt.getTime() > now.getTime() + 60_000) return refuse(REASONS.FUTURE_TIMESTAMP);

  const attribution = {
    approvedBy: row.approved_by,
    approvalReference: reference.reference,
    approvedAt: approvedAt.toISOString(),
    countersignedBy: row.countersigned_by || null,
    auditEventId: row.audit_event_id || null
  };

  // 2. THE SIGNATURE. This is what a database writer cannot produce.
  const key = signingKey(env);
  if (!key) return refuse(REASONS.NO_SIGNING_KEY, attribution);
  if (!row.approval_signature) return refuse(REASONS.UNSIGNED, attribution);
  if (String(row.signature_algorithm || SIGNATURE_ALGORITHM) !== SIGNATURE_ALGORITHM) {
    // An unrecognised algorithm is refused rather than attempted. Downgrade is
    // a real attack: "algorithm: none" has broken more than one token format.
    return refuse(REASONS.BAD_ALGORITHM, attribution);
  }

  const fields = {
    provider: row.provider,
    capability: row.capability,
    environment: row.environment,
    approvedBy: row.approved_by,
    approvalReference: reference.reference,
    approvedAt: approvedAt.toISOString()
  };
  if (!signaturesMatch(sign(canonicalMaterial(fields), key), row.approval_signature)) {
    return refuse(REASONS.BAD_SIGNATURE, attribution);
  }

  // 3. TWO PEOPLE, where real money is involved.
  if (TWO_PERSON_ENVIRONMENTS.includes(String(row.environment || "").toLowerCase())) {
    if (!isUuid(row.countersigned_by)) return refuse(REASONS.NO_COUNTERSIGNER, attribution);
    if (String(row.countersigned_by) === String(row.approved_by)) {
      return refuse(REASONS.SAME_PERSON, attribution);
    }
    if (!row.countersignature) return refuse(REASONS.BAD_COUNTERSIGNATURE, attribution);
    const expected = sign(canonicalCountersignatureMaterial(fields, row.countersigned_by), key);
    if (!signaturesMatch(expected, row.countersignature)) {
      return refuse(REASONS.BAD_COUNTERSIGNATURE, attribution);
    }
  }

  return { approved: true, reason: null, attribution };
}

/**
 * Produce the signatures for an approval.
 *
 * Server side only, and there is deliberately no route, console page or API
 * that reaches it. It exists so the contract is testable and so a future
 * operator tool has something correct to call rather than reimplementing the
 * canonicalisation and getting it subtly wrong.
 *
 * Throws when the key is absent, rather than returning an unsigned approval
 * that would look valid until gate 6 read it.
 */
function signApproval(fields, { countersignedBy = null, env = process.env } = {}) {
  const key = signingKey(env);
  if (!key) {
    throw new Error("BANKING_APPROVAL_SIGNING_KEY is not set, or is shorter than 32 characters. An approval cannot be signed without it.");
  }
  const material = canonicalMaterial(fields);
  return {
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    approvalSignature: sign(material, key),
    countersignature: countersignedBy
      ? sign(canonicalCountersignatureMaterial(fields, countersignedBy), key)
      : null
  };
}

module.exports = {
  SIGNATURE_ALGORITHM,
  TWO_PERSON_ENVIRONMENTS,
  REASONS,
  REFERENCE_MIN_LENGTH,
  REFERENCE_MAX_LENGTH,
  PLACEHOLDER_REFERENCES,
  canonicalMaterial,
  canonicalCountersignatureMaterial,
  validateReference,
  verifyApproval,
  signApproval,
  signingKeyConfigured: (env = process.env) => Boolean(signingKey(env))
};
