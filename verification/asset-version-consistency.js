#!/usr/bin/env node
"use strict";

// ASSET VERSION CONSISTENCY - run before shipping app.zip.
//
// The PWA loads its stylesheet from INSIDE head-boot.js, not from a <link> in
// index.html (that one is noscript-only). So head-boot.js has two versions that
// must move together:
//
//   1. the query on head-boot.js ITSELF, which decides whether a browser or a
//      service worker fetches a fresh copy at all
//   2. the styles.min.css version WRITTEN INSIDE it
//
// Bumping only (2) ships nothing: the cached loader is still served, and it
// keeps asking for the old stylesheet forever. That is exactly what happened on
// v480 - the app bundle updated, the stylesheet did not, and the guided tour
// rendered new numbered markup inside old 7px dots.
//
// This also checks that index.html and the service-worker precache agree, since
// a precached URL that no page requests is dead weight and a precached URL that
// disagrees with the page is a split brain.

const fs = require("fs");
const path = require("path");

const PWA = path.join(__dirname, "..", "pwa");
const read = (f) => fs.readFileSync(path.join(PWA, f), "utf8");

const index = read("index.html");
const boot = read("head-boot.js");
const sw = read("service-worker.js");

const failures = [];
const note = (m) => failures.push(m);

function versionsOf(text, asset) {
  const re = new RegExp(asset.replace(/[.]/g, "\\.") + "\\?v=(\\d+)", "g");
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))];
}

// 1. head-boot.js's own version must equal the stylesheet it loads.
const bootOwn = versionsOf(index, "head-boot.js");
const cssInsideBoot = versionsOf(boot, "styles.min.css");

if (bootOwn.length !== 1) note(`index.html references head-boot.js at ${bootOwn.length} versions: ${bootOwn.join(", ")}`);
if (cssInsideBoot.length !== 1) note(`head-boot.js requests styles.min.css at ${cssInsideBoot.length} versions: ${cssInsideBoot.join(", ")}`);
if (bootOwn.length === 1 && cssInsideBoot.length === 1 && bootOwn[0] !== cssInsideBoot[0]) {
  note(
    `head-boot.js is served as v${bootOwn[0]} but requests styles.min.css v${cssInsideBoot[0]}.\n` +
    `      A browser holding the cached v${bootOwn[0]} loader will keep fetching the OLD stylesheet.\n` +
    `      Bump head-boot.js's own query whenever the stylesheet version moves.`
  );
}

// 2. every versioned asset must agree across index.html and the precache list.
for (const asset of ["styles.min.css", "app.min.js", "head-boot.js"]) {
  const a = versionsOf(index, asset);
  const b = versionsOf(sw, asset);
  if (!a.length || !b.length) { note(`${asset} is missing a version in index.html or the service worker`); continue; }
  if (a[0] !== b[0]) note(`${asset}: index.html has v${a[0]} but the service-worker precache has v${b[0]}`);
}

// 3. the service-worker cache name must move too, or an installed PWA keeps
//    serving every old file regardless of the queries above.
const cacheName = (sw.match(/CACHE_NAME\s*=\s*"([^"]+)"/) || [])[1];
if (!cacheName) note("service-worker.js has no CACHE_NAME");
else {
  const v = (cacheName.match(/v(\d+)/) || [])[1];
  const css = versionsOf(index, "styles.min.css")[0];
  if (v && css && v !== css) {
    note(`CACHE_NAME is "${cacheName}" (v${v}) but assets are at v${css}.\n` +
         `      An installed PWA is served by its worker; without a new cache name it keeps the old files.`);
  }
}

if (failures.length) {
  console.error("ASSET VERSION CONSISTENCY: FAILED\n");
  for (const f of failures) console.error("  - " + f);
  console.error("");
  process.exit(1);
}

const v = versionsOf(index, "styles.min.css")[0];
console.log(`ASSET VERSION CONSISTENCY: OK - loader, stylesheet, app bundle and cache name all at v${v}`);
