// DOES THE LANDING FIT, ON EVERY SCREEN, WITH NO DEAD GROUND?
//
// The landing is "fit by construction": .landing-flow is a grid with
// min-height:100dvh, and body.landing-static gives it height:100dvh,
// overflow:hidden and ONE flexible row, so the page cannot scroll and the
// hero takes up whatever is left over. That construction is easy to break
// from a distance - add a section, change a row template, and one screen size
// grows four hundred pixels of nothing while every other one looks fine.
//
// So this measures, rather than looks. On each device, for both account
// types, it checks four things:
//
//   the page does not scroll, in either direction;
//   every control is fully inside the viewport;
//   the hero panel holds a sensible share of the screen - not collapsed to a
//     strip, not pushing everything else off;
//   and there is no DEAD GROUND: no gap between consecutive sections, or
//     below the last one, big enough to read as a mistake.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/landing-fits-every-device.spec.js

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

// Real handsets, the two ends of the tablet range, and two desktops. The
// short ones matter most: a 640px Android is where a layout built on a 852px
// phone falls apart.
const DEVICES = [
  { name: "Android small",    w: 360, h: 640, touch: true },
  { name: "Galaxy S8",        w: 360, h: 740, touch: true },
  { name: "iPhone SE",        w: 375, h: 667, touch: true },
  { name: "iPhone 13 mini",   w: 375, h: 812, touch: true },
  { name: "iPhone 15",        w: 393, h: 852, touch: true },
  { name: "Pixel 7",          w: 412, h: 915, touch: true },
  { name: "iPhone 15 Pro Max",w: 430, h: 932, touch: true },
  { name: "iPad mini",        w: 768, h: 1024, touch: true },
  { name: "iPad Pro",         w: 1024, h: 1366, touch: true },
  { name: "Laptop",           w: 1280, h: 800, touch: false },
  { name: "Desktop",          w: 1440, h: 900, touch: false }
];

// A gap bigger than this between sections, or under the last one, is the
// "funky empty space" this file exists to catch. Generous enough that ordinary
// breathing room passes.
const DEAD_GROUND = 90;

let bad = 0;
const fail = (device, account, what, detail) => {
  bad += 1;
  console.log(`  FAIL  ${device} · ${account} · ${what}${detail ? " - " + detail : ""}`);
};

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(PWA_ROOT, file);
    if (!resolved.startsWith(PWA_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
  console.log("\n=============================================================");
  console.log("  THE LANDING, MEASURED ON EVERY SCREEN");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    for (const device of DEVICES) {
      const context = await browser.newContext({
        viewport: { width: device.w, height: device.h },
        isMobile: device.touch, hasTouch: device.touch, deviceScaleFactor: 2
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
      await page.waitForSelector(".landing-hero-panel", { timeout: 15000 });
      await page.waitForTimeout(500);

      for (const account of ["personal", "business"]) {
        if (account === "business") {
          const switched = await page.evaluate(() => {
            const tab = document.querySelector('[data-account="business"]');
            if (!tab) return false;
            tab.click();
            return true;
          });
          if (!switched) { fail(device.name, account, "there is no Business tab to switch to"); continue; }
          await page.waitForTimeout(650);
        }

        const m = await page.evaluate(() => {
          const flow = document.querySelector(".landing-flow");
          const panel = document.querySelector(".landing-hero-panel");
          if (!flow || !panel) return null;
          const vh = window.innerHeight;
          const vw = window.innerWidth;
          const visible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== "none" && cs.visibility !== "hidden"
              && cs.position !== "fixed" && r.width > 1 && r.height > 1;
          };
          // The landing's own sections, in the order they are painted.
          const sections = [...flow.children].filter(visible)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { tag: el.tagName.toLowerCase(), cls: el.className.toString().split(/\s+/)[0] || "",
                top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
            })
            .sort((a, b) => a.top - b.top);

          const gaps = [];
          for (let i = 1; i < sections.length; i += 1) {
            gaps.push({ between: `${sections[i - 1].cls} -> ${sections[i].cls}`,
              size: sections[i].top - sections[i - 1].bottom });
          }
          // DEAD GROUND IS MEASURED TO THE FLOAT, NOT TO THE VIEWPORT.
          //
          // The install pill is position: fixed over the bottom of the page,
          // and the landing deliberately reserves room so the scan line does
          // not sit under it. Measuring to the viewport edge counts that
          // reservation as emptiness and reports a fault where there is a
          // floating element. What is actually empty is the space between the
          // last section and whatever is floating over the bottom of the
          // screen - so that is what gets measured.
          const floatTop = [...document.querySelectorAll("body *")]
            .filter((el) => {
              const cs = getComputedStyle(el);
              if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") return false;
              const r = el.getBoundingClientRect();
              return r.height > 4 && r.bottom > vh * 0.5;
            })
            .reduce((lowest, el) => Math.min(lowest, el.getBoundingClientRect().top), vh);
          const last = sections[sections.length - 1];
          const tail = last ? Math.round(floatTop - last.bottom) : 0;

          // Every control a customer is offered, and whether it is fully on screen.
          const controls = [...flow.querySelectorAll("button, a[href]")]
            .filter(visible)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { label: (el.innerText || el.getAttribute("aria-label") || "?").replace(/\s+/g, " ").trim().slice(0, 24),
                top: Math.round(r.top), bottom: Math.round(r.bottom),
                inside: r.top >= -1 && r.bottom <= vh + 1 && r.left >= -1 && r.right <= vw + 1 };
            });

          const panelRect = panel.getBoundingClientRect();
          return {
            vh, vw,
            pageScrollY: Math.round(document.documentElement.scrollHeight - vh),
            pageScrollX: Math.round(document.documentElement.scrollWidth - vw),
            panelShare: Math.round((panelRect.height / vh) * 100),
            panelHasPhoto: getComputedStyle(panel).backgroundImage.includes("landing-"),
            sections, gaps, tail,
            offscreen: controls.filter((c) => !c.inside)
          };
        });

        if (!m) { fail(device.name, account, "the landing did not render"); continue; }

        const problems = [];
        if (m.pageScrollY > 1) problems.push(`page scrolls ${m.pageScrollY}px vertically`);
        if (m.pageScrollX > 1) problems.push(`page scrolls ${m.pageScrollX}px sideways`);
        if (m.offscreen.length) problems.push(`off screen: ${m.offscreen.map((c) => `"${c.label}"`).join(", ")}`);
        if (m.tail > DEAD_GROUND) problems.push(`${m.tail}px of dead ground below the last section`);
        const bigGap = m.gaps.find((g) => g.size > DEAD_GROUND);
        if (bigGap) problems.push(`${bigGap.size}px gap ${bigGap.between}`);
        if (m.panelShare < 25) problems.push(`the hero panel is only ${m.panelShare}% of the screen`);
        if (m.panelShare > 80) problems.push(`the hero panel takes ${m.panelShare}% of the screen`);
        if (!m.panelHasPhoto) problems.push("the hero panel has no photograph");
        if (errors.length) problems.push(`script errors: ${errors.join(" | ")}`);

        if (problems.length) {
          problems.forEach((p) => fail(device.name, account, p));
        } else {
          console.log(`  PASS  ${device.name.padEnd(18)} ${String(device.w).padStart(4)}x${String(device.h).padEnd(4)} ${account.padEnd(8)} hero ${String(m.panelShare).padStart(2)}%  tail ${String(m.tail).padStart(3)}px`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(bad ? `\n  ${bad} problem(s)\n` : "\n  the landing fits every screen with no dead ground\n");
  process.exit(bad ? 1 : 0);
})();
