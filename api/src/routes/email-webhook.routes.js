"use strict";

const express = require("express");
const { processWebhook } = require("../services/email-centre-service");
const router = express.Router();

router.post("/:provider", async (req,res,next)=>{
  try {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.get("x-titopay-email-signature") || req.get("x-webhook-signature") || "";
    const result = await processWebhook(String(req.params.provider||"").toLowerCase(),req.body||{},signature,raw);
    res.json({ok:true,...result});
  } catch(error) { next(error); }
});

module.exports = router;

