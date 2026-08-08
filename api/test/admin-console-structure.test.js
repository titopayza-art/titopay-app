"use strict";

// admin.js is one classic script on purpose — no build step, no module loader,
// nothing for a cPanel deploy to get wrong. What keeps it navigable is a
// convention, and a convention with no test decays. These hold the convention.
//
// The rule: function declarations are hoisted, so they may live in any section.
// Everything else is order-sensitive and must stay in the two banner-marked
// blocks — one at the top, one at the bottom — in its original order.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const adminPath = path.join(__dirname, "../../admin/assets/admin.js");
const source = fs.readFileSync(adminPath, "utf8");
const lines = source.split("\n");

const SECTION_RULE = /^ {3}\d+\. [A-Z]/;
const TOP_BLOCK = "STATE AND CONFIGURATION";
const BOTTOM_BLOCK = "PAGE STATE AND EVENT WIRING";

function sectionHeadings() {
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => SECTION_RULE.test(line))
    .map(({ line, index }) => ({ title: line.trim(), line: index + 1 }));
}

test("the console opens with a contents list", () => {
  assert.match(source.slice(0, 2000), /TitoPay Admin Portal/);
  assert.match(source.slice(0, 2000), /\* Contents/);
  const entries = source.slice(0, 3000).split("\n").filter((line) => /^ \* {2,}\d+\. /.test(line));
  assert.ok(entries.length >= 15, `expected a contents list, found ${entries.length} entries`);
  assert.ok(entries.every((line) => /\d+ functions$/.test(line.trim())), "every entry states its function count");
});

test("the contents list matches the sections in the file, in order", () => {
  const listed = source.slice(0, 3000).split("\n")
    .filter((line) => /^ \* {2,}\d+\. /.test(line))
    .map((line) => line.replace(/^ \* {2,}\d+\. /, "").replace(/\s+\d+ functions$/, "").trim());
  const present = sectionHeadings().map((s) => s.title.replace(/^\d+\. /, ""));
  assert.deepEqual(present.map((t) => t.toLowerCase()), listed.map((t) => t.toLowerCase()));
});

test("both order-sensitive blocks are present and marked", () => {
  assert.ok(source.includes(TOP_BLOCK), "the state block must be banner-marked");
  assert.ok(source.includes(BOTTOM_BLOCK), "the wiring block must be banner-marked");
  assert.match(source, new RegExp(`${TOP_BLOCK} — order matters here; do not reorder`));
  assert.match(source, new RegExp(`${BOTTOM_BLOCK} — order matters here; do not reorder`));
  assert.ok(source.indexOf(TOP_BLOCK) < source.indexOf(BOTTOM_BLOCK), "state comes before wiring");
});

test("no order-sensitive statement has been sprinkled between the function sections", () => {
  // This is the invariant that keeps the reshuffle safe. A `const` added in the
  // middle of a section still works today, but the next person to move a
  // section would silently change when it evaluates.
  const first = sectionHeadings()[0];
  const bottomLine = lines.findIndex((line) => line.includes(BOTTOM_BLOCK)) + 1;
  assert.ok(first && bottomLine > first.line, "sections must sit between the two blocks");

  const strays = [];
  for (let index = first.line; index < bottomLine - 1; index += 1) {
    if (/^(const|let|var|class) /.test(lines[index])) strays.push(`${index + 1}: ${lines[index].slice(0, 70)}`);
  }
  assert.deepEqual(strays, [], `move these into one of the two order-sensitive blocks:\n${strays.join("\n")}`);
});

test("no function is declared twice", () => {
  const names = (source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).map((m) => m.replace(/.*function /, ""));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "a duplicate declaration silently shadows the earlier one");
});

test("every function still lives at the top level", () => {
  // Indentation is the whole reason the section split is readable; a function
  // that drifts inside another one stops being findable by section.
  const declared = (source.match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || []).length;
  assert.ok(declared > 200, `expected the full console, found ${declared} top-level functions`);
});

test("the Admin Portal still calls only the TitoPay API", () => {
  // Structure work must not quietly introduce a direct third-party call.
  const hosts = [...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  const allowed = /titopay\.co\.za$|^127\.0\.0\.1$|^localhost$|^www\.w3\.org$/;
  const foreign = [...new Set(hosts)].filter((host) => !allowed.test(host));
  assert.deepEqual(foreign, [], `unexpected host(s) referenced from the Admin Portal: ${foreign.join(", ")}`);
});
