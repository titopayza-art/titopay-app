"use strict";

/* PROGRESSIVE KYC/FICA ON THE REAL API.
 *
 *  1. Tier 0 limits bind: a payment over the single transaction limit and a
 *     monthly send past the limit are both refused with the upgrade path.
 *  2. Basic verification with a valid SA ID upgrades to Tier 1 instantly,
 *     raises limits, and refuses an ID number already used elsewhere.
 *  3. Tier 2 (FICA verified) has no standing limits.
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

    const newbie = await seedUser("Newbie", { balance: 20000 });
    const friend = await seedUser("Friend", { fica: "verified", balance: 300000 });

    // 1. Tier 0 binds on both send checks.
    const bigSingle = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 3000, recipient: `@${friend.username}` });
    assert.equal(bigSingle.status, 403);
    assert.match(String(bigSingle.data.error || ""), /single payment.*R2500\.00/i);
    const okSend = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 2000, recipient: `@${friend.username}` });
    assert.ok([200, 201].includes(okSend.status), JSON.stringify(okSend.data));
    const secondSend = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 2400, recipient: `@${friend.username}`, idempotencyKey: `b-${TAG}` });
    assert.ok([200, 201].includes(secondSend.status));
    const overMonthly = await call(newbie.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 2200, recipient: `@${friend.username}`, idempotencyKey: `c-${TAG}` });
    assert.equal(overMonthly.status, 403, JSON.stringify(overMonthly.data));
    assert.match(String(overMonthly.data.error || ""), /sent R4400\.00 this month/);
    ok("tier 0 binds: single payment and monthly send limits both refuse with the numbers spelled out");

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

    // 3. Tier 2 is unlimited by standing limits.
    const status2 = await call(friend.token, "GET", "/v1/compliance/status");
    assert.equal(status2.data.tier, 2);
    assert.equal(status2.data.limits.monthlySend, null);
    const rich = await seedUser("Rich", { fica: "verified", balance: 0 });
    const bigVerified = await call(friend.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 60000, recipient: `@${rich.username}`, idempotencyKey: `e-${TAG}` });
    assert.ok([200, 201].includes(bigVerified.status), JSON.stringify(bigVerified.data));
    const overReceive = await call(friend.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 55000, recipient: `@${newbie.username}`, idempotencyKey: `e2-${TAG}` });
    assert.equal(overReceive.status, 403, "the tier 1 recipient's receive limit binds");
    assert.match(String(overReceive.data.error || ""), /can receive up to R50000\.00/);
    ok("tier 2 has no standing limits, and receive limits protect lower tier recipients");

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
      "SELECT * FROM compliance_flags WHERE user_id = $1 AND flag_type = 'enhanced_due_diligence'", [whale.id]);
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

    console.log(`\n${passed}/6 checks passed. Progressive KYC holds on the real API.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    await pool.query("DELETE FROM compliance_flags WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
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
