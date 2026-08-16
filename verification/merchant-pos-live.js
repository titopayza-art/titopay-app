"use strict";

// THE TILL, DRIVEN THE WAY A SHOP USES IT.
//
// Make a Sale puts a code on screen and says "Waiting for payment...". A real
// soft POS turns over the moment the money lands and prints a slip. This one
// waited five minutes and expired, on every completed sale, because it was
// looking for the payment in the wrong place:
//
//   a payment writes ONE transactions row, owned by the PAYER
//   the merchant is credited through wallet_ledger
//   listTransactionsForUser filters on t.user_id
//
// so the merchant's own transaction list could never contain the sale, and the
// till searched it every 2.5 seconds until the clock ran out. The money had
// already arrived; only the screen did not know.
//
//   1. The merchant opens Make a Sale and generates a code for an amount.
//   2. A customer pays that code, from another account, for real.
//   3. The till turns over BY ITSELF, within seconds, with no interaction.
//   4. A slip is produced, and it says what the merchant actually received.
//   5. The countdown is running, not frozen.
//   6. The status endpoint refuses somebody else's code.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/merchant-pos-live.js
//
// Needs the API on 8110 and the PWA on 8010.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const qrService = require("../api/src/services/qr-service");

const TAG = `ps${String(Date.now()).slice(-7)}`;
const PASS = "Str0ng!Pass2026";
const SHOP = `${TAG} Corner Cafe`;
const SALE = 250;
const merchant = { id: randomUUID(), phone: "27110000191", type: "business" };
const payer = { id: randomUUID(), phone: "27110000192", type: "personal" };
const stranger = { id: randomUUID(), phone: "27110000193", type: "business" };

async function seed(user, balance) {
  user.email = `${TAG}_${user.phone.slice(-3)}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status,basic_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'approved',NOW())`,
    [user.id, user.type, `${TAG} ${user.phone.slice(-3)}`, `${TAG}_${user.phone.slice(-3)}`,
      user.email, user.phone, await bcrypt.hash(PASS, 10)]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`, [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
}

const signIn = async ({ email, password, accountType }) => {
  const response = await fetch("https://api.titopay.co.za/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password })
  });
  const body = await response.json();
  const token = body.accessToken || body.token || (body.tokens && body.tokens.accessToken);
  if (!token) throw new Error("sign in failed");
  state.auth = Object.assign({}, state.auth || {}, body.tokens || {}, { accessToken: token });
  state.user = body.user || {};
  state.accountType = accountType;
  await refreshData().catch(() => {});
};

async function openApp(context, user) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("http://127.0.0.1:8010/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(signIn, { email: user.email, password: PASS, accountType: user.type });
  return { page, errors };
}

const balanceOf = async (id) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [id])).rows[0].available_balance);

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  let browser = null;
  try {
    await seed(merchant, 0);
    await seed(payer, 5000);
    await seed(stranger, 0);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), merchant.id, SHOP, `M${TAG}`]);

    browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
    const context = await browser.newContext({ viewport: { width: 900, height: 1100 }, serviceWorkers: "block" });
    await context.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const target = request.url().replace("https://api.titopay.co.za", "http://127.0.0.1:8110");
      const headers = Object.assign({}, request.headers());
      delete headers.host; delete headers.origin; delete headers.referer;
      const upstream = await fetch(target, { method: request.method(), headers, body: request.postData() || undefined, redirect: "manual" });
      const body = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      upstream.headers.forEach((value, key) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) out[key] = value;
      });
      out["access-control-allow-origin"] = "*";
      await route.fulfill({ status: upstream.status, headers: out, body });
    });

    const till = await openApp(context, merchant);

    // 1. Ring up a sale on the keypad, exactly as a cashier does.
    await till.page.evaluate(() => openMerchantSaleModal());
    await till.page.waitForSelector("[data-pos-key]", { timeout: 10000 });
    for (const digit of String(SALE)) {
      await till.page.click(`[data-pos-key="${digit}"]`);
    }
    const onKeypad = await till.page.evaluate(() => (document.querySelector(".merchant-sale-amount strong") || {}).textContent || "");
    assert.match(onKeypad, /250/, `the keypad showed "${onKeypad}"`);
    await till.page.click("[data-action='merchant-generate-qr']");
    await till.page.waitForSelector("[data-sale-countdown]", { timeout: 15000 });
    const qrId = await till.page.evaluate(() => state.merchantSale?.qr?.id || "");
    assert.match(qrId, /^[0-9a-f-]{36}$/i, "the till did not mint a code");
    ok("the till rings up a sale and puts a code on screen", `R${SALE}.00, ${qrId.slice(0, 8)}…`);

    // 5. The clock is running, not frozen at 05:00.
    const first = await till.page.evaluate(() => (document.querySelector("[data-sale-countdown]") || {}).textContent || "");
    await till.page.waitForTimeout(2500);
    const second = await till.page.evaluate(() => (document.querySelector("[data-sale-countdown]") || {}).textContent || "");
    assert.notEqual(first, second, `the countdown is frozen at ${first}`);
    ok("the countdown is running", `${first} -> ${second}`);

    // 6. Somebody else's code is not their business.
    const shop2 = await openApp(context, stranger);
    const refused = await shop2.page.evaluate(async (id) => {
      try { await api(`/v1/qr/${encodeURIComponent(id)}/status`); return "ALLOWED"; }
      catch (error) { return String(error.message || error); }
    }, qrId);
    assert.match(refused, /not found/i, `another business could read this till's code: ${refused}`);
    ok("the status of a code is the owner's business alone", refused);
    await shop2.page.close();

    // 2. The customer pays, from their own account, for real.
    const merchantBefore = await balanceOf(merchant.id);
    const buyer = await openApp(context, payer);
    const paid = await buyer.page.evaluate(async (id) => {
      try { return { ok: true, result: await api("/v1/qr/pay", { method: "POST", body: { qrId: id, idempotencyKey: crypto.randomUUID() } }) }; }
      catch (error) { return { ok: false, error: String(error.message || error) }; }
    }, qrId);
    assert.equal(paid.ok, true, `the payment failed: ${paid.error}`);
    await buyer.page.close();

    // 3. The till turns over on its own. Nothing is clicked.
    await till.page.waitForFunction(() => state.merchantSale && state.merchantSale.status === "paid",
      { timeout: 20000 }).catch(() => {});
    const settled = await till.page.evaluate(() => ({
      status: state.merchantSale?.status || "(none)",
      heading: (document.querySelector(".merchant-success-screen .eyebrow, .merchant-success-screen h2") || {}).textContent || "",
      receipt: state.merchantSale?.receipt || null
    }));
    assert.equal(settled.status, "paid", `the till is still "${settled.status}" after a completed payment`);
    ok("the till turns over by itself when the money lands", `status "${settled.status}", nothing clicked`);

    // 4. A slip, with the right figures on it.
    //
    // A QR payment is priced on both sides: the customer pays R1.50 + 1% on
    // top, and the merchant 1.5% out of the credit. This slip is the
    // MERCHANT'S, so Fees is the merchant's 1.5% and nothing else, and
    // netAmount is what actually reached the wallet. The expected figures come
    // from the live schedule rather than being typed in, so an admin changing
    // a rate does not read here as the till having broken.
    const merchantRate = (await require("../api/src/services/pricing-service")
      .calculateFee("merchant_qr_payment", SALE)).fee;
    const expectedFee = Math.round((Number(merchantRate) + Number.EPSILON) * 100) / 100;
    const expectedNet = Math.round((SALE - expectedFee + Number.EPSILON) * 100) / 100;
    assert.ok(settled.receipt, "no slip was produced");
    assert.equal(Number(settled.receipt.amount), SALE);
    assert.equal(Number(settled.receipt.netAmount), expectedNet,
      `the slip says the merchant received R${settled.receipt.netAmount} on a R${SALE} sale, expected R${expectedNet}`);
    assert.equal(Number(settled.receipt.fees), expectedFee,
      `the slip says the merchant paid R${settled.receipt.fees}, expected R${expectedFee}`);
    assert.ok(Number(settled.receipt.payerFee) > Number(settled.receipt.fees),
      "the slip is carrying the customer's fee as the merchant's");
    assert.equal(settled.receipt.status, "PAID");
    assert.match(settled.receipt.merchantName, new RegExp(TAG));
    ok("a slip is produced, and its figures are the merchant's",
      `received R${Number(settled.receipt.netAmount).toFixed(2)}, merchant fee R${Number(settled.receipt.fees).toFixed(2)}`);

    const merchantAfter = await balanceOf(merchant.id);
    assert.equal(Number((merchantAfter - merchantBefore).toFixed(2)), expectedNet,
      "the wallet and the slip disagree about what was received");
    ok("and the wallet agrees with the slip", `+R${(merchantAfter - merchantBefore).toFixed(2)}`);

    assert.deepEqual(till.errors, [], "script errors on the till");
    ok("no script errors on the till through the whole sale");

    console.log(`\n  ${passed}/7 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    for (const user of [merchant, payer, stranger]) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
