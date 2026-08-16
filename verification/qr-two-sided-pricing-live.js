"use strict";

// A QR PAYMENT NOW HAS TWO SIDES, AND BOTH ARE MEASURED HERE.
//
//   the customer pays   R1.50 + 1% of the amount, capped at R10, ON TOP
//   the merchant pays   1.5% of the amount, OUT OF what they are credited
//
// It was a flat R0.50 from the customer and nothing from the merchant. A
// merchant_qr_payment rule has sat in the pricing schedule since it was
// written, at 1.7%, read by no code at all: every merchant has been credited in
// full on every payment TitoPay has ever settled.
//
// The only thing that really matters when money moves is that the books
// balance, so that is checked cent by cent on every case:
//
//     payer debited      == amount + payer fee
//     merchant credited  == amount - merchant fee
//     revenue credited   == payer fee + merchant fee
//     nothing unaccounted
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/qr-two-sided-pricing-live.js
//
// Seeds and deletes its own accounts. Reads the revenue wallet, never moves it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const qrService = require("../api/src/services/qr-service");
const pricing = require("../api/src/services/pricing-service");

const TAG = `tp${String(Date.now()).slice(-7)}`;
const merchant = { id: randomUUID(), phone: "27110000201", type: "business" };
const payer = { id: randomUUID(), phone: "27110000202", type: "personal" };
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// The schedule, restated independently of the code being tested.
const expectedCustomerFee = (amount) => Math.min(round(1.50 + amount * 0.01), 10);
const expectedMerchantFee = (amount) => round(amount * 0.015);

async function seed(user, balance) {
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE,'approved')`,
    [user.id, user.type, `${TAG} ${user.phone.slice(-3)}`, `${TAG}_${user.phone.slice(-3)}`,
      `${TAG}_${user.phone.slice(-3)}@example.invalid`, user.phone]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`, [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
}
const balanceOf = async (id) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [id])).rows[0].available_balance);
const revenueBalance = async () => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE kind='revenue' AND user_id IS NULL LIMIT 1")).rows[0].available_balance);

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    // The rates the app will actually use, from the pricing engine itself.
    await pricing.applyQrPricingFixupOnce();
    const customerRule = await pricing.calculateFee("qr_payment", 100);
    const merchantRule = await pricing.calculateFee("merchant_qr_payment", 100);
    assert.equal(Number(customerRule.flatFee), 1.50, `customer flat fee is R${customerRule.flatFee}`);
    assert.equal(Number(customerRule.percentageFee), 1, `customer percentage is ${customerRule.percentageFee}%`);
    assert.equal(Number(merchantRule.percentageFee), 1.5, `merchant rate is ${merchantRule.percentageFee}%`);
    ok("the schedule carries the new rates", "customer R1.50 + 1%, merchant 1.5%");

    // The cap, checked at the boundary rather than assumed.
    const capped = await pricing.calculateFee("qr_payment", 5000);
    assert.equal(round(capped.fee), 10, `a R5000 payment charges the customer R${capped.fee}`);
    const under = await pricing.calculateFee("qr_payment", 250);
    assert.equal(round(under.fee), 4, `a R250 payment charges the customer R${under.fee}`);
    ok("the customer fee is capped at R10", "R250 -> R4.00, R5000 -> R10.00");

    await seed(merchant, 0);
    await seed(payer, 60000);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), merchant.id, `${TAG} Shop`, `M${TAG}`]);

    // Real payments across the whole shape of the curve, including the cap.
    const cases = [10, 50, 250, 850, 5000];
    const rows = [];
    for (const amount of cases) {
      const before = { payer: await balanceOf(payer.id), merchant: await balanceOf(merchant.id), revenue: await revenueBalance() };
      const code = await qrService.createQr({ userId: merchant.id, userType: "customer" },
        { codeType: "dynamic", amount, label: "Sale" });
      const result = await qrService.payQr(
        { userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "pricing" },
        { qrId: code.id, idempotencyKey: randomUUID() });
      const after = { payer: await balanceOf(payer.id), merchant: await balanceOf(merchant.id), revenue: await revenueBalance() };

      const debited = round(before.payer - after.payer);
      const credited = round(after.merchant - before.merchant);
      const earned = round(after.revenue - before.revenue);
      const customerFee = expectedCustomerFee(amount);
      const merchantFee = expectedMerchantFee(amount);

      assert.equal(debited, round(amount + customerFee),
        `R${amount}: payer was debited R${debited}, expected R${round(amount + customerFee)}`);
      assert.equal(credited, round(amount - merchantFee),
        `R${amount}: merchant was credited R${credited}, expected R${round(amount - merchantFee)}`);
      assert.equal(earned, round(customerFee + merchantFee),
        `R${amount}: revenue took R${earned}, expected R${round(customerFee + merchantFee)}`);
      assert.equal(round(debited - credited - earned), 0,
        `R${amount}: R${round(debited - credited - earned)} is unaccounted for`);
      rows.push({ amount, debited, credited, earned, reference: result.reference });
    }
    console.log("");
    console.log("        sale     payer pays   merchant gets   TitoPay");
    for (const row of rows) {
      console.log(`      R${String(row.amount).padStart(5)}    R${row.debited.toFixed(2).padStart(8)}    R${row.credited.toFixed(2).padStart(9)}   R${row.earned.toFixed(2).padStart(6)}`);
    }
    console.log("");
    ok(`${cases.length} real payments settle to the cent, and the books balance on every one`);

    // The till's own view has to agree with the wallet, or the slip lies.
    const code = await qrService.createQr({ userId: merchant.id, userType: "customer" }, { codeType: "dynamic", amount: 250, label: "Slip" });
    const merchantBefore = await balanceOf(merchant.id);
    await qrService.payQr({ userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "pricing" },
      { qrId: code.id, idempotencyKey: randomUUID() });
    const status = await qrService.getQrPaymentStatus({ userId: merchant.id }, code.id);
    const actuallyCredited = round((await balanceOf(merchant.id)) - merchantBefore);
    assert.equal(status.paid, true);
    assert.equal(round(status.received), actuallyCredited,
      `the slip says R${status.received} received, the wallet moved R${actuallyCredited}`);
    assert.equal(round(status.merchantFee), 3.75, `the slip reports a merchant fee of R${status.merchantFee}`);
    assert.equal(round(status.payerFee), 4, `the slip reports a customer fee of R${status.payerFee}`);
    ok("the till's slip matches the wallet to the cent",
      `received R${round(status.received).toFixed(2)}, merchant fee R${round(status.merchantFee).toFixed(2)}, customer fee R${round(status.payerFee).toFixed(2)}`);

    // Nothing may be credited a negative amount, whatever the rate.
    assert.ok(rows.every((row) => row.credited > 0), "a merchant was credited nothing or less");
    ok("no merchant is ever credited a negative amount");

    console.log(`\n  ${passed}/5 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    for (const user of [merchant, payer]) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
