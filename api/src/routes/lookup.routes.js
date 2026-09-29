const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { resolveTitoPayUser } = require("../services/security-service");

const router = express.Router();

router.use(requireAuth);

async function resolveRecipient(req, res, next) {
  try {
    const result = await resolveTitoPayUser(req.auth, {
      ...req.body,
      identifier: req.body?.identifier || req.body?.query || req.body?.value || req.query.identifier || req.query.q,
      recipient: req.body?.recipient || req.body?.identifier || req.body?.query || req.body?.value || req.query.recipient || req.query.identifier || req.query.q
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}

router.get("/users/lookup", resolveRecipient);
router.get("/users/resolve", resolveRecipient);
router.get("/users/search", resolveRecipient);
router.get("/recipients/resolve", resolveRecipient);
router.get("/chat/users/lookup", resolveRecipient);
router.post("/users/lookup", resolveRecipient);
router.post("/users/resolve", resolveRecipient);
router.post("/recipients/resolve", resolveRecipient);
router.post("/chat/users/lookup", resolveRecipient);

module.exports = router;
