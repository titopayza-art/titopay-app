"use strict";

// Where the customer PWA lives, relative to the API.
//
// It is `app/` in the sandbox the verification harnesses build and serve, and
// `pwa/` in the repository. The two hold the same files; only the folder name
// differs. Tests that read the PWA hardcoded `../../app/`, so the whole of
// pwa-structure.test.js and statement-financial-integrity.test.js threw on a
// plain checkout — nineteen assertions that looked like they were running and
// were not.
//
// Resolving it once, here, means neither layout is the special one.

const fs = require("fs");
const path = require("path");

const CANDIDATES = ["app", "pwa"];
const ROOT = path.join(__dirname, "../..");

function pwaDir() {
  const found = CANDIDATES
    .map((name) => path.join(ROOT, name))
    .find((dir) => fs.existsSync(path.join(dir, "app.js")));
  if (!found) {
    throw new Error(`the customer PWA is in none of: ${CANDIDATES.map((c) => path.join(ROOT, c)).join(", ")}`);
  }
  return found;
}

function pwaFile(name) {
  return path.join(pwaDir(), name);
}

module.exports = { pwaDir, pwaFile };
