"use strict";

// The unsubscribe link in every marketing email lands here. No login: the
// person clicking may not remember their password, and the law does not let
// an unsubscribe hide behind one. The link is HMAC-signed for one address,
// so it can only ever opt out the address it was sent to.

const express = require("express");
const { recordMarketingOptOut } = require("../services/email-centre-service");

const router = express.Router();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f2f7fc;color:#0b1f3f;font-family:Arial,sans-serif"><div style="max-width:480px;margin:80px auto;padding:32px;background:#fff;border-radius:12px;text-align:center"><h1 style="font-size:22px;margin:0 0 12px">${title}</h1><p style="font-size:15px;line-height:1.6;margin:0">${body}</p></div></body></html>`;

router.get("/", async (req, res) => {
  try {
    const { email } = await recordMarketingOptOut(req.query.e, req.query.s);
    const masked = email.replace(/^(.).*(@.*)$/, "$1***$2");
    res.status(200).send(page(
      "You are unsubscribed",
      `${masked} will no longer receive marketing emails from TitoPay. Emails about your own account and transactions, like receipts and security alerts, still arrive because your account needs them.`
    ));
  } catch {
    res.status(400).send(page(
      "This link did not work",
      'The unsubscribe link is incomplete or has been altered. Open the email again and click the link directly, or write to <a href="mailto:support@titopay.co.za">support@titopay.co.za</a> and the team will remove you by hand.'
    ));
  }
});

module.exports = router;
