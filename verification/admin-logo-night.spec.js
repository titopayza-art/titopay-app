// IS THE WORDMARK ACTUALLY LEGIBLE ON THE SURFACE BEHIND IT?
//
// Reported with a photograph of the sign-in page in night mode: the wordmark
// read "Pay". "Tito" was still being drawn - in #0a1f44 navy, on a #0e1626
// panel, which is a contrast ratio of 1.2 and invisible to a person.
//
// "Looks right" is not checkable, so this measures instead. The artwork the
// browser actually paints is loaded, its ink sampled from the pixels that are
// not transparent, and the contrast against the real panel colour computed the
// way WCAG does. A logo needs 3:1 to read as a shape; the broken state scores
// about 1.2, so the threshold separates them without being arbitrary.
//
// Both themes are checked. The navy artwork is CORRECT on the light surfaces
// these screens normally use, so a fix that simply forced the night logo
// everywhere would trade one invisible wordmark for another.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ADMIN = process.env.ADMIN_ROOT || path.join(__dirname, "..", "admin");
const PORT = 8191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".json": "application/json", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(ADMIN, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(ADMIN) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message)));
    // Set the way the console sets it: applyAdminTheme writes this key and the
    // page reads it on boot. Seeding storage rather than stamping the element
    // means the console's own code puts the attribute on, so this measures the
    // real path a person's theme choice takes - and it avoids the init script
    // running before documentElement exists.
    await page.addInitScript((value) => {
      try { localStorage.setItem("titopay_admin_theme_v1", value); } catch { /* ignore */ }
    }, theme);
    await page.goto(ORIGIN, { waitUntil: "load" });
    await page.waitForSelector(".auth-panel-mark", { timeout: 15000 });
    await page.waitForTimeout(600);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme || "(unset)");
    ok(`${theme}: the console applied the theme`, applied === theme, `root says ${applied}`);

    const measured = await page.evaluate(async () => {
      const mark = document.querySelector(".auth-panel-mark");
      const styles = getComputedStyle(mark);
      // With content:url() the element still reports its ORIGINAL src in
      // currentSrc, so the computed content is the only honest answer to
      // "which file is the browser painting".
      const fromContent = /url\(["']?([^"')]+)["']?\)/.exec(styles.content);
      const painted = fromContent ? fromContent[1] : mark.currentSrc;

      const surface = getComputedStyle(document.documentElement)
        .getPropertyValue("--tp-surface-sunken").trim();

      const image = new Image();
      image.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = () => reject(new Error(`could not load ${painted}`));
        image.src = painted;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      // The left 40% is "Tito" - the half that vanished. "Pay" is a different
      // colour and averaging the whole wordmark would hide the fault.
      const { data, width, height } = ctx.getImageData(0, 0, Math.floor(canvas.width * 0.4), canvas.height);
      let r = 0, g = 0, b = 0, n = 0;
      for (let at = 0; at < data.length; at += 4) {
        if (data[at + 3] < 140) continue;  // transparent, not ink
        r += data[at]; g += data[at + 1]; b += data[at + 2]; n += 1;
      }
      return { painted, surface, ink: n ? [r / n, g / n, b / n] : null, inkPixels: n,
        imageSize: [width, height], naturalSize: [image.naturalWidth, image.naturalHeight] };
    });

    const parse = (colour) => {
      const hex = /^#([0-9a-f]{6})$/i.exec(colour);
      if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16));
      const rgb = colour.match(/\d+(\.\d+)?/g);
      return rgb ? rgb.slice(0, 3).map(Number) : [255, 255, 255];
    };
    const luminance = ([r, g, b]) => {
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const ink = measured.ink;
    const surface = parse(measured.surface);
    const ratio = ink ? contrast(ink, surface) : 0;
    const file = String(measured.painted).split("/").pop().split("?")[0];

    console.log(`\n  ${theme} theme`);
    console.log(`    painting ${file} on ${measured.surface}`);
    console.log(`    "Tito" ink rgb(${ink.map((v) => Math.round(v)).join(", ")})  contrast ${ratio.toFixed(2)}:1`);

    ok(`${theme}: the wordmark reads against the panel`, ratio >= 3,
      `${ratio.toFixed(2)}:1 (needs 3:1)`);
    ok(`${theme}: the right artwork is used`,
      theme === "dark" ? /night/.test(file) : /light/.test(file), file);
    ok(`${theme}: the artwork actually loaded`, measured.inkPixels > 500,
      `${measured.inkPixels} opaque pixels`);
    // Both files are 480x118. If that ever stops being true the swap would
    // resize the wordmark, so it is checked rather than assumed.
    ok(`${theme}: the swap does not resize the wordmark`,
      measured.naturalSize[0] === 480 && measured.naturalSize[1] === 118,
      measured.naturalSize.join("x"));
    ok(`${theme}: no page errors`, errors.length === 0, errors.slice(0, 1).join(" | "));

    await page.screenshot({ path: path.join(__dirname, "artifacts", `admin-login-${theme}.png`),
      clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await page.close();
  }

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
