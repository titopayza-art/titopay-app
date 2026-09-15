"use strict";

// A VALID, SIGNED APPROVAL, FOR TESTS THAT NEED GATE 6 OPEN.
//
// Not a test file: it defines helpers and runs nothing. It sits beside the
// suites for the same reason `pwa-path.js` does.
//
// WHY THIS EXISTS. Gate 6 used to accept any row in
// `banking_capability_approvals`. It now requires attribution, a signature
// keyed by a server-side secret, and for production a second approver. Four
// test suites were creating bare rows and expecting them to approve, and after
// the hardening they correctly stopped working. Rather than repeat the signing
// ceremony in each one, and get it subtly different in each one, it lives here.
//
// The key below is a test key. It signs approvals; it opens no bank, reaches no
// network and is not a credential for anything. The admin identities are seeded
// because `approved_by` is a foreign key to `admin_users`, which is the
// constraint doing its job.

// The runner loads every file in this directory, including one that defines no
// tests, so the same environment preamble every suite carries is needed here
// too: requiring the pool pulls in config/env, which refuses to load without
// these. Without it this file throws at require time and is reported as a
// failing test that contains no tests.
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const crypto = require("node:crypto");
const approvalContract = require("../src/config/banking-approval-contract");
const { pool } = require("../src/db/pool");

const SIGNING_KEY = "shared-test-approval-key-0123456789abcdef0123456789abcdef";
const APPROVER = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const COUNTERSIGNER = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const REFERENCE = "TEST-APPROVAL-REF-2026-08";

async function seedApprovers() {
  for (const [id, label] of [[APPROVER, "primary"], [COUNTERSIGNER, "counter"]]) {
    await pool.query(
      `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
       VALUES ($1,$2,$3,$4,'super_admin','not-a-real-hash','active')
       ON CONFLICT (id) DO NOTHING`,
      [id, `Test Approver ${label}`, `test_approver_${label}`, `test_approver_${label}@example.invalid`]
    ).catch(() => {});
  }
}

/**
 * Insert a fully valid, signed approval.
 *
 * Production approvals are countersigned by a second, different admin, because
 * the contract requires it there and only there.
 */
async function grantApproval({ provider, capability, environment }) {
  await seedApprovers();
  const approvedAt = new Date(Date.now() - 60_000).toISOString();
  const countersignedBy = environment === "production" ? COUNTERSIGNER : null;
  const fields = {
    provider, capability, environment,
    approvedBy: APPROVER, approvalReference: REFERENCE, approvedAt
  };
  const signed = approvalContract.signApproval(fields, {
    countersignedBy, env: { BANKING_APPROVAL_SIGNING_KEY: SIGNING_KEY }
  });
  await pool.query(
    `INSERT INTO banking_capability_approvals
       (provider, capability, environment, approved, approved_by, approval_reference,
        approved_at, approval_signature, signature_algorithm, countersigned_by,
        countersigned_at, countersignature, audit_event_id)
     VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (provider, capability, environment) DO UPDATE SET
       approved = TRUE, approved_by = EXCLUDED.approved_by,
       approval_reference = EXCLUDED.approval_reference, approved_at = EXCLUDED.approved_at,
       approval_signature = EXCLUDED.approval_signature,
       signature_algorithm = EXCLUDED.signature_algorithm,
       countersigned_by = EXCLUDED.countersigned_by,
       countersigned_at = EXCLUDED.countersigned_at,
       countersignature = EXCLUDED.countersignature, revoked_at = NULL`,
    [provider, capability, environment, APPROVER, REFERENCE, approvedAt,
     signed.approvalSignature, signed.signatureAlgorithm, countersignedBy,
     countersignedBy ? approvedAt : null, signed.countersignature, crypto.randomUUID()]
  );
}

async function clearApprovals(provider) {
  await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
}

module.exports = {
  SIGNING_KEY, APPROVER, COUNTERSIGNER, REFERENCE,
  seedApprovers, grantApproval, clearApprovals
};
