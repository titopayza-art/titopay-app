// Builds the PHP edition: var/php-build/public_html (the exact contents of the
// zip) and, with --zip, ticketroom.zip. The zip is extracted INSIDE public_html.
//   zip root: index.php, .htaccess, assets/, sw.js, manifest.webmanifest,
//             tr-app/ (PHP code, page templates, setup code — web access denied)
// Usage: node scripts/build-php.js [--zip [output.zip]] [--setup-code CODE]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "var", "php-build", "public_html");
const args = process.argv.slice(2);
const zipIdx = args.indexOf("--zip");
const codeIdx = args.indexOf("--setup-code");
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const setupCode = codeIdx >= 0 ? args[codeIdx + 1] : Array.from(crypto.randomBytes(12), (b) => ALPHABET[b % 30]).join("");

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f)); }
  else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}

fs.rmSync(path.dirname(OUT_DIR), { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
copy(path.join(ROOT, "php", "public"), OUT_DIR);
copy(path.join(ROOT, "public", "assets"), path.join(OUT_DIR, "assets"));
for (const f of ["sw.js", "manifest.webmanifest"]) fs.copyFileSync(path.join(ROOT, "public", f), path.join(OUT_DIR, f));
const APP = path.join(OUT_DIR, "tr-app");
for (const item of ["bootstrap.php", "setup.php", "cron.php", "schema.sql", "kb-defaults.json", "lib", "routes"]) copy(path.join(ROOT, "php", "app", item), path.join(APP, item));
fs.copyFileSync(path.join(ROOT, "php", "app", "app-htaccess"), path.join(APP, ".htaccess"));
fs.mkdirSync(path.join(APP, "pages"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "public")).filter((x) => x.endsWith(".html"))) fs.copyFileSync(path.join(ROOT, "public", f), path.join(APP, "pages", f));
fs.writeFileSync(path.join(APP, "setup-code.txt"), setupCode + "\n");
fs.writeFileSync(path.join(APP, "README.txt"), fs.readFileSync(path.join(ROOT, "php", "README-AFRIHOST.txt"), "utf8").replace("{{SETUP_CODE}}", setupCode));

(function perms(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { fs.chmodSync(p, 0o755); for (const f of fs.readdirSync(p)) perms(path.join(p, f)); }
  else fs.chmodSync(p, 0o644);
})(OUT_DIR);

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
`, OUT_DIR, out]);
  console.log(`Built ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(`Staged ${OUT_DIR}`);
console.log(`Setup code: ${setupCode}`);
