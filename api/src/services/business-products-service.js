"use strict";

// Business products & stock — the catalogue a business sells from.
//
// Products appear as tap-to-add chips inside "make a sale" (the receive-QR
// screen): tapping builds the basket, the basket total becomes the charge,
// and recording the sale deducts tracked stock. Stock taking writes the
// counted quantity and keeps the variance on an append-only movement trail,
// so the register always shows how a number came to be.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

let schemaReady = null;
function ensureProductsSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS business_products (
          id UUID PRIMARY KEY,
          business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'General',
          price NUMERIC(18,2) NOT NULL DEFAULT 0,
          track_stock BOOLEAN NOT NULL DEFAULT FALSE,
          stock_quantity NUMERIC(18,2) NOT NULL DEFAULT 0,
          low_stock_threshold NUMERIC(18,2) NOT NULL DEFAULT 5,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_business_products_name
         ON business_products (business_user_id, LOWER(name)) WHERE status = 'active'`
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS business_stock_movements (
          id UUID PRIMARY KEY,
          product_id UUID NOT NULL REFERENCES business_products(id) ON DELETE CASCADE,
          business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          movement_type TEXT NOT NULL CHECK (movement_type IN ('opening', 'sale', 'restock', 'adjustment', 'stock_take')),
          quantity_change NUMERIC(18,2) NOT NULL,
          quantity_after NUMERIC(18,2) NOT NULL,
          note TEXT,
          reference TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_business_stock_movements_product ON business_stock_movements (product_id, created_at DESC)"
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function requireBusiness(userId) {
  const { rows } = await pool.query("SELECT id, account_type FROM users WHERE id = $1 LIMIT 1", [userId]);
  if (!rows[0]) throw new AppError(404, "Account not found");
  if (rows[0].account_type !== "business") throw new AppError(403, "Products and stock are available on business accounts");
}

function shapeProduct(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: money(row.price),
    trackStock: row.track_stock,
    stockQuantity: money(row.stock_quantity),
    lowStockThreshold: money(row.low_stock_threshold),
    lowStock: row.track_stock && Number(row.stock_quantity) <= Number(row.low_stock_threshold),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listProducts(userId, { includeArchived = false } = {}) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const { rows } = await pool.query(
    `SELECT * FROM business_products
     WHERE business_user_id = $1${includeArchived ? "" : " AND status = 'active'"}
     ORDER BY category ASC, LOWER(name) ASC
     LIMIT 500`,
    [userId]
  );
  return rows.map(shapeProduct);
}

async function createProduct(userId, payload = {}) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const name = boundedText(payload.name, "Product name", { min: 2, max: 120 });
  const category = boundedText(payload.category || "General", "Category", { min: 1, max: 60 });
  const price = money(payload.price);
  if (!(price >= 0)) throw new AppError(400, "Enter a price of R0.00 or more");
  if (price > 1000000) throw new AppError(400, "Price is above the R1,000,000 product limit");
  const openingStock = payload.openingStock === undefined || payload.openingStock === null || payload.openingStock === ""
    ? null
    : money(payload.openingStock);
  if (openingStock !== null && (!(openingStock >= 0) || openingStock > 100000000)) {
    throw new AppError(400, "Opening stock must be zero or more");
  }
  const id = uuidv4();
  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO business_products (id, business_user_id, name, category, price, track_stock, stock_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, userId, name, category, price, openingStock !== null, openingStock ?? 0]
    ));
  } catch (error) {
    if (error.code === "23505") throw new AppError(409, `You already have a product called "${name}"`);
    throw error;
  }
  if (openingStock !== null) {
    await pool.query(
      `INSERT INTO business_stock_movements (id, product_id, business_user_id, movement_type, quantity_change, quantity_after, note)
       VALUES ($1, $2, $3, 'opening', $4, $4, 'Opening stock')`,
      [uuidv4(), id, userId, openingStock]
    );
  }
  return shapeProduct(rows[0]);
}

async function loadOwnProduct(client, userId, productId) {
  const { rows } = await client.query(
    "SELECT * FROM business_products WHERE id = $1 AND business_user_id = $2 LIMIT 1 FOR UPDATE",
    [productId, userId]
  );
  if (!rows[0]) throw new AppError(404, "Product not found");
  return rows[0];
}

async function updateProduct(userId, productId, payload = {}) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const product = await loadOwnProduct(client, userId, productId);
    const name = payload.name !== undefined ? boundedText(payload.name, "Product name", { min: 2, max: 120 }) : product.name;
    const category = payload.category !== undefined ? boundedText(payload.category, "Category", { min: 1, max: 60 }) : product.category;
    let price = product.price;
    if (payload.price !== undefined) {
      price = money(payload.price);
      if (!(price >= 0) || price > 1000000) throw new AppError(400, "Enter a price between R0.00 and R1,000,000");
    }
    const status = payload.status !== undefined
      ? (["active", "archived"].includes(String(payload.status)) ? String(payload.status) : null)
      : product.status;
    if (!status) throw new AppError(400, "Status must be active or archived");
    const { rows } = await client.query(
      `UPDATE business_products
       SET name = $3, category = $4, price = $5, status = $6, updated_at = NOW()
       WHERE id = $1 AND business_user_id = $2
       RETURNING *`,
      [productId, userId, name, category, price, status]
    );
    await client.query("COMMIT");
    return shapeProduct(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw new AppError(409, "You already have an active product with that name");
    throw error;
  } finally {
    client.release();
  }
}

// One movement, three flavours:
//   restock    — quantity arrives (positive)
//   adjustment — correction by a signed quantity (breakage, theft, error)
//   stock_take — the counted quantity IS the new truth; the movement records
//                the variance between counted and expected.
async function recordStockMovement(userId, productId, payload = {}) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const type = String(payload.type || "");
  if (!["restock", "adjustment", "stock_take"].includes(type)) {
    throw new AppError(400, "Movement type must be restock, adjustment or stock_take");
  }
  const note = payload.note ? boundedText(payload.note, "Note", { min: 1, max: 240 }) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const product = await loadOwnProduct(client, userId, productId);
    const current = money(product.stock_quantity);
    let change;
    let after;
    if (type === "stock_take") {
      const counted = money(payload.countedQuantity);
      if (!(counted >= 0)) throw new AppError(400, "Enter the counted quantity (zero or more)");
      change = money(counted - current);
      after = counted;
    } else {
      change = money(payload.quantity);
      if (type === "restock" && !(change > 0)) throw new AppError(400, "Enter how many units arrived");
      if (type === "adjustment" && !change) throw new AppError(400, "Enter the adjustment quantity (negative to remove)");
      after = money(current + change);
      if (after < 0) throw new AppError(400, `That would take stock below zero (currently ${current}). Use a stock take to set the real count.`);
    }
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO business_stock_movements (id, product_id, business_user_id, movement_type, quantity_change, quantity_after, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [movementId, productId, userId, type, change, after, note]
    );
    const { rows } = await client.query(
      `UPDATE business_products
       SET stock_quantity = $3, track_stock = TRUE, updated_at = NOW()
       WHERE id = $1 AND business_user_id = $2
       RETURNING *`,
      [productId, userId, after]
    );
    await client.query("COMMIT");
    return { product: shapeProduct(rows[0]), movement: { id: movementId, type, quantityChange: change, quantityAfter: after } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listMovements(userId, productId) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const { rows } = await pool.query(
    `SELECT m.*
     FROM business_stock_movements m
     JOIN business_products p ON p.id = m.product_id AND p.business_user_id = $1
     WHERE m.product_id = $2
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [userId, productId]
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.movement_type,
    quantityChange: money(row.quantity_change),
    quantityAfter: money(row.quantity_after),
    note: row.note || "",
    reference: row.reference || "",
    createdAt: row.created_at
  }));
}

// The basket from "make a sale": deduct tracked stock and keep the trail.
// Untracked products sell without touching a counter. A tracked product may
// sell into negative only via the explicit allowNegative flag the till sends
// — a wrong counter must never block a real customer at the counter — and
// the report flags it for the next stock take.
async function recordSale(userId, payload = {}) {
  await ensureProductsSchema();
  await requireBusiness(userId);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new AppError(400, "Add at least one product to the sale");
  if (items.length > 100) throw new AppError(400, "A sale is limited to 100 line items");
  const reference = payload.reference ? boundedText(payload.reference, "Reference", { min: 1, max: 120 }) : `SALE-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let total = 0;
    const lines = [];
    for (const item of items) {
      const quantity = money(item.quantity);
      if (!(quantity > 0) || quantity > 10000) throw new AppError(400, "Each line needs a quantity between 1 and 10,000");
      const product = await loadOwnProduct(client, userId, item.productId);
      if (product.status !== "active") throw new AppError(409, `"${product.name}" is archived and cannot be sold`);
      const lineTotal = money(money(product.price) * quantity);
      total = money(total + lineTotal);
      let after = money(product.stock_quantity);
      if (product.track_stock) {
        after = money(after - quantity);
        if (after < 0 && payload.allowNegative !== true) {
          throw new AppError(409, `Only ${money(product.stock_quantity)} of "${product.name}" in stock. Adjust the quantity, restock, or confirm selling anyway.`);
        }
        await client.query(
          "UPDATE business_products SET stock_quantity = $3, updated_at = NOW() WHERE id = $1 AND business_user_id = $2",
          [product.id, userId, after]
        );
        await client.query(
          `INSERT INTO business_stock_movements (id, product_id, business_user_id, movement_type, quantity_change, quantity_after, reference)
           VALUES ($1, $2, $3, 'sale', $4, $5, $6)`,
          [uuidv4(), product.id, userId, -quantity, after, reference]
        );
      }
      lines.push({ productId: product.id, name: product.name, quantity, unitPrice: money(product.price), lineTotal, stockAfter: product.track_stock ? after : null });
    }
    await client.query("COMMIT");
    return { reference, total, lines };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureProductsSchema,
  listProducts,
  createProduct,
  updateProduct,
  recordStockMovement,
  listMovements,
  recordSale
};
