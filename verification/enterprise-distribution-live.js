"use strict";

// ENTERPRISE BULK DISTRIBUTION — THE FULL LIFECYCLE, REAL DATABASE.
//
// Answers "is this feature fully functional?" with a run, not an opinion:
// an unlicensed business is refused (the app's Organisation-approval screen),
// applies, is approved by admin, loads beneficiaries, creates a batch, locks
// funding (reserve semantics on the business wallet), admin releases, and the
// money lands in each beneficiary's wallet with fees in the revenue wallet —
// conserved to the cent. Then the guards: insufficient balance refused before
// anything moves, a completed batch cannot pay twice, an invalid batch cannot
// be funded.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/enterprise-distribution-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
notif.deliverSms = async () => ({ id: "stub" });
const ebd = require("../api/src/services/enterprise-distribution-service");

const TAG = "ebdlive";
const ids = {
  org: randomUUID(), orgMerchant: randomUUID(), orgWallet: randomUUID(),
  ben1: randomUUID(), ben1Wallet: randomUUID(),
  ben2: randomUUID(), ben2Wallet: randomUUID(),
  admin: randomUUID()
};
const WALLET1 = String(100000000 + Math.floor(Math.random() * 899999999));
const WALLET2 = String(100000000 + Math.floor(Math.random() * 899999999));
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function bal(walletId) {
  const { rows } = await pool.query("SELECT available_balance, reserved_balance FROM wallets WHERE id = $1", [walletId]);
  return { available: Number(rows[0]?.available_balance || 0), reserved: Number(rows[0]?.reserved_balance || 0) };
}
async function revenueBalance() {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 1");
  return Number(rows[0]?.available_balance || 0);
}

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} University','${TAG}_org','${TAG}_org@example.invalid','27110000301','x','active',FALSE,'approved')`,
    [ids.org]);
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,'${TAG} University','MID-${TAG}','active','approved')`,
    [ids.orgMerchant, ids.org]);
  // Deliberately seeded LOW so the insufficient-balance guard can be proven,
  // then topped up.
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',10,0,'active')`,
    [ids.orgWallet, String(Date.now()).slice(-9), ids.org]);
  for (const [userId, walletId, walletNumber, name] of [[ids.ben1, ids.ben1Wallet, WALLET1, "Student One"], [ids.ben2, ids.ben2Wallet, WALLET2, "Student Two"]]) {
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,'personal','${TAG} ${name}','${TAG}_${walletNumber}','${TAG}_${walletNumber}@example.invalid',NULL,'x','active',FALSE,'pending')`,
      [userId]);
    await pool.query(
      `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
       VALUES ($1,$2,$3,'personal','ZAR',0,0,'active')`,
      [walletId, walletNumber, userId]);
  }
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,'${TAG} Admin','${TAG}_admin','${TAG}_admin@example.invalid','super_admin','x')`,
    [ids.admin]);
}

async function cleanup() {
  for (const table of ["enterprise_distribution_batch_items", "enterprise_distribution_batches", "enterprise_distribution_beneficiaries", "enterprise_distribution_audit_logs", "enterprise_distribution_organisations", "enterprise_distribution_applications"]) {
    await pool.query(`DELETE FROM ${table} WHERE organisation_id IN (SELECT id FROM enterprise_distribution_organisations WHERE user_id = $1)`, [ids.org]).catch(() => {});
    await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [ids.org]).catch(() => {});
  }
  const users = [ids.org, ids.ben1, ids.ben2];
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.orgWallet, ids.ben1Wallet, ids.ben2Wallet]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.orgWallet, ids.ben1Wallet, ids.ben2Wallet]]);
  await pool.query("DELETE FROM merchants WHERE id = $1", [ids.orgMerchant]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
  await pool.query("DELETE FROM admin_users WHERE id = $1", [ids.admin]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    await ebd.ensureEnterpriseDistributionSchema();
    await seed();
    console.log("\n" + "=".repeat(80));
    console.log("  ENTERPRISE BULK DISTRIBUTION — FULL LIFECYCLE, REAL DATABASE");
    console.log("=".repeat(80));

    // 1. Unlicensed: the app's screen is honest — not eligible yet.
    const before = await ebd.getEligibility(ids.org);
    assert.equal(before.eligible, false, "an unlicensed business must not be eligible");
    ok("unlicensed business is refused bulk tools (the Organisation-approval screen)");

    // 2. Apply → admin approves → licence active.
    const application = await ebd.submitApplication(ids.org, {
      organisationName: `${TAG} University`,
      registrationNumber: "2026/123456/07",
      institutionType: "university",
      fundingPurpose: "student allowances",
      expectedMonthlyVolume: 100000,
      expectedBeneficiaries: 500,
      fundingSource: "operating account"
    });
    assert.ok(application.id, "the application is recorded");
    await ebd.transitionApplication(application.id, { action: "approve", note: "verified" }, { userId: ids.admin, userType: "admin" });
    const after = await ebd.getEligibility(ids.org);
    assert.equal(after.eligible, true, "an approved licence unlocks the tools");
    ok("application approved by admin — licence active, tools unlocked");

    // 3. Beneficiaries + a validated batch of two wallet payouts.
    await ebd.upsertBeneficiary(ids.org, { name: "Student One", beneficiaryNumber: "STU-001", walletNumber: WALLET1, preferredPaymentMethod: "wallet" });
    await ebd.upsertBeneficiary(ids.org, { name: "Student Two", beneficiaryNumber: "STU-002", walletNumber: WALLET2, preferredPaymentMethod: "wallet" });
    const { batch } = await ebd.createBatch(ids.org, {
      batchName: "March allowances",
      distributionType: "student_allowance",
      rows: [
        { name: "Student One", beneficiaryNumber: "STU-001", walletNumber: WALLET1, amount: 100, currency: "ZAR", preferredPaymentMethod: "wallet" },
        { name: "Student Two", beneficiaryNumber: "STU-002", walletNumber: WALLET2, amount: 50, currency: "ZAR", preferredPaymentMethod: "wallet" }
      ]
    });
    assert.equal(batch.status, "draft_validated", `batch should validate, got ${batch.status}: ${JSON.stringify(batch.validation_summary || {})}`);
    assert.equal(Number(batch.valid_rows), 2);
    ok("batch of 2 wallet payouts (R100 + R50) validated");

    // 4. Funding is refused while the wallet cannot cover it — before any move.
    let short = false;
    try { await ebd.lockBatchFunding(ids.org, batch.id); }
    catch (error) { short = error.statusCode === 400 && /insufficient/i.test(error.message); }
    assert.ok(short, "an underfunded wallet is refused at lock time");
    const untouched = await bal(ids.orgWallet);
    assert.equal(untouched.available, 10, "nothing moved on the refusal");
    assert.equal(untouched.reserved, 0);
    ok("insufficient balance refused the lock; nothing moved");

    // 5. Top up, lock: available drops by the locked total, reserved rises.
    await pool.query("UPDATE wallets SET available_balance = 1000 WHERE id = $1", [ids.orgWallet]);
    const locked = await ebd.lockBatchFunding(ids.org, batch.id);
    const lockedTotal = Number(locked.locked_total);
    const feeTotal = Number(locked.fee_total);
    assert.equal(money(lockedTotal), money(150 + feeTotal), "locked total = payouts + fees");
    const afterLock = await bal(ids.orgWallet);
    assert.equal(money(afterLock.available), money(1000 - lockedTotal), "available drops by the locked total");
    assert.equal(money(afterLock.reserved), money(lockedTotal), "the locked total sits in reserve");
    ok(`funding locked: R${lockedTotal} reserved (R150 payouts + R${feeTotal} fees)`);

    // 6. Admin releases: each beneficiary is credited, fees land in revenue,
    //    and every cent is accounted for.
    const revBefore = await revenueBalance();
    const released = await ebd.releaseBatch(batch.id, { userId: ids.admin, userType: "admin" });
    assert.equal(released.status, "completed", `release should complete, got ${released.status}`);
    const b1 = await bal(ids.ben1Wallet);
    const b2 = await bal(ids.ben2Wallet);
    assert.equal(b1.available, 100, "Student One received exactly R100");
    assert.equal(b2.available, 50, "Student Two received exactly R50");
    const orgAfter = await bal(ids.orgWallet);
    assert.equal(money(orgAfter.reserved), 0, "the reserve is fully drained");
    assert.equal(money(orgAfter.available), money(1000 - lockedTotal), "the business paid exactly the locked total");
    const revAfter = await revenueBalance();
    assert.equal(money(revAfter - revBefore), money(feeTotal), "the fees landed in the revenue wallet");
    assert.equal(money(lockedTotal), money(100 + 50 + (revAfter - revBefore)), "money conserved to the cent: debit = credits + fees");
    ok(`released: beneficiaries R100 + R50, revenue +R${money(revAfter - revBefore)}, conserved to the cent`);

    // 7. A completed batch can never pay twice.
    const again = await ebd.releaseBatch(batch.id, { userId: ids.admin, userType: "admin" });
    assert.equal(again.status, "completed");
    assert.equal((await bal(ids.ben1Wallet)).available, 100, "a second release credits nothing");
    ok("a second release is an idempotent no-op — nobody is paid twice");

    // 8. A batch with a bad row fails validation and cannot be funded.
    const { batch: badBatch } = await ebd.createBatch(ids.org, {
      batchName: "Bad batch", distributionType: "student_allowance",
      rows: [{ name: "Ghost", beneficiaryNumber: "STU-404", walletNumber: "0000000000", amount: 25, currency: "ZAR", preferredPaymentMethod: "wallet" }]
    });
    assert.equal(badBatch.status, "draft_validation_failed", "an unknown wallet fails validation");
    let unfundable = false;
    try { await ebd.lockBatchFunding(ids.org, badBatch.id); }
    catch (error) { unfundable = error.statusCode === 409; }
    assert.ok(unfundable, "an invalid batch cannot be funded");
    ok("a batch with an unknown wallet fails validation and cannot be funded");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — Enterprise Bulk Distribution works end to end.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();
