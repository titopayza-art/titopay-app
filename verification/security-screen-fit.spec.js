"use strict";

/* THE SECURITY SCREEN FITS THE SCREEN, ON EVERY DEVICE.
 *
 * This dialog opens uninvited after every sign-in, so it is the one screen that
 * must never arrive as a scroll. It was 1057px tall on a desktop and 1438px on
 * a 320px phone against 568px of room; every device scrolled.
 *
 * Twenty-four viewports, from a folded Galaxy at 280px wide to an ultrawide,
 * with phones in both orientations. For each one this asserts:
 *   - the backdrop does not scroll,
 *   - the card does not scroll,
 *   - the tips area does not scroll,
 *   - and the acknowledge button is fully inside the viewport.
 *
 * Two ways this measurement was wrong before it was right, both guarded below:
 * the service worker served the PREVIOUS stylesheet, so CSS edits looked inert;
 * and measuring during the modal's entrance animation read its 6px transform as
 * layout overflow and called a settled screen broken.
 *
 * Serve the PWA first:  python3 -m http.server 8099 --directory pwa
 * Run: node verification/security-screen-fit.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");
const DEVICES = [
  ["iPhone SE 1", 320, 568], ["small Android", 360, 640], ["iPhone SE 2/3", 375, 667],
  ["iPhone 14", 390, 844], ["iPhone 11 Pro Max", 414, 896], ["iPhone 15 Pro Max", 430, 932],
  ["Galaxy S22", 360, 780], ["Pixel 7", 412, 915], ["phone landscape", 740, 360],
  ["iPad portrait", 768, 1024], ["iPad landscape", 1024, 768], ["desktop", 1440, 900],
  // A wider net, including the awkward in-between sizes and the extremes.
  ["Galaxy Fold shut", 280, 653], ["iPhone 12 mini", 375, 812], ["Galaxy A", 412, 869],
  ["Nokia small", 360, 592], ["iPhone SE landscape", 667, 375], ["iPhone 14 landscape", 844, 390],
  ["iPad mini", 744, 1133], ["iPad Pro portrait", 1024, 1366], ["Surface", 912, 1368],
  ["laptop 768 tall", 1366, 768], ["laptop short", 1280, 600], ["ultrawide", 2560, 1080],
];
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  console.log("device                viewport   page  card  body-needs/has  button   verdict");
  const rows = [];
  for (const [name, w, h] of DEVICES) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: "block" }); const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:8099/", { waitUntil: "networkidle" });
    await p.evaluate(() => showSecurityTipModal());
    await p.waitForSelector(".security-screen", { timeout: 5000 });
    // The card slides in on open. Measuring mid-animation reports a transform
    // offset as layout overflow, which is how a settled screen looked broken.
    await p.waitForFunction(() => {
      const t = getComputedStyle(document.querySelector(".modal-card")).transform;
      if (t === "none") return true;
      const m = t.match(/matrix\(([^)]+)\)/);
      return m ? Math.abs(parseFloat(m[1].split(",")[5])) < 0.5 : true;
    }, null, { timeout: 5000 });
    const m = await p.evaluate(() => {
      const back = document.querySelector(".modal-backdrop");
      const card = document.querySelector(".modal-card");
      const body = document.querySelector(".security-screen-body");
      const btn = document.querySelector(".security-screen > .btn.primary");
      const r = btn.getBoundingClientRect();
      return {
        pageScrolls: back.scrollHeight > back.clientHeight + 1,
        cardScrolls: card.scrollHeight > card.clientHeight + 1,
        bodyNeeds: body.scrollHeight, bodyHas: body.clientHeight,
        buttonFully: r.top >= 0 && r.bottom <= window.innerHeight + 1,
        parts: {
          head: document.querySelector(".security-screen .modal-head").getBoundingClientRect().height,
          warn: document.querySelector(".security-screen .security-tip-card").getBoundingClientRect().height,
          tips: document.querySelector(".security-screen .activity-list").getBoundingClientRect().height,
          btn: r.height,
        },
      };
    });
    const bodyScrolls = m.bodyNeeds > m.bodyHas + 1;
    const verdict = (!m.pageScrolls && !m.cardScrolls && !bodyScrolls && m.buttonFully) ? "NO SCROLL"
      : (m.buttonFully && !m.pageScrolls && !m.cardScrolls) ? `tips scroll +${m.bodyNeeds - m.bodyHas}` : "BROKEN";
    rows.push({ name, verdict, parts: m.parts, w, h });
    console.log(`${name.padEnd(20)} ${String(w+"x"+h).padEnd(10)} ${String(m.pageScrolls).padEnd(5)} ${String(m.cardScrolls).padEnd(5)} ${String(m.bodyNeeds+"/"+m.bodyHas).padEnd(15)} ${String(m.buttonFully).padEnd(8)} ${verdict}`);
    await ctx.close();
  }
  const clean = rows.filter((r) => r.verdict === "NO SCROLL").length;
  const bad = rows.filter((r) => r.verdict !== "NO SCROLL");
  console.log(`\n  ${clean}/${rows.length} viewports show the whole screen with no scrolling anywhere`);
  await b.close();
  if (bad.length) {
    console.error("\n  FAIL  these viewports still scroll:");
    for (const r of bad) console.error(`    ${r.name} ${r.w}x${r.h}: ${r.verdict}`);
    process.exit(1);
  }
})();
