"use strict";

// Limits and Verification: the customer's view of the progressive KYC
// system. Status answers "what state is my verification in, what are my
// limits, how much of them have I used, and what unlocks the next level".
// Basic verify performs the instant Tier 1 upgrade with a validated identity
// document: SA ID, passport with issuing country, or another approved
// identity document.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { AppError } = require("../lib/errors");
const compliance = require("../services/compliance-service");

const router = express.Router();
router.use(requireAuth);

function requireCustomer(req) {
  if (req.auth.userType !== "customer") throw new AppError(403, "Customer access required");
}

router.get("/status", async (req, res, next) => {
  try {
    requireCustomer(req);
    res.json({ ok: true, ...(await compliance.complianceStatus(req.auth)) });
  } catch (error) {
    next(error);
  }
});

router.post("/basic-verify", async (req, res, next) => {
  try {
    requireCustomer(req);
    const status = await compliance.basicVerify(req.auth, req.body || {});
    // Verifying is the moment held money becomes claimable, so anything
    // waiting that now fits inside the customer's capacity is released
    // immediately rather than after a sweep.
    const released = await require("../services/pending-credit-service")
      .releaseWhatFits(req.auth.userId).catch(() => []);
    res.json({ ok: true, ...status, released });
  } catch (error) {
    next(error);
  }
});

// What this customer can still do right now, per rail. This is what lets
// the app tell someone what they CAN send instead of only refusing them.
router.get("/capacity", async (req, res, next) => {
  try {
    requireCustomer(req);
    const capacity = await require("../services/limit-engine")
      .capacityFor(req.auth.userId, { serviceCode: req.query.serviceCode || null, includeWithdrawal: true });
    if (!capacity) throw new AppError(404, "Account not found.");
    // Internal reasoning (risk band, multipliers) stays out of the customer
    // payload: they see capability, never the rules behind it.
    res.json({ ok: true, limits: capacity.limits, remaining: capacity.remaining, usage: capacity.usage });
  } catch (error) {
    next(error);
  }
});

// Money waiting on verification, and the claim.
router.get("/pending-credits", async (req, res, next) => {
  try {
    requireCustomer(req);
    const pending = require("../services/pending-credit-service");
    res.json({ ok: true, items: await pending.listForRecipient(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/pending-credits/claim", async (req, res, next) => {
  try {
    requireCustomer(req);
    const released = await require("../services/pending-credit-service").releaseWhatFits(req.auth.userId);
    res.json({
      ok: true,
      released,
      message: released.length
        ? "The money waiting for you has been released into your wallet."
        : "Nothing could be released yet. Verify your identity, or free up receiving capacity, and try again."
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
