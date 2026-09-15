"use strict";

/* PROGRESSIVE KYC/FICA ON THE REAL API.
 *
 *  1. Tier 0 limits bind: a payment over the single transaction limit and a
 *     monthly send past the limit are both refused with the upgrade path.
 *  2. Basic verification with a valid SA ID upgrades to Tier 1 instantly,
 *     raises limits, and refuses an ID number already used elsewhere.
 *  3. Tier 2 (FICA verified) carries no standing limit, and a recipient at
 *     capacity has money held for them rather than lost.
 *  4. The limits are CONFIG, not code: changing platform_settings changes
 *     the enforced number immediately.
 *  5. EDD triggers automatically past the configured mark: flag written,
 *     edd_status set, customer notified in the feed.
 *  6. The status endpoint reports usage, percentages and promptNeeded so
 *     the app can warn before a limit is reached.
 *
 * Run: node verification/compliance-live.js
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

// A structurally valid SA ID number (Luhn-correct) generated for the test.
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

async function seedUser(name, { fica = "pending", balance = 0 } = {}) {
  const id = crypto.randomUUID();
  const username = `${name}_${TAG}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',$6)`,
    [id, `${name} Harness`, username, `${name}-${TAG}@example.test`,
      `+2773${String(Date.now()).slice(-6)}${users.length}`, fica]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'personal','ZAR',$4)`,
    [crypto.randomUUID(), `${String(Date.now()).slice(-7)}7${users.length}`, id, balance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]);
  const user = { id, username, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
  users.push(user);
  return user;
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
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

    const newbie = await seedUser("Newbie", { balance: 40000 });
    const friend = await seedUser("Friend", { fica: "verified", balance: 600000 });

    // 1. Tier 0 binds on both send checks.
    const bigSingle = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 3000, recipient: `@${friend.username}` });
    assert.equal(bigSingle.status, 403);
    // The refusal states what IS possible, and never invokes the law.
    assert.match(String(bigSingle.data.error || ""), /one payment right now is R2500\.00/i);
    const okSend = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 2000, recipient: `@${friend.username}` });
    assert.ok([200, 201].includes(okSend.status), JSON.stringify(okSend.data));
    const secondSend = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 1800, recipient: `@${friend.username}`, idempotencyKey: `b-${TAG}` });
    assert.ok([200, 201].includes(secondSend.status), JSON.stringify(secondSend.data));
    const overDaily = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 500, recipient: `@${friend.username}`, idempotencyKey: `c-${TAG}` });
    assert.equal(overDaily.status, 403, JSON.stringify(overDaily.data));
    assert.match(String(overDaily.data.error || ""), /today's sending capacity left/i);
    ok("tier 0 binds: the single payment and daily send limits both refuse with the numbers spelled out");

    // 2. Basic verify upgrades instantly and blocks ID reuse.
    const status0 = await call(newbie.token, "GET", "/v1/compliance/status");
    assert.equal(status0.data.tier, 0);
    const idNumber = testIdNumber(parseInt(TAG.slice(0, 4), 16) % 3999);
    const badId = await call(newbie.token, "POST", "/v1/compliance/basic-verify", { idNumber: "1234567890123" });
    assert.equal(badId.status, 400, "an invalid check digit is refused");
    const upgraded = await call(newbie.token, "POST", "/v1/compliance/basic-verify", { idNumber });
    assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
    assert.equal(upgraded.data.tier, 1);
    const nowAllowed = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 2200, recipient: `@${friend.username}`, idempotencyKey: `d-${TAG}` });
    assert.ok([200, 201].includes(nowAllowed.status), "the same payment passes at tier 1");
    const thief = await seedUser("Thief", { balance: 100 });
    const reuse = await call(thief.token, "POST", "/v1/compliance/basic-verify", { idNumber });
    assert.equal(reuse.status, 409, "one ID number, one account");
    ok("a valid SA ID upgrades to tier 1 instantly, raises limits, and cannot be reused");

    // 3. Tier 2 carries NO standing limit on any rail. That is not the same
    //    as unsupervised: risk banding, monitoring and screening all keep
    //    running, and check 9 of limit-engine-live proves risk still bounds it.
    const status2 = await call(friend.token, "GET", "/v1/compliance/status");
    assert.equal(status2.data.tier, 2);
    assert.equal(status2.data.limits.monthlySend, null);
    assert.equal(status2.data.limits.monthlyReceive, null);
    assert.equal(status2.data.limits.maxBalance, null);
    const rich = await seedUser("Rich", { fica: "verified", balance: 0 });
    const bigVerified = await call(friend.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 60000, recipient: `@${rich.username}`, idempotencyKey: `e-${TAG}` });
    assert.ok([200, 201].includes(bigVerified.status), JSON.stringify(bigVerified.data));
    // A recipient at their receiving capacity no longer refuses the sender:
    // the payment is held for the recipient to claim, and the sender is
    // never told another account's numbers or verification state.
    const overReceive = await call(friend.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 220000, recipient: `@${newbie.username}`, idempotencyKey: `e2-${TAG}` });
    assert.ok([200, 201].includes(overReceive.status), JSON.stringify(overReceive.data));
    const { rows: heldRows } = await pool.query(
      "SELECT amount FROM pending_credits WHERE recipient_user_id = $1 AND status = 'awaiting_verification'", [newbie.id]);
    assert.ok(heldRows[0], "the payment is held for the recipient rather than refused");
    ok("tier 2 carries no standing limit, and a recipient at capacity has money held for them, not lost");

    // 4. The numbers are config. Change them, and enforcement changes NOW.
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('compliance_tier_limits', $1::JSONB, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ tiers: { 1: { singleTransaction: 1000 } } })]);
    const reconfigured = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 1500, recipient: `@${friend.username}`, idempotencyKey: `f-${TAG}` });
    assert.equal(reconfigured.status, 403, JSON.stringify(reconfigured.data));
    assert.match(String(reconfigured.data.error || ""), /R1000\.00/);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'");
    ok("limits are configuration: a stored change is enforced immediately, nothing hard-coded");

    // 5. EDD triggers automatically and audibly.
    const whale = await seedUser("Whale", { fica: "verified", balance: 250000 });
    const huge = await call(whale.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 120000, recipient: `@${friend.username}`, idempotencyKey: `g-${TAG}` });
    assert.ok([200, 201].includes(huge.status), JSON.stringify(huge.data));
    await new Promise((r) => setTimeout(r, 400));
    const { rows: flags } = await pool.query(
      "SELECT * FROM compliance_flags WHERE user_id = $1 AND flag_type = 'edd_trigger'", [whale.id]);
    assert.ok(flags[0], "the EDD flag is written");
    assert.equal(flags[0].status, "open");
    const { rows: whaleRow } = await pool.query("SELECT edd_status FROM users WHERE id = $1", [whale.id]);
    assert.equal(whaleRow[0].edd_status, "required");
    const whaleFeed = await call(whale.token, "GET", "/v1/chat/notifications");
    assert.ok((whaleFeed.data.notifications || []).some((n) => n.notification_type === "compliance_edd"),
      "the customer is told in the app");
    const whaleStatus = await call(whale.token, "GET", "/v1/compliance/status");
    assert.equal(whaleStatus.data.eddActive, true);
    ok("enhanced due diligence triggers itself: flag, status, and the customer told in-app");

    // 6. The status endpoint carries everything the app needs to warn early.
    const s1 = await call(newbie.token, "GET", "/v1/compliance/status");
    assert.equal(s1.data.tier, 1);
    assert.ok(Array.isArray(s1.data.tiers) && s1.data.tiers.length === 3);
    assert.ok(s1.data.usage.sent > 0);
    assert.ok(Number.isFinite(s1.data.usage.sendPercent));
    assert.ok(typeof s1.data.promptNeeded === "boolean");
    assert.ok(s1.data.nextSteps.length >= 1);
    ok("the status endpoint reports tier, usage, percentages, prompt flag and next steps");

    // 7. Risk status is a separate axis: a signal escalates it while the KYC
    //    tier stays put, and only a compliance decision lowers it.
    const compliance = require(path.join(API, "src", "services", "compliance-service.js"));
    await compliance.recordRiskSignal(rich.id, "unusual_activity", { pattern: "harness" });
    let { rows: fr } = await pool.query("SELECT risk_status, fica_status FROM users WHERE id = $1", [rich.id]);
    assert.equal(fr[0].risk_status, "elevated");
    assert.equal(fr[0].fica_status, "verified", "KYC status untouched by risk movement");
    await compliance.setRiskStatus(rich.id, "normal", "harness_clear");
    ({ rows: fr } = await pool.query("SELECT risk_status FROM users WHERE id = $1", [rich.id]));
    assert.equal(fr[0].risk_status, "normal");
    ok("risk status moves independently of KYC and only a compliance decision lowers it");

    // 8. Sanctions screening: a list entry matches by name, raises high risk,
    //    and the flag records what matched.
    await pool.query(
      "INSERT INTO compliance_screening_list (id, label, name_pattern) VALUES ($1, $2, $3)",
      [crypto.randomUUID(), `Harness designation ${TAG}`, `Thief Harness`]);
    const thiefScreen = await compliance.screenUser(thief.id);
    assert.equal(thiefScreen.hit, true);
    const { rows: thiefRow } = await pool.query("SELECT risk_status FROM users WHERE id = $1", [thief.id]);
    assert.equal(thiefRow[0].risk_status, "high_risk");
    const { rows: screenFlags } = await pool.query(
      "SELECT details FROM compliance_flags WHERE user_id = $1 AND flag_type = 'sanctions_screening'", [thief.id]);
    assert.equal(screenFlags[0].details.matchedBy, "name");
    ok("sanctions screening matches the list, raises high risk, and records the match");

    // 9. The withdrawal gate binds per tier.
    const bigWithdrawal = await call(newbie.token, "POST", "/v1/payouts/withdrawals",
      { amount: 30000, idempotencyKey: `w-${TAG}`, bankAccountNumber: "1234567890", bankCode: "250655", accountHolder: "Newbie Harness" });
    assert.equal(bigWithdrawal.status, 403, JSON.stringify(bigWithdrawal.data));
    assert.match(String(bigWithdrawal.data.error || ""), /withdraw at once right now is R10000\.00/i);
    ok("withdrawal limits bind by tier before any wallet or provider work");

    // 10. The pre-limit nudge is a real notification.
    const { rows: sentRows2 } = await pool.query(
      `SELECT COALESCE(SUM(ABS(wl.amount)) FILTER (WHERE wl.entry_type = 'debit'), 0) AS sent
       FROM wallet_ledger wl JOIN wallets w ON w.id = wl.wallet_id
       WHERE w.user_id = $1 AND wl.created_at >= DATE_TRUNC('month', NOW())`, [newbie.id]);
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('compliance_tier_limits', $1::JSONB, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ tiers: { 1: { monthlySend: Math.round(Number(sentRows2[0].sent) / 0.85) } } })]);
    await compliance.reviewForEdd(newbie.id, 10, "wallet_transfer");
    const nudgeFeed = await call(newbie.token, "GET", "/v1/chat/notifications");
    assert.ok((nudgeFeed.data.notifications || []).some((n) => n.notification_type === "compliance_prompt"),
      "the upgrade nudge arrives as a notification before the limit is hit");
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'");
    ok("the customer is nudged to upgrade before reaching a limit, in their notifications");

    // 11. A foreign customer verifies with a passport: document type and
    //     issuing country are stored, the number only as a hash, and reuse
    //     of the same passport is refused. The wording never says SA ID.
    const traveller = await seedUser("Traveller", { balance: 5000 });
    const noCountry = await call(traveller.token, "POST", "/v1/compliance/basic-verify",
      { documentType: "passport", documentNumber: `P${TAG}77`, dateOfBirth: "1992-04-15" });
    assert.equal(noCountry.status, 400, "a passport without its issuing country is refused");
    const passportOk = await call(traveller.token, "POST", "/v1/compliance/basic-verify",
      { documentType: "passport", documentNumber: `P${TAG}77`, issuingCountry: "GB", dateOfBirth: "1992-04-15" });
    assert.equal(passportOk.status, 200, JSON.stringify(passportOk.data));
    assert.equal(passportOk.data.tier, 1);
    assert.equal(passportOk.data.document.type, "passport");
    assert.equal(passportOk.data.document.issuingCountry, "GB");
    assert.ok(!JSON.stringify(passportOk.data).includes(`P${TAG}77`.toUpperCase()),
      "the passport number never appears in the status payload");
    assert.doesNotMatch(String(passportOk.data.label || "") + String((passportOk.data.tiers || []).map((t) => t.description).join(" ")), /SA ID verified/);
    const { rows: travellerRow } = await pool.query(
      "SELECT kyc_document_type, kyc_issuing_country, id_number_hash FROM users WHERE id = $1", [traveller.id]);
    assert.equal(travellerRow[0].kyc_document_type, "passport");
    assert.equal(travellerRow[0].kyc_issuing_country, "GB");
    assert.match(String(travellerRow[0].id_number_hash), /^[a-f0-9]{64}$/, "hash only, never the number");
    const copycat = await seedUser("Copycat", { balance: 100 });
    const passportReuse = await call(copycat.token, "POST", "/v1/compliance/basic-verify",
      { documentType: "passport", documentNumber: `P${TAG}77`, issuingCountry: "GB", dateOfBirth: "1990-01-01" });
    assert.equal(passportReuse.status, 409, "one passport, one account");
    const { rows: history } = await pool.query(
      "SELECT document_type, issuing_country FROM kyc_verifications WHERE user_id = $1", [traveller.id]);
    assert.equal(history[0].document_type, "passport");
    ok("a passport verifies a foreign customer: hash-only storage, issuing country kept, reuse refused");

    // 12. The verification state machine reaches the wallet badge: the state
    //     and its customer-safe label travel in the status payload.
    assert.equal(passportOk.data.verificationState, "basic_verified");
    assert.match(String(passportOk.data.verificationLabel), /Basic Verified/);
    const whaleState = await call(whale.token, "GET", "/v1/compliance/status");
    assert.ok(["edd_required", "under_review"].includes(whaleState.data.verificationState),
      `EDD shows a review state, got ${whaleState.data.verificationState}`);
    await pool.query("UPDATE users SET fica_status = 'rejected' WHERE id = $1", [copycat.id]);
    const failedState = await call(copycat.token, "GET", "/v1/compliance/status");
    assert.equal(failedState.data.verificationState, "verification_failed");
    await pool.query("UPDATE users SET fica_status = 'submitted' WHERE id = $1", [copycat.id]);
    const progressState = await call(copycat.token, "GET", "/v1/compliance/status");
    assert.equal(progressState.data.verificationState, "verification_in_progress");
    ok("verification states flow to the badge: basic verified, review, failed and in-progress all derive correctly");

    console.log(`\n${passed}/12 checks passed. Progressive KYC holds on the real API.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    await pool.query("DELETE FROM compliance_flags WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM kyc_verifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM compliance_screening_list WHERE label LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
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
