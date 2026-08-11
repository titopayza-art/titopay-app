const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireUuid } = require("../lib/validation");
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
    res.status(201).json({ ok: true, transaction: await createTransaction(req.auth, { ...req.body, idempotencyKey }) });
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
    res.json({ ok: true, transaction: await reverseTransaction(transactionId, req.auth) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
