// DOES THE EVENT CARD COVER THE ORGANISER'S POSTER?
//
// The card used to draw three things ON the artwork: a date badge top-left, a
// category pill bottom-left, a status pill bottom-right. Event posters are
// designed full-bleed and put their logo top-left and their time/venue strip
// bottom-left, so the two collided exactly. A customer's screenshot showed the
// badge sitting over "TitoPay" and the category pill over "11am, Sandton".
//
// This harness renders the card with the SHIPPED stylesheet and measures the
// overlap geometrically rather than by eye: it draws the poster's own hot
// zones as elements, then asserts that no card chrome intersects them. It also
// renders the previous markup beside the new one, so the screenshot is a real
// before-and-after rather than an assertion that something looks better.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });

const PWA = path.join(__dirname, "..", "pwa");
const PORT = 8151;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A stand-in poster with the zones a real event poster uses, drawn rather than
// borrowed: the logo lock-up top-left, the time/venue/date strip bottom-left,
// the terms column right. Labelled as a stand-in so nobody mistakes the
// screenshot for the customer's own artwork.
const POSTER = `
  <div class="probe-poster">
    <div class="pz pz-logo" data-hot="logo">titoPay<small>Smart Payments. Simplified.</small></div>
    <div class="pz pz-strip" data-hot="strip">11am to 5pm &nbsp;·&nbsp; TitoPay HQ, Sandton &nbsp;·&nbsp; 20 November 2026</div>
    <div class="pz pz-terms">T&amp;Cs<br>1. The launch takes place on<br>20 November 2026, 11am to 5pm.<br>2. Attendance is subject to<br>available capacity.</div>
    <div class="pz pz-note">stand-in poster</div>
  </div>`;

const CARD = (variant) => `
  <article class="event-card">
    <button class="event-card-open" type="button">
      <div class="event-poster" style="position:relative">
        ${POSTER}
        ${variant === "before" ? `
          <span class="event-date-badge legacy" aria-hidden="true"><span>NOV</span><strong>20</strong></span>
          <span class="event-category-pill legacy">Conferences &amp; Business</span>
          <span class="event-status-pill is-scarce legacy">9 left</span>` : ""}
      </div>
      <div class="event-card-body">
        <h3 class="event-card-title">TitoPay Launch</h3>
        <p class="event-card-line">Fri, 20 November 2026 · 11:00</p>
        <p class="event-card-line">TitoPay Headquarters, Johannesburg</p>
        ${variant === "before"
          ? `<p class="event-card-price">Free entry</p>`
          : `<p class="event-card-meta">
               <span class="event-card-price">Free entry</span>
               <span class="event-card-flags">
                 <span class="event-status-pill is-scarce">9 left</span>
                 <span class="event-category-pill">Conferences &amp; Business</span>
               </span>
             </p>`}
      </div>
    </button>
    <div class="event-card-actions">
      <button class="btn secondary event-card-cta" type="button">Get tickets</button>
    </div>
  </article>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.min.css">
<style>
  body{margin:0;padding:22px;background:#f4f7fd;font-family:system-ui,sans-serif}
  .rig{display:grid;grid-template-columns:1fr 1fr;gap:22px;max-width:900px;margin:0 auto}
  .col h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#62708a;margin:0 0 10px}
  .col.after h2{color:#14633c}
  /* The legacy overlays, reproduced here only so the "before" column is real.
     They are not in the shipped stylesheet any more. */
  .event-date-badge.legacy{position:absolute;top:12px;left:12px;display:grid;place-items:center;
    min-width:52px;padding:7px 9px;border-radius:14px;background:rgba(255,255,255,.86);
    box-shadow:0 2px 10px rgba(11,31,63,.18)}
  .event-date-badge.legacy span{color:#0a4dff;font-size:.62rem;font-weight:800;letter-spacing:.08em}
  .event-date-badge.legacy strong{color:#0b1f3f;font-size:1.15rem;font-weight:800;line-height:1.1}
  .event-category-pill.legacy{position:absolute;bottom:12px;left:12px;background:rgba(6,26,61,.72);
    color:#fff;max-width:calc(100% - 24px)}
  .event-status-pill.legacy{position:absolute;bottom:12px;right:12px}
  /* The poster's own content, as zones we can measure. */
  .probe-poster{position:absolute;inset:0;background:linear-gradient(120deg,#eef4ff,#ffffff 55%,#e7efff);
    overflow:hidden}
  .pz{position:absolute;color:#0b1f3f}
  .pz-logo{top:7%;left:5%;font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1}
  .pz-logo small{display:block;font-size:9px;font-weight:600;color:#0a4dff;margin-top:4px;letter-spacing:0}
  .pz-strip{bottom:9%;left:5%;right:42%;font-size:10px;font-weight:700;color:#0a4dff;
    border-top:2px solid #cfe0ff;padding-top:6px}
  .pz-terms{top:8%;right:4%;width:34%;font-size:7px;line-height:1.55;color:#41557a}
  .pz-note{bottom:3%;right:4%;font-size:7px;letter-spacing:.1em;text-transform:uppercase;color:#9fb0cc}
</style></head><body>
  <div class="rig">
    <div class="col"><h2>Before</h2>${CARD("before")}</div>
    <div class="col after"><h2>After</h2>${CARD("after")}</div>
  </div>
</body></html>`;

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  if (clean === "/" || clean === "/rig") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(PAGE);
  }
  const file = path.join(PWA, clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ": " + detail : ""}`);
};

const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 940, height: 640 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${ORIGIN}/rig`, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const measure = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
    const read = (col) => {
      const root = document.querySelector(`.col.${col}`);
      const poster = root.querySelector(".event-poster");
      const hot = [...root.querySelectorAll("[data-hot]")].map((el) => ({ name: el.dataset.hot, ...box(el) }));
      const chrome = [...root.querySelectorAll(".event-date-badge, .event-category-pill, .event-status-pill")]
        .map((el) => ({ name: el.className.split(" ")[0], ...box(el) }));
      return { poster: box(poster), hot, chrome };
    };
    return { before: read("col"), after: read("after") };
  });

  const clashes = (side) => {
    const out = [];
    for (const chrome of side.chrome) {
      // Only chrome that actually sits inside the poster can cover it.
      if (!overlaps(chrome, side.poster)) continue;
      for (const zone of side.hot) if (overlaps(chrome, zone)) out.push(`${chrome.name} over ${zone.name}`);
    }
    return out;
  };

  const before = clashes(measure.before);
  const after = clashes(measure.after);
  console.log(`  before: ${before.length ? before.join(", ") : "none"}`);
  console.log(`  after:  ${after.length ? after.join(", ") : "none"}`);

  // The harness has to be able to SEE the defect, or its clean result proves
  // nothing. The old markup must clash; the new markup must not.
  ok("the previous card really did cover the poster", before.length >= 2, `${before.length} overlaps`);
  ok("NOTHING covers the poster any more", after.length === 0, after.join(", "));

  const inPoster = measure.after.chrome.filter((c) => overlaps(c, measure.after.poster));
  ok("no chip is drawn inside the poster at all", inPoster.length === 0,
    inPoster.map((c) => c.name).join(", "));
  ok("both chips still render, in the body",
    measure.after.chrome.length === 2, String(measure.after.chrome.length));
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: `${ARTIFACTS}/event-card-poster.png`, fullPage: true });
  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
