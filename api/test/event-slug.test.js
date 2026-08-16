"use strict";

// THE WEB ADDRESS OF AN EVENT IS THE LINK AN ORGANISER SENDS OUT.
//
// A free name has always been used as it is. What changed is the COLLISION
// suffix: six characters of a sha1 digest, which nobody can read or say out
// loud, became the next free number.
//
//   was   app.titopay.co.za/events/titopay-launch-3d4c29
//   is    app.titopay.co.za/events/titopay-launch-2
//
// The behaviour against a real database is proven in
// verification/event-slug-live.js. This is the guard in the build.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
const uniqueSlug = SOURCE.slice(SOURCE.indexOf("async function uniqueSlug("), SOURCE.indexOf("/* ---- Ticket phases"));
const code = uniqueSlug.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

test("a free event name is the web address, untouched", () => {
  assert.match(code, /if \(!\(await taken\(candidate\)\)\) return candidate;/,
    "a name nobody holds must be used exactly as it is");
});

test("a collision reads as a number, not as a hex digest", () => {
  assert.match(code, /for \(let counter = 2; counter <= 50/,
    "the second event with a name must be -2, and it must count up from there");
  assert.match(code, /`\$\{candidate\}-\$\{counter\}`/);
  // The digest survives only as a bounded last resort, never as the first answer.
  const firstDigest = code.indexOf("sha1");
  const firstNumber = code.indexOf("counter = 2");
  assert.ok(firstNumber > -1 && firstNumber < firstDigest,
    "the numbered candidates must be tried before any digest");
});

test("the loop is bounded, so it cannot spin forever", () => {
  // The old version was `while (true)` with a counter that only ever grew.
  assert.doesNotMatch(code, /while \(true\)/, "an unbounded loop against the database is not acceptable here");
  assert.match(code, /throw new AppError\(409/, "the last resort must end in a readable refusal");
});

test("a slug is never left with a dangling hyphen", () => {
  const slugify = SOURCE.slice(SOURCE.indexOf("function slugify("), SOURCE.indexOf("function cleanText("));
  // The 70-character cut happens after the trim, so it can land mid-word.
  assert.ok(slugify.indexOf(".slice(0, 70)") < slugify.lastIndexOf("replace(/-+$/g"),
    "the trailing hyphen must be stripped AFTER the length cut, not before");

  // eslint-disable-next-line no-new-func
  const fn = new Function(`${slugify}; return slugify;`)();
  assert.equal(fn("TitoPay Launch"), "titopay-launch");
  assert.equal(fn("  Braai & Chill!! 2027 — Jozi  "), "braai-chill-2027-jozi");
  assert.equal(fn(""), "event");
  assert.equal(fn("!!!"), "event");
  for (const name of ["Annual General Meeting ".repeat(5), "a".repeat(200), "The-End-", "x ".repeat(60)]) {
    const slug = fn(name);
    assert.doesNotMatch(slug, /-$/, `"${slug}" ends in a hyphen`);
    assert.doesNotMatch(slug, /^-/, `"${slug}" starts with a hyphen`);
    assert.doesNotMatch(slug, /--/, `"${slug}" has a doubled hyphen`);
    assert.ok(slug.length <= 70 && slug.length > 0);
    assert.match(slug, /^[a-z0-9-]+$/);
  }
});
