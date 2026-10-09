// Builds the Afrihost (PHP) package: var/php-build/public_html, which is
// exactly what goes inside public_html, and with --zip, ticketroom.zip.
//
//   public_html/
//     index.html, sell.html, help.html, …   the pages (plain files, clean URLs)
//     legal/                                 the legal documents
//     assets/                                styles, scripts, images
//     api/                                   the PHP that answers /api/ (never served as files)
//     data/                                  database, keys, uploads, your settings (locked)
//     index.php                              front door for hosts that route everything to PHP
//     deploy-check.php, set-password.php     locked tools (see START-HERE.txt)
//     version.txt, START-HERE.txt, DEPLOY-AFRIHOST.md
//
// The first administrator's temporary password is given at build time and
// only its hash goes into the package:
//   TR_ADMIN_PASSWORD='…' node scripts/build-php.js --zip [output.zip]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "var", "php-build", "public_html");
const args = process.argv.slice(2);
const zipIdx = args.indexOf("--zip");
const password = process.env.TR_ADMIN_PASSWORD || "";
if (password.length < 10) { console.error("Set TR_ADMIN_PASSWORD (at least 10 characters) to the administrator's temporary password."); process.exit(1); }
const hash = execFileSync("php", ["-r", "echo password_hash(getenv('TR_ADMIN_PASSWORD'), PASSWORD_DEFAULT);"], { env: { ...process.env, TR_ADMIN_PASSWORD: password } }).toString();
if (!hash.startsWith("$2y$")) throw new Error("Could not hash the admin password");

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const BUILD = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

function copy(src, dst) {
  if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f)); }
  else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}
const write = (rel, text) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- root files
for (const f of [".htaccess", "index.php", "deploy-check.php", "set-password.php", "START-HERE.txt", "DEPLOY-AFRIHOST.md", "robots.txt"]) copy(path.join(ROOT, "php", "public", f), path.join(OUT, f));
copy(path.join(ROOT, "php", "public", "data"), path.join(OUT, "data"));
write("version.txt", `TicketRoom build ${BUILD}\n`);
for (const f of ["sw.js", "manifest.webmanifest"]) copy(path.join(ROOT, "public", f), path.join(OUT, f));
copy(path.join(ROOT, "public", "assets"), path.join(OUT, "assets"));

// ---- pages: one file per address, each with its own title and description
const page = (template, title, description, canonical) => {
  let h = fs.readFileSync(path.join(ROOT, "public", template), "utf8");
  h = h.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  h = h.replace(/<html lang="en-ZA"( class="booting")?>\n/, (m) => `${m}<!-- TicketRoom build ${BUILD} -->\n`);
  if (description) h = /<meta name="description"/.test(h) ? h.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`) : h.replace("</title>", `</title>\n  <meta name="description" content="${esc(description)}">`);
  if (canonical) h = h.replace("</title>", `</title>\n  <link rel="canonical" href="https://ticketroom.co.za${canonical}">`);
  return h;
};
const PUBLIC = [
  ["index.html", "TicketRoom | Tickets for events across South Africa", "Find concerts, comedy, sport and festivals across South Africa, and keep your tickets on your phone.", "/"],
  ["event.html", "Event tickets | TicketRoom", "", ""],
  ["order.html", "Your order | TicketRoom", "", ""],
  ["sell.html", "Sell tickets | TicketRoom", "List your event on TicketRoom. Free events cost nothing to run; paid events carry a 5% commission.", "/sell"],
  ["advertise.html", "Advertise your business | TicketRoom", "Get a spot on TicketRoom from as little as R50 per day. Your poster in front of people planning their next event.", "/advertise"],
  ["subscribe.html", "Subscribe to updates | TicketRoom", "Be first to hear about new events, ticket releases and free shows near you.", "/subscribe"],
  ["help.html", "Help centre | TicketRoom", "Answers about tickets, transfers, refunds and events, and how to reach the TicketRoom team.", "/help"],
  ["contact.html", "Contact us | TicketRoom", "Email hello@ticketroom.co.za or ask us to call you back. We reply within 24 to 48 hours.", "/contact"],
  ["unsubscribe.html", "Unsubscribe | TicketRoom", "", ""],
  ["signin.html", "Sign in | TicketRoom", "", "/signin"],
  ["404.html", "Page not found | TicketRoom", "", ""],
];
for (const [file, title, desc, canon] of PUBLIC) write(file, page("index.html", title, desc, canon));
for (const [slug, title] of [["terms-of-use", "Terms of Use"], ["terms", "Terms and Conditions"], ["privacy", "Privacy Policy"], ["cookies", "Cookie Policy"], ["paia", "PAIA manual"]]) {
  write(`legal/${slug}.html`, page("index.html", `${title} | TicketRoom`, `TicketRoom ${title}. TicketRoom (Pty) Ltd, registration number 2026811077.`, `/legal/${slug}`));
}
// Portals keep their own page and title; /organisers is organisers.html.
for (const [file, out] of [["account.html", "account.html"], ["organiser.html", "organisers.html"], ["admin.html", "admin.html"], ["scan.html", "scan.html"], ["pos.html", "pos.html"]]) {
  const title = fs.readFileSync(path.join(ROOT, "public", file), "utf8").match(/<title>([^<]*)<\/title>/)[1];
  write(out, page(file, title, "", ""));
}

// ---- api/
const API = path.join(OUT, "api");
for (const item of ["index.php", "bootstrap.php", "cron.php", "schema.sql", "lib", "routes", ".htaccess"]) copy(path.join(ROOT, "php", "api", item), path.join(API, item));
const config = fs.readFileSync(path.join(ROOT, "php", "api", "config.php"), "utf8");
if (!config.includes("{{ADMIN_PASSWORD_HASH}}")) throw new Error("config.php placeholder missing");
fs.writeFileSync(path.join(API, "config.php"), config.replace("{{ADMIN_PASSWORD_HASH}}", hash));
// Assistant answers come from the shared knowledge base; features this edition
// does not have yet are answered as "coming soon".
const COMING_SOON = {
  "How do cashless wristbands work?": "Cashless wristbands are coming soon. When they arrive you'll be able to link a wristband to your account, top it up and pay vendors at the event with a tap.",
  "I lost my wristband": "Cashless wristbands aren't available yet. If you've lost something at an event, contact the organiser, or ask us to call you back and we'll help where we can.",
  "How do organisers get paid?": "Payouts start when paid ticket sales open. Organisers will be paid by EFT a few days after their event, less the 5% commission and any refunds. Free events don't involve any money.",
};
const kb = require(path.join(ROOT, "src", "modules", "site", "kb-defaults.js")).map((a) => (COMING_SOON[a.q] ? { ...a, a: COMING_SOON[a.q], cb: a.q === "I lost my wristband" } : a));
fs.writeFileSync(path.join(API, "kb-defaults.json"), JSON.stringify(kb, null, 1));

(function perms(p) {
  if (fs.statSync(p).isDirectory()) { fs.chmodSync(p, 0o755); for (const f of fs.readdirSync(p)) perms(path.join(p, f)); }
  else fs.chmodSync(p, 0o644);
})(OUT);

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
console.log(`Build ${BUILD}`);
