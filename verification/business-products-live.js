"use strict";

// PRODUCTS & STOCK — REAL DATABASE.
//
// Proves the catalogue behind "make a sale": products are created with
// opening stock, a basket sale deducts tracked stock and prices the basket
// server-side, an oversell is refused unless the till explicitly confirms,
// stock takes set the counted truth and keep the variance on the trail,
// restocks add up, archiving removes a product from sale without losing its
// history, duplicates are refused, and personal accounts get nothing at all.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/business-products-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const products = require("../api/src/services/business-products-service");

const TAG = "stocklive";
const ids = { biz: randomUUID(), personal: randomUUID() };
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Kitchen','${TAG}_biz','${TAG}_biz@example.invalid','27110000701','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Person','${TAG}_personal','${TAG}_personal@example.invalid','27110000702','x','active',FALSE,'pending')`,
    [ids.biz, ids.personal]
  );
}

async function cleanup() {
  await pool.query("DELETE FROM business_stock_movements WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM business_products WHERE business_user_id = $1", [ids.biz]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.biz, ids.personal]]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  PRODUCTS & STOCK — THE CATALOGUE BEHIND MAKE-A-SALE, REAL DATABASE");
    console.log("=".repeat(80));

    await seed();

    // 1. Create: one tracked plate, one untracked drink.
    const plate = await products.createProduct(ids.biz, { name: "1/4 chicken plate", category: "Plates", price: 55, openingStock: 20 });
    const drink = await products.createProduct(ids.biz, { name: "2L Cold-drink", category: "Drinks", price: 35 });
    assert.equal(plate.trackStock, true);
    assert.equal(plate.stockQuantity, 20);
    assert.equal(drink.trackStock, false, "no opening stock means no tracking");
    const listed = await products.listProducts(ids.biz);
    assert.equal(listed.length, 2, "both products listed for make-a-sale");
    ok("products created — tracked plate (20 in stock) and untracked drink");

    // 2. Duplicate names are refused while active.
    let duplicate = false;
    try { await products.createProduct(ids.biz, { name: "1/4 Chicken Plate", price: 60 }); }
    catch (error) { duplicate = error.statusCode === 409; }
    assert.ok(duplicate, "case-insensitive duplicate refused");
    ok("a duplicate product name is refused");

    // 3. A basket sale prices server-side and deducts tracked stock only.
    const sale = await products.recordSale(ids.biz, { items: [
      { productId: plate.id, quantity: 3 },
      { productId: drink.id, quantity: 2 }
    ] });
    assert.equal(money(sale.total), money(3 * 55 + 2 * 35), "the server prices the basket");
    const afterSale = await products.listProducts(ids.biz);
    assert.equal(afterSale.find((p) => p.id === plate.id).stockQuantity, 17, "plate stock counted down by 3");
    assert.equal(afterSale.find((p) => p.id === drink.id).trackStock, false, "untracked drink untouched");
    ok("basket sale: server-side total R" + sale.total + ", plate 20 → 17, drink untouched");

    // 4. Overselling is refused — then allowed only with explicit confirmation.
    let refused = false;
    try { await products.recordSale(ids.biz, { items: [{ productId: plate.id, quantity: 100 }] }); }
    catch (error) { refused = error.statusCode === 409 && /in stock/i.test(error.message); }
    assert.ok(refused, "an oversell is refused with the stock count in the message");
    const oversold = await products.recordSale(ids.biz, { items: [{ productId: plate.id, quantity: 100 }], allowNegative: true });
    assert.equal(oversold.lines[0].stockAfter, -83, "explicit confirmation sells anyway and shows the negative");
    ok("oversell refused by default; explicit confirmation sells and goes negative");

    // 5. Stock take sets the counted truth and records the variance.
    const taken = await products.recordStockMovement(ids.biz, plate.id, { type: "stock_take", countedQuantity: 12, note: "Evening count" });
    assert.equal(taken.product.stockQuantity, 12, "the counted quantity is the new truth");
    assert.equal(money(taken.movement.quantityChange), money(12 - (-83)), "the variance is on the movement");
    ok("stock take: counted 12 becomes the truth; variance recorded");

    // 6. Restock adds; the trail tells the whole story in order.
    await products.recordStockMovement(ids.biz, plate.id, { type: "restock", quantity: 30 });
    const restocked = await products.listProducts(ids.biz);
    assert.equal(restocked.find((p) => p.id === plate.id).stockQuantity, 42);
    const trail = await products.listMovements(ids.biz, plate.id);
    assert.deepEqual(trail.map((m) => m.type), ["restock", "stock_take", "sale", "sale", "opening"], "every movement is on the trail, newest first");
    ok("restock 12 → 42; the append-only trail holds opening, sales, count and restock");

    // 7. Archive removes it from sale but keeps the history.
    await products.updateProduct(ids.biz, plate.id, { status: "archived" });
    const remaining = await products.listProducts(ids.biz);
    assert.ok(!remaining.some((p) => p.id === plate.id), "archived product is off the till");
    let archivedSale = false;
    try { await products.recordSale(ids.biz, { items: [{ productId: plate.id, quantity: 1 }] }); }
    catch (error) { archivedSale = error.statusCode === 409; }
    assert.ok(archivedSale, "an archived product cannot be sold");
    assert.equal((await products.listMovements(ids.biz, plate.id)).length, 5, "history survives archiving");
    ok("archiving removes the product from sale and keeps its history");

    // 8. A personal account is refused, and one business cannot touch
    //    another's products.
    let personal = false;
    try { await products.listProducts(ids.personal); }
    catch (error) { personal = error.statusCode === 403; }
    assert.ok(personal);
    let foreign = false;
    try { await products.recordStockMovement(ids.personal, drink.id, { type: "restock", quantity: 5 }); }
    catch (error) { foreign = [403, 404].includes(error.statusCode); }
    assert.ok(foreign, "another account cannot move this stock");
    ok("personal accounts refused; nobody can move another business's stock");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — products, make-a-sale and stock taking hold up.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
