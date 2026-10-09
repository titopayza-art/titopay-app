class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new AppError(400, "bad_request", message, details);
const invalid = (details) => new AppError(422, "validation_failed", "Some fields need attention.", details);
const unauthenticated = () => new AppError(401, "unauthenticated", "Please sign in.");
const forbidden = (message = "You do not have permission to do that.") => new AppError(403, "forbidden", message);
// Used for objects outside the caller's tenancy so their existence is not revealed.
const notFound = (what = "Not found") => new AppError(404, "not_found", what);
const conflict = (message, code = "conflict", details) => new AppError(409, code, message, details);
const tooMany = () => new AppError(429, "rate_limited", "Too many requests. Please wait a moment and try again.");

module.exports = { AppError, bad, invalid, unauthenticated, forbidden, notFound, conflict, tooMany };
