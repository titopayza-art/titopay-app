"use strict";

// Peach Checkout redirects the customer's browser back to `shopperResultUrl`
// using a POST, which a static PWA cannot receive. This public endpoint accepts
// that POST, triggers server-side verification, and 303-redirects the browser
// on to the PWA.
//
// It is deliberately unauthenticated — it is a browser redirect target, not an
// API. It therefore decides nothing: it only looks the transaction up and asks
// the Checkout service to verify with Peach. No value in the request body can
// cause a wallet credit.

const express = require("express");
const { resolveReturn } = require("../services/peach-checkout-service");

const router = express.Router();

async function handleReturn(req, res) {
  let target;
  try {
    const result = await resolveReturn(req.body || {}, req.query || {});
    target = result.redirectTo;
  } catch (error) {
    console.error("[peach-checkout-return] failed", { message: error?.message || "unknown" });
    target = `${String(process.env.APP_BASE_URL || "https://app.titopay.co.za").replace(/\/+$/, "")}/?topup=pending`;
  }
  res.redirect(303, target);
}

router.post("/", handleReturn);
router.get("/", handleReturn);

module.exports = router;
