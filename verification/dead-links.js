"use strict";

// DEAD LINKS AND DEAD CONTROLS, ACROSS ALL THREE APPS.
//
// "Open Profile" on the ticketing verification notice looked broken for weeks.
// It was not: it navigated correctly and the modal stayed on top of where it
// went. That is what a dead link usually is in this codebase — not a missing
// href, but a control whose result never reaches the screen.
//
// This looks for the whole family, statically, so it can be run against a
// build without a database, a browser or a network:
//
//   1. data-route values the customer app cannot render. appView() draws
//      exactly five routes; anything else paints an empty screen.
//   2. data-action values with no handler anywhere in the source — a button
//      wired to a name nothing listens for.
//   3. href values that go nowhere: empty, "#", "javascript:void(0)", or a
//      bare word that is neither a URL nor a path.
//   4. Relative links and asset references whose file is not in the package,
//      which is the one that breaks only after deployment.
//   5. Route links inside modals, which navigate under their own sheet unless
//      the click handler closes it.
//
// It reports and changes nothing. Run it from the repository root:
//
//     node verification/dead-links.js
//     node verification/dead-links.js --all    also list what it considered fine

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHOW_ALL = process.argv.includes("--all");

// The customer app renders these and nothing else — see appView().
const PWA_ROUTES = new Set(["services", "qr", "activity", "profile", "dashboard"]);

const findings = [];
function report(app, severity, what, detail, where) {
  findings.push({ app, severity, what, detail, where });
}

// A scan that examined nothing also finds nothing. These are counted and
// printed so "0 broken" can be read against how much was actually judged, and
// so the parts this cannot see are stated rather than implied to be fine.
const coverage = { judged: 0, dynamic: 0, external: 0, files: 0 };

function readIfPresent(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (error) { return null; }
}

function listFiles(dir, extensions) {
  const out = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Every attribute value, with the line it sits on, so a finding can be pointed at.
function* attributeValues(source, attribute) {
  const pattern = new RegExp(`${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const value = match[1] !== undefined ? match[1] : match[2];
    const line = source.slice(0, match.index).split("\n").length;
    yield { value, line, index: match.index };
  }
}

/* ------------------------------------------------------- the customer app */

function auditPwa() {
  const app = "PWA";
  const file = path.join(ROOT, "pwa/app.js");
  const source = readIfPresent(file);
  if (!source) { report(app, "note", "pwa/app.js not in this package", "", ""); return; }

  // 1. Routes the app cannot draw.
  const routes = new Map();
  for (const { value, line } of attributeValues(source, "data-route")) {
    // Interpolated values are decided at runtime and cannot be judged here.
    if (value.includes("${")) { coverage.dynamic += 1; continue; }
    coverage.judged += 1;
    if (!routes.has(value)) routes.set(value, line);
  }
  for (const [value, line] of routes) {
    if (PWA_ROUTES.has(value)) {
      if (SHOW_ALL) report(app, "ok", `route "${value}"`, "renders", `app.js:${line}`);
      continue;
    }
    report(app, "dead", `data-route="${value}"`,
      `appView() renders only ${[...PWA_ROUTES].join(", ")} — this paints an empty screen`,
      `app.js:${line}`);
  }

  // 2. Actions nothing listens for. An action name that appears only inside
  //    markup, and never as a string the code compares against, has no
  //    handler — the button is decoration.
  const actions = new Map();
  for (const { value, line } of attributeValues(source, "data-action")) {
    if (value.includes("${")) { coverage.dynamic += 1; continue; }
    coverage.judged += 1;
    if (!actions.has(value)) actions.set(value, line);
  }
  for (const [value, line] of actions) {
    // Count occurrences as a bare quoted string outside an attribute.
    const asLiteral = new RegExp(`["'\`]${value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["'\`]`, "g");
    const literalHits = (source.match(asLiteral) || []).length;
    const attributeHits = (source.match(new RegExp(`data-action=["']${value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["']`, "g")) || []).length;
    // Some families are handled by prefix — startsWith("chat-invite:") covers
    // every chat-invite:* button — so a name that never appears literally can
    // still be perfectly well handled.
    const prefix = value.includes(":") ? value.slice(0, value.indexOf(":") + 1) : "";
    const prefixHandled = prefix
      && new RegExp(`startsWith\\(["'\`]${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(source);
    if (literalHits > attributeHits || prefixHandled) {
      if (SHOW_ALL) {
        report(app, "ok", `action "${value}"`, prefixHandled ? "handled by prefix" : "handled", `app.js:${line}`);
      }
      continue;
    }
    report(app, "dead", `data-action="${value}"`,
      "no handler compares against this name — the control does nothing", `app.js:${line}`);
  }

  // 5. Route links inside modals navigate under their own sheet unless the
  //    click handler dismisses it.
  const closesModal = /closest\("\.modal-backdrop"\)\s*\)?\s*&?&?\s*closeModal\(\)/.test(source)
    || /if \(route\.closest\("\.modal-backdrop"\)\) closeModal\(\)/.test(source);
  if (!closesModal) {
    report(app, "dead", "route links inside modals",
      "the click handler does not close the modal, so the page navigated to is "
      + "drawn underneath it and the control reads as dead", "app.js (onClick)");
  } else if (SHOW_ALL) {
    report(app, "ok", "route links inside modals", "the modal is dismissed on navigation", "app.js");
  }

  auditHrefs(app, file, source, path.join(ROOT, "pwa"));

  // The shipped bundle is what customers run. A fix in the source that is not
  // in the bundle is a dead control that looks fixed in review.
  const min = readIfPresent(path.join(ROOT, "pwa/app.min.js"));
  if (min) {
    if (closesModal && !/closest\(["']\.modal-backdrop["']\)&&closeModal\(\)/.test(min)) {
      report(app, "dead", "app.min.js is older than app.js",
        "index.html loads app.min.js — rebuild it with verification/build-pwa.sh", "pwa/app.min.js");
    }
    const html = readIfPresent(path.join(ROOT, "pwa/index.html")) || "";
    const worker = readIfPresent(path.join(ROOT, "pwa/service-worker.js")) || "";
    const pageVersion = (html.match(/app\.min\.js\?v=(\d+)/) || [])[1];
    const workerVersion = (worker.match(/app\.min\.js\?v=(\d+)/) || [])[1];
    if (pageVersion && workerVersion && pageVersion !== workerVersion) {
      report(app, "dead", "the page and the service worker disagree on the bundle version",
        `index.html asks for v${pageVersion}, the worker caches v${workerVersion} — returning `
        + "users keep the old bundle", "pwa/index.html");
    }
  }
}

/* --------------------------------------------------------- links and files */

// Anything that claims to be a destination, judged on whether it is one.
function auditHrefs(app, file, source, packageRoot) {
  const relative = path.relative(ROOT, file);
  // Script bodies are not markup. A minified bundle is full of things that
  // look like attributes — href="'+l+'" is JavaScript building a string, not a
  // link — and reading them as HTML invents findings that are not there.
  if (file.endsWith(".html")) source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const seen = new Set();
  for (const { value, line } of attributeValues(source, "href")) {
    if (value.includes("${")) { coverage.dynamic += 1; continue; }
    coverage.judged += 1;
    const key = `${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const href = value.trim();

    if (!href) {
      report(app, "dead", 'href=""', "an empty destination", `${relative}:${line}`);
      continue;
    }
    if (href === "#") {
      report(app, "suspect", 'href="#"',
        "goes to the top of the page; if it is a button it should be one", `${relative}:${line}`);
      continue;
    }
    if (/^javascript:\s*void/i.test(href)) {
      report(app, "suspect", `href="${href}"`, "a link that deliberately does nothing", `${relative}:${line}`);
      continue;
    }
    if (/^(https?:)/i.test(href) || href.startsWith("//")) coverage.external += 1;
    if (/^(https?:|mailto:|tel:|data:|blob:)/i.test(href) || href.startsWith("//")) {
      if (SHOW_ALL) report(app, "ok", href.slice(0, 60), "external or protocol link", `${relative}:${line}`);
      continue;
    }
    if (href.startsWith("#")) {
      if (SHOW_ALL) report(app, "ok", href, "in-page or route anchor", `${relative}:${line}`);
      continue;
    }
    // A relative path: the file has to be in the package that ships.
    const target = href.split("?")[0].split("#")[0].replace(/^\.?\//, "");
    if (!target) continue;
    const candidates = [
      path.join(packageRoot, target),
      path.join(packageRoot, target, "index.html"),
      path.join(path.dirname(file), target)
    ];
    if (candidates.some((candidate) => fs.existsSync(candidate))) {
      if (SHOW_ALL) report(app, "ok", href, "file is in the package", `${relative}:${line}`);
      continue;
    }
    // A bare word with no slash and no extension is not a path at all.
    const shape = /[./]/.test(target) ? "the file is not in this package" : "not a URL, a path or an anchor";
    report(app, "dead", `href="${href}"`, shape, `${relative}:${line}`);
  }
}

/* ------------------------------------------------ the admin console and HR */

function auditHtmlPackage(app, dir) {
  const root = path.join(ROOT, dir);
  if (!fs.existsSync(root)) { report(app, "note", `${dir} not in this package`, "", ""); return; }
  const packageFiles = listFiles(root, [".html", ".js"]);
  coverage.files += packageFiles.length;
  for (const file of packageFiles) {
    const source = readIfPresent(file);
    if (!source) continue;
    auditHrefs(app, file, source, root);

    // Scripts and stylesheets that are not there fail silently and take a
    // whole page's behaviour with them.
    const markup = file.endsWith(".html")
      ? source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => block.replace(/[^\n]/g, " "))
      : source;
    for (const attribute of ["src", "data-src"]) {
      for (const { value, line } of attributeValues(markup, attribute)) {
        if (value.includes("${") || !value) continue;
        if (/^(https?:|data:|blob:)/i.test(value) || value.startsWith("//")) continue;
        const target = value.split("?")[0].replace(/^\.?\//, "");
        if (!target) continue;
        const candidates = [path.join(root, target), path.join(path.dirname(file), target)];
        if (candidates.some((candidate) => fs.existsSync(candidate))) continue;
        report(app, "dead", `${attribute}="${value}"`, "the file is not in this package",
          `${path.relative(ROOT, file)}:${line}`);
      }
    }
  }
}

/* --------------------------------------------------------------- reporting */

auditPwa();
auditHtmlPackage("Admin", "admin");
auditHtmlPackage("HR", "hr");

const order = { dead: 0, suspect: 1, note: 2, ok: 3 };
findings.sort((a, b) => (order[a.severity] - order[b.severity]) || a.app.localeCompare(b.app));

console.log(`\n${"=".repeat(78)}\n  DEAD LINKS AND DEAD CONTROLS\n${"=".repeat(78)}`);
const dead = findings.filter((f) => f.severity === "dead");
const suspect = findings.filter((f) => f.severity === "suspect");

for (const group of [["dead", "BROKEN — these go nowhere"], ["suspect", "WORTH A LOOK"],
  ["note", "NOTES"], ...(SHOW_ALL ? [["ok", "FINE"]] : [])]) {
  const rows = findings.filter((f) => f.severity === group[0]);
  if (!rows.length) continue;
  console.log(`\n--- ${group[1]} (${rows.length}) ---`);
  let lastApp = "";
  for (const row of rows) {
    if (row.app !== lastApp) { console.log(`\n  [${row.app}]`); lastApp = row.app; }
    console.log(`    ${row.what}`);
    if (row.detail) console.log(`      ${row.detail}`);
    if (row.where) console.log(`      ${row.where}`);
  }
}

console.log(`\n${"=".repeat(78)}`);
console.log(`  ${dead.length} broken, ${suspect.length} worth a look.`);
console.log(`  ${coverage.judged} destinations judged across ${coverage.files} files.`);
console.log(`\n  NOT judged here, and not therefore fine:`);
console.log(`    ${coverage.dynamic} built at runtime from a variable — only a browser can follow those.`);
console.log(`    ${coverage.external} point at another site; whether they answer needs the network.`);
console.log(`    The HR portal is a compiled bundle: its links are made in JavaScript,`);
console.log(`    so only the page shell around them is checked here.`);
if (!dead.length) console.log("  Nothing in this build points at somewhere that does not exist.");
console.log(`${"=".repeat(78)}\n`);
process.exit(dead.length ? 1 : 0);
