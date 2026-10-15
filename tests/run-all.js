// Runs every harness and fails the process if any reports an error, a failure
// or a submitted transaction. This is the gate a change has to pass.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SUITES = [
  ["continuity-test.js", []],
  ["v169-regression.js", []],
  ["vas-phase2.js", []],
  ["stockvel-test.js", []],
  ["four-features.js", ["personal"]],
  ["four-features.js", ["business"]],
  ["learn-test.js", ["personal"]],
  ["learn-test.js", ["business"]],
  ["doc-test.js", []],
  ["stmt-split-test.js", ["personal"]],
  ["stmt-split-test.js", ["business"]],
  ["round4-test.js", ["personal"]],
  ["round4-test.js", ["business"]],
  ["header-test.js", ["personal"]],
  ["header-test.js", ["business"]],
  ["swipe-test.js", []],
  ["modal-stack.js", []],
  ["wording-sweep.js", ["personal"]],
  ["wording-sweep.js", ["business"]],
  ["v182-features.js", []]
];

// Suites that intentionally drive a mocked submission all the way through.
// These drive a mocked submission through to completion on purpose, because
// the assertion is about the request body that results. Everything else must
// report txPosts: 0.
const EXPECTS_SUBMISSION = new Set(["stockvel-test.js", "doc-test.js", "vas-phase2.js"]);

let failed = 0;
for (const [file, args] of SUITES) {
  const label = `${file}${args.length ? " " + args.join(" ") : ""}`;
  process.stdout.write(label.padEnd(34));
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, file), ...args], {
      encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    console.log("CRASHED");
    console.log(String(error.stdout || "").slice(-800));
    failed += 1;
    continue;
  }
  let json = null;
  const start = out.indexOf("{");
  if (start >= 0) { try { json = JSON.parse(out.slice(start)); } catch (_) { json = null; } }
  const problems = [];
  if (json) {
    const errors = json.errors || json.pageErrors || [];
    if (Array.isArray(errors) && errors.length) problems.push(`${errors.length} console/page errors`);
    if (Array.isArray(json.failures) && json.failures.length) problems.push(`${json.failures.length} assertion failures`);
    // Harnesses that assert "no transaction was submitted" report txPosts: 0.
    // Ones that deliberately exercise a mocked submission declare it, so only
    // an unexpected post is a failure.
    if (json.txPosts && !EXPECTS_SUBMISSION.has(file)) problems.push(`${json.txPosts} unexpected transaction posts`);
    // overflowX is a boolean in some harnesses and a per-axis object in others.
    const overflow = json.overflowX;
    if (overflow === true) problems.push("horizontal overflow");
    else if (overflow && typeof overflow === "object" && Object.values(overflow).some(Boolean)) {
      problems.push("horizontal overflow: " + Object.entries(overflow).filter(([, v]) => v).map(([k]) => k).join(", "));
    }
  }
  if (problems.length) { console.log("FAIL  " + problems.join("; ")); failed += 1; }
  else console.log("pass");
}

console.log(failed ? `\n${failed} suite(s) failed` : "\nAll suites passed");
process.exit(failed ? 1 : 0);
