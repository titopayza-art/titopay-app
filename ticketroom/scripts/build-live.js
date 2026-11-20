// Builds ticketroom.zip from live/public_html, the package that runs on
// ticketroom.co.za. Every file is shipped as it is; only the build name
// (version.txt, page comments, ?build= links, the service worker cache) is
// stamped fresh so browsers and the deploy check pick up the new upload.
//
//   node scripts/build-live.js [--zip [output.zip]]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "live", "public_html");
const OUT = path.join(ROOT, "var", "live-build", "public_html");
const args = process.argv.slice(2);
const zipIdx = args.indexOf("--zip");

const current = fs.readFileSync(path.join(SRC, "version.txt"), "utf8").match(/build (\S+)/)[1];
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const BUILD = process.env.TR_BUILD || `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const TEXT = /\.(html|js|css|php|txt|md|json|webmanifest|htaccess|sql)$|^\.htaccess$/;

// The MySQL schema must match schema.sql (scripts/mysql-schema.php writes it).
execFileSync("php", [path.join(__dirname, "mysql-schema.php"), "--check"], { stdio: ["ignore", "ignore", "inherit"] });

fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
(function copy(src, dst) {
  if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dst, { recursive: true }); fs.chmodSync(dst, 0o755); for (const f of fs.readdirSync(src).sort()) copy(path.join(src, f), path.join(dst, f)); return; }
  if (TEXT.test(path.basename(src))) fs.writeFileSync(dst, fs.readFileSync(src, "utf8").split(current).join(BUILD));
  else fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o644);
})(SRC, OUT);

if (zipIdx >= 0) {
  const out = path.resolve(args[zipIdx + 1] && !args[zipIdx + 1].startsWith("--") ? args[zipIdx + 1] : path.join(ROOT, "..", "ticketroom.zip"));
  fs.rmSync(out, { force: true });
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
`, OUT, out]);
  console.log(`Built ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(`Staged ${OUT}`);
console.log(`Build ${BUILD} (from ${current})`);
