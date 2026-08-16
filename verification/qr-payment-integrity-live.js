"use strict";

// FOUR THINGS ABOUT A QR PAYMENT, ONE OF WHICH WAS LOSING MONEY.
//
// 1. THE OWNER OF A QR CODE CAN BE NAMED.
//    The review screen has always had a card for it and it has always read
//    "Owner not confirmed", for every code and every customer, because the app
//    called GET /v1/qr/:id/details and that endpoint was never built. The
//    Security Tip screen tells people to read the verified recipient name
//    before pressing Confirm, and there was no name to read.
//
// 2. A PAYMENT WITH NOBODY TO CREDIT IS REFUSED.
//    createTransaction credited the recipient only `if (recipientWallet)` and
//    had no else. A QR whose owner had no wallet row therefore debited the
//    payer in full, took the fee, credited nobody, held nothing, and reported
//    "completed". Measured before the fix: R200.50 out, R0.50 to revenue,
//    R200.00 existing nowhere.
//
// 3. PAYING YOUR OWN QR IS REFUSED.
//    It moved money in a circle and charged the fee for doing it.
//
// 4. A MISSING REVENUE WALLET SAYS SO.
//    Nothing in the codebase creates that wallet. Without it every fee-bearing
//    wallet payment failed at Confirm while the fee preview on the same screen
//    worked, and what reached the phone was the API's blanket 5xx sentence,
//    "Unable to complete the request. Please try again.", naming nothing.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/qr-payment-integrity-live.js
//
// Runs the real Express app over HTTP. Seeds and deletes its own accounts, and
// puts the revenue wallet back exactly as it found it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { app } = require("../api/src/app");
const { pool } = require("../api/src/db/pool");
const { signAccessToken } = require("../api/src/lib/jwt");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const qrService = require("../api/src/services/qr-service");

const TAG = `qi${String(Date.now()).slice(-7)}`;
const payer = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const owner = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const orphan = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const everyone = [payer, owner, orphan];
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
let server, base, parkedRevenue = null;

async function seed(user, type, phone, balance, { wallet = true } = {}) {
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE,'approved')`,
    [user.id, type, `${TAG} ${phone.slice(-3)}`, `${TAG}_${phone.slice(-3)}`, `${TAG}_${phone.slice(-3)}@example.invalid`, phone]);
  if (wallet) {
    await pool.query(
      `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
       VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`, [randomUUID(), phone.slice(-9), user.id, type, balance]);
  }
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]);
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function call(method, path, user, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

const balanceOf = async (userId) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [userId])).rows[0].available_balance);

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    await seed(payer, "personal", "27110000111", 5000);
    await seed(owner, "business", "27110000112", 0);
    await seed(orphan, "business", "27110000113", 0, { wallet: false });
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), owner.id, `${TAG} Corner Shop`, `M${TAG}`]);

    const good = await qrService.createQr({ userId: owner.id, userType: "customer" }, { codeType: "static", label: "Till 1" });
    const orphanCode = await qrService.createQr({ userId: orphan.id, userType: "customer" }, { codeType: "static", label: "Till 2" });
    const ownCode = await qrService.createQr({ userId: payer.id, userType: "customer" }, { codeType: "static", label: "Mine" });

    server = http.createServer(app).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // 1. The owner can be named.
    const details = await call("GET", `/v1/qr/${good.id}/details`, payer);
    assert.equal(details.status, 200, `the details endpoint answered ${details.status}`);
    assert.equal(details.body.qr.owner.displayName, `${TAG} Corner Shop`, "a registered business trades under its business name");
    assert.equal(details.body.qr.owner.accountType, "business");
    ok("the QR owner is named before Confirm", details.body.qr.owner.displayName);

    // And it says nothing it should not.
    const leaked = JSON.stringify(details.body);
    for (const secret of ["example.invalid", "27110000112", "password", "available_balance"]) {
      assert.doesNotMatch(leaked, new RegExp(secret, "i"), `the details response leaked ${secret}`);
    }
    ok("and leaks no email, phone, wallet number or balance");

    // 2. Nobody to credit means nothing moves.
    const before = await balanceOf(payer.id);
    const nowhere = await call("POST", "/v1/qr/pay", payer, { qrId: orphanCode.id, amount: 200, idempotencyKey: randomUUID() });
    assert.notEqual(nowhere.status, 200, "a payment with no recipient wallet was accepted");
    assert.match(nowhere.body.error || "", /nothing was taken from your wallet/i);
    ok("a payment with nobody to credit is refused", `${nowhere.status} ${nowhere.body.error}`);

    const after = await balanceOf(payer.id);
    assert.equal(after, before, `R${(before - after).toFixed(2)} left the payer on a refused payment`);
    ok("and the payer's balance is untouched", `R${after.toFixed(2)} before and after`);

    // 3. Your own code is not a payment.
    const self = await call("POST", "/v1/qr/pay", payer, { qrId: ownCode.id, amount: 200, idempotencyKey: randomUUID() });
    assert.equal(self.status, 400);
    assert.match(self.body.error || "", /your own QR code/i);
    assert.equal(await balanceOf(payer.id), before, "money moved on a self-payment");
    ok("paying your own QR is refused, and costs nothing", self.body.error);

    const ownDetails = await call("GET", `/v1/qr/${ownCode.id}/details`, payer);
    assert.equal(ownDetails.body.qr.isOwnCode, true, "the review screen is not told it is the payer's own code");
    ok("and the review screen is told before they press Confirm");

    // An ordinary payment still works, which is the thing all of this must not break.
    // A QR payment is priced on both sides: the customer pays R1.50 + 1% on
    // top, the merchant 1.5% out of the credit. The figures are worked out
    // from the rates rather than typed in, so this reads as the rule and not
    // as two numbers that happen to be right today.
    const customerFee = Math.min(round(1.50 + 200 * 0.01), 10);
    const merchantFee = round(200 * 0.015);
    const ownerBefore = await balanceOf(owner.id);
    const paid = await call("POST", "/v1/qr/pay", payer, { qrId: good.id, amount: 200, idempotencyKey: randomUUID() });
    assert.equal(paid.status, 200, paid.body.error || "");
    assert.equal(round(await balanceOf(payer.id)), round(before - 200 - customerFee));
    assert.equal(round((await balanceOf(owner.id)) - ownerBefore), round(200 - merchantFee));
    ok("an ordinary QR payment settles on both sides",
      `payer -R${round(200 + customerFee).toFixed(2)}, merchant +R${round(200 - merchantFee).toFixed(2)}`);

    // 4. A missing revenue wallet is named, not hidden behind the blanket 5xx.
    const { rows } = await pool.query("SELECT * FROM wallets WHERE kind='revenue' AND user_id IS NULL LIMIT 1");
    parkedRevenue = rows[0] || null;
    if (parkedRevenue) {
      await pool.query("UPDATE wallets SET user_id = $2 WHERE id = $1", [parkedRevenue.id, payer.id]);
      const blind = await call("POST", "/v1/qr/pay", payer, { qrId: good.id, amount: 100, idempotencyKey: randomUUID() });
      assert.equal(blind.status, 500);
      assert.notEqual(blind.body.error, "Unable to complete the request. Please try again.",
        "a missing revenue wallet still reads as an unexplained failure");
      assert.match(blind.body.error || "", /Nothing was taken from your wallet/i);
      assert.doesNotMatch(blind.body.error || "", /revenue wallet|sql|database/i,
        "the customer must not be shown TitoPay's internal wallet architecture");
      assert.ok(blind.body.requestId, "no requestId to trace it by");
      await pool.query("UPDATE wallets SET user_id = NULL WHERE id = $1", [parkedRevenue.id]);
      parkedRevenue = null;
      ok("a missing revenue wallet says something a person can act on", blind.body.error);
    }

    console.log(`\n  ${passed}/8 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    if (parkedRevenue) await pool.query("UPDATE wallets SET user_id = NULL WHERE id = $1", [parkedRevenue.id]).catch(() => {});
    if (server) server.close();
    for (const user of everyone) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE id=$1", [user.session]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
