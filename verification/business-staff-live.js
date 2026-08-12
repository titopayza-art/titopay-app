"use strict";

// SERVER-BACKED STAFF — REAL DATABASE, THE FULL DAY-TO-DAY LOOP.
//
// A business adds a cashier by their TitoPay handle; the cashier is notified
// in the app and by email, sees the business under My Workplaces, reads the
// product catalogue, and takes a sale: the basket is priced server-side,
// tracked stock counts down, the sale is logged under the cashier's name,
// and the payment QR carries the BUSINESS's identity — the money can only
// land in the business wallet. Then the guards: strangers and removed staff
// are refused, a register entry without a TitoPay account cannot sell and
// says so, the register survives across devices (it is server truth), and
// the performance report shows the cashier's till sales.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/business-staff-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const staff = require("../api/src/services/business-staff-service");
const products = require("../api/src/services/business-products-service");
const sales = require("../api/src/services/business-sales-service");
const { ensureEmailSchema } = require("../api/src/services/email-centre-service");

const TAG = "bstafflive";
const ids = { biz: randomUUID(), cashier: randomUUID(), stranger: randomUUID() };
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
let previousSendingEnabled = null;

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Spaza','${TAG}_biz','${TAG}_biz@example.invalid','27110000901','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Cashier','${TAG}_cashier','${TAG}_cashier@example.invalid','27110000902','x','active',FALSE,'pending'),
            ($3,'personal','${TAG} Stranger','${TAG}_stranger','${TAG}_stranger@example.invalid','27110000903','x','active',FALSE,'pending')`,
    [ids.biz, ids.cashier, ids.stranger]
  );
  await ensureEmailSchema();
  const { rows } = await pool.query("SELECT sending_enabled FROM email_settings WHERE id=TRUE");
  previousSendingEnabled = rows[0] ? rows[0].sending_enabled : null;
  await pool.query("UPDATE email_settings SET sending_enabled=TRUE WHERE id=TRUE");
}

async function cleanup() {
  if (previousSendingEnabled !== null) {
    await pool.query("UPDATE email_settings SET sending_enabled=$1 WHERE id=TRUE", [previousSendingEnabled]).catch(() => {});
  }
  const users = [ids.biz, ids.cashier, ids.stranger];
  await pool.query("DELETE FROM email_queue WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM business_staff_sales WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM business_staff WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM business_stock_movements WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM business_products WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM qr_codes WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  SERVER-BACKED STAFF — REGISTER, WORKPLACES AND TILL SALES, REAL DB");
    console.log("=".repeat(80));

    await seed();
    await staff.ensureStaffSchema();

    // 1. Add a cashier by @username: linked, on the register, notified.
    const added = await staff.addStaff(ids.biz, { fullName: `${TAG} Cashier`, role: "Cashier", contact: `@${TAG}_cashier` });
    assert.equal(added.linked, true, "the cashier's TitoPay account is linked");
    const register = await staff.listStaff(ids.biz);
    assert.equal(register.length, 1);
    assert.equal(register[0].role, "Cashier");
    const { rows: alerts } = await pool.query(
      "SELECT * FROM notifications WHERE user_id = $1 AND notification_type = 'business_staff_added'", [ids.cashier]);
    assert.equal(alerts.length, 1, "one in-app alert");
    const { rows: mails } = await pool.query(
      "SELECT recipient, subject FROM email_queue WHERE user_id = $1 AND idempotency_key LIKE 'business-staff-added:%'", [ids.cashier]);
    assert.equal(mails.length, 1, "one email");
    assert.ok(/Cashier/.test(mails[0].subject), "the email names the role");
    ok("cashier added by @username — linked, on the register, alerted in-app + email");

    // 2. The cashier sees the workplace from their own account.
    const workplaces = await staff.listMyWorkplaces(ids.cashier);
    assert.equal(workplaces.length, 1);
    assert.equal(workplaces[0].businessUserId, ids.biz);
    assert.equal(workplaces[0].businessName, `${TAG} Spaza`);
    ok("the cashier sees the business under My Workplaces");

    // 3. The cashier reads the catalogue and takes a basket sale.
    const plate = await products.createProduct(ids.biz, { name: "Kota", category: "Food", price: 30, openingStock: 10 });
    const catalogue = await staff.workplaceProducts(ids.cashier, ids.biz);
    assert.ok(catalogue.some((product) => product.id === plate.id), "the cashier sees the business's products");
    const sale = await staff.staffSale(ids.cashier, ids.biz, { items: [{ productId: plate.id, quantity: 2 }] });
    assert.equal(money(sale.total), 60, "the server priced the basket");
    assert.equal((await products.listProducts(ids.biz)).find((p) => p.id === plate.id).stockQuantity, 8, "stock counted down 10 → 8");
    ok("basket sale: server-priced R60, stock 10 → 8, taken by the cashier");

    // 4. The payment QR carries the BUSINESS identity — the money can only
    //    land in the business wallet, whoever's phone shows the code.
    assert.ok(sale.qr?.imageDataUrl?.startsWith("data:image/"), "a scannable QR came back");
    const { rows: qrRows } = await pool.query("SELECT user_id, amount, payload FROM qr_codes WHERE id = $1", [sale.qr.id]);
    assert.equal(qrRows[0].user_id, ids.biz, "the QR belongs to the business, not the cashier");
    assert.equal(money(qrRows[0].amount), 60);
    assert.equal(qrRows[0].payload.userId, ids.biz, "the scanned payload pays the business");
    ok("the payment QR is the business's — staff never touch the money");

    // 5. The sale is credited to the cashier on the performance report.
    const report = await sales.staffPerformance(ids.biz, {});
    const cashierRow = report.members.find((member) => member.userId === ids.cashier);
    assert.ok(cashierRow, "the cashier is on the report");
    assert.equal(cashierRow.salesCount, 1);
    assert.equal(money(cashierRow.salesTotal), 60);
    ok("Sales → Staff shows the cashier's till sale of R60");

    // 6. A typed-amount sale (no catalogue) works too.
    const quick = await staff.staffSale(ids.cashier, ids.biz, { amount: 12.5 });
    assert.equal(money(quick.total), 12.5);
    ok("a typed-amount sale works when nothing is in the catalogue");

    // 7. Strangers are refused everywhere.
    for (const call of [
      () => staff.workplaceProducts(ids.stranger, ids.biz),
      () => staff.staffSale(ids.stranger, ids.biz, { amount: 10 })
    ]) {
      let refused = false;
      try { await call(); } catch (error) { refused = error.statusCode === 403; }
      assert.ok(refused, "a stranger is refused");
    }
    ok("a stranger can neither read the catalogue nor take a sale");

    // 8. Removal switches selling off and tells the person.
    await staff.removeStaff(ids.biz, register[0].id);
    let after = false;
    try { await staff.staffSale(ids.cashier, ids.biz, { amount: 10 }); }
    catch (error) { after = error.statusCode === 403; }
    assert.ok(after, "a removed cashier can no longer sell");
    assert.equal((await staff.listMyWorkplaces(ids.cashier)).length, 0, "the workplace is gone from their app");
    const { rows: removedAlerts } = await pool.query(
      "SELECT * FROM notifications WHERE user_id = $1 AND notification_type = 'business_staff_removed'", [ids.cashier]);
    assert.equal(removedAlerts.length, 1, "the removal is announced");
    ok("removal: selling off, workplace gone, the person is told");

    // 9. A register entry with no TitoPay match is honest about it.
    const unlinked = await staff.addStaff(ids.biz, { fullName: "Paper Person", role: "Assistant", contact: "071 000 9999" });
    assert.equal(unlinked.linked, false);
    assert.ok(/cannot sell/i.test(unlinked.message), "the response says they cannot sell yet");
    ok("a register entry without a TitoPay account is saved and honestly labelled");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — staff is real: register, workplaces, till sales.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
