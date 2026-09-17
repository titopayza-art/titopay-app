// THE HEADING AND THE BODY COPY MUST NOT BE DRAWN ON TOP OF EACH OTHER.
//
// docs/overview/build-deck.js used to park the cursor on a fixed line after
// drawing each slide heading. That is only safe while every heading is one
// line long; a heading that wrapped to two ran past the fixed line and the
// paragraph underneath was printed straight over it. It was reported from a
// phone, as a screenshot of slide 2 with the heading unreadable.
//
// There is no PDF renderer on this machine, so this does not look at a
// picture. It patches pdfkit, records the box every piece of text is drawn
// into, and fails if two boxes in the same column of the same slide overlap
// vertically. That is the defect itself, measured, rather than an eyeball.
//
//   cd api && NODE_PATH=$PWD/node_modules node ../verification/deck-layout.spec.js

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const PDFDocument = require("pdfkit");

const H = 595.28;
const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// Every text draw, as a box, tagged with the slide it landed on.
const boxes = [];
// Zero, not one: pdfkit's constructor adds the first page itself, and the
// patch below is installed before the deck is required, so that call counts.
let page = 0;
let recording = true;

const addPage = PDFDocument.prototype.addPage;
PDFDocument.prototype.addPage = function patchedAddPage(...args) {
  const out = addPage.apply(this, args);
  page += 1;
  return out;
};

// The slide-number pass walks back over finished pages on purpose. Those
// placements are absolute and deliberate, so stop recording once it starts.
const switchToPage = PDFDocument.prototype.switchToPage;
PDFDocument.prototype.switchToPage = function patchedSwitchToPage(...args) {
  recording = false;
  return switchToPage.apply(this, args);
};

const text = PDFDocument.prototype.text;
PDFDocument.prototype.text = function patchedText(value, x, y, options) {
  let opts = options;
  let px = x;
  let py = y;
  if (typeof x === "object" && x !== null) { opts = x; px = undefined; py = undefined; }
  opts = opts || {};
  const left = typeof px === "number" ? px : this.x;
  const top = typeof py === "number" ? py : this.y;
  const str = String(value);
  const width = opts.lineBreak === false
    ? this.widthOfString(str, opts)
    : (opts.width || this.page.width - left - this.page.margins.right);
  const height = opts.lineBreak === false
    ? this.currentLineHeight(true)
    : this.heightOfString(str, Object.assign({}, opts, { width }));
  if (recording) boxes.push({ page, left, top, right: left + width, bottom: top + height, str });
  return text.apply(this, arguments);
};

console.log("\n=============================================================");
console.log("  DECK -> nothing is printed on top of anything else");
console.log("=============================================================\n");

const out = path.join(os.tmpdir(), `deck-layout-${process.pid}.pdf`);
process.env.OUT = out;
require(path.join(__dirname, "..", "docs", "overview", "build-deck.js"));

process.on("exit", () => { try { fs.unlinkSync(out); } catch (error) { /* already gone */ } });

// Give pdfkit's write stream a moment, then judge what was recorded.
setTimeout(() => {
  const slides = new Map();
  for (const box of boxes) {
    if (!slides.has(box.page)) slides.set(box.page, []);
    slides.get(box.page).push(box);
  }

  const collisions = [];
  for (const [slide, items] of slides) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        // Two boxes only fight if they share horizontal space as well. Cards
        // and tick columns sit side by side at the same height on purpose.
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 2 && overlapY > 2) {
          collisions.push(`slide ${slide}: "${a.str.slice(0, 34)}" over "${b.str.slice(0, 34)}"`
            + ` (${overlapY.toFixed(1)}pt)`);
        }
      }
    }
  }
  check("NO TEXT IS DRAWN OVER OTHER TEXT", collisions.length === 0,
    collisions.slice(0, 6).join(" | "));

  const spilled = boxes.filter((b) => b.bottom > H - 24);
  check("nothing runs off the bottom of a slide", spilled.length === 0,
    spilled.map((b) => `slide ${b.page}: "${b.str.slice(0, 30)}" ends at ${b.bottom.toFixed(0)}`).join(" | "));

  check("the deck is 13 slides", page === 13, String(page));

  // A CHARACTER WITH NO SLOT IN THE FONT PRINTS AS RUBBISH. pdfkit uses
  // WinAnsiEncoding for the built-in Helvetica. Anything it cannot map goes
  // into the page as its raw code point, so a tick (U+2713) came out as an
  // apostrophe. Curly quotes, dashes and the middle dot all have slots and
  // are fine; this catches the ones that do not.
  const WIN_ANSI_HIGH = new Set([0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D,
    0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178]);
  const unmappable = new Set();
  for (const box of boxes) {
    for (const ch of box.str) {
      const code = ch.codePointAt(0);
      if (code === 10 || (code >= 32 && code <= 126)) continue;
      if ((code >= 0xA0 && code <= 0xFF) || WIN_ANSI_HIGH.has(code)) continue;
      unmappable.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")} (${ch})`);
    }
  }
  check("every character the deck prints exists in the font", unmappable.size === 0,
    [...unmappable].join(", "));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exitCode = failed.length ? 1 : 0;
}, 400);
