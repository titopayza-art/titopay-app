const crypto = require("crypto");
const config = require("../config");
const db = require("../lib/db");
const { sha256, safeEqual } = require("../lib/crypto");
const { AppError, unauthenticated, forbidden } = require("../lib/errors");

const SESSION_COOKIE = "tr_sid";

function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()");
  if (config.isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

function parseCookies(req, _res, next) {
  req.cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
    }
  }
  next();
}

function setSessionCookie(res, token, expires) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Expires=${expires.toUTCString()}`];
  if (config.cookieSecure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${config.cookieSecure ? "; Secure" : ""}`);
}

// Resolves the session cookie to a user and their roles. Never throws for a
// missing session; routes decide whether one is required.
async function loadSession(req, _res, next) {
  try {
    const token = req.cookies[SESSION_COOKIE];
    if (!token || token.length > 100) return next();
    const { rows } = await db.query(
      `SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.full_name, u.phone, u.status, u.email_verified_at,
              (u.spending_pin_hash IS NOT NULL) AS has_pin,
              COALESCE(array_agg(pr.role) FILTER (WHERE pr.role IS NOT NULL), '{}') AS platform_roles
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN platform_roles pr ON pr.user_id = u.id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        GROUP BY s.id, u.id`,
      [sha256(token)]
    );
    const row = rows[0];
    if (row && row.status === "active") {
      req.session = { id: row.session_id, csrfToken: row.csrf_token };
      req.user = {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        phone: row.phone,
        emailVerified: !!row.email_verified_at,
        hasPin: row.has_pin,
        platformRoles: new Set(row.platform_roles),
      };
      req.user.primaryRole = ["admin", "finance", "support"].find((r) => req.user.platformRoles.has(r)) || "user";
    }
    next();
  } catch (err) {
    next(err);
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// CSRF: (1) state-changing API calls must be JSON or a declared upload type,
// which a cross-site HTML form cannot send without a CORS preflight we never
// grant; (2) when authenticated by cookie, the per-session token must also be
// echoed in X-CSRF-Token.
function csrf(req, _res, next) {
  if (!UNSAFE.has(req.method)) return next();
  if (req.path.startsWith("/api/webhooks/") || req.path.startsWith("/sim/")) return next();
  const type = String(req.headers["content-type"] || "").toLowerCase();
  const isUpload = req.path.endsWith("/uploads");
  const bodyless = !type && (!req.headers["content-length"] || req.headers["content-length"] === "0");
  if (isUpload) {
    if (!/^image\/(png|jpeg|webp)$/.test(type)) return next(new AppError(415, "unsupported_media_type", "Upload a PNG, JPEG or WebP image."));
  } else if (!bodyless && !type.startsWith("application/json")) {
    return next(new AppError(415, "unsupported_media_type", "Requests must be JSON."));
  }
  if (req.session) {
    const sent = req.headers["x-csrf-token"];
    if (!sent || !safeEqual(sent, req.session.csrfToken)) {
      return next(new AppError(403, "csrf_failed", "Your session security token is missing or stale. Refresh the page and try again."));
    }
  }
  next();
}

const requireAuth = (req, _res, next) => (req.user ? next() : next(unauthenticated()));

function requirePlatformRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthenticated());
    if (!roles.some((r) => req.user.platformRoles.has(r))) return next(forbidden());
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  if (err.type === "entity.too.large") err = new AppError(413, "too_large", "That request is too large.");
  if (err.type === "entity.parse.failed") err = new AppError(400, "bad_json", "Malformed JSON.");
  if (!(err instanceof AppError) && err.code) {
    // Map database constraint violations to safe client errors.
    if (err.code === "23505") err = new AppError(409, "duplicate", "That already exists.");
    else if (err.code === "23514" || err.code === "23503") err = new AppError(409, "constraint", "That change is not allowed in the current state.");
    else if (err.code === "22P02") err = new AppError(400, "bad_request", "Invalid identifier.");
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Never echo internals. Log with the request id only — no body, no headers.
  console.error(`[error] ${req.id} ${req.method} ${req.path}:`, err.code || "", err.message);
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong on our side.", requestId: req.id } });
}

module.exports = { securityHeaders, parseCookies, loadSession, csrf, requireAuth, requirePlatformRole, wrap, errorHandler, setSessionCookie, clearSessionCookie };
