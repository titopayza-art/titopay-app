"use strict";

/* THE LIMIT ENGINE AND THE BUSINESS TEST, ON THE REAL API.
 *
 * The point of this harness is the opposite of the compliance one: it
 * proves the controls do NOT block legitimate customers.
 *
 *  1. Everyday life fits: a run of ordinary payments never touches a wall.
 *  2. Basic verified is a real wallet: a large legitimate payment goes.
 *  3. A refusal states the remaining capacity, never a legal threshold.
 *  4. Product rules narrow one rail without touching the others.
 *  5. Risk narrows last and wins over verification and earned standing.
 *  6. Money sent to a capacity-limited recipient is HELD, not lost.
 *  7. Verifying releases held money into the wallet, once.
 *  8. An unclaimed hold returns to the sender, in full, once.
 *  9. The capacity endpoint tells a customer what they can do.
 * 10. Fully verified has no fixed limits; high risk gives it real ones.
 *
 * Run: node verification/limit-engine-live.js
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

function testIdNumber(seed) {
  const base = `900101${String(5000 + seed).padStart(4, "0")}08`;
  for (let check = 0; check <= 9; check += 1) {
    const digits = base + String(check);
    let sum = 0;
    for (let i = 0; i < 13; i += 1) {
      let digit = Number(digits[i]);
      if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) return digits;
  }
  throw new Error("no check digit found");
}

async function seedUser(name, { fica = "pending", balance = 0, basicVerified = false } = {}) {
  const id = crypto.randomUUID();
  const username = `${name}_${TAG}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status, basic_verified_at)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',$6,$7)`,
    [id, `${name} Harness`, username, `${name}-${TAG}@example.test`,
      `+2775${String(Date.now()).slice(-6)}${users.length}`, fica, basicVerified ? new Date() : null]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'personal','ZAR',$4)`,
    [walletId, `${String(Date.now()).slice(-7)}9${users.length}`, id, balance]);
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
  const limits = require(path.join(API, "src", "services", "limit-engine.js"));
  const pending = require(path.join(API, "src", "services", "pending-credit-service.js"));
  const compliance = require(path.join(API, "src", "services", "compliance-service.js"));
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
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    await pending.ensurePendingCreditSchema();

    const spender = await seedUser("Spender", { basicVerified: true, balance: 400000 });
    const shop = await seedUser("Shop", { fica: "verified", balance: 0 });

    // 1. EVERYDAY LIFE FITS. Twelve ordinary payments, no wall.
    let everyday = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = await call(spender.token, "POST", "/v1/transactions",
        { serviceCode: "wallet_transfer", amount: 350, recipient: `@${shop.username}`, idempotencyKey: `day-${TAG}-${i}` });
      assert.ok([200, 201].includes(result.status), `payment ${i} refused: ${JSON.stringify(result.data)}`);
      everyday += 1;
    }
    assert.equal(everyday, 12);
    ok("twelve ordinary payments in a row all go through: everyday life fits inside basic verified");

    // 2. A LARGE LEGITIMATE PAYMENT GOES. Rent, at basic verified.
    const rent = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 18000, recipient: `@${shop.username}`, idempotencyKey: `rent-${TAG}` });
    assert.ok([200, 201].includes(rent.status), JSON.stringify(rent.data));
    ok("a large legitimate payment (R18 000) clears at basic verified: this is a real everyday wallet");

    // 3. A REFUSAL STATES REMAINING CAPACITY, NEVER A LEGAL THRESHOLD.
    const tooBig = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 26000, recipient: `@${shop.username}`, idempotencyKey: `big-${TAG}` });
    assert.equal(tooBig.status, 403);
    const message = String(tooBig.data.error || "");
    assert.match(message, /most you can send in one payment right now/i);
    // Word boundaries matter here: "Verification" legitimately contains
    // the letters f-i-c-a, and a naive test would fail on correct copy.
    assert.doesNotMatch(message, /\bFICA\b|\bSARB\b|statutory|legally required|required by law/i,
      "a refusal never invokes the law");
    assert.match(message, /R25000\.00|R25 000/, "the refusal quotes what IS possible");
    ok("a refusal states the remaining capacity and never claims a legal threshold");

    // 4. PRODUCT RULES NARROW ONE RAIL ONLY. A gift is capped tighter than
    //    a transfer of the same amount by the same customer.
    const bigGift = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "send_gift", amount: 8000, recipient: `@${shop.username}`, idempotencyKey: `gift-${TAG}` });
    assert.equal(bigGift.status, 403, JSON.stringify(bigGift.data));
    const sameByTransfer = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 8000, recipient: `@${shop.username}`, idempotencyKey: `xfer-${TAG}` });
    assert.ok([200, 201].includes(sameByTransfer.status), "the same amount is fine on the transfer rail");
    ok("a product rule narrows the gift rail without touching transfers");

    // 5. RISK NARROWS LAST AND WINS.
    const normalCapacity = await limits.capacityFor(spender.id);
    await compliance.recordRiskSignal(spender.id, "unusual_activity", { pattern: "harness_risk" });
    const elevatedCapacity = await limits.capacityFor(spender.id);
    assert.ok(elevatedCapacity.limits.singleTransaction < normalCapacity.limits.singleTransaction,
      "elevated risk narrows the same verified customer");
    assert.equal(elevatedCapacity.basis.riskStatus, "elevated");
    await compliance.setRiskStatus(spender.id, "normal", "harness_clear");
    await pool.query("UPDATE compliance_flags SET status = 'resolved' WHERE user_id = $1", [spender.id]);
    ok("risk narrows a fully legitimate customer's capacity and is applied last");

    // 6. MONEY SENT TO A CAPACITY-LIMITED RECIPIENT IS HELD, NOT LOST.
    const newcomer = await seedUser("Newcomer");
    await pool.query("UPDATE wallets SET available_balance = 4800 WHERE user_id = $1", [newcomer.id]);
    await pool.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,NULL,'credit',4800,4800,$3,'{}'::JSONB)`,
      [crypto.randomUUID(), newcomer.walletId, `PRIOR-${TAG}`]);
    const gift = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "send_gift", amount: 400, recipient: `@${newcomer.username}`, idempotencyKey: `held-${TAG}` });
    assert.ok([200, 201].includes(gift.status), `the sender is never blocked: ${JSON.stringify(gift.data)}`);
    const { rows: holds } = await pool.query(
      "SELECT * FROM pending_credits WHERE recipient_user_id = $1 AND status = 'awaiting_verification'", [newcomer.id]);
    assert.equal(holds.length, 1, "the payment is held for the recipient");
    assert.equal(Number(holds[0].amount), 400);
    const { rows: [newcomerWallet] } = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [newcomer.id]);
    assert.equal(Number(newcomerWallet.available_balance), 4800, "held money is never spendable before release");
    const feed = await call(newcomer.token, "GET", "/v1/chat/notifications");
    assert.ok((feed.data.notifications || []).some((n) => n.notification_type === "pending_credit"),
      "the recipient is told money is waiting");
    ok("a payment beyond the recipient's capacity is held for them, not refused, and never spendable");

    // 7. VERIFYING RELEASES HELD MONEY, ONCE.
    const verify = await call(newcomer.token, "POST", "/v1/compliance/basic-verify",
      { documentType: "sa_id", idNumber: testIdNumber((parseInt(TAG.slice(0, 4), 16) % 3900) + 40) });
    assert.equal(verify.status, 200, JSON.stringify(verify.data));
    assert.equal((verify.data.released || []).length, 1, "verifying released the held payment");
    const { rows: [afterRelease] } = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [newcomer.id]);
    assert.equal(Number(afterRelease.available_balance), 5200, "the held amount landed exactly once");
    const again = await call(newcomer.token, "POST", "/v1/compliance/pending-credits/claim", {});
    assert.equal((again.data.released || []).length, 0, "a second claim releases nothing");
    ok("verifying releases held money into the wallet exactly once");

    // 8. AN UNCLAIMED HOLD RETURNS TO THE SENDER, IN FULL, ONCE.
    const stranger = await seedUser("Stranger");
    await pool.query("UPDATE wallets SET available_balance = 4900 WHERE user_id = $1", [stranger.id]);
    await pool.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,NULL,'credit',4900,4900,$3,'{}'::JSONB)`,
      [crypto.randomUUID(), stranger.walletId, `PRIOR2-${TAG}`]);
    const { rows: [beforeSend] } = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [spender.id]);
    const doomed = await call(spender.token, "POST", "/v1/transactions",
      { serviceCode: "send_gift", amount: 300, recipient: `@${stranger.username}`, idempotencyKey: `doomed-${TAG}` });
    assert.ok([200, 201].includes(doomed.status));
    await pool.query(
      "UPDATE pending_credits SET expires_at = NOW() - INTERVAL '1 day' WHERE recipient_user_id = $1", [stranger.id]);
    const returned = await pending.returnExpiredHolds();
    assert.equal(returned.length, 1);
    const { rows: [afterReturn] } = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [spender.id]);
    assert.equal(Number(afterReturn.available_balance), Number(beforeSend.available_balance),
      "the sender is made whole to the cent");
    assert.equal((await pending.returnExpiredHolds()).length, 0, "a second sweep returns nothing");
    ok("an unclaimed payment returns to the sender in full, exactly once");

    // 9. THE CAPACITY ENDPOINT ANSWERS "WHAT CAN I DO".
    const capacity = await call(spender.token, "GET", "/v1/compliance/capacity");
    assert.equal(capacity.status, 200);
    assert.ok(Number(capacity.data.remaining.monthlySend) > 0);
    assert.ok(Number(capacity.data.remaining.singleTransaction) > 0);
    assert.equal(capacity.data.basis, undefined, "internal reasoning is never sent to the customer");
    ok("the capacity endpoint tells a customer what they can still do, without exposing the rules");

    // 10. FULLY VERIFIED HAS NO FIXED LIMITS; HIGH RISK GIVES IT REAL ONES.
    const whale = await seedUser("Whale", { fica: "verified", balance: 500000 });
    const whaleCapacity = await limits.capacityFor(whale.id);
    assert.equal(whaleCapacity.limits.monthlySend, null);
    await compliance.setRiskStatus(whale.id, "high_risk", "harness_high_risk");
    const restrained = await limits.capacityFor(whale.id);
    assert.ok(Number(restrained.limits.singleTransaction) > 0, "high risk gives an unlimited level a boundary");
    assert.ok(Number(restrained.limits.monthlySend) > 0);
    ok("fully verified carries no fixed limits, and high risk imposes real ones on it");

    console.log(`\n${passed}/10 checks passed. Legitimate activity flows; risk and capacity still bind.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    await pool.query("DELETE FROM pending_credits WHERE sender_user_id = ANY($1::UUID[]) OR recipient_user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM money_integrity_alerts WHERE user_id = ANY($1::UUID[]) OR wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
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
