"use strict";

// Value-added service purchases: airtime, data, electricity, vouchers, bills.
//
// The dedicated door transaction-service points at. A VAS purchase debits the
// wallet AND delivers a redeemable token, and the two have to happen in one
// controlled lifecycle — so the generic wallet-debit endpoint refuses these
// service codes and answers with USE_VAS_PURCHASE_FLOW and this path.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  purchaseVas,
  getPurchase,
  listPurchases
} = require("../services/vas-purchase-service");

const router = express.Router();
router.use(requireAuth);

router.post("/purchase", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, purchase: await purchaseVas(req.auth, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

// The customer's own purchases. No tokens in the list — see listPurchases.
router.get("/purchases", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listPurchases(req.auth, req.query.limit) });
  } catch (error) {
    next(error);
  }
});

// One purchase, by reference or id, scoped to the caller. This is the only
// response that carries the redeemable token.
router.get("/purchases/:reference", async (req, res, next) => {
  try {
    res.json({ ok: true, purchase: await getPurchase(req.auth, req.params.reference) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
