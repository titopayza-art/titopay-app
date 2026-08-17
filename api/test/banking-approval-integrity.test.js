"use strict";

// GATE 6: AN APPROVAL IS ATTRIBUTABLE, SIGNED, AND FOR PRODUCTION COUNTERSIGNED.
//
// The limitation this narrows: gate 6 used to ask the database whether a
// capability was approved, and the database answered. Anybody who could write
// to `banking_capability_approvals` could approve a bank rail.
//
// It is now necessary but not sufficient. An approval must carry attribution
// (who, when, against which external document), a signature keyed by a secret
// that lives in the SERVER environment and never in the database, and for
// production a second, different approver's countersignature.
//
// THE BOUNDARY THAT REMAINS, PROVED AT THE END OF THIS FILE: signing is HMAC
// with a shared key, so one person holding that key can produce both
// signatures. The two-person rule is enforced in the DATA and not in the
// CEREMONY. That is a real limitation, it is not hidden, and there is a test
// asserting it is exactly that and no worse.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const approvals = require("../src/config/banking-approval-contract");
const flags = require("../src/config/banking-flags");
const banking = require("../src/services/banking-service");
const { registerProvider, CAPABILITIES } = require("../src/providers");
const { pool } = require("../src/db/pool");

const API = path.join(__dirname, "..");
const CAPABILITY = "CUSTOMER_PAYMENT_INITIATION";

// A test signing key. Fake, 64 characters, and it is not a credential for
// anything: it signs approvals, it does not open a bank.
const KEY = "test-approval-signing-key-0123456789abcdef0123456789abcdef";
const ENV_WITH_KEY = { BANKING_APPROVAL_SIGNING_KEY: KEY };

const APPROVER = "11111111-1111-4111-8111-111111111111";
const SECOND_APPROVER = "22222222-2222-4222-8222-222222222222";
const REFERENCE = "BOARD-MINUTE-2026-08-17";

function fieldsFor({ provider, environment, approvedBy = APPROVER, reference = REFERENCE, approvedAt }) {
  return {
    provider, capability: CAPABILITY, environment,
    approvedBy, approvalReference: reference,
    approvedAt: approvedAt || "2026-08-17T09:00:00.000Z"
  };
}

// A complete, valid approval row as the database would return it.
function validRow(overrides = {}) {
  const environment = overrides.environment || "staging";
  const provider = overrides.provider || "approval_fixture";
  const approvedBy = overrides.approved_by || APPROVER;
  const reference = overrides.approval_reference || REFERENCE;
  const approvedAt = overrides.approved_at || "2026-08-17T09:00:00.000Z";
  const countersignedBy = Object.prototype.hasOwnProperty.call(overrides, "countersigned_by")
    ? overrides.countersigned_by
    : (environment === "production" ? SECOND_APPROVER : null);

  const fields = fieldsFor({ provider, environment, approvedBy, reference, approvedAt });
  const signed = approvals.signApproval(fields, { countersignedBy, env: ENV_WITH_KEY });

  return {
    provider, capability: CAPABILITY, environment,
    approved: true,
    approved_by: approvedBy,
    approval_reference: reference,
    approved_at: approvedAt,
    approval_signature: signed.approvalSignature,
    signature_algorithm: signed.signatureAlgorithm,
    countersigned_by: countersignedBy,
    countersigned_at: countersignedBy ? approvedAt : null,
    countersignature: signed.countersignature,
    audit_event_id: crypto.randomUUID(),
    revoked_at: null, revoked_by: null, revocation_reason: null,
    ...overrides
  };
}

const NOW = new Date("2026-08-17T12:00:00.000Z");
const verify = (row, env = ENV_WITH_KEY) => approvals.verifyApproval(row, { env, now: NOW });

/* ============================================================================
   The contract, directly
   ========================================================================== */

test("a complete, signed, attributed approval is accepted", () => {
  const verdict = verify(validRow());
  assert.equal(verdict.approved, true, verdict.reason || "");
  assert.equal(verdict.attribution.approvedBy, APPROVER);
  assert.equal(verdict.attribution.approvalReference, REFERENCE);
});

test("a bare row with no attribution and no signature is NOT an approval", () => {
  // Exactly what database write access alone can produce.
  const verdict = verify({
    provider: "x", capability: CAPABILITY, environment: "staging",
    approved: true, approved_by: null, approval_reference: null,
    approved_at: null, approval_signature: null, revoked_at: null
  });
  assert.equal(verdict.approved, false);
  assert.equal(verdict.reason, "APPROVAL_HAS_NO_APPROVER");
});

test("each attribution field is independently required", () => {
  const cases = [
    [{ approved_by: null }, "APPROVAL_HAS_NO_APPROVER"],
    [{ approved_by: "not-a-uuid" }, "APPROVAL_HAS_NO_APPROVER"],
    [{ approval_reference: null }, "APPROVAL_HAS_NO_EXTERNAL_REFERENCE"],
    [{ approval_reference: "   " }, "APPROVAL_HAS_NO_EXTERNAL_REFERENCE"],
    [{ approval_reference: "ok" }, "APPROVAL_REFERENCE_MALFORMED"],
    [{ approved_at: null }, "APPROVAL_HAS_NO_TIMESTAMP"],
    [{ approved_at: "not a date" }, "APPROVAL_HAS_NO_TIMESTAMP"]
  ];
  for (const [override, reason] of cases) {
    const verdict = verify(validRow(override));
    assert.equal(verdict.approved, false, `${JSON.stringify(override)} must refuse`);
    assert.equal(verdict.reason, reason);
  }
});

test("an approval reference must point outside this system", () => {
  // A UUID is what this database generates. The authority has to live elsewhere.
  assert.equal(verify(validRow({ approval_reference: crypto.randomUUID() })).reason,
    "APPROVAL_REFERENCE_MALFORMED");
  // And a placeholder is not a reference.
  for (const placeholder of approvals.PLACEHOLDER_REFERENCES) {
    const padded = placeholder.padEnd(approvals.REFERENCE_MIN_LENGTH, "x");
    if (!approvals.PLACEHOLDER_REFERENCES.includes(padded)) continue;
    assert.equal(verify(validRow({ approval_reference: padded })).approved, false);
  }
  assert.equal(verify(validRow({ approval_reference: "placeholder" })).reason,
    "APPROVAL_REFERENCE_MALFORMED");
});

test("an approval dated in the future is refused", () => {
  assert.equal(verify(validRow({ approved_at: "2027-01-01T00:00:00.000Z" })).reason,
    "APPROVAL_TIMESTAMP_IN_FUTURE");
  // A minute of clock skew is tolerated, because servers and databases drift.
  const nearly = new Date(NOW.getTime() + 30_000).toISOString();
  assert.equal(verify(validRow({ approved_at: nearly })).approved, true);
});

test("a revoked approval is refused, with the revocation reported", () => {
  const verdict = verify(validRow({
    revoked_at: "2026-08-17T11:00:00.000Z",
    revoked_by: SECOND_APPROVER,
    revocation_reason: "Agreement terminated"
  }));
  assert.equal(verdict.approved, false);
  assert.equal(verdict.reason, "APPROVAL_REVOKED");
  assert.equal(verdict.attribution.revocationReason, "Agreement terminated");
});

/* ============================================================================
   The signature: what database write access cannot forge
   ========================================================================== */

test("WITHOUT THE SERVER KEY, NO APPROVAL IS VALID", () => {
  // The whole point. A complete, perfectly attributed, correctly signed row,
  // read by a server that does not hold the key: refused.
  const verdict = approvals.verifyApproval(validRow(), { env: {}, now: NOW });
  assert.equal(verdict.approved, false);
  assert.equal(verdict.reason, "APPROVAL_SIGNING_KEY_ABSENT");
});

test("a short signing key is treated as no key at all", () => {
  const verdict = approvals.verifyApproval(validRow(), {
    env: { BANKING_APPROVAL_SIGNING_KEY: "tooshort" }, now: NOW
  });
  assert.equal(verdict.reason, "APPROVAL_SIGNING_KEY_ABSENT");
});

test("an unsigned approval is refused", () => {
  assert.equal(verify(validRow({ approval_signature: null })).reason, "APPROVAL_UNSIGNED");
  assert.equal(verify(validRow({ approval_signature: "" })).reason, "APPROVAL_UNSIGNED");
});

test("a forged or corrupted signature is refused", () => {
  for (const forged of [
    "0".repeat(64),
    crypto.randomBytes(32).toString("hex"),
    "deadbeef",
    validRow().approval_signature.slice(0, -1) + "0"
  ]) {
    assert.equal(verify(validRow({ approval_signature: forged })).reason,
      "APPROVAL_SIGNATURE_INVALID", `${forged.slice(0, 12)} must be refused`);
  }
});

test("a signature signed with the WRONG key is refused", () => {
  const row = validRow();
  const otherKey = { BANKING_APPROVAL_SIGNING_KEY: "a-different-key-0123456789abcdef0123456789abcdef01" };
  assert.equal(approvals.verifyApproval(row, { env: otherKey, now: NOW }).reason,
    "APPROVAL_SIGNATURE_INVALID");
});

test("an algorithm downgrade is refused rather than attempted", () => {
  for (const algorithm of ["none", "NONE", "md5", "HMAC-SHA1", "plain"]) {
    assert.equal(verify(validRow({ signature_algorithm: algorithm })).reason,
      "APPROVAL_SIGNATURE_ALGORITHM_UNKNOWN", `${algorithm} must be refused`);
  }
});

test("EVERY signed field is committed to: changing any one invalidates the signature", () => {
  // A signature that did not cover a field would let that field be edited in
  // the database afterwards. This proves each one is inside the material.
  const tampered = [
    { provider: "a_different_bank" },
    { capability: "WITHDRAWAL" },
    { environment: "production" },
    { approved_by: SECOND_APPROVER },
    { approval_reference: "BOARD-MINUTE-2026-09-99" },
    { approved_at: "2026-08-17T09:00:00.001Z" }
  ];
  for (const override of tampered) {
    const row = validRow();
    Object.assign(row, override);
    const verdict = verify(row);
    assert.equal(verdict.approved, false,
      `editing ${Object.keys(override)[0]} after signing must invalidate the approval`);
  }
});

test("a signature cannot be lifted from one approval onto another", () => {
  const staging = validRow({ provider: "bank_one", environment: "staging" });
  const other = validRow({ provider: "bank_two", environment: "staging" });
  other.approval_signature = staging.approval_signature;
  assert.equal(verify(other).reason, "APPROVAL_SIGNATURE_INVALID");
});

/* ============================================================================
   The two-person rule, for production
   ========================================================================== */

test("a production approval requires a countersigner", () => {
  const verdict = verify(validRow({ environment: "production", countersigned_by: null }));
  assert.equal(verdict.approved, false);
  assert.equal(verdict.reason, "APPROVAL_NOT_COUNTERSIGNED");
});

test("a production approval countersigned by the SAME person is refused", () => {
  const fields = fieldsFor({ provider: "approval_fixture", environment: "production" });
  const signed = approvals.signApproval(fields, { countersignedBy: APPROVER, env: ENV_WITH_KEY });
  const row = validRow({
    environment: "production",
    countersigned_by: APPROVER,
    approval_signature: signed.approvalSignature,
    countersignature: signed.countersignature
  });
  assert.equal(verify(row).reason, "APPROVAL_COUNTERSIGNED_BY_SAME_PERSON");
});

test("a production approval with a forged countersignature is refused", () => {
  assert.equal(verify(validRow({ environment: "production", countersignature: "0".repeat(64) })).reason,
    "APPROVAL_COUNTERSIGNATURE_INVALID");
  assert.equal(verify(validRow({ environment: "production", countersignature: null })).reason,
    "APPROVAL_COUNTERSIGNATURE_INVALID");
});

test("a countersignature cannot be replayed as the primary signature", () => {
  const row = validRow({ environment: "production" });
  row.approval_signature = row.countersignature;
  assert.equal(verify(row).reason, "APPROVAL_SIGNATURE_INVALID");
});

test("a countersignature naming a different person than the row does not verify", () => {
  const row = validRow({ environment: "production" });
  row.countersigned_by = "33333333-3333-4333-8333-333333333333";
  assert.equal(verify(row).reason, "APPROVAL_COUNTERSIGNATURE_INVALID");
});

test("the two-person rule applies to production and not to lower environments", () => {
  assert.deepEqual(approvals.TWO_PERSON_ENVIRONMENTS, ["production"]);
  // Staging and development approve with one person, deliberately: they move no
  // real money, and a ceremony nobody can complete is a ceremony people bypass.
  for (const environment of ["staging", "development"]) {
    assert.equal(verify(validRow({ environment, countersigned_by: null })).approved, true);
  }
});

test("THE REMAINING BOUNDARY, stated as a test: one key holder can produce both signatures", () => {
  // This is the limitation that is NOT closed, asserted so it cannot be
  // forgotten or quietly assumed away. Signing is HMAC with a shared server key,
  // so the two-person rule is enforced in the DATA (two distinct admin
  // identities, two distinct valid signatures) and not in the CEREMONY.
  //
  // Closing it needs per-approver keys or an external signing service, which is
  // a product feature. It is named in BANKING_SAFETY_AUDIT.md and here.
  const fields = fieldsFor({ provider: "approval_fixture", environment: "production" });
  const signed = approvals.signApproval(fields, { countersignedBy: SECOND_APPROVER, env: ENV_WITH_KEY });
  const row = validRow({
    environment: "production",
    approval_signature: signed.approvalSignature,
    countersignature: signed.countersignature
  });
  assert.equal(verify(row).approved, true,
    "one key holder CAN mint a valid two-person approval; this is the documented boundary");
});

/* ============================================================================
   No secret anywhere
   ========================================================================== */

test("no verdict, in any failure mode, contains the signing key or a signature", () => {
  const rows = [
    validRow(),
    validRow({ approval_signature: "0".repeat(64) }),
    validRow({ environment: "production", countersigned_by: null }),
    validRow({ revoked_at: "2026-08-17T11:00:00.000Z" }),
    { approved: true }
  ];
  for (const row of rows) {
    const serialised = JSON.stringify(verify(row));
    assert.ok(!serialised.includes(KEY), "the signing key must never appear in a verdict");
    if (row.approval_signature) {
      assert.ok(!serialised.includes(row.approval_signature),
        "a signature must never be echoed back");
    }
    if (row.countersignature) {
      assert.ok(!serialised.includes(row.countersignature));
    }
  }
});

test("the contract never reads a credential other than its own signing key", () => {
  const source = fs.readFileSync(path.join(API, "src", "config", "banking-approval-contract.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//"))
    .map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
  const envReads = [...source.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], ["BANKING_APPROVAL_SIGNING_KEY"],
    "the approval contract must read exactly one environment variable");
  assert.doesNotMatch(source, /https?:\/\//, "no endpoint may appear here");
  for (const name of ["absa", "peach", "docfox", "flash", "ott", "standard_bank", "nedbank", "capitec"]) {
    assert.ok(!source.toLowerCase().includes(name), `the contract must not name ${name}`);
  }
});

test("signApproval refuses to sign without a key rather than returning something useless", () => {
  assert.throws(
    () => approvals.signApproval(fieldsFor({ provider: "x", environment: "staging" }), { env: {} }),
    /BANKING_APPROVAL_SIGNING_KEY/
  );
});

/* ============================================================================
   Gate 6 end to end, against the real database
   ========================================================================== */

const GATE_PROVIDER = "approval_gate_fixture";

registerProvider({
  capability: CAPABILITIES.BANKING,
  key: GATE_PROVIDER,
  declaredCapabilities() {
    return flags.ALL_CAPABILITIES.map((capability) => ({
      capability, implemented: true, configured: true, reason: null
    }));
  },
  configEnvironment() {
    return { ok: true, environment: "staging", reason: null, declarations: {} };
  }
});

function gateEnvironment(extra = {}) {
  return {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_PROVIDER: GATE_PROVIDER,
    BANKING_ENVIRONMENT: "staging",
    TITOPAY_ENV: "sandbox",
    BANKING_APPROVAL_SIGNING_KEY: KEY,
    [flags.capabilityFlagName(GATE_PROVIDER, CAPABILITY)]: "true",
    ...extra
  };
}

// `approved_by` and `countersigned_by` are foreign keys to `admin_users`, so an
// approval cannot name somebody who does not exist. That is the constraint
// doing its job; these two rows are what lets the end-to-end tests exercise it.
async function seedApprovers() {
  for (const [id, label] of [[APPROVER, "one"], [SECOND_APPROVER, "two"]]) {
    await pool.query(
      `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
       VALUES ($1,$2,$3,$4,'super_admin','not-a-real-hash','active')
       ON CONFLICT (id) DO NOTHING`,
      [id, `Approval Fixture ${label}`, `approval_fixture_${label}`, `approval_fixture_${label}@example.invalid`]
    );
  }
}

async function insertApproval(row) {
  await seedApprovers();
  await pool.query(
    `INSERT INTO banking_capability_approvals
       (provider, capability, environment, approved, approved_by, approval_reference,
        approved_at, approval_signature, signature_algorithm,
        countersigned_by, countersigned_at, countersignature, audit_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (provider, capability, environment) DO UPDATE SET
       approved = EXCLUDED.approved, approved_by = EXCLUDED.approved_by,
       approval_reference = EXCLUDED.approval_reference, approved_at = EXCLUDED.approved_at,
       approval_signature = EXCLUDED.approval_signature,
       signature_algorithm = EXCLUDED.signature_algorithm,
       countersigned_by = EXCLUDED.countersigned_by,
       countersignature = EXCLUDED.countersignature, revoked_at = NULL`,
    [row.provider, row.capability, row.environment, row.approved, row.approved_by,
     row.approval_reference, row.approved_at, row.approval_signature, row.signature_algorithm,
     row.countersigned_by, row.countersigned_at, row.countersignature, row.audit_event_id]
  );
}

async function clear() {
  await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [GATE_PROVIDER]).catch(() => {});
}

async function gateEntry(env) {
  const previous = process.env.BANKING_PROVIDER;
  process.env.BANKING_PROVIDER = GATE_PROVIDER;
  try {
    const report = await banking.getCapabilityReport({ env });
    return report.capabilities.find((c) => c.capability === CAPABILITY);
  } finally {
    if (previous === undefined) delete process.env.BANKING_PROVIDER;
    else process.env.BANKING_PROVIDER = previous;
  }
}

test("GATE 6 end to end: a fully valid signed approval opens the capability", async () => {
  try {
    await insertApproval(validRow({ provider: GATE_PROVIDER, environment: "staging" }));
    const entry = await gateEntry(gateEnvironment());
    assert.equal(entry.gates.approved, true, entry.reason || "");
    assert.equal(entry.available, true, "all six gates open");
    assert.equal(entry.approvedBy, APPROVER);
    assert.equal(entry.approvalReference, REFERENCE);
  } finally { await clear(); }
});

test("GATE 6 end to end: an UNSIGNED row in the database does not open anything", async () => {
  // The attack this closes: somebody with database write access inserts an
  // approval. Every other gate is open. The capability stays shut.
  try {
    await pool.query(
      `INSERT INTO banking_capability_approvals (provider, capability, environment, approved, approved_at)
       VALUES ($1,$2,'staging',TRUE,NOW())`,
      [GATE_PROVIDER, CAPABILITY]
    );
    const entry = await gateEntry(gateEnvironment());
    assert.equal(entry.gates.implemented, true, "code exists");
    assert.equal(entry.gates.configured, true, "configuration resolves");
    assert.equal(entry.gates.flagEnabled, true, "flag on");
    assert.equal(entry.gates.environmentPermits, true, "environments paired");
    assert.equal(entry.gates.configEnvironmentBound, true, "stored config bound");
    assert.equal(entry.gates.approved, false, "but the approval is not attributable");
    assert.equal(entry.available, false, "database write access alone must not open a bank rail");
    assert.equal(entry.reason, "APPROVAL_HAS_NO_APPROVER");
  } finally { await clear(); }
});

test("GATE 6 end to end: without the server signing key, a valid row still refuses", async () => {
  try {
    await insertApproval(validRow({ provider: GATE_PROVIDER, environment: "staging" }));
    const env = gateEnvironment();
    delete env.BANKING_APPROVAL_SIGNING_KEY;
    const entry = await gateEntry(env);
    assert.equal(entry.gates.approved, false);
    assert.equal(entry.reason, "APPROVAL_SIGNING_KEY_ABSENT");
    assert.equal(entry.available, false);
  } finally { await clear(); }
});

test("GATE 6 end to end: a signature tampered with in the database refuses", async () => {
  try {
    await insertApproval(validRow({ provider: GATE_PROVIDER, environment: "staging" }));
    await pool.query(
      "UPDATE banking_capability_approvals SET approval_reference = $2 WHERE provider = $1",
      [GATE_PROVIDER, "EDITED-AFTER-SIGNING-2026"]
    );
    const entry = await gateEntry(gateEnvironment());
    assert.equal(entry.gates.approved, false);
    assert.equal(entry.reason, "APPROVAL_SIGNATURE_INVALID");
  } finally { await clear(); }
});

test("the database itself refuses a production approval countersigned by the same person", async () => {
  await seedApprovers();
  // The two-person rule is in the schema as well as the contract, because a
  // rule that lives only in application code is one bad query away from gone.
  await assert.rejects(
    async () => pool.query(
      `INSERT INTO banking_capability_approvals
         (provider, capability, environment, approved, approved_by, countersigned_by)
       VALUES ($1,$2,'production',TRUE,$3,$3)`,
      [GATE_PROVIDER, CAPABILITY, APPROVER]
    ),
    /banking_approvals_two_person|violates check constraint/i
  );
  await clear();
});

test("no capability report, in any state, leaks a signature or the signing key", async () => {
  try {
    await insertApproval(validRow({ provider: GATE_PROVIDER, environment: "staging" }));
    const previous = process.env.BANKING_PROVIDER;
    process.env.BANKING_PROVIDER = GATE_PROVIDER;
    let report;
    try { report = await banking.getCapabilityReport({ env: gateEnvironment() }); }
    finally {
      if (previous === undefined) delete process.env.BANKING_PROVIDER;
      else process.env.BANKING_PROVIDER = previous;
    }
    const serialised = JSON.stringify(report);
    assert.ok(!serialised.includes(KEY), "the signing key must never reach a report");
    assert.ok(!/[0-9a-f]{64}/.test(serialised.replace(/"[0-9a-f-]{36}"/g, "")),
      "no 64-character hex digest may appear in a report");
    for (const field of ["approval_signature", "countersignature", "signature"]) {
      assert.ok(!serialised.includes(field), `${field} must not be in the report shape`);
    }
  } finally { await clear(); }
});
