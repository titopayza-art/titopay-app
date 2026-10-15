// Builds ticketroom.zip for Afrihost cPanel hosting. The zip is extracted
// INSIDE public_html, so its root is exactly what public_html should contain:
//   index.html, holding/   "Launching soon" page
//   .htaccess              no folder listings; blocks private files and /ticketroom-app
//   ticketroom-app/        the Node.js app (own deny-all .htaccess; setup guide inside)
// Usage: node scripts/build-afrihost.js [output.zip]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "..", "ticketroom.zip"));
const STAGE = path.join(ROOT, "var", "afrihost-build");
const APP = path.join(STAGE, "ticketroom-app");

const INCLUDE = ["server.js", "src", "public", "docs", "scripts/run-jobs.js", "scripts/check-syntax.js", "README.md", "package.json"];
const SKIP = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.DS_Store$/, /src\/db\/seed\.js$/];

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else if (!SKIP.some((re) => re.test(src))) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
for (const item of INCLUDE) copy(path.join(ROOT, item), path.join(APP, item));
copy(path.join(ROOT, "deploy", "afrihost", "public_html"), STAGE);
fs.copyFileSync(path.join(ROOT, "deploy", "afrihost", "AFRIHOST-SETUP.html"), path.join(APP, "AFRIHOST-SETUP.html"));
fs.copyFileSync(path.join(ROOT, "deploy", "afrihost", "README-FIRST.txt"), path.join(APP, "README-FIRST.txt"));
fs.copyFileSync(path.join(ROOT, "deploy", "afrihost", "env.afrihost"), path.join(APP, ".env.example"));
fs.copyFileSync(path.join(ROOT, "deploy", "afrihost", "app-htaccess"), path.join(APP, ".htaccess"));

// Runtime-only package.json: cPanel's "Run NPM Install" must not pull test tooling.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
delete pkg.devDependencies;
pkg.scripts = { start: "node server.js", migrate: "node src/db/migrate.js up", jobs: "node scripts/run-jobs.js", check: "node scripts/check-syntax.js" };
pkg.engines = { node: ">=20" };
fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit" });
// check-syntax walks tests/ too; the package has none.
fs.mkdirSync(path.join(APP, "tests"), { recursive: true });
fs.writeFileSync(path.join(APP, "tests", ".keep"), "");

// Normalise permissions: directories 755, files 644 (web servers cannot read 600 files).
(function perms(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { fs.chmodSync(p, 0o755); for (const f of fs.readdirSync(p)) perms(path.join(p, f)); }
  else fs.chmodSync(p, 0o644);
})(STAGE);

fs.rmSync(OUT, { force: true });
execFileSync("python3", ["-c", `
import os, sys, time, zipfile
stage, out = sys.argv[1], sys.argv[2]
now = time.localtime()[:6]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for base, dirs, files in os.walk(stage):
        dirs.sort()
        rel = os.path.relpath(base, stage)
        if rel != ".":
            zi = zipfile.ZipInfo(rel + "/", date_time=now); zi.external_attr = (0o40755 << 16) | 0x10; z.writestr(zi, "")
        for f in sorted(files):
            full = os.path.join(base, f); arc = os.path.relpath(full, stage)
            zi = zipfile.ZipInfo(arc, date_time=now); zi.external_attr = (0o100644 << 16); zi.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh: z.writestr(zi, fh.read())
`, STAGE, OUT]);
console.log(`Built ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
