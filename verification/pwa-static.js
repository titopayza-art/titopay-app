// Serve the PWA with no-store, so a test always exercises what is on disk.
// python -m http.server sends Last-Modified and the browser reuses its cached
// copy, which quietly tested the previous build.
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "app");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store, must-revalidate" });
  res.end(fs.readFileSync(file));
}).listen(8010, "127.0.0.1", () => console.log("pwa on 8010, no-store"));
