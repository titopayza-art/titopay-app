"use strict";

/* THE APP DOES NOT COMPETE WITH THE BROWSER'S EDGE GESTURE.
 *
 * iOS Safari reserves a strip down each side of the screen for its own back
 * and forward navigation, and it wins: `touch-action` does not govern a system
 * gesture. A swipe starting there became a page transition AND stepped the
 * landing screen from Personal to Business at the same time, so the app slid
 * sideways with a pale gap where the rest of it should have been.
 *
 *   1. A swipe from the middle still switches account type. The feature works.
 *   2. A swipe that starts in the left edge strip is declined.
 *   3. A swipe that starts in the right edge strip is declined.
 *   4. It is declined at the START of the gesture, so nothing half-happens.
 *   5. A mostly-vertical drag never switches, edge or not.
 *   6. The surface declares that it owns horizontal panning.
 *   7. The gutter is narrow enough that the screen is still swipeable.
 *
 * Serve the PWA first:  python3 -m http.server 8099 --directory pwa
 * Run: node verification/landing-swipe-edge.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const WIDTH = 390;
const HEIGHT = 844;

let passed = 0;
const check = (condition, message, detail = "") => {
  if (condition) { passed += 1; console.log("  PASS  " + message); return; }
  console.error(`  FAIL  ${message}${detail ? "  — " + detail : ""}`);
  process.exitCode = 1;
};

// A real pointer drag, in steps, the way a finger moves.
async function swipe(page, fromX, toX, y = 430) {
  await page.evaluate(() => { window.__landingSteps = 0; });
  await page.mouse.move(fromX, y);
  await page.evaluate(([x, yy]) => {
    document.elementFromPoint(x, yy)?.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: x, clientY: yy, pointerType: "touch", isPrimary: true
    }));
  }, [fromX, y]);
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps);
    await page.evaluate(([xx, yy]) => {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: xx, clientY: yy, pointerType: "touch", isPrimary: true
      }));
    }, [x, y]);
  }
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true }));
  });
  await page.waitForTimeout(150);
}

const accountType = (page) => page.evaluate(() => state.accountType);

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"]
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    serviceWorkers: "block", hasTouch: true, isMobile: true
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8099/", { waitUntil: "networkidle" });
  await page.waitForSelector("[data-landing-swipe]", { timeout: 8000 });

  // Measured by behaviour rather than by reading the constant: the shipped
  // bundle is minified, so the name is gone, and behaviour is what matters.
  // Swiping RIGHT steps backwards through the account types, so the probe
  // starts on Business: if the gesture is accepted it lands on Personal.
  const usableFrom = await (async () => {
    for (let x = 2; x < 80; x += 2) {
      await page.evaluate(() => { state.accountType = "business"; render(); });
      await page.waitForTimeout(60);
      await swipe(page, x, x + 180);
      if (await accountType(page) === "personal") return x;
    }
    return null;
  })();
  check(usableFrom !== null && usableFrom <= 40,
    "the strip the app declines is narrow, not a dead band down the screen", `swipes work from ${usableFrom}px in`);
  check(usableFrom !== null && WIDTH - usableFrom * 2 > WIDTH * 0.8,
    "and more than four fifths of the screen still swipes", `${WIDTH - usableFrom * 2}px of ${WIDTH}px`);

  // ---- 1. The feature still works from the middle -------------------------
  await page.evaluate(() => { state.accountType = "personal"; render(); });
  await page.waitForTimeout(120);
  await swipe(page, 260, 90);
  check(await accountType(page) === "business",
    "a swipe from the middle of the screen still switches to Business",
    await accountType(page));

  await swipe(page, 130, 300);
  check(await accountType(page) === "personal",
    "and back to Personal the other way", await accountType(page));

  // ---- 2 + 3. The edges belong to the browser -----------------------------
  const before = await accountType(page);
  await swipe(page, 6, 200);
  check(await accountType(page) === before,
    "a swipe starting in the LEFT edge strip is declined, so nothing half-happens",
    `${before} -> ${await accountType(page)}`);

  await swipe(page, WIDTH - 6, WIDTH - 220);
  check(await accountType(page) === before,
    "a swipe starting in the RIGHT edge strip is declined too",
    `${before} -> ${await accountType(page)}`);

  // ---- 4. Declined at the start, not part-way through ---------------------
  // Refused at the start, not part-way: a pointerdown in the strip followed by
  // a full-width move must still change nothing.
  await page.evaluate(() => { state.accountType = "personal"; render(); });
  await page.waitForTimeout(80);
  await swipe(page, 3, WIDTH - 40);
  check(await accountType(page) === "personal",
    "a gesture begun in the strip changes nothing even if it crosses the whole screen");

  // ---- 5. A vertical drag is a scroll, not a switch -----------------------
  const beforeVertical = await accountType(page);
  await page.evaluate(() => {
    const surface = document.querySelector("[data-landing-swipe]");
    surface.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: 200, clientY: 300, pointerType: "touch", isPrimary: true
    }));
    for (let i = 1; i <= 6; i += 1) {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: 200 + i * 10, clientY: 300 + i * 40, pointerType: "touch", isPrimary: true
      }));
    }
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true }));
  });
  await page.waitForTimeout(120);
  check(await accountType(page) === beforeVertical,
    "a mostly-vertical drag scrolls rather than switching account type");

  // ---- 6. The surface declares what it owns -------------------------------
  const declared = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector("[data-landing-swipe]"));
    return { touch: style.touchAction, overscroll: style.overscrollBehaviorX };
  });
  check(/pan-y/.test(declared.touch),
    "the surface declares that it handles horizontal itself", declared.touch);
  check(declared.overscroll === "contain",
    "and that a horizontal overscroll stops at its own boundary", declared.overscroll);

  await browser.close();
  console.log(`\n  ${passed}/9 landing swipe checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
