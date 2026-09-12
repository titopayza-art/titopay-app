"use strict";

// Dual authorisation (build 92): one admin requests, a DIFFERENT admin
// approves and executes. Behavioral against the real database, including a
// real reversal executed through the approval path.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "dualauth-test-access-secret-32-bytes-ok!";
process.env.JWT_REFRESH_SECRET ||= "dualauth-test-refresh-secret-32-bytes-!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const dualAuth = require("../src/services/dual-auth-service");
const { ensureLedgerPostingIndex } = require("../src/services/wallet-service");

const stamp = Date.now().toString(36);
const meta = { ipAddress: "127.0.0.1", userAgent: "node-test" };

async function makeAdmin(tag) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,$2,$3,$4,'super_admin',$5)`,
    [id, `DualAuth ${tag}`, `da_${tag}_${stamp}_${crypto.randomBytes(3).toString("hex")}`,
     `da_${tag}_${stamp}_${crypto.randomBytes(3).toString("hex")}@t.local`, await hashPassword("Str0ngPass!2026")]
  );
  return id;
}

async function makeCustomerWithWallet(balance) {
  const id = crypto.randomUUID();
  const username = `dau_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'personal','DualAuth Test',$2,$3,$4,$5)`,
    [id, username, `${username}@t.local`,
     `+2774${Math.floor(1000000 + Math.random() * 8999999)}`, await hashPassword("Str0ngPass!2026")]
  );
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, user_id, wallet_number, kind, available_balance, reserved_balance)
     VALUES ($1,$2,$3,'personal',$4,0)`,
    [walletId, id, String(Math.floor(100000000 + Math.random() * 899999999)), balance]
  );
  return { id, walletId };
}

// A completed transfer with real ledger rows, so reverseTransaction has
// something genuine to unwind when the second admin approves.
async function makeCompletedTransfer(sender, recipient, amount) {
  const txId = crypto.randomUUID();
  const reference = `TX-DAU-${stamp}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
  await pool.query(
    `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference)
     VALUES ($1,$2,$3,'wallet_transfer',$4,0,$4,'completed','debit',$5)`,
    [txId, sender.id, sender.walletId, amount, reference]
  );
  const post = async (walletId, entryType, value) => pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference)
     VALUES ($1,$2,$3,$4,$5,0,$6)`,
    [crypto.randomUUID(), walletId, txId, entryType, value, reference]
  );
  await post(sender.walletId, "debit", amount);
  await post(recipient.walletId, "credit", amount);
  return { txId, reference };
}

async function cleanup(ids) {
  for (const table of ["admin_dual_auth_requests"]) {
    await pool.query(`DELETE FROM ${table} WHERE requested_by = ANY($1)`, [ids.admins]).catch(() => {});
  }
  for (const userId of ids.users || []) {
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [userId]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [userId]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [userId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
  }
  for (const adminId of ids.admins || []) {
    await pool.query("DELETE FROM admin_users WHERE id=$1", [adminId]).catch(() => {});
  }
}

test("defaults gate reversals from R1,000 and every limit change", async () => {
  await pool.query("DELETE FROM platform_settings WHERE key='dual_auth_config'");
  assert.equal(await dualAuth.requiresReversalDualAuth(999.99), false);
  assert.equal(await dualAuth.requiresReversalDualAuth(1000), true);
  assert.equal(await dualAuth.requiresLimitChangeDualAuth(), true);
});

test("self-approval refused; a second admin approves and the reversal executes", async () => {
  const requester = await makeAdmin("req");
  const approver = await makeAdmin("apr");
  const sender = await makeCustomerWithWallet(500);
  const recipient = await makeCustomerWithWallet(3000);
  const ids = { admins: [requester, approver], users: [sender.id, recipient.id] };
  try {
    const { txId, reference } = await makeCompletedTransfer(sender, recipient, 1500);
    const request = await dualAuth.createRequest({
      actionType: "transaction_reversal",
      payload: { transactionId: txId, reason: "customer dispute" },
      summary: `Reverse ${reference} (R 1500.00)`,
      amount: 1500, adminId: requester, meta
    });
    assert.equal(request.status, "pending");

    await assert.rejects(() => dualAuth.approveRequest(request.id, requester, meta),
      /different administrator/i);

    const outcome = await dualAuth.approveRequest(request.id, approver, meta);
    assert.equal(outcome.request.status, "executed");
    const { rows } = await pool.query("SELECT status FROM transactions WHERE id=$1", [txId]);
    assert.equal(rows[0].status, "reversed", "the approval really ran the reversal");
    const senderBalance = await pool.query("SELECT available_balance FROM wallets WHERE id=$1", [sender.walletId]);
    assert.equal(Number(senderBalance.rows[0].available_balance), 2000, "sender got the money back");

    await assert.rejects(() => dualAuth.approveRequest(request.id, approver, meta), /already been decided/i);
  } finally {
    await cleanup(ids);
  }
});

test("decline needs a note; only the requester can cancel", async () => {
  const requester = await makeAdmin("req2");
  const other = await makeAdmin("oth2");
  const ids = { admins: [requester, other], users: [] };
  try {
    const request = await dualAuth.createRequest({
      actionType: "limit_change",
      payload: { config: {}, reason: "test" },
      summary: "Limit framework change: test", adminId: requester, meta
    });
    await assert.rejects(() => dualAuth.declineRequest(request.id, other, "", meta), /State why/i);
    const declined = await dualAuth.declineRequest(request.id, other, "Numbers not signed off", meta);
    assert.equal(declined.status, "declined");

    const second = await dualAuth.createRequest({
      actionType: "limit_change",
      payload: { config: {}, reason: "test 2" },
      summary: "Limit framework change: test 2", adminId: requester, meta
    });
    await assert.rejects(() => dualAuth.cancelRequest(second.id, other, meta), /Only the requester/i);
    const cancelled = await dualAuth.cancelRequest(second.id, requester, meta);
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await cleanup(ids);
  }
});

test("an approved limit change executes through saveComplianceConfig", async () => {
  const requester = await makeAdmin("req3");
  const approver = await makeAdmin("apr3");
  const ids = { admins: [requester, approver], users: [] };
  try {
    const request = await dualAuth.createRequest({
      actionType: "limit_change",
      payload: { config: {}, reason: "dual-auth execution test" },
      summary: "Limit framework change: dual-auth execution test",
      adminId: requester, meta
    });
    const outcome = await dualAuth.approveRequest(request.id, approver, meta);
    assert.equal(outcome.request.status, "executed");
    assert.equal(outcome.result.applied, true);
  } finally {
    await cleanup(ids);
  }
});

test("the settlement fee is gated, but routine pricing is not", async () => {
  await pool.query("DELETE FROM platform_settings WHERE key='dual_auth_config'");
  // Only the settlement fee triggers dual-auth; every other rule is untouched.
  assert.equal(await dualAuth.requiresPricingChangeDualAuth("pos_settlement"), true);
  assert.equal(await dualAuth.requiresPricingChangeDualAuth("POS_SETTLEMENT"), true);
  assert.equal(await dualAuth.requiresPricingChangeDualAuth("pos_qr"), false);
  assert.equal(await dualAuth.requiresPricingChangeDualAuth("wallet_transfer"), false);
  assert.equal(await dualAuth.requiresPricingChangeDualAuth(""), false);
});

test("a settlement-fee change needs a second admin and then really re-prices", async () => {
  const { ensureDefaultPricingRule, getPricingRule } = require("../src/services/pricing-service");
  const requester = await makeAdmin("prc");
  const approver = await makeAdmin("prc2");
  const ids = { admins: [requester, approver], users: [] };
  try {
    // Start from a known settlement-fee rule and note its id.
    await ensureDefaultPricingRule("pos_settlement");
    await pool.query(
      "UPDATE pricing_rules SET flat_fee = 0, percentage_fee = 0, fee_type = 'FREE', fee_value = 0 WHERE service_code = 'pos_settlement'");
    const { rows: ruleRows } = await pool.query(
      "SELECT id FROM pricing_rules WHERE service_code = 'pos_settlement' LIMIT 1");
    const ruleId = ruleRows[0].id;

    const request = await dualAuth.createRequest({
      actionType: "pricing_change",
      payload: { pricingRuleId: ruleId, pricingPayload: { flatFee: 7.5 }, serviceCode: "pos_settlement" },
      summary: "Settlement fee change (pos_settlement) requested",
      adminId: requester, meta
    });
    assert.equal(request.status, "pending");

    // The requester cannot approve their own re-pricing.
    await assert.rejects(() => dualAuth.approveRequest(request.id, requester, meta), /different administrator/i);

    // The fee has NOT changed while the request is pending.
    let rule = await getPricingRule("pos_settlement");
    assert.equal(Number(rule.flat_fee), 0, "fee must not move before the second approval");

    // A different admin approves; the fee is now applied.
    const outcome = await dualAuth.approveRequest(request.id, approver, meta);
    assert.equal(outcome.request.status, "executed");
    rule = await getPricingRule("pos_settlement");
    assert.equal(Number(rule.flat_fee), 7.5, "the approval really re-priced the settlement fee");

    // Reset so later tests see a FREE settlement fee.
    await pool.query(
      "UPDATE pricing_rules SET flat_fee = 0, percentage_fee = 0, fee_type = 'FREE', fee_value = 0 WHERE service_code = 'pos_settlement'");
  } finally {
    await cleanup(ids);
  }
});

test("duplicate ledger postings are structurally impossible once the index stands", async () => {
  await ensureLedgerPostingIndex();
  const { rows } = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_wallet_ledger_unique_posting'");
  if (!rows.length) {
    // Pre-existing duplicate history blocks the index by design (the create
    // is deliberately non-fatal). The honest assertion then is that such
    // duplicates really exist - otherwise the index should have been built.
    const dupes = await pool.query(`
      SELECT 1 FROM wallet_ledger WHERE transaction_id IS NOT NULL
      GROUP BY transaction_id, wallet_id, entry_type, reference
      HAVING COUNT(*) > 1 LIMIT 1`);
    assert.ok(dupes.rows.length > 0,
      "index missing yet no duplicates found - ensureLedgerPostingIndex failed for another reason");
    return;
  }
  const sender = await makeCustomerWithWallet(100);
  const recipient = await makeCustomerWithWallet(100);
  const ids = { admins: [], users: [sender.id, recipient.id] };
  try {
    const { txId, reference } = await makeCompletedTransfer(sender, recipient, 50);
    await assert.rejects(() => pool.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference)
       VALUES ($1,$2,$3,'debit',50,0,$4)`,
      [crypto.randomUUID(), sender.walletId, txId, reference]
    ), /duplicate key|23505/i, "a second identical posting must be refused by the database");
  } finally {
    await cleanup(ids);
  }
});
