"use strict";

// REFUNDS.
//
//   GET  /v1/refunds                  what this business has refunded
//   GET  /v1/refunds/lookup?reference=  the payment behind a reference, and
//                                     how much of it is left to refund
//   POST /v1/refunds/preview          who gets what, and what it costs
//   POST /v1/refunds                  the refund itself
//
// A door of its own rather than a service code on /v1/transactions, for the
// same reason withdrawals and VAS purchases have theirs: createTransaction
// does one debit and knows nothing about an original payment, so it could
// never hold the rules that make a refund a refund. /v1/transactions refuses
// the code and names this endpoint.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const refunds = require("../services/refund-service");

const router = express.Router();
router.use(requireAuth);

const run = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};

const actorOf = (req) => ({
  ...req.auth,
  ipAddress: req.ip,
  userAgent: req.get("user-agent") || ""
});

router.get("/", run(async (req, res) => {
  res.json({ ok: true, items: await refunds.listRefundsForBusiness(req.auth.userId, { limit: req.query.limit }) });
}));

// The reference the business typed, resolved: who paid, how much, and what is
// still refundable. Lets the screen name the customer before anything moves,
// instead of asking the business to type a customer in and hoping it matches.
router.get("/lookup", run(async (req, res) => {
  const found = await refunds.findRefundablePayment(req.auth.userId, req.query.reference);
  res.json({
    ok: true,
    originalReference: found.original.reference,
    customerName: found.customerName,
    paid: found.paid,
    alreadyRefunded: found.alreadyRefunded,
    refundable: found.refundable
  });
}));

router.post("/preview", run(async (req, res) => {
  res.json({ ok: true, preview: await refunds.previewRefund(actorOf(req), req.body || {}) });
}));

router.post("/", run(async (req, res) => {
  res.status(201).json({ ok: true, refund: await refunds.createRefund(actorOf(req), req.body || {}) });
}));

module.exports = router;
