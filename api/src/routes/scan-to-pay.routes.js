"use strict";

// Scan-to-Pay — customer capability and admin monitoring.
//
// This router adds no payment path. Creating, resolving, confirming and
// cancelling a QR payment already live in src/pos/ and are untouched: the
// customer app calls those directly once the feature is on. What is here is the
// part that was missing — a way for the app to ask whether the feature is
// available before it offers a Scan & Pay button, a scheme check that answers
// "we do not support that code" politely instead of failing at payment time,
// and read-only monitoring for the Admin Portal.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("../services/audit-service");
const scanToPay = require("../services/scan-to-pay-service");

const router = express.Router();
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

/* ----------------------------------------------------------------- customer */

// Can this customer use Scan & Pay right now?
//
// The app asks this before showing the entry point, so turning the feature off
// removes it from every customer's screen on their next load without a deploy.
// It reports only what a customer needs: whether it is on, and which schemes
// they can scan. Never the environment lever or the reason it is off — that is
// operator information.
router.get("/capability", requireAuth, handle(async (_req, res) => {
  const config = await scanToPay.getScanToPayConfig();
  res.json({
    ok: true,
    enabled: config.enabled,
    schemes: config.enabled
      ? config.schemes.filter((scheme) => scheme.status === "available")
        .map(({ key, label, dynamic, static: isStatic }) => ({ key, label, dynamic, static: isStatic }))
      : []
  });
}));

// Is this scanned code something TitoPay can pay?
//
// Deliberately returns the token and nothing else on success. It does not
// resolve the payment, look up the merchant or read an amount — the app then
// calls the existing POS resolve endpoint, which is where the server decides
// what this payment actually is. Splitting it this way means a scanned code
// that is not ours never reaches the payment engine at all.
router.post("/parse", requireAuth, handle(async (req, res) => {
  const config = await scanToPay.getScanToPayConfig();
  if (!config.enabled) throw new AppError(404, "Scan to Pay is not available.");

  const result = scanToPay.identifyScheme(req.body?.payload);
  if (!result.supported) {
    // 200, not an error: an unsupported code is a normal thing for a camera to
    // see, and the app shows the message rather than an error screen.
    res.json({ ok: true, supported: false, reason: result.reason });
    return;
  }
  res.json({ ok: true, supported: true, scheme: result.scheme, token: result.token });
}));

/* -------------------------------------------------------------------- admin */

// requireAdminPermission reads req.auth, so authentication has to run first —
// without this every admin route answers "Authentication required" even with a
// valid token, which reads like a broken endpoint rather than a missing step.
const adminOnly = [requireAuth, (req, _res, next) => {
  if (req.auth?.userType !== "admin") { next(new AppError(403, "Admin access required")); return; }
  next();
}];

router.get("/admin/config", ...adminOnly, requireAdminPermission("integrations"), handle(async (_req, res) => {
  res.json({ ok: true, config: await scanToPay.getScanToPayConfig() });
}));

router.post("/admin/config", ...adminOnly, requireAdminPermission("integrations"), handle(async (req, res) => {
  const enabled = req.body?.enabled === true;
  const before = await scanToPay.getScanToPayConfig();
  const config = await scanToPay.setScanToPayEnabled(enabled, req.auth?.userId || null);
  await writeAuditLog({
    actorType: "admin", actorId: req.auth?.userId || null,
    action: enabled ? "scan_to_pay_enabled" : "scan_to_pay_disabled",
    // entity_id is a uuid column and a settings key is not a uuid. Passing one
    // made this insert fail silently behind the catch below, so the audit entry
    // never existed. The key goes in metadata, where it is a text field.
    entityType: "platform_setting", entityId: null,
    ipAddress: req.ip, userAgent: req.get("user-agent"),
    metadata: { settingKey: scanToPay.SETTING_KEY, before: before.runtimeEnabled, after: config.runtimeEnabled,
      effective: config.enabled, reason: req.body?.reason || null }
  }).catch((error) => console.error("[scan-to-pay] audit write failed", { message: error.message }));
  res.json({ ok: true, config });
}));

router.get("/admin/overview", ...adminOnly, requireAdminPermission("integrations"), handle(async (req, res) => {
  const [config, monitoring] = await Promise.all([
    scanToPay.getScanToPayConfig(),
    scanToPay.monitoringOverview({ days: req.query?.days })
  ]);
  res.json({ ok: true, config, ...monitoring });
}));

router.get("/admin/payments", ...adminOnly, requireAdminPermission("integrations"), handle(async (req, res) => {
  res.json({ ok: true, ...(await scanToPay.recentPayments(req.query)) });
}));

module.exports = router;
