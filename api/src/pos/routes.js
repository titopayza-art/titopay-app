"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireTerminalAuth, verifyProviderWebhook } = require("./security");
const { pool } = require("../db/pool");
const service = require("./service");
const eventTagService = require("../services/event-tag-service");

const router = express.Router();

function meta(req) {
  return {
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || "",
    requestId: req.requestId
  };
}

function idempotencyKey(req) {
  return String(req.get("idempotency-key") || "").trim();
}

router.post(
  "/terminals/register",
  requireAuth,
  requireAdminPermission("engineering"),
  async (req, res, next) => {
    try {
      res.status(201).json({ ok: true, ...(await service.registerTerminal(req.auth, req.body || {}, meta(req))) });
    } catch (error) {
      next(error);
    }
  }
);

router.post("/payment-intents", requireTerminalAuth, async (req, res, next) => {
  try {
    const payment = await service.createPaymentIntent(
      req.posTerminal,
      req.body || {},
      idempotencyKey(req),
      req.requestId
    );
    res.status(payment.idempotentReplay ? 200 : 201).json({ ok: true, payment });
  } catch (error) {
    next(error);
  }
});

router.get("/payment-intents/resolve/:token", requireAuth, async (req, res, next) => {
  try {
    res.json({
      ok: true,
      payment: await service.resolvePaymentIntent(req.params.token, req.auth, req.requestId)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/payment-intents/:paymentId/confirm", requireAuth, async (req, res, next) => {
  try {
    res.json({
      ok: true,
      payment: await service.confirmPayment(
        req.params.paymentId,
        req.auth,
        idempotencyKey(req),
        req.requestId
      )
    });
  } catch (error) {
    next(error);
  }
});

router.get("/payment-intents/:paymentId", requireTerminalAuth, async (req, res, next) => {
  try {
    res.json({
      ok: true,
      payment: await service.getPaymentStatus(req.params.paymentId, req.posTerminal, req.requestId)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/payment-intents/:paymentId/cancel", requireTerminalAuth, async (req, res, next) => {
  try {
    res.json({
      ok: true,
      payment: await service.cancelPayment(
        req.params.paymentId,
        req.posTerminal,
        req.body || {},
        idempotencyKey(req),
        req.requestId
      )
    });
  } catch (error) {
    next(error);
  }
});

for (const operation of ["reverse", "refund"]) {
  router.post(`/payment-intents/:paymentId/${operation}`, requireAuth, async (req, res, next) => {
    try {
      res.json({
        ok: true,
        payment: await service.refundOrReverse(
          operation,
          req.params.paymentId,
          req.auth,
          req.body || {},
          idempotencyKey(req),
          req.requestId
        )
      });
    } catch (error) {
      next(error);
    }
  });
}

// Event Tag tap-to-pay. It lives here, behind the SAME requireTerminalAuth the
// rest of this router uses, because the thing being authenticated is identical:
// a signed request from a registered terminal. That brings HMAC signing,
// timestamp tolerance and nonce replay protection along unchanged, and adds no
// new way into the wallet.
//
// The request supplies only a tag credential and an amount. It does not get to
// name the customer, the wallet or the event — the service resolves all three
// from the tag and refuses if the vendor is not authorised for that event.
router.post("/event-tags/charge", requireTerminalAuth, async (req, res, next) => {
  try {
    const charge = await eventTagService.chargeEventTag(
      req.posTerminal,
      req.body || {},
      idempotencyKey(req),
      req.requestId
    );
    res.status(charge.idempotentReplay ? 200 : 201).json({ ok: true, charge });
  } catch (error) {
    next(error);
  }
});

async function handleProviderWebhook(req, res, next) {
  try {
    const verified = await verifyProviderWebhook(req);
    try {
      await pool.query(
        `INSERT INTO pos_provider_nonces (nonce_hash, expires_at)
         VALUES ($1, NOW() + INTERVAL '10 minutes')`,
        [verified.nonceHash]
      );
    } catch (error) {
      if (error.code === "23505") {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      throw error;
    }
    const result = await service.processProviderWebhook(req.body || {}, req.requestId);
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}

router.handleProviderWebhook = handleProviderWebhook;

module.exports = router;
