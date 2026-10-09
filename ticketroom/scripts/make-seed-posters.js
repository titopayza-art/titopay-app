// Renders the demo event posters used by the seed (seed-assets/*.png).
// Development tooling only: run `node scripts/make-seed-posters.js`.
const path = require("path");
const { chromium } = require("playwright");

const posters = [
  ["sunset.png", "SOWETO", "SUNSET SESSIONS", "AMAPIANO · DEEP HOUSE", ["#FF8A3D", "#C2185B", "#2B1055"], "sun"],
  ["comedy.png", "CAPE TOWN", "COMEDY NIGHT", "FIVE COMICS · ONE NIGHT", ["#FFD166", "#EF476F", "#1B1B3A"], "mic"],
  ["jazz.png", "DURBAN", "FOOD & JAZZ", "TWO STAGES · FORTY KITCHENS", ["#06D6A0", "#118AB2", "#073B4C"], "wave"],
  ["tech.png", "PRETORIA", "TECH BREAKFAST", "FOUNDERS · FUNDERS · COFFEE", ["#8EC5FC", "#4361EE", "#0B1D3F"], "grid"],
  ["kids.png", "SCIENCE", "SATURDAY", "HANDS-ON · AGES 6–12", ["#F9C74F", "#43AA8B", "#1D3557"], "dots"],
  ["rugby.png", "RUGBY", "FAN PARK", "BIG SCREENS · BRAAI · MATCH DAY", ["#90BE6D", "#2D6A4F", "#081C15"], "stripes"],
];

const motif = {
  sun: `<div class="sun"></div>`, mic: `<div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div>`,
  wave: Array.from({ length: 7 }, (_, i) => `<div class="wave" style="bottom:${i * 34}px;opacity:${0.18 + i * 0.08}"></div>`).join(""),
  grid: `<div class="gridbg"></div>`, dots: `<div class="dots"></div>`, stripes: `<div class="stripes"></div>`,
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  for (const [file, l1, l2, l3, [a, b, c], m] of posters) {
    await page.setContent(`<html><body style="margin:0"><div class="p"><style>
      .p{width:1200px;height:675px;position:relative;overflow:hidden;font-family:Inter,system-ui,sans-serif;background:linear-gradient(140deg,${a} 0%,${b} 45%,${c} 100%);color:#fff}
      .sun{position:absolute;right:120px;top:90px;width:360px;height:360px;border-radius:50%;background:radial-gradient(circle at 40% 40%,#FFE29A,#FF8A3D 60%,transparent 61%);box-shadow:0 0 140px #FFB86B}
      .ring{position:absolute;border:14px solid rgba(255,255,255,.18);border-radius:50%;right:80px;top:60px}.r1{width:420px;height:420px}.r2{width:300px;height:300px;right:140px;top:120px}.r3{width:180px;height:180px;right:200px;top:180px;background:rgba(255,255,255,.12)}
      .wave{position:absolute;left:-10%;width:120%;height:120px;border-radius:50%;border-top:10px solid rgba(255,255,255,.7)}
      .gridbg{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.12) 1px,transparent 1px);background-size:48px 48px}
      .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.35) 6px,transparent 7px);background-size:56px 56px}
      .stripes{position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.08) 0 60px,transparent 60px 120px)}
      .t{position:absolute;left:70px;bottom:70px}.t1{font-size:38px;font-weight:800;letter-spacing:.3em;opacity:.9}.t2{font-size:96px;font-weight:900;line-height:.95;letter-spacing:-.02em;max-width:760px;text-shadow:0 6px 30px rgba(0,0,0,.25)}
      .t3{margin-top:18px;font-size:24px;font-weight:700;letter-spacing:.2em;color:#FFE7B8}
    </style>${motif[m]}<div class="t"><div class="t1">${l1}</div><div class="t2">${l2}</div><div class="t3">${l3}</div></div></div></body></html>`);
    await page.screenshot({ path: path.resolve(__dirname, "..", "seed-assets", file) });
  }
  await browser.close();
  console.log(`rendered ${posters.length} posters`);
})();
