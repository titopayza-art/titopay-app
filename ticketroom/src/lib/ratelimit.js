// Fixed-window in-memory limiter. Adequate for a single instance; a multi-
// instance deployment must move this to a shared store (see docs/OPERATIONS.md).
const { tooMany } = require("./errors");

const windows = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (w.reset < now) windows.delete(k);
}, 60_000).unref();

function hit(key, limit, windowMs) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || w.reset < now) {
    w = { count: 0, reset: now + windowMs };
    windows.set(key, w);
  }
  w.count += 1;
  return w.count <= limit;
}

// keyFn(req) lets limits be per user, per terminal or per IP.
function limit(bucket, max, windowMs, keyFn = (req) => req.ip) {
  return (req, _res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();
    if (!hit(`${bucket}:${keyFn(req)}`, max, windowMs)) return next(tooMany());
    next();
  };
}

const reset = () => windows.clear();
module.exports = { limit, hit, reset };
