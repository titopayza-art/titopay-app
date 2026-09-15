"use strict";

// BUSINESS VERIFICATION. A different door from personal verification, on
// purpose.
//
//   GET  /v1/business/verification            the person, their businesses, the
//                                             entity types and the roles
//   POST /v1/business/verification/businesses register a business entity
//   POST /v1/business/verification/businesses/:id/submit
//                                             submit that entity for KYB
//   GET  /v1/business/verification/businesses/:id/commercial-profile
//   PUT  /v1/business/verification/businesses/:id/commercial-profile
//                                             what the business does and where
//                                             its money comes from
//
// Nothing here accepts an identity document. A person verifies themselves once
// at /v1/compliance/basic-verify, and every business they are authorised on
// reuses that verification. Sending an ID number to these endpoints would
// create a second identity for the same human being, which is the exact
// confusion this router exists to end.

const express = require("express");
const { AppError } = require("../lib/errors");
const { requireAuth } = require("../middleware/auth");
const {
  businessVerificationOverview,
  createBusinessProfile,
  submitBusinessVerification,
  getCommercialProfile,
  updateCommercialProfile
} = require("../services/business-verification-service");

const router = express.Router();

router.use(requireAuth);

function requireCustomer(req) {
  if (req.auth.userType !== "customer") throw new AppError(403, "Customer access required");
}

function actor(req) {
  return { ...req.auth, ipAddress: req.ip, userAgent: req.get("user-agent") };
}

router.get("/", async (req, res, next) => {
  try {
    requireCustomer(req);
    res.json({ ok: true, ...(await businessVerificationOverview(actor(req))) });
  } catch (error) {
    next(error);
  }
});

router.post("/businesses", async (req, res, next) => {
  try {
    requireCustomer(req);
    // An identity document has no place on this door.
    for (const field of ["idNumber", "documentNumber", "id_number"]) {
      if (req.body && req.body[field]) {
        throw new AppError(400,
          "This screen registers the business itself. Your own identity is verified separately, and only once.");
      }
    }
    res.status(201).json({ ok: true, ...(await createBusinessProfile(actor(req), req.body || {})) });
  } catch (error) {
    next(error);
  }
});

router.post("/businesses/:id/submit", async (req, res, next) => {
  try {
    requireCustomer(req);
    res.json({ ok: true, ...(await submitBusinessVerification(actor(req), req.params.id)) });
  } catch (error) {
    next(error);
  }
});

// WHAT THE BUSINESS DOES, AND WHERE ITS MONEY COMES FROM.
//
// Self-declared, saved directly, and NOT routed through the Support approval
// queue that a business NAME change goes through. A name is identity; this is
// the business describing itself, it proves nothing, and an approval queue
// would add Support load for answers only the business can give.
//
// Authorisation is the same as every other route here: the service resolves the
// business through business_representatives, so a person can only read or
// change a business they are actually on.
router.get("/businesses/:id/commercial-profile", async (req, res, next) => {
  try {
    requireCustomer(req);
    const profile = await getCommercialProfile(req.auth.userId, req.params.id);
    res.json({ ok: true, profile });
  } catch (error) {
    next(error);
  }
});

router.put("/businesses/:id/commercial-profile", async (req, res, next) => {
  try {
    requireCustomer(req);
    const profile = await updateCommercialProfile(
      req.auth.userId,
      req.params.id,
      req.body || {},
      { ipAddress: req.ip, userAgent: req.get("user-agent") }
    );
    res.json({ ok: true, profile });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
