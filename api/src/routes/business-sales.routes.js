"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { salesLedger, salesSummary, staffPerformance } = require("../services/business-sales-service");

const router = express.Router();
router.use(requireAuth);

function range(req) {
  const clean = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "");
  return { from: clean(req.query.from), to: clean(req.query.to) };
}

router.get("/ledger", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await salesLedger(req.auth.userId, range(req))) });
  } catch (error) {
    next(error);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    res.json({ ok: true, summary: await salesSummary(req.auth.userId, range(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/staff-performance", async (req, res, next) => {
  try {
    res.json({ ok: true, report: await staffPerformance(req.auth.userId, range(req)) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
