// Regenerates the endpoint table in docs/API.md from the route files.
const fs = require("fs");
const path = require("path");
const mounts = { "auth.js": "/api/auth", "public.js": "/api/public", "account.js": "/api/me", "organiser.js": "/api/organiser", "staff.js": "/api/staff", "pos.js": "/api/pos", "admin.js": "/api/admin", "webhooks.js": "/api/webhooks" };
const access = {
  "auth.js": "public / session", "public.js": "public (orders: session)", "account.js": "session (attendee)", "organiser.js": "session + organiser member role",
  "staff.js": "session + event staff / organiser owner|manager / admin|support", "pos.js": "session + vendor member (+ X-Terminal-Key for sales)", "admin.js": "platform role (admin | finance | support)", "webhooks.js": "provider signature",
};
let out = "| Method | Path | Access | Role / note |\n|---|---|---|---|\n";
for (const [file, prefix] of Object.entries(mounts)) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", file), "utf8");
  for (const m of src.matchAll(/^(?:router|sim)\.(get|post|patch|put|delete)\("([^"]+)",\s*([A-Z_]+,)?/gm)) {
    const role = m[3] ? m[3].replace(",", "") : "";
    out += `| ${m[1].toUpperCase()} | \`${prefix}${m[2] === "/" ? "" : m[2]}\` | ${access[file]} | ${role} |\n`;
  }
}
const doc = path.join(__dirname, "..", "docs", "API.md");
const cur = fs.readFileSync(doc, "utf8");
fs.writeFileSync(doc, cur.replace(/<!-- endpoints -->[\s\S]*<!-- \/endpoints -->/, `<!-- endpoints -->\n${out}<!-- /endpoints -->`));
console.log(`${out.split("\n").length - 3} endpoints written`);
