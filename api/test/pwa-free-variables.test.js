"use strict";

// A VARIABLE THAT IS NOT THERE.
//
// app.js is strict mode, so reading an identifier nothing declares throws a
// ReferenceError. Safari words it "Can't find variable: data", and that is the
// sentence a customer saw over a QR payment that had ALREADY SUCCEEDED.
//
// confirmReviewedQrPayment() sent the payment with context.data and then built
// the receipt from a bare `data`, which is declared nowhere in it. The bug was
// invisible for as long as it existed, because /v1/qr/pay was failing earlier
// in the function for an unrelated reason and the receipt block was never
// reached. The first payment that went through hit it immediately, and told the
// customer their completed payment had failed — which is how somebody pays
// twice.
//
// A property read off an undeclared name is the shape of that whole class of
// bug, so it is checked across the bundle rather than in one function.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { pwaFile } = require("./pwa-path");

const source = fs.readFileSync(pwaFile("app.js"), "utf8");

// Top-level function declarations, closed by a column-zero brace.
function topLevelFunctions(text) {
  const lines = text.split("\n");
  const found = [];
  let current = null;
  lines.forEach((line, index) => {
    const head = line.match(/^(?:async )?function ([A-Za-z0-9_$]+)\s*\(([\s\S]*?)\)\s*\{/);
    if (head && !current) current = { name: head[1], params: head[2], start: index + 1, body: [] };
    if (current) current.body.push(line);
    if (current && line === "}") { found.push(current); current = null; }
  });
  return found;
}

// `data` is the name this bit us on, and it is the one that recurs: almost every
// form handler in this file takes a parameter called `data`, so writing `data.x`
// inside a function that has no such parameter is an easy and silent mistake.
//
// Only a PROPERTY READ counts, `data.qrId`. A dot excludes the three things that
// legitimately look similar: an object key (`data: offer`), a regex
// (`/data:([^;]+)/`) and a data-* attribute in markup.
const READ = /(^|[^A-Za-z0-9_$."'`\-\\])data\./;

test("no function reads data.something without a data in scope", () => {
  const offenders = [];
  for (const fn of topLevelFunctions(source)) {
    const code = fn.body.map((line) => line.replace(/^\s*\/\/.*$/, "")).join("\n");
    const reads = code.split("\n").filter((line) => READ.test(line) && !/data-[a-z]/.test(line));
    if (!reads.length) continue;
    const declared = /\bdata\b/.test(fn.params)
      || /\b(?:const|let|var)\s+data\b/.test(code)
      || /\((?:[^)]*,\s*)?data\s*[),]/.test(code)
      || /\bdata\s*=>/.test(code)
      || /\{[^}]*\bdata\b[^}]*\}\s*=/.test(code);
    if (!declared) offenders.push(`${fn.name}() line ${fn.start}: ${reads[0].trim().slice(0, 70)}`);
  }
  assert.deepEqual(offenders, [],
    "app.js is strict mode, so this throws ReferenceError the first time the line is reached");
});

test("a QR payment that succeeded is never reported as a failure", () => {
  const fn = source.slice(source.indexOf("async function confirmReviewedQrPayment"),
    source.indexOf("\nfunction safeQrFilename("));
  assert.ok(fn.length > 200, "confirmReviewedQrPayment must exist");

  // The payload and the receipt must read from the same place.
  assert.doesNotMatch(fn.replace(/^\s*\/\/.*$/gm, ""), /[^.\w]data\.(qrId|amount)/,
    "the receipt must be built from context.data, not from a name nothing declares");
  assert.match(fn, /context\.data\.qrId/);

  // Everything after the money moves is wrapped, so no bookkeeping error can
  // present as a failed payment.
  const afterPay = fn.slice(fn.indexOf("closeModal();"));
  assert.match(afterPay, /try \{[\s\S]*saveTitoPayReceipt[\s\S]*\} catch/,
    "the receipt, notification and refresh must not be able to look like a failed payment");
  assert.ok(afterPay.lastIndexOf("showToast(") > afterPay.indexOf("} catch"),
    "the success message must be shown after the guard, so it is shown either way");
});
