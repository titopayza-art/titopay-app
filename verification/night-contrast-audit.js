// FULL NIGHT-MODE CONTRAST AUDIT
//
// Every earlier sweep compared a rule's OWN background against its OWN color.
// That cannot see the commonest form of this bug: a light panel whose CHILD
// text takes a token that flips - .integration-note strong was invisible that
// way. This one renders each surface with real child elements and measures the
// computed colour of every one of them, compositing alpha down to the true
// ground, exactly as the eye sees it.
const { chromium } = require("/home/user/titopay-app/node_modules/playwright");
const fs = require("fs");

const CSS_PATH = process.argv[2] || "/home/user/titopay-app/pwa/styles.min.css";
const raw = fs.readFileSync(CSS_PATH, "utf8");

/* ---------- parse ---------- */
function stripAtRule(text, name) {
  let out = "", i = 0;
  for (;;) {
    const at = text.indexOf(name, i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let j = text.indexOf("{", at);
    if (j < 0) { out += text.slice(at); break; }
    let depth = 0;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
}
const css = stripAtRule(raw.replace(/\/\*[\s\S]*?\*\//g, ""), "@media print");

const rules = [];
const RULE = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = RULE.exec(css))) rules.push({ sel: m[1].trim(), body: m[2] });

/* ---------- pick testable container selectors ---------- */
// Anything that paints a background and can be built from classes alone.
const SKIP = /[:>+~\[]|::|^@|^html|^:root|^\*/;
const candidates = new Map();
for (const r of rules) {
  if (!/(?:^|;)\s*background(?:-color|-image)?\s*:/.test(r.body)) continue;
  for (let part of r.sel.split(",")) {
    part = part.trim();
    if (!part || SKIP.test(part)) continue;
    if (!part.startsWith(".")) continue;
    // ".a .b" (descendant) or ".a.b" (compound) only, max two levels
    const chain = part.split(/\s+/);
    if (chain.length > 2) continue;
    if (chain.some((c) => !/^\.[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/.test(c))) continue;
    candidates.set(part, chain);
  }
}

/* ---------- build one page containing every candidate ---------- */
const cls = (token) => token.slice(1).split(".").join(" ");
const CHILDREN = `<strong data-k="strong">Label</strong>
<span data-k="span">Body copy</span>
<p data-k="p">Paragraph copy</p>
<small data-k="small">Caption</small>
<a data-k="a" href="#">Link</a>`;

const blocks = [...candidates.entries()].map(([sel, chain], i) => {
  const inner = `<div data-probe="${i}">${CHILDREN}</div>`;
  return chain.length === 2
    ? `<div class="${cls(chain[0])}"><div class="${cls(chain[1])}" data-host="${i}">${inner}</div></div>`
    : `<div class="${cls(chain[0])}" data-host="${i}">${inner}</div>`;
});

const HTML = `<!doctype html><html data-theme="night"><head><meta charset="utf-8">
<style>${raw}</style>
<style>body{margin:0;padding:10px;background:var(--soft)}
[data-host]{margin:6px 0}</style></head><body>
${blocks.join("\n")}
</body></html>`;

/* ---------- measure ---------- */
function lum(c) {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (f, b) => {
  const a = lum(f) + 0.05, d = lum(b) + 0.05;
  return +(Math.max(a, d) / Math.min(a, d)).toFixed(2);
};

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ colorScheme: "dark", viewport: { width: 480, height: 900 } });
  await page.setContent(HTML, { waitUntil: "load" });
  await page.waitForTimeout(500);

  const found = await page.evaluate(() => {
    const parse = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    function bgOf(el) {
      const layers = [];
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/transparent/.test(c)) {
          const q = (c.match(/[\d.]+/g) || []).map(Number);
          const a = q.length > 3 ? q[3] : 1;
          if (a > 0) { layers.push({ rgb: q.slice(0, 3), a }); if (a === 1) break; }
        }
        n = n.parentElement;
      }
      let out = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) {
        const { rgb, a } = layers[i];
        out = out.map((base, k) => Math.round(rgb[k] * a + base * (1 - a)));
      }
      return out;
    }
    const res = [];
    document.querySelectorAll("[data-host]").forEach((host) => {
      const idx = host.getAttribute("data-host");
      const bg = bgOf(host);
      host.querySelectorAll("[data-k]").forEach((kid) => {
        res.push({ idx, kind: kid.getAttribute("data-k"), fg: parse(getComputedStyle(kid).color), bg });
      });
    });
    return res;
  });

  const selByIdx = [...candidates.keys()];
  const failures = new Map();
  for (const f of found) {
    // The injected <a> inherits link colour, which is meaningless in a
    // container that never holds a link - it only adds noise.
    if (f.kind === "a") continue;
    const cr = ratio(f.fg, f.bg);
    if (cr >= 4.5) continue;
    const sel = selByIdx[Number(f.idx)];
    if (!failures.has(sel)) failures.set(sel, { bg: f.bg, kinds: [], lum: lum(f.bg) });
    failures.get(sel).kinds.push(`${f.kind} ${cr}:1`);
  }

  console.log(`stylesheet: ${CSS_PATH.split("/").pop()}`);
  console.log(`surfaces rendered: ${candidates.size}   text probes: ${found.length}`);
  console.log(`surfaces with unreadable text: ${failures.size}\n`);
  // A LIGHT ground at night is the reported bug: a surface that never flipped,
  // now carrying text that did. A dark ground that merely reads a bit low is a
  // different, milder question and is listed separately so it cannot drown it.
  const light = [...failures.entries()].filter(([, i]) => i.lum > 0.55);
  const dark  = [...failures.entries()].filter(([, i]) => i.lum <= 0.55);
  console.log(`LIGHT SURFACES AT NIGHT (the reported bug class): ${light.length}`);
  for (const [sel, info] of light.sort((a, b) => a[1].lum - b[1].lum).reverse()) {
    console.log(`  ${sel}`);
    console.log(`      ground rgb(${info.bg})  ->  ${info.kinds.join(", ")}`);
  }
  console.log(`\nLOW CONTRAST ON A DARK GROUND (separate, milder): ${dark.length}`);
  for (const [sel, info] of dark) {
    console.log(`  ${sel}  rgb(${info.bg})  ${info.kinds[0]}`);
  }
  
  await browser.close();
  process.exit(0);
})();
