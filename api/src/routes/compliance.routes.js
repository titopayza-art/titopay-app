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
    res.json({ ok: true, ...(await compliance.basicVerify(req.auth, req.body || {})) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
