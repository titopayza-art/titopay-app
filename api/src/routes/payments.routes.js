const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { AppError } = require("../lib/errors");
const { payQr } = require("../services/qr-service");
const { config } = require("../config/env");
const {
  getCardTopupStatus,
  confirmCardTopup,
  captureCardTopup,
  cancelCardTopup,
  refundCardTopup
} = require("../services/peach-payments-service");
// The PAYMENT capability. Which provider supplies it is configuration; this
// route asks for processPayment and never for a named company's checkout.
const {
  processPayment,
  getPaymentStatus,
  listRecentPayments
} = require("../providers/payment-provider");

const router = express.Router();

router.use(requireAuth);

function assertTransactionsAllowed(req) {
  if (req.auth.profileLocked) {
    throw new AppError(423, "Profile is locked. Payment actions are disabled until OTP unlock.");
  }
}

router.post("/qr", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const result = await payQr(req.auth, req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Card top-up runs on Peach Checkout V2. The response carries a redirectUrl the
// PWA sends the customer to; the wallet is credited only after this server has
// verified the checkout with Peach.
router.post("/topup", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const result = await processPayment(req.auth, {
      ...req.body,
      idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey
    });
    res.status(result.idempotentReplay ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/topup", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listRecentPayments(req.auth, req.query.limit) });
  } catch (error) { next(error); }
});

// Status polling stays available while a profile is locked so a customer can
// always see how a payment they already made resolved.
router.get("/topup/:reference", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await getPaymentStatus(req.auth, req.params.reference)) });
  } catch (error) { next(error); }
});

// Legacy Peach Payments API lifecycle actions. Unchanged, still behind
// PEACH_PAYMENTS_V2_ENABLED, and not part of the Checkout top-up flow.
//
// Each is mounted at both its original /topup/:paymentId/... path and a clearer
// /legacy-topup/... alias, so no path that existed before this change stops
// answering. The original paths keep their exact previous behaviour.
function legacyAction(action) {
  return async (req, res, next) => {
    try {
      assertTransactionsAllowed(req);
      if (!config.integrations.peachPayments.v2Enabled) throw new AppError(503, "This provider flow is not enabled.");
      res.json({ ok: true, ...(await action(req.auth, req.params.paymentId, req.body || {})) });
    } catch (error) { next(error); }
  };
}

router.get("/legacy-topup/:paymentId", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    if (!config.integrations.peachPayments.v2Enabled) throw new AppError(503, "This provider flow is not enabled.");
    res.json({ ok: true, ...(await getCardTopupStatus(req.auth, req.params.paymentId)) });
  } catch (error) { next(error); }
});

for (const [path, action] of [["confirm", confirmCardTopup], ["capture", captureCardTopup], ["cancel", cancelCardTopup], ["refund", refundCardTopup]]) {
  router.post(`/legacy-topup/:paymentId/${path}`, legacyAction(action));
  router.post(`/topup/:paymentId/${path}`, legacyAction(action));
}

// Payment requests: Request funds and Bill Split. Creating and answering a
// request never moves money by itself - the only money movement is the pay
// action, which runs on the same wallet_transfer rails as Send Money.
const paymentRequests = require("../services/payment-request-service");

router.post("/requests", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await paymentRequests.createRequest(req.auth, req.body || {})) });
  } catch (error) { next(error); }
});

router.post("/requests/split", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await paymentRequests.createSplit(req.auth, req.body || {})) });
  } catch (error) { next(error); }
});

router.get("/requests", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await paymentRequests.listRequests(req.auth)) });
  } catch (error) { next(error); }
});

router.post("/requests/:id/pay", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    res.json({ ok: true, ...(await paymentRequests.payRequest(req.auth, req.params.id, req.body || {})) });
  } catch (error) { next(error); }
});

router.post("/requests/:id/decline", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await paymentRequests.declineRequest(req.auth, req.params.id, req.body || {})) });
  } catch (error) { next(error); }
});

router.post("/requests/:id/cancel", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await paymentRequests.cancelRequest(req.auth, req.params.id)) });
  } catch (error) { next(error); }
});

module.exports = router;
