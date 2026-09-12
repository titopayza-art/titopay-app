const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createQr, ensureProfileQr, getMerchantQrs, getQrDetails, getQrHistory, getQrPaymentStatus, payQr, shareQr } = require("../services/qr-service");
const { AppError } = require("../lib/errors");

const router = express.Router();

function assertTransactionsAllowed(req) {
  if (req.auth.profileLocked) {
    throw new AppError(423, "Profile is locked. QR actions are disabled until OTP unlock.");
  }
}

router.use(requireAuth);

router.get("/profile", async (req, res, next) => {
  try {
    const qr = await ensureProfileQr(req.auth);
    res.json({ ok: true, qr });
  } catch (error) {
    next(error);
  }
});

router.post("/profile", async (req, res, next) => {
  try {
    const qr = await ensureProfileQr(req.auth);
    res.status(201).json({ ok: true, qr });
  } catch (error) {
    next(error);
  }
});

router.post("/share", async (req, res, next) => {
  try {
    const result = await shareQr(req.auth, req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/create", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const qr = await createQr(req.auth, req.body);
    res.status(201).json({ ok: true, qr });
  } catch (error) {
    next(error);
  }
});

router.post("/generate-static", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const qr = await createQr(req.auth, { ...req.body, codeType: "static" });
    res.status(201).json({ ok: true, qr });
  } catch (error) {
    next(error);
  }
});

router.post("/generate-dynamic", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const qr = await createQr(req.auth, { ...req.body, codeType: "dynamic" });
    res.status(201).json({ ok: true, qr });
  } catch (error) {
    next(error);
  }
});

router.post("/pay", async (req, res, next) => {
  try {
    assertTransactionsAllowed(req);
    const result = await payQr(req.auth, req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    const history = await getQrHistory(req.auth.userId);
    res.json({ ok: true, history });
  } catch (error) {
    next(error);
  }
});

// Who owns this code, so the payer can read a name before they press Confirm.
// It moves no money and changes nothing. Two segments, so it cannot swallow the
// one-segment /profile, /history or /merchant whatever the declaration order.
router.get("/:id/details", async (req, res, next) => {
  try {
    res.json({ ok: true, qr: await getQrDetails(req.auth, req.params.id) });
  } catch (error) {
    next(error);
  }
});

// The till asking "has it been paid yet?". Owner only, read-only, and the one
// call a soft POS makes on a loop while the code is on screen.
router.get("/:id/status", async (req, res, next) => {
  try {
    res.json({ ok: true, status: await getQrPaymentStatus(req.auth, req.params.id) });
  } catch (error) {
    next(error);
  }
});

router.get("/merchant", async (req, res, next) => {
  try {
    const qrs = await getMerchantQrs(req.auth.userId);
    res.json({ ok: true, qrs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
