"use strict";

// WHAT A REJECTED REQUEST COSTS.
//
// Every request the rate limiter turned away also wrote a security_logs row, so
// the cheap path cost the most: the busier or more hostile the traffic, the
// more database work the rejections created. Those writes were already logging
// as slow at 246ms on an idle box, and a spike would have made the database the
// bottleneck rather than the shield.
//
// The signal still matters — you want to know somebody is hammering you — so
// this is coalescing, not dropping. What is asserted here is the count: how
// many writes N rejections actually produce.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const audit = require("../src/services/audit-service");

// Count writes without touching a database.
function withCountedWrites(run) {
  const original = audit.writeSecurityLog;
  const written = [];
  audit.writeSecurityLog = async (entry) => { written.push(entry); };
  try { return run(written); } finally { audit.writeSecurityLog = original; }
}

function freshModule() {
  delete require.cache[require.resolve("../src/middleware/rate-limits")];
  return require("../src/middleware/rate-limits").__rateLimitLogging;
}

const entry = (ip = "10.0.0.1", policy = "auth") => ({
  actorType: "unknown", eventType: "rate_limit_blocked", severity: "warning",
  ipAddress: ip, userAgent: "probe", success: false,
  metadata: { policy, method: "POST", route: "/v1/auth/login", identifier: "someone", retryAfterSeconds: 60 }
});

test("one caller hammering an endpoint writes once, not once per attempt", () => {
  withCountedWrites((written) => {
    const logging = freshModule();
    logging.blockTallies.clear();
    for (let i = 0; i < 500; i += 1) logging.recordRateLimitBlock(entry(), "auth:10.0.0.1:someone");
    assert.equal(written.length, 1,
      `500 rejections produced ${written.length} writes; before this change it was 500`);
    // The first is written immediately so a flood is visible in seconds.
    assert.equal(written[0].eventType, "rate_limit_blocked");
  });
});

test("the suppressed attempts are not lost — they are flushed as a total", () => {
  withCountedWrites((written) => {
    const logging = freshModule();
    logging.blockTallies.clear();
    for (let i = 0; i < 250; i += 1) logging.recordRateLimitBlock(entry(), "auth:10.0.0.1:someone");
    logging.flushBlockTallies();
    assert.equal(written.length, 2, "the immediate one, then one summarising row");
    const summary = written[1];
    assert.equal(summary.metadata.blockedAttempts, 249, "every attempt after the first is counted");
    assert.equal(summary.metadata.coalesced, true);
    assert.equal(summary.ipAddress, "10.0.0.1", "the summary still names who it was");
    assert.equal(summary.metadata.policy, "auth");
  });
});

test("different callers are counted separately, so one cannot mask another", () => {
  withCountedWrites((written) => {
    const logging = freshModule();
    logging.blockTallies.clear();
    for (let i = 0; i < 20; i += 1) {
      logging.recordRateLimitBlock(entry("10.0.0.1"), "auth:10.0.0.1:a");
      logging.recordRateLimitBlock(entry("10.0.0.2"), "auth:10.0.0.2:b");
    }
    assert.equal(written.length, 2, "one immediate write per distinct caller");
    assert.deepEqual(written.map((w) => w.ipAddress).sort(), ["10.0.0.1", "10.0.0.2"]);
  });
});

test("a flush with nothing suppressed writes nothing", () => {
  withCountedWrites((written) => {
    const logging = freshModule();
    logging.blockTallies.clear();
    logging.recordRateLimitBlock(entry(), "auth:10.0.0.1:someone");
    logging.flushBlockTallies();
    assert.equal(written.length, 1, "a single rejection must not produce a redundant summary");
  });
});

test("the tally map is bounded, so rotating IPs cannot exhaust memory", () => {
  // Trading write amplification for a memory leak would be no trade at all.
  withCountedWrites(() => {
    const logging = freshModule();
    logging.blockTallies.clear();
    for (let i = 0; i < logging.BLOCK_KEY_CAP + 2000; i += 1) {
      logging.recordRateLimitBlock(entry(`10.1.${(i >> 8) & 255}.${i & 255}`), `auth:key-${i}`);
    }
    assert.ok(logging.blockTallies.size <= logging.BLOCK_KEY_CAP,
      `tally map grew to ${logging.blockTallies.size}, above the ${logging.BLOCK_KEY_CAP} cap`);
  });
});

test("the flush timer never holds the process open", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "middleware", "rate-limits.js"), "utf8");
  assert.match(source, /blockFlushTimer\.unref === "function"\) blockFlushTimer\.unref\(\)/,
    "an unreffed timer is what stops a log flush keeping the API alive at shutdown");
  assert.match(source, /clearInterval\(blockFlushTimer\); blockFlushTimer = null;/,
    "the timer must be cleared once there is nothing left to flush");
});

test("the response to the caller is unchanged", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "middleware", "rate-limits.js"), "utf8");
  // Coalescing is a logging change. What the customer sees must not move.
  assert.match(source, /res\.set\("Retry-After", String\(retryAfter\)\)/);
  assert.match(source, /res\.status\(429\)\.json\(\{[\s\S]*?error: "Too many attempts\. Please try again later\."/);
  assert.match(source, /retryAfterSeconds: retryAfter/);
});
