// Drop-in replacement for the TitoPay API's bearer-token middleware.
//
// Fixes the fault in api/INCIDENT-admin-500.md: an invalid, malformed or
// expired token currently produces a 500, because the verification error
// escapes to the generic error handler. Clients gate session recovery on 401,
// so a 500 leaves them retrying a dead token until the operator signs out and
// back in. That is the "Admin module unavailable" loop.
//
// Written against the stack the live API actually reports: Express (weak
// ETags), Helmet, cors and express-rate-limit v7, behind Cloudflare. The error
// envelope and the "Bearer token required" wording below are copied from live
// responses so nothing user-visible changes except the status code on the
// paths that are currently wrong.
//
// Verify with api/verify-auth-fix.sh — all nine checks must pass.

"use strict";

const jwt = require("jsonwebtoken");

/** The envelope every TitoPay error already uses. */
function fail(req, res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message,
    // The live API already returns this and the console prints it as
    // "Reference", so keep whichever source is populated.
    requestId: req.id || req.requestId || res.getHeader("x-request-id") || undefined
  });
}

/**
 * Reads and verifies the bearer token.
 *
 * The whole bug is the try/catch: jwt.verify throws rather than returning
 * null, and every one of the errors it throws is a 401, not a 500.
 */
function verifyBearer(req, res, next, { secret, scope }) {
  const header = req.headers.authorization || "";

  // Unchanged: this path is already correct in production and the wording is
  // what clients display today.
  if (!header.startsWith("Bearer ")) {
    return fail(req, res, 401, "Bearer token required");
  }

  const token = header.slice(7).trim();
  if (!token) return fail(req, res, 401, "Bearer token required");

  let claims;
  try {
    claims = jwt.verify(token, secret);
  } catch (err) {
    // TokenExpiredError | JsonWebTokenError | NotBeforeError.
    // Before this catch existed, each of these became a 500.
    if (err && err.name === "TokenExpiredError") {
      return fail(req, res, 401, "Your session has expired. Please sign in again.");
    }
    return fail(req, res, 401, "Your session is no longer valid. Please sign in again.");
  }

  // A customer token must not open an admin route. This is an authorisation
  // failure, not a server fault, so it is also never a 5xx.
  if (scope && claims.scope !== scope) {
    return fail(req, res, 403, "You do not have access to this area.");
  }

  req.user = claims;
  return next();
}

/** Customer routes — /v1/wallets, /v1/transactions, and the rest of the app API. */
const requireAuth = (req, res, next) =>
  verifyBearer(req, res, next, { secret: process.env.JWT_SECRET });

/** Admin routes — /v1/admin/*. Requires an admin-scoped token. */
const requireAdmin = (req, res, next) =>
  verifyBearer(req, res, next, { secret: process.env.JWT_SECRET, scope: "admin" });

/**
 * The refresh handler has the same fault and needs the same treatment: a
 * refresh token that is absent, malformed, expired or revoked is a 401.
 *
 * Fixing only the middleware above moves the loop one step along rather than
 * ending it — the client gets its 401, tries to refresh, and the refresh 500s.
 *
 * Wire this in front of the existing handler body, or fold the try/catch into
 * it. `issueSession` is whatever the current handler already calls to mint a
 * new token pair.
 */
async function refreshHandler(req, res, issueSession) {
  const { refreshToken, scope } = req.body || {};

  if (!refreshToken || typeof refreshToken !== "string") {
    return fail(req, res, 401, "Your session has expired. Please sign in again.");
  }

  let claims;
  try {
    claims = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
  } catch {
    return fail(req, res, 401, "Your session has expired. Please sign in again.");
  }

  if (scope && claims.scope !== scope) {
    return fail(req, res, 401, "Your session has expired. Please sign in again.");
  }

  // Revoked or rotated tokens are also a 401, not a 500. Whatever the current
  // store lookup is, a miss lands here.
  try {
    const session = await issueSession(claims);
    if (!session) {
      return fail(req, res, 401, "Your session has expired. Please sign in again.");
    }
    return res.json({ ok: true, ...session });
  } catch (err) {
    // A genuine failure to mint a session is a real 500 — let it through to
    // the error handler rather than disguising it as an auth problem.
    throw err;
  }
}

module.exports = { requireAuth, requireAdmin, refreshHandler, verifyBearer, fail };
