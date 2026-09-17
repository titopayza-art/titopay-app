"use strict";

const express = require("express");
const integrationsRoutes = require("./integrations.routes");

const router = express.Router();

router.get("/", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ ok: false, error: "Method Not Allowed" });
});

router.post("/", integrationsRoutes.handlePeachProviderWebhook);

module.exports = router;
