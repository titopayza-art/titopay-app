const rateLimitPackage = require("express-rate-limit");
const { writeSecurityLog } = require("../services/audit-service");
const { CLOUDFLARE_CIDRS, compileCidrs, isInCidr } = require("../lib/ip-range");
const { sharedStore } = require("../lib/rate-limit-store");

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

// One security_logs INSERT per REJECTED request meant the cheap path cost the
// most: the busier or more hostile the traffic, the more database work the
// rejections created. A spike or a crude flood turned the database into the
// bottleneck rather than the shield, and the writes were already logging as
// slow at 246ms on an idle box.
//
// The signal is worth keeping — you want to know somebody is hammering you —
// but not one row per attempt. So the first rejection for a given caller and
// policy is written immediately, because that is the one that tells you it
// started, and everything after it is counted and flushed as a single row
// carrying the total.
//
// Bounded on purpose. An attacker rotating IPs would otherwise grow this map
// without limit, which would be a memory exhaustion bug traded for a write
// amplification one. Past the cap, further keys fall back to writing directly.
const BLOCK_FLUSH_MS = 30000;
const BLOCK_KEY_CAP = 5000;
const blockTallies = new Map();
let blockFlushTimer = null;

function flushBlockTallies() {
  const pending = [...blockTallies.entries()];
  blockTallies.clear();
  if (blockFlushTimer) { clearInterval(blockFlushTimer); blockFlushTimer = null; }
  for (const [, tally] of pending) {
    if (tally.suppressed <= 0) continue;
    writeSecurityLog({
      actorType: "unknown",
      eventType: "rate_limit_blocked",
      severity: "warning",
      ipAddress: tally.ipAddress,
      userAgent: tally.userAgent,
      success: false,
      metadata: { ...tally.metadata, blockedAttempts: tally.suppressed, coalesced: true }
    }).catch(() => {});
  }
}

function recordRateLimitBlock(entry, key) {
  const existing = blockTallies.get(key);
  if (existing) {
    existing.suppressed += 1;
    return;
  }
  // The first one is written straight away, so a flood is visible in seconds
  // rather than after a flush interval.
  writeSecurityLog(entry).catch(() => {});
  if (blockTallies.size >= BLOCK_KEY_CAP) return;
  blockTallies.set(key, {
    suppressed: 0,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    metadata: entry.metadata
  });
  if (!blockFlushTimer) {
    blockFlushTimer = setInterval(flushBlockTallies, BLOCK_FLUSH_MS);
    // Never hold the process open for a log flush.
    if (typeof blockFlushTimer.unref === "function") blockFlushTimer.unref();
  }
}

function rateLimitHandler(policyName, fallbackSeconds) {
  return (req, res) => {
    const retryAfter = retryAfterSeconds(req, fallbackSeconds);
    res.set("Retry-After", String(retryAfter));
    const identifier = normalizedIdentifier(req);
    recordRateLimitBlock({
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
        identifier,
        retryAfterSeconds: retryAfter
      }
    }, `${policyName}:${req.ip}:${identifier}`);
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

// The five-per-fifteen-minutes limits are security controls, so they count in
// PostgreSQL and mean the same number no matter how many processes are running.
// The general limiter's ceiling, overridable so a staging box can be load
// tested without editing code. Nothing else is overridable: the sensitive
// limiters guard sign-in, OTP and password reset, and those are security
// controls rather than capacity knobs.
//
// The default is the historical 120 and an unset variable changes nothing. A
// deliberately loud line at boot when it IS set, because a raised limit that
// nobody remembers raising is how a staging convenience becomes a production
// hole.
function generalLimitMax() {
  const raw = Number(process.env.GENERAL_RATE_LIMIT_MAX);
  if (!Number.isFinite(raw) || raw <= 0) return 120;
  const value = Math.min(1000000, Math.floor(raw));
  console.warn(
    `[rate-limit] GENERAL_RATE_LIMIT_MAX is set: allowing ${value} requests per minute per caller ` +
    "instead of the default 120. This is intended for load testing a staging box, not for production."
  );
  return value;
}

// Each limiter gets its own store instance because express-rate-limit calls
// init() on whatever it is handed.
const sensitiveLimiterOptions = {
  ...commonLimiterOptions,
  windowMs: SENSITIVE_WINDOW_MS,
  max: 5,
  keyGenerator: sensitiveKey,
  handler: rateLimitHandler("sensitive_auth", 15 * 60)
};

const authLimiter = rateLimit({
  ...sensitiveLimiterOptions,
  store: sharedStore("auth")
});

const otpLimiter = rateLimit({
  ...sensitiveLimiterOptions,
  store: sharedStore("otp"),
  handler: rateLimitHandler("otp", 15 * 60)
});

// A STOKVEL INVITE CODE IS A GUESSABLE SECRET, SO GUESSING MUST COST SOMETHING.
//
// Codes are SV plus eight digits, which is a 10^8 space, and the join endpoint
// carried only the general 120-per-minute fairness cap: 172,800 attempts a day
// from one address. Against a few thousand live groups that lands hits, and a
// hit is not harmless. Joining is instant with no organiser approval, and the
// stranger immediately reads the full register: every member's name, what each
// of them has contributed, and the group chat.
//
// Its OWN bucket, not authLimiter's. Sharing that store would let a few mistyped
// invite codes eat the attempts a person needs to sign in, which turns a privacy
// control into an account lockout. sensitiveKey includes the authenticated user
// id, so this counts per person rather than per address and shared carrier NAT
// cannot make one customer lock out another.
const stokvelJoinLimiter = rateLimit({
  ...sensitiveLimiterOptions,
  store: sharedStore("stokvel-join"),
  handler: rateLimitHandler("stokvel_join", 15 * 60)
});

// Deliberately left in process memory. This one is a fairness control rather
// than a security control — 120 requests a minute is about stopping a runaway
// client, not about stopping an attacker — and putting a database write in
// front of every single request to spread it across processes would cost more
// than it protects. Worst case with N workers it allows 120N a minute, which is
// still a limit and still bounded.
const generalLimiter = rateLimit({
  ...commonLimiterOptions,
  windowMs: GENERAL_WINDOW_MS,
  max: generalLimitMax()
});

// PUBLIC BOOKINGS ARE NOT A CONTACT FORM, and the difference matters.
//
// The first version of Book's public booking endpoint reused
// publicContactLimiter, which allows FIVE requests per fifteen minutes per
// client key. That is right for "send this business a message" and wrong for
// "book a table": South African mobile carriers put thousands of subscribers
// behind a handful of addresses, so five bookings per fifteen minutes would be
// consumed by strangers on the same network and real customers would be turned
// away. A restaurant's own wifi has the same problem.
//
// Twenty is chosen because a booking is already a poor spam target: it needs a
// published venue slug, an active service, a genuinely open slot and a contact
// detail, and a fake booking consumes a real slot that the business can cancel
// and see. The global 120-per-minute limiter still applies underneath.
const publicBookingLimiter = rateLimit({
  ...commonLimiterOptions,
  windowMs: SENSITIVE_WINDOW_MS,
  max: 20
});

const publicContactLimiter = rateLimit({
  ...commonLimiterOptions,
  windowMs: SENSITIVE_WINDOW_MS,
  max: 5,
  store: sharedStore("public_contact"),
  handler: rateLimitHandler("public_contact", 15 * 60)
});

module.exports = {
  authLimiter,
  otpLimiter,
  stokvelJoinLimiter,
  generalLimiter,
  publicContactLimiter,
  publicBookingLimiter,
  registrationLimiter: authLimiter,
  passwordResetLimiter: authLimiter,
  pinLimiter: authLimiter,
  accountRecoveryLimiter: authLimiter,
  // Exported so the coalescing can be tested for what it actually does —
  // how many writes N rejections produce — rather than by reading the source.
  __rateLimitLogging: { recordRateLimitBlock, flushBlockTallies, blockTallies, BLOCK_KEY_CAP }
};
