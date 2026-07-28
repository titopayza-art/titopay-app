// The version appears in five places and a mismatch ships a build that serves
// stale cached assets. This has bitten this project before, so it is a gate.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const html = read("index.html");
const sw = read("service-worker.js");
const app = read("app.js");
const marker = read("DEPLOYMENT_BUILD_MARKER.txt");

const versions = new Set();
[...html.matchAll(/(?:styles\.css|app\.js|manifest\.webmanifest)\?v=(\d+)/g)].forEach((m) => versions.add(m[1]));
[...sw.matchAll(/(?:styles\.css|app\.js|manifest\.webmanifest|services-default\.json)\?v=(\d+)/g)].forEach((m) => versions.add(m[1]));
[...app.matchAll(/services-default\.json\?v=(\d+)/g)].forEach((m) => versions.add(m[1]));

const cacheName = (sw.match(/CACHE_NAME\s*=\s*"([^"]+)"/) || [])[1] || "";
const cacheVersion = (cacheName.match(/v(\d+)/) || [])[1];
const markerVersion = (marker.match(/v(\d+)/) || [])[1];

const problems = [];
if (versions.size !== 1) problems.push(`asset query versions disagree: ${[...versions].join(", ")}`);
const assetVersion = [...versions][0];
if (cacheVersion !== assetVersion) problems.push(`service worker cache is v${cacheVersion}, assets are v${assetVersion}`);
if (markerVersion !== assetVersion) problems.push(`build marker is v${markerVersion}, assets are v${assetVersion}`);

if (problems.length) {
  console.error("Version check failed:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}
console.log(`Version check passed: v${assetVersion} consistent across index.html, service-worker.js, app.js and the build marker.`);
