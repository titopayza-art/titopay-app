const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireUuid } = require("../lib/validation");
const { createMerchant, getMerchantForUser, verifyMerchant } = require("../services/merchant-service");

const router = express.Router();

router.use(requireAuth);

router.get("/me", async (req, res, next) => {
  try {
    res.json({ ok: true, merchant: await getMerchantForUser(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, merchant: await createMerchant(req.auth, req.body) });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/verify", requireAdminPermission("merchants"), async (req, res, next) => {
  try {
    const merchantId = requireUuid(req.params.id, "Merchant ID");
    res.json({ ok: true, merchant: await verifyMerchant(merchantId, req.auth) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
