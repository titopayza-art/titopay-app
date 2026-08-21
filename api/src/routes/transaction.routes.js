const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireUuid } = require("../lib/validation");
const { AppError } = require("../lib/errors");
const {
  feePreview,
  createTransaction,
  listTransactionsForUser,
  reverseTransaction
} = require("../services/transaction-service");

const router = express.Router();

router.use(requireAuth);

router.post("/fee-preview", async (req, res, next) => {
  try {
    res.json({ ok: true, preview: await feePreview({ ...req.body, actor: req.auth }) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const idempotencyKey = req.headers["idempotency-key"] || req.body.idempotencyKey;
    // Who bears the fee and how much of a payment is diverted to it are
    // server-authoritative: they are set only by internal callers that invoke
    // createTransaction directly (e.g. qr-service for a merchant sale). A client
    // must never influence them, so strip them from the public request body —
    // otherwise a sender could dodge the send fee or shortchange the recipient.
    const { merchantReceivesFee, recipientFee, ...body } = req.body || {};
    res.status(201).json({ ok: true, transaction: await createTransaction(req.auth, { ...body, idempotencyKey }) });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listTransactionsForUser(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/reverse", requireAdminPermission("transactions"), async (req, res, next) => {
  try {
    const transactionId = requireUuid(req.params.id, "Transaction ID");
    // A reversal is the one admin action that moves customer money, so it
    // carries its reason into the record and always raises a visibility
    // alert for the integrity queue. The reason is accepted rather than
    // demanded so existing consoles keep working; an unstated reason is
    // itself recorded as unstated.
    const reason = String(req.body?.reason || "").trim().slice(0, 300) || "not stated";
    // Dual authorisation: at or above the configured amount, a reversal is
    // captured as a request and a SECOND admin executes it via approval.
    // Below it, the single-admin path (reason + integrity alert) continues.
    const dualAuth = require("../services/dual-auth-service");
    const { rows: txRows } = await require("../db/pool").pool.query(
      "SELECT id, total, amount, reference, user_id FROM transactions WHERE id = $1", [transactionId]);
    if (!txRows[0]) throw new AppError(404, "Transaction not found");
    const gateAmount = Number(txRows[0].total ?? txRows[0].amount ?? 0);
    if (await dualAuth.requiresReversalDualAuth(gateAmount)) {
      const request = await dualAuth.createRequest({
        actionType: "transaction_reversal",
        payload: { transactionId, reason },
        summary: `Reverse ${txRows[0].reference} (R ${gateAmount.toFixed(2)})`,
        amount: gateAmount,
        adminId: req.auth.userId,
        meta: { ipAddress: req.ip, userAgent: req.get("user-agent") }
      });
      res.status(202).json({ ok: true, pendingApproval: true, request });
      return;
    }
    const transaction = await reverseTransaction(transactionId, req.auth);
    const integrity = require("../services/money-integrity-service");
    await integrity.raiseAlert({
      alertType: "manual_reversal", severity: "info",
      fingerprint: `manual_reversal:${transactionId}`,
      userId: transaction?.user_id || null, transactionId,
      details: { reason, reversedBy: req.auth.userId }
    }).catch(() => {});
    res.json({ ok: true, transaction });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
