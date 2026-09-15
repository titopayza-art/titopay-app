"use strict";

// The security copy the customer app renders. This route is deliberately
// public: "Why trust TitoPay?" and the security tip card are reachable before
// anyone signs in, and someone deciding whether to trust the app is exactly the
// person who has no token yet. Nothing here is account specific.
//
// It is mounted inside mountVersionedRoutes ahead of lookupRoutes, which puts a
// requireAuth on the bare /v1 prefix; a route added after that mount answers
// "Bearer token required" instead of serving content.

const express = require("express");
const { getSecurityContent } = require("../services/security-content-service");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    res.json({ ok: true, content: await getSecurityContent() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
