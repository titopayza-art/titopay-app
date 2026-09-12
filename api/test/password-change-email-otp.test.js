"use strict";

process.env.POSTGRES_URL ||= "postgres://localhost/titopay_password_change_otp_test";
process.env.JWT_ACCESS_SECRET ||= "password-change-otp-test-access";
process.env.JWT_REFRESH_SECRET ||= "password-change-otp-test-refresh";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const emailCentre = require("../src/services/email-centre-service");
const emailOtp = require("../src/services/email-otp-service");
const audit = require("../src/services/audit-service");

const original = {
  connect: pool.connect,
  ensureEmailSchema: emailCentre.ensureEmailSchema,
  shouldRequireEmailOtp: emailOtp.shouldRequireEmailOtp,
  createChallenge: emailOtp.createChallenge,
  writeAuditLog: audit.writeAuditLog
};

emailCentre.ensureEmailSchema = async () => {};
emailOtp.shouldRequireEmailOtp = async () => true;
audit.writeAuditLog = async () => {};

function fakeClient({ existingQueue = null } = {}) {
  const queries = [];
  const client = {
    queries,
    released: false,
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      queries.push(text);
      if (text.includes("FROM users WHERE id")) return { rows: [{ id: "customer-1", user_type: "customer", status: "active", email: "customer@example.com", full_name: "Test Customer" }] };
      if (text.includes("FROM email_queue WHERE idempotency_key")) return { rows: existingQueue ? [existingQueue] : [] };
      return { rows: [] };
    },
    release() { this.released = true; }
  };
  return client;
}

test("free password-change Email OTP is atomic, queued once and idempotent", async (t) => {
  t.after(() => {
    pool.connect = original.connect;
    emailCentre.ensureEmailSchema = original.ensureEmailSchema;
    emailOtp.shouldRequireEmailOtp = original.shouldRequireEmailOtp;
    emailOtp.createChallenge = original.createChallenge;
    audit.writeAuditLog = original.writeAuditLog;
  });

  let challengeCalls = 0;
  emailOtp.createChallenge = async (_user, purpose, _meta, options) => {
    challengeCalls += 1;
    assert.equal(purpose, "change_password");
    assert.equal(options.requireEventEnabled, true);
    assert.match(options.queueIdempotencyKey, /^email-otp-password-change:customer-1:/);
    assert.equal(options.metadata.fee, 0);
    return { challengeId: "challenge-1", queueId: "queue-1", otpRequired: true, authenticationMode: "email_otp", maskedDestination: "cu***@example.com" };
  };
  delete require.cache[require.resolve("../src/services/password-change-otp-service")];
  const service = require("../src/services/password-change-otp-service");

  const queuedClient = fakeClient();
  pool.connect = async () => queuedClient;
  const charged = await service.requestEmailPasswordChangeOtp("customer-1", { idempotencyKey: "email-otp-request-001" }, {});
  assert.equal(charged.fee, 0);
  assert.equal(charged.deduplicated, false);
  assert.equal(challengeCalls, 1);
  assert.ok(queuedClient.queries.includes("BEGIN"));
  assert.ok(queuedClient.queries.includes("COMMIT"));
  assert.equal(queuedClient.queries.some((query) => query.startsWith("INSERT INTO transactions")), false);
  assert.equal(queuedClient.queries.some((query) => query.startsWith("INSERT INTO revenue_ledger")), false);
  assert.equal(queuedClient.released, true);

  const duplicateClient = fakeClient({ existingQueue: { id: "queue-1", metadata: { otpChallengeId: "challenge-1", fee: 0 } } });
  pool.connect = async () => duplicateClient;
  const duplicate = await service.requestEmailPasswordChangeOtp("customer-1", { idempotencyKey: "email-otp-request-001" }, {});
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.challengeId, "challenge-1");
  assert.equal(challengeCalls, 1, "an idempotent retry must not queue or charge another OTP");
  assert.ok(duplicateClient.queries.includes("COMMIT"));
  assert.equal(duplicateClient.queries.some((query) => query.startsWith("INSERT INTO transactions")), false);

});
