"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const {
  listProducts,
  createProduct,
  updateProduct,
  recordStockMovement,
  listMovements,
  recordSale
} = require("../services/business-products-service");
const { ownerTillSale } = require("../services/business-staff-service");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listProducts(req.auth.userId, { includeArchived: req.query.archived === "true" }) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, product: await createProduct(req.auth.userId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const productId = requireUuid(req.params.id, "Product ID");
    res.json({ ok: true, product: await updateProduct(req.auth.userId, productId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/stock", async (req, res, next) => {
  try {
    const productId = requireUuid(req.params.id, "Product ID");
    res.status(201).json({ ok: true, ...(await recordStockMovement(req.auth.userId, productId, req.body || {})) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/movements", async (req, res, next) => {
  try {
    const productId = requireUuid(req.params.id, "Product ID");
    res.json({ ok: true, items: await listMovements(req.auth.userId, productId) });
  } catch (error) {
    next(error);
  }
});

// STOCK OUT, WITH NO PAYMENT ATTACHED.
//
// Kept for the cases that really are just a stock movement — a manual
// write-down, an offline sale being caught up, anything an owner reconciles
// by hand. The till no longer comes through here: a sale being made at the
// counter goes to /till-sale below and moves its stock when the money lands.
router.post("/record-sale", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, sale: await recordSale(req.auth.userId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

// THE OWNER'S OWN TILL: price the basket, mint the QR, wait to be paid.
//
// Nothing is sold here. The pending row this writes is settled by qr-service
// when a real payment arrives, and that is the moment the goods leave the
// shelf.
router.post("/till-sale", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, sale: await ownerTillSale(req.auth.userId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
