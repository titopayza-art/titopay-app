"use strict";

// WHAT A 5xx ACTUALLY TELLS THE PERSON READING IT.
//
// "Unable to complete the request. Please try again." is the right thing to say
// when the server does not know what went wrong. It is the wrong thing to say
// when it does. The Email Statement screen showed it while the server was
// holding "TitoPay revenue wallet is not configured" — a sentence that names
// the fault and the fix — and threw it away because the status was 500.
//
// These pin both halves: an authored message reaches the person, and a
// technical one never does.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../src/lib/errors");
const { errorHandler } = require("../src/middleware/error-handler");

// The handler writes to the response, so a small stand-in collects what it said.
function send(error) {
  let captured = null;
  const res = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    json(body) { captured = { status: this.statusCode, body }; return this; }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    errorHandler(error, { requestId: "test", method: "POST", originalUrl: "/v1/test" }, res, () => {});
  } finally {
    console.error = originalError;
  }
  return captured;
}

test("a 500 the server can explain says what is wrong", () => {
  const result = send(new AppError(500, "TitoPay revenue wallet is not configured"));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "TitoPay revenue wallet is not configured",
    "the only useful thing the server knew must reach the person reading it");
});

test("provider-state messages still survive, as they always did", () => {
  for (const [status, message] of [
    [503, "Card top-up is not configured yet"],
    [502, "Peach Payments could not be reached"],
    [504, "Flash timed out"]
  ]) {
    assert.equal(send(new AppError(status, message)).body.error, message);
  }
});

test("technical detail never reaches a customer, whatever the status", () => {
  for (const message of [
    "pricing rule not found for email_statement",
    'relation "email_queue" does not exist — sql error',
    "Internal server error",
    "Unhandled exception in wallet ledger",
    "The audience could not be built. The rule was rejected by the database."
  ]) {
    const result = send(new AppError(500, message));
    assert.equal(result.body.error, "Unable to complete the request. Please try again.",
      `"${message}" must not reach a customer`);
  }
});

test("an error this codebase did not author is never quoted", () => {
  // A driver or provider throwing an ordinary Error carries text nobody wrote
  // for a customer, so it is replaced whatever it says.
  const raw = new Error("ECONNREFUSED 10.0.0.4:5432 password=hunter2");
  const result = send(raw);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Unable to complete the request. Please try again.");
  assert.doesNotMatch(JSON.stringify(result.body), /hunter2|ECONNREFUSED/);
});

test("every authored 5xx message in the codebase is safe to show", () => {
  // The change above lets these through, so they are worth reading as a set:
  // none may carry a credential, a host, a stack or SQL.
  const root = path.join(__dirname, "..", "src");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  })(root);

  const messages = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/AppError\(50[0-9],\s*"([^"]{3,200})"/g)) messages.add(match[1]);
  }
  assert.ok(messages.size > 20, `expected the authored 5xx messages, found ${messages.size}`);
  for (const message of messages) {
    const result = send(new AppError(500, message));
    const shown = result.body.error;
    if (shown === "Unable to complete the request. Please try again.") continue; // scrubbed, fine
    // The risk is a credential VALUE, not the name of a field. "invalid Client
    // ID, Client Secret or Merchant ID" tells an operator which credential to
    // check and tells an attacker nothing; that message is a 502 and has always
    // been reachable. So this looks for values being handed out: an assignment,
    // a bearer token, a long opaque string.
    assert.doesNotMatch(shown, /(password|secret|api[_-]?key|token)\s*[:=]\s*\S/i,
      `"${message}" hands out a credential value`);
    assert.doesNotMatch(shown, /Bearer\s+\S|\b[A-Za-z0-9_-]{32,}\b/,
      `"${message}" contains something that looks like a token`);
    assert.doesNotMatch(shown, /\bselect\b|\binsert\b|\bstack\b/i,
      `"${message}" exposes query or stack detail`);
    assert.doesNotMatch(shown, /\b\d{1,3}(\.\d{1,3}){3}\b/, `"${message}" exposes a host address`);
  }
});
