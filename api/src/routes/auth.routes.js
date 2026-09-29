const express = require("express");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { requireAuth } = require("../middleware/auth");
const { requireAllowedRegistrationCountry } = require("../middleware/geo-guard");
const { authLimiter, otpLimiter } = require("../middleware/rate-limits");
const {
  register,
  login,
  getPasswordChangeOptions,
  requestPasswordChangeOtp,
  requestPasswordReset,
  confirmPasswordReset,
  verifyOtpLogin,
  verifyEmailOtpLogin,
  getLoginMfaStatus,
  setLoginMfaEnabled,
  refreshTokens,
  logout,
  logoutAll,
  getMe
} = require("../services/auth-service");
const {
  createProfileChangeRequest,
  listOwnProfileChangeRequests
} = require("../services/profile-change-service");
const { verifyEmailToken, resendVerification, confirmEmailPasswordReset } = require("../services/email-centre-service");
const emailOtp = require("../services/email-otp-service");
const {
  getCustomerNotificationPreferences,
  updateCustomerNotificationPreferences
} = require("../services/customer-notification-preference-service");
const {
  getAuthenticationPreference,
  requestAuthenticationPreferenceChange,
  confirmAuthenticationPreferenceChange
} = require("../services/authentication-preference-service");

const router = express.Router();

router.post("/register", authLimiter, requireAllowedRegistrationCountry, async (req, res, next) => {
  try {
    const user = await register(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.status(201).json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const result = await login(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("[auth-login-error]", {
      requestId: req.requestId,
      status: error.statusCode || error.status || 500,
      name: error.name,
      message: error.message,
      identifierType: req.body?.identifier
        ? String(req.body.identifier).includes("@")
          ? "email_or_username"
          : String(req.body.identifier).startsWith("+27")
            ? "phone"
            : "username_or_phone"
        : "missing"
    });
    next(error);
  }
});

router.post("/verify-otp", otpLimiter, async (req, res, next) => {
  try {
    const result = await verifyOtpLogin(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/email-otp/verify", otpLimiter, async (req,res,next)=>{
  try { res.json({ok:true,...await verifyEmailOtpLogin(req.body,{ipAddress:req.ip,userAgent:req.get("user-agent")})}); }
  catch(error){next(error);}
});

router.post("/email-otp/resend", otpLimiter, async (req,res,next)=>{
  try { res.json({ok:true,...await emailOtp.resendChallenge(req.body.challengeId,{ipAddress:req.ip,userAgent:req.get("user-agent"),deviceName:req.body.deviceName,location:req.body.location})}); }
  catch(error){next(error);}
});

router.post("/email-otp/send", requireAuth, otpLimiter, async (req,res,next)=>{
  try {
    const table=req.auth.userType==="admin"?"admin_users":"users";
    const {rows}=await pool.query(`SELECT *, $2::text AS user_type FROM ${table} WHERE id=$1`,[req.auth.userId,req.auth.userType]);
    const purpose=String(req.body.purpose||"optional_mfa");
    if(!await emailOtp.shouldRequireEmailOtp(purpose))throw new AppError(409,"Email OTP is not enabled for this action");
    res.status(202).json({ok:true,...await emailOtp.createChallenge(rows[0],purpose,{ipAddress:req.ip,userAgent:req.get("user-agent"),deviceName:req.body.deviceName,location:req.body.location})});
  } catch(error){next(error);}
});

router.post("/refresh", authLimiter, async (req, res, next) => {
  try {
    const result = await refreshTokens(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/me/password-change/options", requireAuth, async (req, res, next) => {
  try {
    const options = await getPasswordChangeOptions(req.auth.userId, req.auth.userType);
    res.json({ ok: true, options });
  } catch (error) {
    next(error);
  }
});

router.post("/me/password-change/request", requireAuth, otpLimiter, async (req, res, next) => {
  try {
    const result = await requestPasswordChangeOtp(req.auth.userId, req.auth.userType, {
      ...req.body,
      idempotencyKey: req.headers["idempotency-key"] || req.body.idempotencyKey
    }, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.status(202).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/password-reset/request", authLimiter, async (req, res, next) => {
  try {
    const result = await requestPasswordReset(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/password-reset", authLimiter, async (req, res, next) => {
  try {
    if (req.body.mode === "confirm") {
      const result = await confirmPasswordReset(req.body, {
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });
      res.json(result);
      return;
    }
    const result = await requestPasswordReset(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/password-reset/confirm", authLimiter, async (req, res, next) => {
  try {
    if (req.body.token) {
      res.json(await confirmEmailPasswordReset(req.body.token, req.body.newPassword, {ipAddress:req.ip,userAgent:req.get("user-agent")}));
      return;
    }
    const result = await confirmPasswordReset(req.body, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/email/verify", authLimiter, async (req,res,next)=>{
  try { res.json({ok:true,user:await verifyEmailToken(req.body.token,{ipAddress:req.ip,userAgent:req.get("user-agent")})}); }
  catch(error){next(error);}
});

router.post("/email/resend-verification", authLimiter, async (req,res,next)=>{
  try { await resendVerification(req.body.email||req.body.identifier,{ipAddress:req.ip,userAgent:req.get("user-agent")});res.json({ok:true,message:"If the account is eligible, a verification email has been queued."}); }
  catch(error){next(error);}
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getMe(req.auth.userId, req.auth.userType);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

router.get("/me/authentication-preference", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const preference = await getAuthenticationPreference(req.auth.userId);
    res.json({ ok: true, preference });
  } catch (error) {
    next(error);
  }
});

router.post("/me/authentication-preference/request", requireAuth, otpLimiter, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const challenge = await requestAuthenticationPreferenceChange(req.auth.userId, req.body?.method, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      deviceName: req.body?.deviceName,
      location: req.body?.location
    });
    res.status(202).json({ ok: true, ...challenge });
  } catch (error) {
    next(error);
  }
});

router.put("/me/authentication-preference", requireAuth, otpLimiter, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const preference = await confirmAuthenticationPreferenceChange({
      userId: req.auth.userId,
      desiredMethod: req.body?.method,
      challengeId: req.body?.challengeId,
      otp: req.body?.otp,
      meta: { ipAddress: req.ip, userAgent: req.get("user-agent") }
    });
    res.json({ ok: true, preference });
  } catch (error) {
    next(error);
  }
});

router.get("/me/notification-preferences", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const preferences = await getCustomerNotificationPreferences(req.auth.userId);
    res.json({ ok: true, preferences });
  } catch (error) {
    next(error);
  }
});

router.put("/me/notification-preferences", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const preferences = await updateCustomerNotificationPreferences(req.auth.userId, req.body || {}, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.json({ ok: true, preferences });
  } catch (error) {
    next(error);
  }
});

const {
  createClosureRequest,
  getOwnClosureRequest,
  cancelOwnClosureRequest
} = require("../services/account-closure-service");

router.get("/me/closure-request", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, request: await getOwnClosureRequest(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/me/closure-request", requireAuth, otpLimiter, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const request = await createClosureRequest(req.auth.userId, req.body || {}, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.status(201).json({ ok: true, request });
  } catch (error) {
    next(error);
  }
});

router.delete("/me/closure-request", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, request: await cancelOwnClosureRequest(req.auth.userId, { ipAddress: req.ip, userAgent: req.get("user-agent") }) });
  } catch (error) {
    next(error);
  }
});

const {
  listRewardsForCustomer,
  markRewardsSeen,
  recordCouponCopy
} = require("../services/rewards-service");
const { requireUuid: requireRewardUuid } = require("../lib/validation");

// The Rewards feed: admin-approved publications only. Read-only from this
// side — a customer can never create, change or redeem anything here, so the
// worst a bad request can do is see an empty list.
router.get("/me/rewards", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, ...await listRewardsForCustomer(req.auth.userId, req.auth.accountType) });
  } catch (error) {
    next(error);
  }
});

router.post("/me/rewards/seen", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, ...await markRewardsSeen(req.auth.userId, req.auth.accountType) });
  } catch (error) {
    next(error);
  }
});

router.post("/me/rewards/:id/copied", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json(await recordCouponCopy(requireRewardUuid(req.params.id, "Publication ID")));
  } catch (error) {
    next(error);
  }
});

router.get("/me/login-mfa", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, ...await getLoginMfaStatus(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.put("/me/login-mfa", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    res.json({ ok: true, ...await setLoginMfaEnabled(req.auth.userId, req.body?.enabled) });
  } catch (error) {
    next(error);
  }
});

router.put("/me/photo", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const mediaType = req.body.mediaType === "businessLogo" ? "businessLogo" : "profilePhoto";
    const dataUrl = String(req.body.dataUrl || "");
    if (!/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      throw new AppError(400, "Choose a valid PNG, JPEG or WebP image");
    }
    if (Buffer.byteLength(dataUrl, "utf8") > 700 * 1024) {
      throw new AppError(413, "Profile image is too large");
    }
    const column = mediaType === "businessLogo" ? "business_logo_url" : "profile_photo_url";
    const { rows } = await pool.query(
      `UPDATE users SET ${column} = $1, updated_at = NOW() WHERE id = $2 RETURNING ${column}`,
      [dataUrl, req.auth.userId]
    );
    res.json({ ok: true, mediaType, url: rows[0]?.[column] || "" });
  } catch (error) {
    next(error);
  }
});

router.get("/me/profile-change-requests", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const items = await listOwnProfileChangeRequests(req.auth.userId);
    res.json({ ok: true, items });
  } catch (error) {
    next(error);
  }
});

router.post("/me/profile-change-requests", requireAuth, async (req, res, next) => {
  try {
    if (req.auth.userType !== "customer") throw new AppError(403, "Customer account required");
    const request = await createProfileChangeRequest(req.auth.userId, req.body || {}, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
    res.status(201).json({
      ok: true,
      request,
      message: "Profile update submitted for Support approval within 72 hours."
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", requireAuth, async (req, res, next) => {
  try {
    await logout(req.body.refreshToken, req.auth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/logout-all", requireAuth, async (req, res, next) => {
  try {
    await logoutAll(req.auth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
