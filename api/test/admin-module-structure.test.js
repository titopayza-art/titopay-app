"use strict";

// The two Admin pages that ship as ES modules rather than as part of admin.js:
// Enterprise Analytics and the Low-Code Service Builder. admin.js imports each
// one only when an operator opens that page, so they stay out of every other
// page's payload.
//
// They follow the same convention as admin.js and app.js, and for the same
// reason: function declarations are hoisted to the top of the module scope, so
// they may live in any section, while everything else is order-sensitive and
// must stay in the two banner-marked blocks — one at the top, one at the
// bottom — in its original order. A convention with no test decays.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SECTION_RULE = /^ {3}\d+\. [A-Z]/;
const TOP_BLOCK = "order matters here; do not reorder";
const BOTTOM_BLOCK = "THE ENTRY POINT admin.js IMPORTS";

const MODULES = [
  { file: "admin-analytics.js", title: "Enterprise Analytics", entry: "renderAnalytics", minFunctions: 90, minSections: 8 },
  { file: "admin-service-builder.js", title: "Low-Code Service Builder", entry: "renderServiceBuilder", minFunctions: 45, minSections: 8 }
];

for (const module of MODULES) {
  const source = fs.readFileSync(path.join(__dirname, "../../admin/assets", module.file), "utf8");
  const lines = source.split("\n");
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => SECTION_RULE.test(line))
    .map(({ line, index }) => ({ title: line.trim(), line: index + 1 }));

  test(`${module.file} opens with a contents list`, () => {
    const head = source.slice(0, 4000);
    assert.match(head, new RegExp(`${module.title} — how this file is laid out`));
    assert.match(head, /\* Contents/);
    assert.match(head, new RegExp(`Entry point: ${module.entry}\\(`));
    const entries = head.split("\n").filter((line) => /^ \* {2,}\d+\. /.test(line));
    assert.ok(entries.length >= module.minSections, `expected a contents list, found ${entries.length} entries`);
    assert.ok(entries.every((line) => /\d+ functions$/.test(line.trim())), "every entry states its function count");
  });

  test(`${module.file}: the contents list matches the sections in the file, in order`, () => {
    const listed = source.slice(0, 4000).split("\n")
      .filter((line) => /^ \* {2,}\d+\. /.test(line))
      .map((line) => line.replace(/^ \* {2,}\d+\. /, "").replace(/\s+\d+ functions$/, "").trim().toLowerCase());
    const present = headings.map((s) => s.title.replace(/^\d+\. /, "").toLowerCase());
    assert.deepEqual(present, listed);
  });

  test(`${module.file}: the contents list counts the functions each section really holds`, () => {
    const counts = source.slice(0, 4000).split("\n")
      .filter((line) => /^ \* {2,}\d+\. /.test(line))
      .map((line) => Number(line.trim().match(/(\d+) functions$/)[1]));
    const bottom = lines.findIndex((line) => line.includes(BOTTOM_BLOCK)) + 1;
    const bounds = headings.map((h, index) => [h.line, index + 1 < headings.length ? headings[index + 1].line : bottom]);
    const actual = bounds.map(([from, to]) =>
      lines.slice(from, to - 1).filter((line) => /^(?:async )?function [A-Za-z0-9_$]+/.test(line)).length);
    assert.deepEqual(actual, counts, "a section grew or shrank without its contents entry being updated");
  });

  test(`${module.file}: both order-sensitive blocks are present and marked`, () => {
    assert.ok(source.includes(TOP_BLOCK), "the state block must be banner-marked");
    assert.ok(source.includes(BOTTOM_BLOCK), "the entry-point block must be banner-marked");
    assert.ok(source.indexOf(TOP_BLOCK) < source.indexOf(BOTTOM_BLOCK), "state comes before the entry point");
  });

  test(`${module.file}: no order-sensitive statement sits between the function sections`, () => {
    // This is the invariant that keeps the reshuffle safe. A `const` added in
    // the middle of a section still works today, but the next person to move a
    // section would silently change when it evaluates.
    const first = headings[0];
    const bottom = lines.findIndex((line) => line.includes(BOTTOM_BLOCK)) + 1;
    assert.ok(first && bottom > first.line, "sections must sit between the two blocks");

    const strays = [];
    for (let index = first.line; index < bottom - 1; index += 1) {
      if (/^(const|let|var|class|export) /.test(lines[index])) strays.push(`${index + 1}: ${lines[index].slice(0, 70)}`);
    }
    assert.deepEqual(strays, [], `move these into one of the two order-sensitive blocks:\n${strays.join("\n")}`);
  });

  test(`${module.file}: exports exactly its one entry point`, () => {
    const exported = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
    const other = [...source.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
    assert.deepEqual([...exported, ...other], [module.entry], "admin.js imports one function from this module; adding another widens the contract");
  });

  test(`${module.file}: no function is declared twice`, () => {
    const names = (source.match(/^(?:export )?(?:async )?function [A-Za-z0-9_$]+/gm) || []).map((m) => m.replace(/.*function /, ""));
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    assert.deepEqual([...new Set(duplicates)], [], "a duplicate declaration silently shadows the earlier one");
    assert.ok(names.length >= module.minFunctions, `expected the full module, found ${names.length} top-level functions`);
  });

  test(`${module.file} still calls only the TitoPay API`, () => {
    // Structure work must not quietly introduce a direct third-party call.
    const hosts = [...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    const allowed = /titopay\.co\.za$|^127\.0\.0\.1$|^localhost$|^www\.w3\.org$|^schemas\.openxmlformats\.org$|^schemas\.microsoft\.com$|^purl\.org$/;
    const foreign = [...new Set(hosts)].filter((host) => !allowed.test(host));
    assert.deepEqual(foreign, [], `unexpected host(s) referenced from ${module.file}: ${foreign.join(", ")}`);
  });
}
