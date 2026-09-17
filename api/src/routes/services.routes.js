const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireUuid } = require("../lib/validation");
const { capabilityReport, createService, listServices, updateService } = require("../services/service-management-service");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const items = await listServices({ audience: req.query.audience || "all" });
    res.json({ ok: true, items });
  } catch (error) {
    next(error);
  }
});

router.get("/admin", requireAuth, requireAdminPermission("services"), async (_req, res, next) => {
  try {
    const items = await listServices({ audience: "all", includeDisabled: true });
    // The catalogue AND what is gating it, on one call and one permission. A
    // service held back by a capability is not a row an operator can edit, so
    // showing the status without the reason sends them looking for a toggle
    // that does not exist.
    res.json({ ok: true, items, capabilities: capabilityReport() });
  } catch (error) {
    next(error);
  }
});

router.post("/admin", requireAuth, requireAdminPermission("services"), async (req, res, next) => {
  try {
    const item = await createService(req.body, req.auth);
    res.status(201).json({ ok: true, item });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/:id", requireAuth, requireAdminPermission("services"), async (req, res, next) => {
  try {
    const serviceId = requireUuid(req.params.id, "Service ID");
    const item = await updateService(serviceId, req.body, req.auth);
    res.json({ ok: true, item });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
