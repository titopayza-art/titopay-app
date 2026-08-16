"use strict";

// BUSINESS VERIFICATION. A different door from personal verification, on
// purpose.
//
//   GET  /v1/business/verification            the person, their businesses, the
//                                             entity types and the roles
//   POST /v1/business/verification/businesses register a business entity
//   POST /v1/business/verification/businesses/:id/submit
//                                             submit that entity for KYB
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
  submitBusinessVerification
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

module.exports = router;
