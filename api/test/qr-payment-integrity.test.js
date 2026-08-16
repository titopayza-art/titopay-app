"use strict";

// THE PAYMENT QR AS AN INSTRUMENT HANDED TO STRANGERS.
//
// A payment QR is printed on A4 sheets, shown on till screens, photographed and
// forwarded. Everything inside it is readable and editable by whoever is
// paying, and the payer's phone is hostile by assumption. These are the rules
// that make that safe, pinned so they cannot quietly come undone.
//
// The full adversarial run lives in verification/qr-tamper-audit.js, which
// drives real money over real HTTP. This is the fast guard in the build.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "qr-service.js"), "utf8");
const payQrFull = SERVICE.slice(SERVICE.indexOf("async function payQr("), SERVICE.indexOf("\nfunction qrResponse("));
const persist = SERVICE.slice(SERVICE.indexOf("async function persistQr("), SERVICE.indexOf("async function createQr("));
// Comments quote the old code deliberately, so that the next reader knows what
// this replaced. What must not survive is the old code ITSELF.
const stripComments = (text) => text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const payQr = stripComments(payQrFull);

test("the price on a QR comes from TitoPay's row, never from the request body", () => {
  // It used to read `payload.amount ?? qr.amount`, so the REQUEST BODY won and
  // the merchant's own price was the fallback. Make a Sale mints a code for one
  // exact amount and waits; a payer sending amount: 1 against a R200 sale was
  // paid through, the merchant was credited R1.00, and the code was marked paid.
  assert.doesNotMatch(payQr, /payload\.amount\s*\?\?\s*qr\.amount/,
    "the payer's amount must never take precedence over the merchant's");
  assert.match(payQr, /const fixedAmount = qr\.amount/,
    "the code's own amount must be read from the row");
  assert.match(payQr, /throw new AppError\(409,[\s\S]{0,200}This QR code is for R/,
    "a disagreement must be refused, not silently corrected: nobody may be charged an amount they did not see");
  // An open code has no price and is unchanged.
  assert.match(payQr, /amount = Number\(requested \?\? 0\)/,
    "a code with no amount must still let the payer name one");
});

test("only the id is trusted from a scan", () => {
  // The owner, the status, the expiry and the price are all re-read from the
  // qr_codes row. A forged userId, label or amount in the scanned JSON changes
  // nothing, which is what makes an unsigned payload safe.
  assert.match(payQr, /const qrId = readQrId\(payload\.qrId\)/);
  assert.match(payQr, /FROM qr_codes q\s*\n\s*JOIN users u ON u\.id = q\.user_id/,
    "the owner must be resolved by joining on the stored row, never taken from the scan");
  for (const field of ["payload.userId", "payload.label", "payload.currency", "payload.codeType"]) {
    assert.doesNotMatch(payQr, new RegExp(field.replace(".", "\\.")),
      `${field} from a scan must never be trusted`);
  }
});

test("the printed payload is the shortest thing that works", () => {
  // Every character encoded makes the printed code denser, and a denser code
  // has smaller modules at the same size, which is what a camera struggles with
  // across a counter. This carried the id, the owner's account UUID, the
  // amount, the currency, the reference, the label and a metadata object: 219
  // characters, a 61x61 code, none of which the server reads.
  const line = persist.slice(persist.indexOf("const payload = {"),
    persist.indexOf("\n", persist.indexOf("const payload = {")));
  assert.doesNotMatch(line, /\buserId\b/,
    "the owner's internal account id must not be printed on every QR poster");
  for (const dead of ["amount", "currency", "reference", "label", "metadata"]) {
    assert.doesNotMatch(line, new RegExp(`\\b${dead}\\b`),
      `${dead} is re-read from the row and must not be encoded into the image`);
  }
  // The scanner classifies a payment code on id PLUS codeType, so both stay.
  assert.match(line, /\bid\b/);
  assert.match(line, /\bcodeType\b/);
});

test("the printed code has the quiet zone the standard requires", () => {
  // A camera finds a code by locating its finder patterns against clear space.
  // This was margin: 1 against a required 4, which fails most often in exactly
  // the conditions a till is in.
  assert.doesNotMatch(persist, /margin:\s*1\b/, "a one-module quiet zone is below the QR standard");
  assert.match(persist, /margin:\s*4\b/, "the QR standard requires four modules of clear border");
  // One render config, used for both the SVG and the data URL, so they cannot
  // drift apart into two differently-scannable codes.
  assert.equal((persist.match(/margin:/g) || []).length, 1,
    "the SVG and the data URL must render from one config");
});

test("a QR that is not payable is refused before any money moves", () => {
  for (const [what, pattern] of [
    ["a code that does not exist", /if \(!qr\) throw new AppError\(404/],
    ["the payer's own code", /qr\.user_id === actor\.userId/],
    ["an inactive or revoked code", /qr\.status !== "active"/],
    ["an expired code", /qr\.expires_at.*getTime\(\) < Date\.now\(\)/],
    ["a dynamic code already paid", /already been paid/],
    ["an event ticket", /not a payment QR/]
  ]) {
    assert.match(`${payQr}${SERVICE.slice(SERVICE.indexOf("function readQrId("), SERVICE.indexOf("async function getQrDetails("))}`,
      pattern, `${what} must be refused`);
  }
});

test("the owner lookup discloses a name and nothing more", () => {
  const details = SERVICE.slice(SERVICE.indexOf("async function getQrDetails("), SERVICE.indexOf("async function payQr("));
  assert.match(details, /displayName/);
  assert.match(details, /accountType/);
  // A payment QR is shown to strangers, so anything returned here is public.
  for (const field of ["email", "phone", "wallet_number", "available_balance", "password", "id_number"]) {
    assert.doesNotMatch(details, new RegExp(`\\b${field}\\b`, "i"),
      `the QR owner lookup must not return ${field}`);
  }
  assert.doesNotMatch(details.slice(details.indexOf("return {")), /owner_id\s*[,:]/,
    "the owner's account id must not be returned to a payer");
});
