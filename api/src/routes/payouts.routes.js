"use strict";

// Withdrawals and business payouts on the Peach Payouts API.
//
//   GET    /v1/payouts/banks                 banks TitoPay can pay out to
//   GET    /v1/payouts/bank-accounts         the customer's saved accounts (masked)
//   POST   /v1/payouts/bank-accounts         save an account, validated against Peach's rules
//   DELETE /v1/payouts/bank-accounts/:id     soft delete
//   POST   /v1/payouts/withdrawals           create a withdrawal (debits, then submits)
//   GET    /v1/payouts/withdrawals           recent withdrawals
//   GET    /v1/payouts/withdrawals/:ref      status, re-verified with Peach
//
// Every route is authenticated and scoped to the calling user. Nothing here
// accepts bank details on the withdrawal itself — only the id of an account the
// customer already saved — so a request body can never redirect someone's money.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  createBankAccount,
  deleteBankAccount,
  listBankAccounts,
  listSupportedBanks,
  ACCOUNT_TYPES
} = require("../services/payout-account-service");
const {
  createWithdrawal,
  getWithdrawalStatus,
  listRecentWithdrawals
} = require("../services/peach-withdrawal-service");
const { payoutAvailability } = require("../services/peach-payout-service");

const router = express.Router();

router.use(requireAuth);

// What the withdrawal form needs to render itself: the banks, the account types
// and whether payouts are open at all. No credential is exposed.
router.get("/banks", async (_req, res, next) => {
  try {
    const availability = await payoutAvailability();
    res.json({
      ok: true,
      banks: listSupportedBanks(),
      accountTypes: ACCOUNT_TYPES,
      payoutsAvailable: availability.available === true
    });
  } catch (error) {
    next(error);
  }
});

router.get("/bank-accounts", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listBankAccounts(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/bank-accounts", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, account: await createBankAccount(req.auth.userId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.delete("/bank-accounts/:id", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await deleteBankAccount(req.auth.userId, req.params.id)) });
  } catch (error) {
    next(error);
  }
});

router.post("/withdrawals", async (req, res, next) => {
  try {
    const result = await createWithdrawal(req.auth, {
      ...req.body,
      idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey
    });
    res.status(result.idempotentReplay ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/withdrawals", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listRecentWithdrawals(req.auth, req.query.limit) });
  } catch (error) {
    next(error);
  }
});

router.get("/withdrawals/:reference", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await getWithdrawalStatus(req.auth, req.params.reference)) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
