"use strict";

// Peach Payouts status webhook.
//
//   POST /v1/webhooks/peach-payouts
//   { "status": "...", "payoutId": "...", "lastUpdated": "...", "resultCode": "..." }
//
// Reference: https://developer.peachpayments.com/reference/post_payoutstatusupdated
//
// The published reference documents no signature for this webhook, and the body
// carries no secret, so it is NOT treated as an authority on anything. It is a
// TRIGGER: it names a payout that changed, and TitoPay then asks the Peach
// Payouts API directly — with its own server-side credentials — what the status
// actually is. Every money decision comes from that verified answer.
//
// Consequently a forged delivery can, at most, cause TitoPay to re-query a
// payout it already owns. A payoutId TitoPay does not recognise does nothing at
// all, and is answered 202 rather than 404 so the endpoint cannot be used to
// probe which payout identifiers exist.

const express = require("express");
const { settleWithdrawalFromWebhook } = require("../services/peach-withdrawal-service");

const router = express.Router();

router.get("/", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ ok: false, error: "Method Not Allowed" });
});

router.post("/", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const payoutId = String(body.payoutId || "").trim().toLowerCase();

  // Answer Peach immediately and identically in every case. Peach retries on a
  // non-2xx, and there is nothing for it to retry: the authoritative status is
  // fetched by TitoPay, not delivered here.
  res.status(202).json({ ok: true, received: true });

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payoutId)) return;

  try {
    const result = await settleWithdrawalFromWebhook({ payoutId });
    console.info("[peach-payout] webhook trigger handled", {
      payoutId, handled: result.handled, verified: result.verified ?? null, status: result.status ?? null
    });
  } catch (error) {
    // A failure here loses nothing: the status poll re-verifies the same payout.
    console.error("[peach-payout] webhook trigger failed", {
      payoutId, code: error?.details?.code || "UNKNOWN"
    });
  }
});

module.exports = router;
