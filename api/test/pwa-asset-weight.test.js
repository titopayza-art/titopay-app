"use strict";

// EVERY BYTE IN THE APP SHELL IS PAID FOR BY A PHONE ON A MOBILE NETWORK.
//
// The service worker precaches the whole shell on install, and install runs on
// EVERY release. So an oversized image is not paid once — it is paid by every
// customer, every time anything ships. Measured cold on a mid-range Android
// over a busy 4G link, the app took 3.35 seconds to reach a typeable password
// field, and 59 KB of that was a two-colour logo stored as a full-colour PNG.
//
// Re-encoding the seven precached images took the set from 550 KB to 296 KB
// with no resizing and no visible difference on either theme. This test exists
// so it stays that way: a designer exporting a fresh logo from Illustrator at
// default settings would put 50 KB straight back, and nobody would notice until
// somebody complained the app was slow again.
//
// The budgets are deliberately loose - roughly double what each file is today.
// This is a guard against a file quietly tripling, not a demand that nobody
// ever touch the artwork.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "..", "pwa", "assets");
const PWA = path.join(__dirname, "..", "..", "pwa");

// name -> budget in KB.
const BUDGET = {
  "titopay-logo.png": 20,
  "titopay-logo-night.png": 14,
  "favicon.png": 8,
  "icon-192.png": 34,
  "icon-512.png": 190,
  "maskable-512.png": 165,
  "poster-app-screen.jpg": 185,
};

test("no precached image exceeds its weight budget", () => {
  const over = [];
  for (const [name, budgetKb] of Object.entries(BUDGET)) {
    const file = path.join(ASSETS, name);
    assert.ok(fs.existsSync(file), `${name} is missing from pwa/assets`);
    const kb = Math.round(fs.statSync(file).size / 1024);
    if (kb > budgetKb) over.push(`${name} is ${kb} KB, budget ${budgetKb} KB`);
  }
  assert.deepEqual(over, [],
    `re-encode before shipping - these are fetched by every phone on every release:\n  ${over.join("\n  ")}`);
});

test("THE LOGO ON THE CRITICAL PATH STAYS SMALL", () => {
  // index.html preloads this one with fetchpriority="high" ahead of everything
  // else, so its size is felt before any other image on the page. It is a flat
  // two-colour wordmark; there is no version of it that needs 50 KB.
  const kb = fs.statSync(path.join(ASSETS, "titopay-logo.png")).size / 1024;
  assert.ok(kb < 20, `titopay-logo.png is ${kb.toFixed(1)} KB and is preloaded at high priority`);

  const index = fs.readFileSync(path.join(PWA, "index.html"), "utf8");
  assert.match(index, /rel="preload"[^>]*titopay-logo\.png/,
    "the preload is what makes this file's size matter; if it goes, revisit the budget");
});

test("the shell's whole image payload stays under a quarter megabyte", () => {
  // The number that actually reaches a phone. Everything in BUDGET is in the
  // service worker's APP_SHELL, so this is one release's image cost.
  const total = Object.keys(BUDGET)
    .reduce((sum, name) => sum + fs.statSync(path.join(ASSETS, name)).size, 0);
  const kb = Math.round(total / 1024);
  assert.ok(kb < 350, `the precached images total ${kb} KB; they were 550 KB before re-encoding and 296 KB after`);
});

test("every image the service worker precaches actually exists", () => {
  // A miss no longer kills the whole install - each file is fetched on its own
  // - but it still silently costs that file from the offline shell.
  const worker = fs.readFileSync(path.join(PWA, "service-worker.js"), "utf8");
  const referenced = [...worker.matchAll(/"\.\/(assets\/[^"?]+)/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 5, "the app shell should list its images");
  for (const relative of referenced) {
    assert.ok(fs.existsSync(path.join(PWA, relative)), `${relative} is precached but not in the repo`);
  }
});

test("the images are still the size the layout expects", () => {
  // Re-encoding must never resize: index.html gives the logo explicit width and
  // height attributes, and a changed intrinsic size would shift the landing
  // screen on first paint.
  const index = fs.readFileSync(path.join(PWA, "index.html"), "utf8");
  const declared = index.match(/titopay-logo\.png"[^>]*width="(\d+)" height="(\d+)"/);
  assert.ok(declared, "index.html must keep explicit width/height on the logo");

  // PNG dimensions live at a fixed offset in the IHDR chunk - read directly,
  // so this test needs no image library.
  const buffer = fs.readFileSync(path.join(ASSETS, "titopay-logo.png"));
  assert.equal(buffer.readUInt32BE(16), Number(declared[1]), "logo width must match the markup");
  assert.equal(buffer.readUInt32BE(20), Number(declared[2]), "logo height must match the markup");
});
