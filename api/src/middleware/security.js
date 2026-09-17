const { AppError } = require("../lib/errors");

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const JSON_CONTENT_TYPES = new Set([
  "application/json",
  "application/merge-patch+json",
  "application/vnd.api+json"
]);

function securityHeaders(_req, res, next) {
  res.setHeader("Permissions-Policy", [
    "camera=(self)",
    "microphone=(self)",
    "geolocation=()",
    "payment=(self)",
    "usb=()",
    "serial=()",
    "interest-cohort=()"
  ].join(", "));
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
}

function validateJsonContentType(req, _res, next) {
  if (!BODY_METHODS.has(req.method)) {
    next();
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (!contentLength) {
    next();
    return;
  }

  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (JSON_CONTENT_TYPES.has(contentType)) {
    next();
    return;
  }

  const path = String(req.originalUrl || req.url || "").split("?")[0].toLowerCase();
  if (
    (path === "/v1/webhooks/provider" || path === "/v1/payments/topup/return")
    && contentType === "application/x-www-form-urlencoded"
  ) {
    next();
    return;
  }
  if (contentType === "multipart/form-data" && /\/hr\/uploads\/?$/.test(path)) {
    next();
    return;
  }

  next(new AppError(415, "Unsupported content type"));
}

module.exports = { securityHeaders, validateJsonContentType };
