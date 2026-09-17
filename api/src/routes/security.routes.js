const express = require("express");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { requireUuid } = require("../lib/validation");
const { requireAuth } = require("../middleware/auth");
const { otpLimiter, pinLimiter } = require("../middleware/rate-limits");
const { getMe } = require("../services/auth-service");
const {
  WALLET_PURPOSE,
  methodAvailability,
  requestChallenge,
  verifyWalletUnlock
} = require("../services/authentication-preference-service");
const { writeAuditLog, writeSecurityLog } = require("../services/audit-service");
const {
  getSecurityCentre,
  trustCurrentDevice,
  revokeTrustedDevice,
  remoteLogout,
  logPinAttempt
} = require("../services/security-service");

const router = express.Router();

router.use(requireAuth);

function requireCustomer(req) {
  if (req.auth.userType !== "customer") {
    throw new AppError(403, "Customer wallet access required");
  }
}

router.get("/centre", async (req, res, next) => {
  try {
    requireCustomer(req);
    const centre = await getSecurityCentre(req.auth);
    res.json({ ok: true, centre });
  } catch (error) {
    next(error);
  }
});

router.get("/devices", async (req, res, next) => {
  try {
    requireCustomer(req);
    const centre = await getSecurityCentre(req.auth);
    const trusted = (centre.trustedDevices || []).map((item) => ({
      id: item.id,
      deviceName: item.deviceLabel || "Trusted device",
      device_name: item.deviceLabel || "Trusted device",
      status: item.revokedAt ? "Revoked" : "Trusted",
      userAgent: item.userAgent,
      ipAddress: item.ipAddress,
      createdAt: item.trustedAt || item.lastSeenAt,
      created_at: item.trustedAt || item.lastSeenAt,
      lastSeenAt: item.lastSeenAt
    }));
    const sessions = (centre.activeSessions || []).map((item) => ({
      id: item.id,
      deviceName: item.deviceLabel || "Active session",
      device_name: item.deviceLabel || "Active session",
      status: item.revokedAt ? "Signed out" : item.active === false ? "Inactive" : "Active",
      userAgent: item.userAgent,
      ipAddress: item.ipAddress,
      createdAt: item.createdAt,
      created_at: item.createdAt,
      lastSeenAt: item.lastSeenAt
    }));
    res.json({ ok: true, items: [...sessions, ...trusted] });
  } catch (error) {
    next(error);
  }
});

router.get("/logins", async (req, res, next) => {
  try {
    requireCustomer(req);
    const centre = await getSecurityCentre(req.auth);
    const loginAttempts = (centre.loginAttempts || []).map((item) => ({
      action: "Login attempt",
      status: item.success === false ? "Failed" : "Successful",
      success: item.success,
      identifier: item.identifier,
      ipAddress: item.ipAddress,
      createdAt: item.createdAt,
      created_at: item.createdAt
    }));
    const securityEvents = (centre.securityEvents || []).map((item) => ({
      action: item.eventType || "Security event",
      event_type: item.eventType,
      status: item.success === false ? "Failed" : "Successful",
      success: item.success,
      severity: item.severity,
      createdAt: item.createdAt,
      created_at: item.createdAt
    }));
    res.json({ ok: true, items: [...loginAttempts, ...securityEvents].slice(0, 50) });
  } catch (error) {
    next(error);
  }
});

router.post("/trusted-devices/current", async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await trustCurrentDevice(req.auth, req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.delete("/trusted-devices/:id", async (req, res, next) => {
  try {
    requireCustomer(req);
    const deviceId = requireUuid(req.params.id, "Trusted device ID");
    const result = await revokeTrustedDevice(req.auth, deviceId);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/sessions/:id/logout", async (req, res, next) => {
  try {
    requireCustomer(req);
    const sessionId = requireUuid(req.params.id, "Session ID");
    const result = await remoteLogout(req.auth, sessionId);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/pin-attempts", pinLimiter, async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await logPinAttempt(req.auth, req.body);
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/wallet-lock", async (req, res, next) => {
  try {
    requireCustomer(req);
    await pool.query("UPDATE users SET profile_locked = TRUE, updated_at = NOW() WHERE id = $1", [req.auth.userId]);
    await writeAuditLog({
      actorType: "customer",
      actorId: req.auth.userId,
      action: "wallet_locked",
      entityType: "wallet_security",
      entityId: req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: { source: "pwa" }
    });
    await writeSecurityLog({
      actorType: "customer",
      actorId: req.auth.userId,
      eventType: "wallet_locked",
      severity: "warning",
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      success: true,
      metadata: {}
    });
    const user = await getMe(req.auth.userId, "customer");
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

router.get("/wallet-lock/unlock/options", async (req, res, next) => {
  try {
    requireCustomer(req);
    const { rows } = await pool.query("SELECT phone, email, preferred_authentication_method, authentication_method_updated_at FROM users WHERE id = $1 LIMIT 1", [req.auth.userId]);
    const user = rows[0];
    if (!user) throw new AppError(404, "User not found");
    const availability = await methodAvailability(user, WALLET_PURPOSE);
    res.json({
      ok: true,
      message: "For your security, please verify your identity.",
      preferredAuthenticationMethod: user.preferred_authentication_method || "PUSH",
      authenticationMethodUpdatedAt: user.authentication_method_updated_at || null,
      options: {
        sms: { ...availability.SMS, fee: 0, currency: "ZAR" },
        email: { ...availability.EMAIL, fee: 0, currency: "ZAR" },
        push: { ...availability.PUSH, fee: 0, currency: "ZAR" }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/wallet-lock/unlock/request", otpLimiter, async (req, res, next) => {
  try {
    requireCustomer(req);
    const legacyChannel = String(req.body?.channel || "").trim().toUpperCase();
    const requestedMethod = req.body?.authenticationMethod || (legacyChannel || undefined);
    const challenge = await requestChallenge({
      userId: req.auth.userId,
      requestedMethod,
      purpose: WALLET_PURPOSE,
      meta: {
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        deviceName: req.body?.deviceName,
        location: req.body?.location
      }
    });
    res.json({ ok: true, ...challenge });
  } catch (error) {
    next(error);
  }
});

router.post("/wallet-lock/unlock/verify", otpLimiter, async (req, res, next) => {
  try {
    requireCustomer(req);
    const { challengeId, otp } = req.body || {};
    const verifiedChallengeId = requireUuid(challengeId, "Challenge ID");
    if (!otp) throw new AppError(400, "Challenge ID and OTP are required");
    const verification = await verifyWalletUnlock({
      userId: req.auth.userId,
      challengeId: verifiedChallengeId,
      otp,
      meta: { ipAddress: req.ip, userAgent: req.get("user-agent") }
    });
    const user = await getMe(req.auth.userId, "customer");
    res.json({ ok: true, user, authenticationMethod: verification.authenticationMethod, returnTo: "/wallet" });
  } catch (error) {
    next(error);
  }
});

router.get("/wallet-lock/history", async (req, res, next) => {
  try {
    requireCustomer(req);
    const { rows } = await pool.query(
      `SELECT action, entity_type, metadata, created_at
       FROM audit_logs
       WHERE actor_type = 'customer'
         AND actor_id = $1
         AND action IN ('wallet_locked', 'wallet_unlock_requested', 'wallet_unlocked', 'wallet_unlock_failed', 'authentication_fallback_used')
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.auth.userId]
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
