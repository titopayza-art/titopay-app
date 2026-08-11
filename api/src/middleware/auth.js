const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { verifyAccessToken } = require("../lib/jwt");
const { AppError } = require("../lib/errors");

function isHrPublicPath(req, suffix) {
  const path = String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "");
  return [
    `/api/v1/hr/${suffix}`,
    `/v1/hr/${suffix}`,
    `/api/hr/${suffix}`,
    `/hr/${suffix}`
  ].some((candidate) => path === candidate);
}

function requestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent") || "",
    trustedDevice: req.body?.trustedDevice === true
  };
}

async function handleHrPublicPath(req, res) {
  const hr = require("../services/hr-service");
  if (req.method === "GET" && isHrPublicPath(req, "health")) {
    await hr.health();
    res.json({
      ok: true,
      service: "titopay-hr",
      status: "ready",
      database: "ok",
      basePath: "/api/v1/hr"
    });
    return true;
  }
  if (req.method === "POST" && isHrPublicPath(req, "auth/login")) {
    res.json(await hr.login(req.body || {}, requestMeta(req)));
    return true;
  }
  if (req.method === "POST" && isHrPublicPath(req, "auth/refresh")) {
    res.json(await hr.refresh(req.body?.refreshToken));
    return true;
  }
  if (req.method === "POST" && isHrPublicPath(req, "auth/reset")) {
    res.json(await hr.passwordReset(req.body || {}));
    return true;
  }
  if (req.method === "POST" && isHrPublicPath(req, "public/career-application")) {
    const configuredToken = process.env.HR_WEBSITE_TOKEN || "";
    if (configuredToken) {
      const suppliedToken = req.get("x-titopay-website-token") || "";
      if (suppliedToken !== configuredToken) {
        res.status(401).json({ ok: false, error: "Website application token required" });
        return true;
      }
    }
    res.status(201).json(await hr.receiveWebsiteApplication(req.body || {}, requestMeta(req)));
    return true;
  }
  return false;
}

async function requireAuth(req, res, next) {
  try {
    if (await handleHrPublicPath(req, res)) return;
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      throw new AppError(401, "Bearer token required");
    }
    const token = header.slice(7);
    const decoded = verifyAccessToken(token);
    const sessionResult = await pool.query(
      `SELECT s.*
       FROM sessions s
       WHERE s.id = $1
         AND s.access_jti = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [decoded.sid, decoded.jti]
    );
    const session = sessionResult.rows[0];
    if (!session) throw new AppError(401, "Session not found");
    if (decoded.sub !== session.user_id || decoded.typ !== session.user_type) {
      throw new AppError(401, "Invalid session");
    }

    const table = session.user_type === "admin" ? "admin_users" : "users";
    const accountResult = await pool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [session.user_id]);
    const account = accountResult.rows[0];
    if (!account) throw new AppError(401, "Account not found");
    if (account.status !== "active") throw new AppError(403, "Account is not active");
    if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
      throw new AppError(423, `Account locked until ${account.locked_until}`);
    }
    if (new Date(session.last_activity_at).getTime() < Date.now() - (config.sessionIdleTimeoutSeconds * 1000)) {
      await pool.query(
        "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'idle_timeout' WHERE id = $1",
        [decoded.sid]
      );
      throw new AppError(401, "Session expired due to inactivity");
    }
    if (account.profile_locked && session.user_type === "customer") {
      req.profileLocked = true;
    }
    await pool.query(
      "UPDATE sessions SET last_activity_at = NOW(), ip_address = $2, user_agent = $3 WHERE id = $1",
      [decoded.sid, req.ip, req.get("user-agent")]
    );
    req.auth = {
      sessionId: decoded.sid,
      userId: session.user_id,
      userType: session.user_type,
      accountType: account.account_type || null,
      role: session.user_type === "admin" ? account.role : "customer",
      profileLocked: Boolean(account.profile_locked),
      fullName: account.full_name || account.fullName || null,
      full_name: account.full_name || null,
      email: account.email,
      username: account.username,
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    };
    next();
  } catch (error) {
    if (error?.name === "TokenExpiredError") return next(new AppError(401, "Session expired"));
    if (error?.name === "JsonWebTokenError" || error?.name === "NotBeforeError") return next(new AppError(401, "Invalid session"));
    next(error);
  }
}

module.exports = { requireAuth };
