// A sandbox stand-in for the rules in hr/.htaccess.
//
// The portal routes on the path (/recruitment, /employees/42), and production
// Apache rewrites every miss to index.html. python -m http.server does not, so
// reloading any route answered 404 and the test saw a broken portal that works
// perfectly when deployed. This mirrors the two rules that matter: root assets
// requested from a nested route, and the SPA fallback.
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "hrserve");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".css": "text/css" };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(ROOT, url);
  const rootAsset = url.match(/\/(hr-session\.js|titopay-logo\.png|favicon\.ico)$/);
  if (rootAsset && !fs.existsSync(file)) file = path.join(ROOT, rootAsset[1]);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  const body = fs.readFileSync(file);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store" });
  res.end(body);
}).listen(8030, "127.0.0.1", () => console.log("hrserve on 8030 with SPA fallback"));
