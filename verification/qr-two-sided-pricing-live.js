"use strict";

// A QR PAYMENT NOW HAS TWO SIDES, AND BOTH ARE MEASURED HERE.
//
//   the customer pays   a flat R1.50, ON TOP of the amount
//   the merchant pays   R1.50 + 1.5% of the amount, OUT OF the credit
//
// A person pays the same R1.50 on a R20 coffee as on a R5000 sofa. The
// percentage sits on the business side, where the sale is being earned.
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
const expectedCustomerFee = () => 1.50;
const expectedMerchantFee = (amount) => round(1.50 + amount * 0.015);

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
    assert.equal(Number(customerRule.percentageFee), 0, `customer percentage is ${customerRule.percentageFee}%`);
    assert.equal(Number(merchantRule.flatFee), 1.50, `merchant flat fee is R${merchantRule.flatFee}`);
    assert.equal(Number(merchantRule.percentageFee), 1.5, `merchant rate is ${merchantRule.percentageFee}%`);
    ok("the schedule carries the new rates", "customer a flat R1.50, merchant R1.50 + 1.5%");

    // The customer's side does not move with the sale. Checked across three
    // orders of magnitude rather than assumed from the rule alone.
    for (const amount of [20, 250, 5000, 20000]) {
      const quoted = await pricing.calculateFee("qr_payment", amount);
      assert.equal(round(quoted.fee), 1.50, `a R${amount} payment charges the customer R${quoted.fee}`);
    }
    ok("the customer pays R1.50 whatever the sale", "R20, R250, R5000 and R20000 all charge R1.50");

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
    assert.equal(round(status.merchantFee), expectedMerchantFee(250), `the slip reports a merchant fee of R${status.merchantFee}`);
    assert.equal(round(status.payerFee), expectedCustomerFee(250), `the slip reports a customer fee of R${status.payerFee}`);
    ok("the till's slip matches the wallet to the cent",
      `received R${round(status.received).toFixed(2)}, merchant fee R${round(status.merchantFee).toFixed(2)}, customer fee R${round(status.payerFee).toFixed(2)}`);

    // Nothing may be credited a negative amount, whatever the rate.
    assert.ok(rows.every((row) => row.credited > 0), "a merchant was credited nothing or less");
    ok("no merchant is ever credited a negative amount");

    // A SALE SMALLER THAN ITS OWN FEE IS REFUSED, NOT SETTLED AT ZERO.
    //
    // The merchant's side carries a flat component, so under about R1.52 the
    // fee reaches the whole sale. Taking the customer's money, crediting the
    // business nothing and reporting success would be the worst of the three
    // possible outcomes, so the boundary is checked from both sides of itself.
    const tiny = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "dynamic", amount: 1, label: "Too small" });
    const beforeTiny = { payer: await balanceOf(payer.id), merchant: await balanceOf(merchant.id) };
    let refusal = null;
    try {
      await qrService.payQr({ userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "pricing" },
        { qrId: tiny.id, idempotencyKey: randomUUID() });
    } catch (error) { refusal = error; }
    assert.ok(refusal, "a R1.00 sale was accepted, and the business was credited nothing");
    assert.equal(refusal.statusCode, 400, "the refusal is a 400, so the customer reads the real reason");
    assert.match(refusal.message, /too small/i);
    assert.equal(round(await balanceOf(payer.id)), round(beforeTiny.payer), "the payer was charged on a refused payment");
    assert.equal(round(await balanceOf(merchant.id)), round(beforeTiny.merchant), "the merchant moved on a refused payment");

    // And just above the boundary it settles normally.
    const small = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "dynamic", amount: 2, label: "Small" });
    const beforeSmall = await balanceOf(merchant.id);
    await qrService.payQr({ userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "pricing" },
      { qrId: small.id, idempotencyKey: randomUUID() });
    const creditedSmall = round((await balanceOf(merchant.id)) - beforeSmall);
    assert.ok(creditedSmall > 0, `a R2.00 sale credited the merchant R${creditedSmall}`);
    ok("a sale too small to carry its own fee is refused, and nothing moves",
      `R1.00 refused, R2.00 settles at R${creditedSmall.toFixed(2)}`);

    console.log(`\n  ${passed}/6 checks passed\n`);
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
