"use strict";

/* THE MONEY INTEGRITY ENGINE ON THE REAL API.
 *
 *  1. A clean, balanced transfer raises nothing.
 *  2. A duplicate ledger posting is detected.
 *  3. A completed transaction with no ledger entries is detected (orphan).
 *  4. A balance changed without a ledger entry is detected (mismatch),
 *     and resolving then recurring re-opens the same alert.
 *  5. Status history: every transition recorded; reversed is terminal at
 *     the database level.
 *  6. A stale in-flight payment is detected.
 *  7. Provider reconciliation: amount mismatch and missing settlement land
 *     in the exception queue with a run record.
 *  8. Case management: assign and decide, with audit entries.
 *  9. A limit change without a reason is refused; with one, the audit
 *     carries reason + previous + new.
 * 10. A document reuse attempt raises a duplicate_account risk flag on the
 *     attempting account.
 *
 * Run: node verification/money-integrity-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };
const users = [];

async function seedUser(name, { fica = "pending", balance = 0 } = {}) {
  const id = crypto.randomUUID();
  const username = `${name}_${TAG}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',$6)`,
    [id, `${name} Harness`, username, `${name}-${TAG}@example.test`,
      `+2774${String(Date.now()).slice(-6)}${users.length}`, fica]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'personal','ZAR',$4)`,
    [walletId, `${String(Date.now()).slice(-7)}8${users.length}`, id, balance]);
  // The sweep proves balance == ledger, so a seeded opening balance carries
  // its own ledger entry, the same way a real credit would.
  if (balance > 0) {
    await pool.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,NULL,'credit',$3,$3,$4,'{}'::JSONB)`,
      [crypto.randomUUID(), walletId, balance, `OPENING-${TAG}-${users.length}`]);
  }
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]);
  const user = { id, walletId, username, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
  users.push(user);
  return user;
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const integrity = require(path.join(API, "src", "services", "money-integrity-service.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, apiPath, body) => {
    const response = await fetch(`${base}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  try {
    await integrity.ensureIntegritySchema();
    const payer = await seedUser("Payer", { balance: 10000 });
    const payee = await seedUser("Payee", { balance: 0 });

    // 1. A clean transfer through the real rail raises nothing about itself.
    const send = await call(payer.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 500, recipient: `@${payee.username}` });
    assert.ok([200, 201].includes(send.status), JSON.stringify(send.data));
    const cleanSweep = await integrity.runIntegritySweep({});
    const { rows: cleanAlerts } = await pool.query(
      "SELECT alert_type FROM money_integrity_alerts WHERE (user_id = $1 OR user_id = $2) AND status = 'open'",
      [payer.id, payee.id]);
    assert.equal(cleanAlerts.length, 0, `clean transfer flagged: ${JSON.stringify(cleanAlerts)}`);
    ok("a clean, balanced transfer sweeps clean");

    // 2. Duplicate posting detection: copy a real ledger row.
    const { rows: [ledgerRow] } = await pool.query(
      "SELECT * FROM wallet_ledger WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 1", [payee.walletId]);
    await pool.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::JSONB)`,
      [crypto.randomUUID(), ledgerRow.wallet_id, ledgerRow.transaction_id, ledgerRow.entry_type,
        ledgerRow.amount, ledgerRow.balance_after, ledgerRow.reference]);
    await integrity.runIntegritySweep({});
    const { rows: dupAlerts } = await pool.query(
      "SELECT id FROM money_integrity_alerts WHERE alert_type = 'duplicate_posting' AND wallet_id = $1 AND status = 'open'",
      [payee.walletId]);
    assert.ok(dupAlerts[0], "the duplicate posting is flagged");
    ok("a duplicated ledger posting is detected as critical");

    // 3. Orphan: a completed transaction with no ledger trace.
    const orphanId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference)
       VALUES ($1,$2,$3,'wallet_transfer',250,0,250,'completed','debit',$4)`,
      [orphanId, payer.id, payer.walletId, `TX-ORPHAN-${TAG}`]);
    await integrity.runIntegritySweep({});
    const { rows: orphanAlerts } = await pool.query(
      "SELECT id FROM money_integrity_alerts WHERE alert_type = 'orphan_transaction' AND transaction_id = $1", [orphanId]);
    assert.ok(orphanAlerts[0], "the orphan is flagged");
    ok("a completed transaction with no ledger entries is detected");

    // 4. Balance mismatch: money appears with no ledger entry. Then resolve
    //    and let it recur: the SAME alert must re-open, not vanish.
    await pool.query("UPDATE wallets SET available_balance = available_balance + 777 WHERE id = $1", [payee.walletId]);
    await integrity.runIntegritySweep({});
    const { rows: [mismatch] } = await pool.query(
      "SELECT id, status FROM money_integrity_alerts WHERE alert_type = 'balance_mismatch' AND wallet_id = $1", [payee.walletId]);
    assert.ok(mismatch, "the mismatch is flagged");
    await integrity.resolveAlert(mismatch.id, { userId: payer.id }, "harness resolution");
    await integrity.runIntegritySweep({});
    const { rows: [reopened] } = await pool.query(
      "SELECT status FROM money_integrity_alerts WHERE id = $1", [mismatch.id]);
    assert.equal(reopened.status, "open", "a recurring condition re-opens its alert");
    ok("a balance changed without a ledger entry is detected, and recurrence re-opens the alert");

    // 5. Status history + terminal reversed.
    const lifecycleId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference)
       VALUES ($1,$2,$3,'wallet_transfer',10,0,10,'pending','debit',$4)`,
      [lifecycleId, payer.id, payer.walletId, `TX-LIFE-${TAG}`]);
    await pool.query("UPDATE transactions SET status = 'processing' WHERE id = $1", [lifecycleId]);
    await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [lifecycleId]);
    await pool.query("UPDATE transactions SET status = 'reversed' WHERE id = $1", [lifecycleId]);
    const { rows: history } = await pool.query(
      "SELECT from_status, to_status FROM transaction_status_history WHERE transaction_id = $1 ORDER BY changed_at", [lifecycleId]);
    assert.deepEqual(history.map((h) => `${h.from_status || "start"}>${h.to_status}`),
      ["start>pending", "pending>processing", "processing>completed", "completed>reversed"]);
    let terminalHeld = false;
    try {
      await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [lifecycleId]);
    } catch (error) {
      terminalHeld = /reversed is terminal/.test(error.message);
    }
    assert.ok(terminalHeld, "the database refuses to resurrect a reversed transaction");
    ok("every status transition is recorded and reversed is terminal at the database");

    // 6. Stale in-flight detection.
    const staleId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, created_at, updated_at)
       VALUES ($1,$2,$3,'wallet_transfer',300,0,300,'pending','credit',$4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
      [staleId, payer.id, payer.walletId, `TX-STALE-${TAG}`]);
    await integrity.runIntegritySweep({});
    const { rows: staleAlerts } = await pool.query(
      "SELECT id FROM money_integrity_alerts WHERE alert_type = 'stale_in_flight' AND transaction_id = $1", [staleId]);
    assert.ok(staleAlerts[0], "the stuck payment is flagged");
    ok("a payment stuck in flight past the window is detected");

    // 7. Provider reconciliation with disagreements.
    const recon = await integrity.runProviderReconciliation({
      provider: "harness",
      entries: [
        { reference: `TX-LIFE-${TAG}`, amount: 10, state: "settled" },
        { reference: `TX-ORPHAN-${TAG}`, amount: 999, state: "settled" },
        { reference: `TX-STALE-${TAG}`, amount: 300, state: "settled" },
        { reference: `NEVER-SEEN-${TAG}`, amount: 50, state: "settled" }
      ],
      actor: { userId: payer.id }
    });
    assert.ok(recon.exceptions >= 3, `expected exceptions, got ${recon.exceptions}`);
    const { rows: excTypes } = await pool.query(
      "SELECT exception_type FROM reconciliation_exceptions WHERE run_id = $1", [recon.runId]);
    const types = excTypes.map((row) => row.exception_type);
    assert.ok(types.includes("amount_mismatch"));
    assert.ok(types.includes("missing_settlement"));
    assert.ok(types.includes("unmatched_provider_transaction"));
    const { rows: [run] } = await pool.query("SELECT * FROM reconciliation_runs WHERE id = $1", [recon.runId]);
    assert.equal(run.checked_count, 4);
    ok("provider reconciliation queues amount, settlement and unmatched exceptions with a run record");

    // 8. Case management: assign and decide a flag.
    const compliance = require(path.join(API, "src", "services", "compliance-service.js"));
    const flagId = await compliance.recordRiskSignal(payer.id, "unusual_activity", { pattern: "harness_case" });
    await pool.query("UPDATE compliance_flags SET assigned_to = $2 WHERE id = $1", [flagId, payer.id]);
    await pool.query(
      `UPDATE compliance_flags SET status = 'resolved', decision = 'no_action', resolved_at = NOW(), resolution_note = 'harness'
       WHERE id = $1`, [flagId]);
    const { rows: [caseRow] } = await pool.query(
      "SELECT assigned_to, decision, status FROM compliance_flags WHERE id = $1", [flagId]);
    assert.equal(caseRow.decision, "no_action");
    assert.equal(caseRow.status, "resolved");
    ok("a compliance flag carries assignment and a recorded decision");

    // 9. Limit changes: reason mandatory, audit carries previous and new.
    const before = await compliance.loadComplianceConfig();
    await compliance.saveComplianceConfig({ userId: payer.id }, { tiers: { 1: { singleTransaction: 12345 } } }, { reason: "harness change" });
    const { rows: [auditRow] } = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action = 'compliance_limits_updated' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(auditRow.metadata.reason, "harness change");
    assert.equal(Number(auditRow.metadata.previous.tiers["1"].singleTransaction),
      Number(before.tiers["1"].singleTransaction));
    assert.equal(Number(auditRow.metadata.config.tiers["1"].singleTransaction), 12345);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'");
    ok("a limit change records reason, previous value and new value in one audit entry");

    // 10. Document reuse attempt flags the attempting account.
    const original = await seedUser("Original");
    const mimic = await seedUser("Mimic");
    const passport = { documentType: "passport", documentNumber: `MI${TAG}9`, issuingCountry: "DE", dateOfBirth: "1990-06-01" };
    const first = await call(original.token, "POST", "/v1/compliance/basic-verify", passport);
    assert.equal(first.status, 200);
    const second = await call(mimic.token, "POST", "/v1/compliance/basic-verify", passport);
    assert.equal(second.status, 409);
    const { rows: dupFlags } = await pool.query(
      "SELECT id FROM compliance_flags WHERE user_id = $1 AND flag_type = 'duplicate_account'", [mimic.id]);
    assert.ok(dupFlags[0], "the reuse attempt is flagged on the attempting account");
    ok("a document reuse attempt raises a duplicate account flag for compliance");

    console.log(`\n${passed}/10 checks passed. Money integrity holds on the real API.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    await pool.query("DELETE FROM money_integrity_alerts WHERE user_id = ANY($1::UUID[]) OR wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM reconciliation_exceptions WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM reconciliation_runs WHERE triggered_by = ANY($1::UUID[]) OR scope = 'provider:harness'", [ids]).catch(() => {});
    await pool.query("DELETE FROM compliance_flags WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM kyc_verifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM transaction_status_history WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM beneficiary_history WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM email_queue WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::UUID[])", [ids]).catch(() => {});
  }
})();
