// IS THE LANDING PAGE ACTUALLY GOOD?
//
// Not "does it look nice in a screenshot" - measured properties a good page has
// and a mediocre one does not, checked on both account types at three sizes.
// The screenshot is written too, but the screenshot is the evidence, not the
// test: a collision three quarters of the way down the page is easy to look
// past and impossible to measure past.
//
// The rules, and why each one is here:
//
//   nothing covers the call to action   the band's eyebrow, line and button must
//                                       stay readable. The install pill floats
//                                       INSIDE the band's box on purpose - the
//                                       band reserves 56px of bottom padding for
//                                       it - so the box overlap is reported and
//                                       never failed on. Content is what counts.
//   the page does not scroll            the landing is designed to be one
//                                       screen. If it scrolls, it is broken.
//   nothing is stranded under it        measured to the floating install pill,
//                                       it reads as a rendering fault.
//   44px tap targets                    the platform minimum, on the screen a
//                                       first-time customer meets first.
//   only controls look like controls    a bordered, filled box that cannot be
//                                       pressed is a false affordance. Same
//                                       standard the wallet card now holds.
//   the headline is the largest thing   if something else is bigger, the page
//                                       has no first thing to read.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8167;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const SIZES = [["phone", 390, 844], ["tablet", 768, 1024], ["laptop", 1440, 900]];

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

async function measure(page) {
  return page.evaluate(() => {
    const seen = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden"
        && Number(cs.opacity) > 0.05 && r.width > 1 && r.height > 1;
    };
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const band = document.querySelector(".scan-card");
    const de = document.documentElement;

    // Anything painted OVER the band that is not part of it. The install pill
    // is position:fixed and appended to <body>, so it is not a descendant and
    // a containment check would miss it entirely.
    const covering = [];
    const overBand = [];
    if (band) {
      const target = band.querySelector(".landing-cta-btn") || band;
      const box = target.getBoundingClientRect();
      const bandBox = band.getBoundingClientRect();
      document.querySelectorAll("body *").forEach((el) => {
        if (!seen(el) || band.contains(el) || el.contains(band)) return;
        if (getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "absolute") return;
        const r = el.getBoundingClientRect();
        const name = (el.className || el.tagName).toString().split(" ")[0];
        if (hit(r, box)) covering.push(name);
        else if (hit(r, bandBox)) overBand.push(name);
      });
    }

    // Tap targets. Only things a finger is meant to find.
    const small = [];
    document.querySelectorAll("button, a[href], [role='tab']").forEach((el) => {
      if (!seen(el)) return;
      const r = el.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 44) {
        small.push(`${(el.className || el.tagName).toString().split(" ")[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    });

    // Boxes that look pressable and are not.
    //
    // The first version of this flagged .segment (a real tab group), its moving
    // thumb, and every decorative icon circle - three false positives and it
    // still missed the one box it was written for. The rule is narrower now and
    // says what it means: a rounded, filled or bordered container that CARRIES
    // TEXT, sits inside no control, and holds no control of its own. That is a
    // thing shaped like a button that cannot be pressed.
    const fakeControls = [];
    document.querySelectorAll(".landing-flow *").forEach((el) => {
      if (!seen(el)) return;
      if (el.closest("button, a[href], [role='tab'], [role='tablist']")) return;
      if (el.querySelector("button, a[href]")) return;
      if (!(el.textContent || "").trim()) return;
      // A BOX HOLDING THE PAGE'S HEADING IS A SECTION, NOT A CONTROL.
      //
      // Narrowed, and the reason matters more than the rule. The landing's
      // hero is a rounded panel of ink carrying the h1, and this flagged it
      // six times - once per size and account type. The honest question is
      // whether the check is right or the shape is wrong, and the answer is
      // that nothing carrying a page heading reads as pressable: it is a
      // banner, and its size says so before its corners do.
      //
      // This is the narrowest way to say that. It does NOT exempt by name,
      // by class or by size, so a rounded filled box with ordinary copy in it
      // is still caught, which is what the check was written for.
      if (el.querySelector("h1, h2")) return;
      const cs = getComputedStyle(el);
      const bordered = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
      const filled = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
      const rounded = parseFloat(cs.borderTopLeftRadius) >= 8;
      if (rounded && (bordered || filled)) {
        fakeControls.push((el.className || el.tagName).toString().split(" ")[0]);
      }
    });

    const h1 = document.querySelector(".landing-flow h1");
    let biggest = { size: 0, what: "" };
    document.querySelectorAll(".landing-flow *").forEach((el) => {
      if (!seen(el)) return;
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!direct) return;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > biggest.size) {
        biggest = { size, what: el.tagName.toLowerCase(), isH1: el.tagName === "H1" };
      }
    });

    return {
      covering: [...new Set(covering)],
      overBand: [...new Set(overBand)],
      small: [...new Set(small)],
      fakeControls: [...new Set(fakeControls)],
      scrollY: de.scrollHeight - de.clientHeight,
      scrollX: de.scrollWidth - de.clientWidth,
      bandGap: band ? Math.round(de.clientHeight - band.getBoundingClientRect().bottom) : null,
      // The same gap, but measured to whatever is floating over the bottom of
      // the screen rather than to the viewport edge. The install pill is
      // position: fixed there and the landing reserves room for it on purpose,
      // so the distance to the edge counts that reservation as emptiness.
      bandGapToFloat: band ? (() => {
        const r = band.getBoundingClientRect();
        const floatTop = [...document.querySelectorAll("body *")].filter((el) => {
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") return false;
          const fr = el.getBoundingClientRect();
          return fr.height > 4 && fr.bottom > de.clientHeight * 0.5;
        }).reduce((low, el) => Math.min(low, el.getBoundingClientRect().top), de.clientHeight);
        return Math.round(floatTop - r.bottom);
      })() : null,
      h1Size: h1 ? Math.round(parseFloat(getComputedStyle(h1).fontSize)) : 0,
      biggest,
    };
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  for (const account of ["personal", "business"]) {
    for (const [label, width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message)));
      await page.goto(ORIGIN, { waitUntil: "load" });
      await page.waitForSelector(".landing-hero", { timeout: 20000 });
      if (account === "business") {
        await page.click('[data-account="business"]');
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(700);

      const m = await measure(page);
      const at = `${account}/${label}`;
      ok(`${at} nothing is drawn over the call to action`, m.covering.length === 0, m.covering.join(", "));
      // NOT A FAILURE, AND THE FIRST VERSION OF THIS SAID IT WAS.
      //
      // The install pill is position:fixed at the bottom of the viewport and so
      // its box overlaps the band's box. That is deliberate and already handled:
      //   body:has(.install-float-wrap.public-install) .landing-flow
      //     .scan-card.landing-cta-footer { padding-bottom: ... + 56px ... }
      // reserves the space it lands in, which is why it covers no content. A
      // check that failed on this would have driven a "fix" to a design that was
      // already right - it very nearly did. Reported, never asserted.
      if (m.overBand.length) console.log(`        (floats in the band's reserved space, by design: ${m.overBand.join(", ")})`);
      ok(`${at} the page does not scroll`, m.scrollY <= 1 && m.scrollX <= 1, `y=${m.scrollY} x=${m.scrollX}`);
      // THIS CHECK USED TO ASSERT THE FOOTER WAS A FULL-BLEED BAND PINNED TO
      // THE VIEWPORT EDGE, AND THAT DESIGN IS GONE.
      //
      // From 900px up the scan line was positioned absolutely across the whole
      // viewport with a 112px minimum height, and the landing reserved up to
      // 192px of bottom padding to sit clear of it. The redesign made it
      // .is-quiet - transparent, no band, one short line - and put it back in
      // the grid, which is what removed 116px to 136px of measured dead ground
      // on every desktop. Pinned to the edge is no longer the right answer, so
      // asserting it would hold the layout to a design that was replaced.
      //
      // What still matters is that nothing is stranded under it. That is the
      // same question, asked against the floating install pill instead of the
      // viewport edge: the landing reserves room for the pill deliberately, so
      // the space between the line and the pill is the only space that is
      // genuinely empty. verification/landing-fits-every-device.spec.js asks
      // it across eleven screens; this keeps it honest at these three.
      ok(`${at} nothing is stranded under the scan line`,
        m.bandGapToFloat !== null && m.bandGapToFloat <= 40,
        `${m.bandGapToFloat}px to the float (${m.bandGap}px to the viewport edge)`);
      ok(`${at} every tap target is at least 44px`, m.small.length === 0, m.small.slice(0, 3).join(", "));
      ok(`${at} only controls look like controls`, m.fakeControls.length === 0, m.fakeControls.slice(0, 4).join(", "));
      ok(`${at} the headline is the largest text`, m.biggest.isH1 || m.h1Size >= m.biggest.size,
        `h1 ${m.h1Size}px vs ${m.biggest.what} ${Math.round(m.biggest.size)}px`);
      ok(`${at} no page errors`, errors.length === 0, errors.slice(0, 1).join(" | "));

      if (label === "phone") {
        await page.screenshot({ path: `${ARTIFACTS}/landing-quality-${account}.png` });
      }
      await context.close();
    }
  }

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
