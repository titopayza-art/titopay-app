"use strict";

// WHERE A STATEMENT IS ALLOWED TO GO.
//
// The destination used to be the account holder's own address and nothing else,
// so a customer sending a statement to their bookkeeper had to forward it
// themselves. It is now typed on the confirmation screen.
//
// A statement is the customer's whole transaction history, so the two things
// that matter are that a bad address cannot be charged for, and that wherever
// it goes is recorded against the charge — nobody can send one somewhere
// without it being visible in their own Activity afterwards.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WALLET_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "wallet-service.js"), "utf8");
const ROUTE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "routes", "wallet.routes.js"), "utf8");
const { pwaFile } = require("./pwa-path");
const APP_SOURCE = fs.readFileSync(pwaFile("app.js"), "utf8");

// resolveStatementRecipient is not exported — it is an internal rule, and
// lifting it out purely to test it would widen the service's surface. Reading
// it out of the source and running it is the same function, byte for byte.
function loadResolver() {
  const match = WALLET_SOURCE.match(/function resolveStatementRecipient\(requested, accountEmail\) \{[\s\S]*?\n\}/);
  assert.ok(match, "resolveStatementRecipient must exist");
  class AppError extends Error {
    constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
  }
  // eslint-disable-next-line no-new-func
  return new Function("AppError", `${match[0]}; return resolveStatementRecipient;`)(AppError);
}

test("an empty destination falls back to the account holder's own address", () => {
  const resolve = loadResolver();
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(resolve(blank, "Owner@TitoPay.co.za"), "owner@titopay.co.za",
      "the default must be the account address, lowercased");
  }
});

test("a typed address is accepted and normalised", () => {
  const resolve = loadResolver();
  assert.equal(resolve("  Bookkeeper@Firm.CO.ZA  ", "owner@titopay.co.za"), "bookkeeper@firm.co.za");
  assert.equal(resolve("accounts+titopay@firm.co.za", "owner@titopay.co.za"), "accounts+titopay@firm.co.za");
});

test("a bad address is refused before anything is charged", () => {
  const resolve = loadResolver();
  for (const bad of [
    "notanemail", "@nodomain.co.za", "no@tld", "two@@at.co.za",
    "spaces in@here.co.za", "trailing@dot.", "a@b.c"
  ]) {
    assert.throws(() => resolve(bad, "owner@titopay.co.za"),
      (error) => error.statusCode === 400,
      `"${bad}" must be refused`);
  }
  assert.throws(() => resolve(`${"a".repeat(250)}@firm.co.za`, "owner@titopay.co.za"),
    (error) => error.statusCode === 400 && /too long/i.test(error.message));
});

test("the destination varies the duplicate guard, so a corrected address still sends", () => {
  // Without the destination in the key, a customer who typed the wrong address,
  // noticed, corrected it and confirmed again would be told the request was
  // already received — for the wrong address, with no way to reach the right one.
  assert.match(WALLET_SOURCE,
    /idempotencyKey:`email-statement:\$\{userId\}:\$\{destination\}:\$\{idempotencyKey\}`/,
    "the queue key must include the destination");
});

test("wherever it is sent is recorded against the charge", () => {
  // The audit trail is the safeguard. A statement is a full transaction history,
  // so sending one elsewhere must never be invisible to the account holder.
  const fn = WALLET_SOURCE.slice(WALLET_SOURCE.indexOf("async function emailWalletStatement"));
  const body = fn.slice(0, fn.indexOf("\nasync function"));
  assert.match(body, /recipient:destination,\s*templateKey:"email_statement"/,
    "the email must go to the resolved destination");
  assert.match(body, /INSERT INTO transactions[\s\S]*?recipient_reference/,
    "the transaction must carry a recipient reference");
  assert.match(body, /pricing\.fee,reference,destination,JSON\.stringify\(\{[^}]*destination/,
    "the transaction row and its metadata must both name the destination");
  assert.match(body, /action:"email_statement_queued"[\s\S]{0,400}destination,sentElsewhere/,
    "the audit log must record the destination and whether it left the account");
  assert.doesNotMatch(body, /recipient:statement\.account\.email/,
    "nothing may still hard-code the account address as the delivery target");
});

test("the route passes the typed address through", () => {
  assert.match(ROUTE_SOURCE, /emailWalletStatement\([^)]*recipient:req\.body\.recipient/,
    "the endpoint must accept a recipient");
});

test("the app offers an editable destination, prefilled and validated", () => {
  const fn = APP_SOURCE.match(/async function confirmEmailStatement\(button\)[\s\S]*?\n\}/);
  assert.ok(fn, "confirmEmailStatement must exist");
  assert.match(APP_SOURCE, /data-statement-recipient/, "the modal must offer an input");
  assert.match(APP_SOURCE, /id="statement-recipient"[\s\S]{0,400}value="\$\{esc\(preview\.recipient\|\|state\.user\?\.email\|\|""\)\}"/,
    "it must be prefilled with the account address so the common case is one tap");
  assert.match(fn[0], /recipient\}/, "the typed address must reach the request body");
  assert.match(fn[0], /button\.disabled=false;[\s\S]{0,80}throw new Error\("Enter the email address/,
    "an empty address must re-enable the button rather than leaving it dead");
  // Assert the CHECK, not just the message. A previous version of this test
  // only looked for the sentence, so replacing the condition with `if(false)`
  // left the sentence in the file, the validation gone, and the test green.
  assert.match(fn[0], /if\(!\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\{2,\}\$\/\.test\(recipient\)\)\{/,
    "the typed address must actually be tested against the pattern");
  assert.match(fn[0], /does not look right/, "and the customer must be told why");
  // The check has to happen before the request, or the fee is charged first.
  assert.ok(fn[0].indexOf("does not look right") < fn[0].indexOf("statement/email"),
    "validation must run before the request that charges");

  // The label has to be present and associated, or the field is unusable with a
  // screen reader on the one screen that spends money.
  assert.match(APP_SOURCE, /<label for="statement-recipient">/);
  assert.match(APP_SOURCE, /aria-describedby="statement-recipient-hint"/);
});
