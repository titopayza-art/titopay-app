const rateLimitPackage = require("express-rate-limit");
const { writeSecurityLog } = require("../services/audit-service");
const { CLOUDFLARE_CIDRS, compileCidrs, isInCidr } = require("../lib/ip-range");

const rateLimit = rateLimitPackage.rateLimit || rateLimitPackage;
const ipKeyGenerator = rateLimitPackage.ipKeyGenerator || ((ip) => ip);
const SENSITIVE_WINDOW_MS = 15 * 60 * 1000;
const GENERAL_WINDOW_MS = 60 * 1000;

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizedIdentifier(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const authenticatedIdentity = req.auth?.userId
    ? `${req.auth.userType || "user"}:${req.auth.userId}`
    : "";
  const raw = authenticatedIdentity || body.identifier || body.email || body.username || body.phone || body.mobile ||
    body.challengeId || query.identifier || "anonymous";
  return String(raw).trim().toLowerCase().slice(0, 128) || "anonymous";
}

// Which addresses are allowed to speak for someone else.
//
// Overridable with TRUSTED_EDGE_CIDRS (comma-separated) so the list can be
// refreshed, or narrowed, without a code change. An entry that does not parse is
// dropped rather than treated as a wildcard.
const TRUSTED_EDGE_CIDRS = compileCidrs(
  process.env.TRUSTED_EDGE_CIDRS ? process.env.TRUSTED_EDGE_CIDRS : CLOUDFLARE_CIDRS
);

function arrivedFromTrustedEdge(address) {
  return TRUSTED_EDGE_CIDRS.some((cidr) => isInCidr(address, cidr));
}

// The key every rate limit counts against.
//
// This used to read CF-Connecting-IP first, then X-Real-IP, then req.ip. Both of
// those are just request headers: anyone reaching the origin directly could send
// a different CF-Connecting-IP on every request and mint a fresh bucket each
// time, which switched off brute-force protection entirely — including the
// 5-attempts-per-15-minutes limit on login, OTP and password reset. Measured
// before this change: 25 wrong-password attempts with a rotating header, none
// blocked; 12 without it, blocked from the fifth.
//
// app.js already refuses `trust proxy: true` for exactly this reason, and says
// so in a comment. Reading a different client-controlled header first undid it.
//
// req.ip is the honest starting point: Express derives it from the trust-proxy
// setting, which is "loopback", so only the local reverse proxy can influence
// it. Behind Cloudflare that resolves to the Cloudflare edge address — shared by
// many customers, so keying on it alone would make strangers lock each other
// out. CF-Connecting-IP names the real client and Cloudflare overwrites whatever
// a client supplied, so it is trustworthy precisely when the request actually
// came from Cloudflare. That is the condition being checked here.
//
// The effect is that this fix stands on its own: it needs no change to nginx to
// be safe, and stripping the header at the edge as well is defence in depth
// rather than a prerequisite.
function clientIpKey(req) {
  const peer = String(req.ip || req.socket?.remoteAddress || "").trim();
  if (arrivedFromTrustedEdge(peer)) {
    const forwarded = firstHeaderValue(req.headers["cf-connecting-ip"]);
    if (forwarded) return ipKeyGenerator(String(forwarded).trim());
  }
  return ipKeyGenerator(peer || "unknown");
}

function sensitiveKey(req) {
  const routeScope = `${req.method || "REQUEST"}:${req.baseUrl || ""}${req.route?.path || req.path || ""}`
    .replace(/\s+/g, "")
    .slice(0, 200);
  return `${clientIpKey(req)}:${normalizedIdentifier(req)}:${routeScope}`;
}

function retryAfterSeconds(req, fallbackSeconds) {
  const reset = req.rateLimit?.resetTime;
  if (!reset) return fallbackSeconds;
  return Math.max(1, Math.ceil((new Date(reset).getTime() - Date.now()) / 1000));
}

function rateLimitHandler(policyName, fallbackSeconds) {
  return (req, res) => {
    const retryAfter = retryAfterSeconds(req, fallbackSeconds);
    res.set("Retry-After", String(retryAfter));
    writeSecurityLog({
      actorType: "unknown",
      eventType: "rate_limit_blocked",
      severity: "warning",
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      success: false,
      metadata: {
        policy: policyName,
        method: req.method,
        route: req.route?.path || req.path,
        identifier: normalizedIdentifier(req),
        retryAfterSeconds: retryAfter
      }
    }).catch(() => {});
    res.status(429).json({
      ok: false,
      error: "Too many attempts. Please try again later.",
      retryAfterSeconds: retryAfter,
      maximumAttempts: req.rateLimit?.limit || null,
      attemptsRemaining: 0
    });
  };
}

const commonLimiterOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler: rateLimitHandler("general", 60)
};

const sensitiveLimiterOptions = {
  ...commonLimiterOptions,
  windowMs: SENSITIVE_WINDOW_MS,
  max: 5,
  keyGenerator: sensitiveKey,
  handler: rateLimitHandler("sensitive_auth", 15 * 60)
};

const authLimiter = rateLimit({
  ...sensitiveLimiterOptions
});

const otpLimiter = rateLimit({
  ...sensitiveLimiterOptions,
  handler: rateLimitHandler("otp", 15 * 60)
});

const generalLimiter = rateLimit({
  ...commonLimiterOptions,
  windowMs: GENERAL_WINDOW_MS,
  max: 120
});

const publicContactLimiter = rateLimit({
  ...commonLimiterOptions,
  windowMs: SENSITIVE_WINDOW_MS,
  max: 5,
  handler: rateLimitHandler("public_contact", 15 * 60)
});

module.exports = {
  authLimiter,
  otpLimiter,
  generalLimiter,
  publicContactLimiter,
  registrationLimiter: authLimiter,
  passwordResetLimiter: authLimiter,
  pinLimiter: authLimiter,
  accountRecoveryLimiter: authLimiter
};
