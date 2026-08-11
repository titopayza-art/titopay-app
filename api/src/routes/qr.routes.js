const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createQr, ensureProfileQr, getMerchantQrs, getQrHistory, payQr, shareQr } = require("../services/qr-service");
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

router.get("/merchant", async (req, res, next) => {
  try {
    const qrs = await getMerchantQrs(req.auth.userId);
    res.json({ ok: true, qrs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
