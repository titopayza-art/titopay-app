// Syntax gate: server code as CommonJS, browser code as ES modules.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
let failed = 0;
for (const f of [path.join(root, "server.js"), ...walk(path.join(root, "src")), ...walk(path.join(root, "tests"))].filter((f) => f.endsWith(".js"))) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch (e) { failed++; console.error(String(e.stderr)); }
}
for (const f of walk(path.join(root, "public")).filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"))) {
  const src = fs.readFileSync(f, "utf8");
  try { execFileSync(process.execPath, ["--input-type=module", "--check"], { input: src, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { if (f.endsWith("sw.js")) { try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); continue; } catch { /* fallthrough */ } } failed++; console.error(f, String(e.stderr)); }
}
if (failed) { console.error(`${failed} file(s) failed the syntax check`); process.exit(1); }
console.log("syntax ok");
