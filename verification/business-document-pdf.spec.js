// IS THE DOCUMENT A FORMAL DOCUMENT, AND DOES IT HOLD TOGETHER?
//
// Reported with a photograph of a real invoice: "Subtotal R 100.00" printed ON
// TOP OF the single item row, and two things crossed out in red - the PDF
// extraction fee with its transaction reference, and the platform's own
// tagline. Neither belongs on a document handed to a customer.
//
// The collision came from the totals being positioned UPWARD from a cursor
// that was already below the last row, so with one item they landed back on
// it. The more items there were the further apart they drifted - which is why
// it looked right while it was being built and wrong on a real one-line
// invoice.
//
// This generates the real PDF and READS THE PAGE BACK: every text operator in
// the content stream, its position and its width. Overlaps are computed rather
// than eyeballed, because "looks fine" is what shipped the bug.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8201;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json" };

const USER = {
  id: "aa110000-1111-4222-8333-444444444444",
  fullName: "Thuso Tshiloane", username: "titopay",
  email: "titopayza@gmail.com", phone: "+27768847372",
  accountType: "business", account_type: "business", status: "active",
  businessName: "TitoPay", registrationNumber: "2020/123456/07", vatNumber: "4123456789"
};

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

// The page's own text operators. This PDF is written uncompressed by hand, so
// the content stream can be read directly - no library, and no guessing about
// what ended up on the page.
const TEXT_OP = /BT \/(\w+) ([\d.]+) Tf ([\d.]+ [\d.]+ [\d.]+) rg (-?[\d.]+) (-?[\d.]+) Td \((.*?)\) Tj ET/g;

// Helvetica advance widths, the same table the generator uses to right-align.
function advance(char) {
  if (/[0-9]/.test(char)) return 0.556;
  if (char === " ") return 0.278;
  if (/[.,:;'`]/.test(char)) return 0.278;
  if (/[A-Z]/.test(char)) return 0.694;
  if (/[ilj]/.test(char)) return 0.235;
  if (/[frt]/.test(char)) return 0.315;
  if (/[mw]/.test(char)) return 0.833;
  return 0.54;
}
const widthOf = (value, size) => [...String(value)].reduce((sum, ch) => sum + advance(ch), 0) * size;

function readPage(bytes) {
  const raw = Buffer.from(bytes).toString("latin1");
  const ops = [];
  let match;
  TEXT_OP.lastIndex = 0;
  while ((match = TEXT_OP.exec(raw)) !== null) {
    ops.push({ size: Number(match[2]), x: Number(match[4]), y: Number(match[5]), text: match[6] });
  }
  return ops;
}

// Two pieces of text on the same baseline whose boxes intersect. This is the
// exact fault that was photographed.
function overlaps(ops) {
  const byLine = new Map();
  for (const op of ops) {
    const key = Math.round(op.y * 10) / 10;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push({ from: op.x, to: op.x + widthOf(op.text, op.size), text: op.text });
  }
  const found = [];
  for (const [y, line] of byLine) {
    line.sort((a, b) => a.from - b.from);
    for (let i = 0; i < line.length - 1; i += 1) {
      if (line[i].to > line[i + 1].from + 0.5) {
        found.push(`y${y}: "${line[i].text}" over "${line[i + 1].text}"`);
      }
    }
  }
  return found;
}

const oneItem = [{ description: "Consulting", quantity: 1, unit: 100, total: 100 }];
const manyItems = Array.from({ length: 12 }, (unused, index) => ({
  description: `Line item number ${index + 1}`, quantity: index + 1,
  unit: 125.5, total: (index + 1) * 125.5
}));

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext();
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "3382660735", status: "active" }] });
    return json({ items: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe", refreshToken: "probe", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForTimeout(1600);

  async function build(items, extra = {}, user = USER) {
    return page.evaluate(([list, more, who]) => {
      state.user = who;
      const doc = Object.assign({
        kind: "Invoice", number: "INV-2026-0001", reference: "INV-2026-0001",
        businessName: "TitoPay", businessContact: "titopayza@gmail.com", businessAddress: "Sandton City",
        customerName: "Thuso Tshiloane", customerEmail: "thusotshiloane@icloud.com",
        customerAddress: "Bedfordview", items: list,
        totals: documentTotals(list, "No VAT", 0), createdAt: new Date().toISOString(),
        issueDate: "2026-09-14", dueDate: "2026-10-14", dateLabel: "Due date",
        notes: "Thank you for your business.", disclaimer: "",
        pdfFeePaid: true, pdfPaidAt: new Date().toISOString(),
        pdfFeeReference: "TX-1789418897443-GSZI7G"
      }, more);
      return Array.from(new TextEncoder().encode(businessDocumentPdf(doc)));
    }, [items, extra, user]);
  }

  const cases = [
    ["a one-line invoice, the document that was photographed", oneItem, {}],
    ["a twelve-line invoice", manyItems, {}],
    ["a quote", oneItem, { kind: "Quote", number: "QUO-2026-0001",
      disclaimer: "This quote is an offer and is not a request for payment." }],
    ["a proforma invoice", oneItem, { kind: "Proforma Invoice", number: "PRO-2026-0001",
      disclaimer: "This is a proforma invoice and not a tax invoice." }]
  ];

  for (const [label, items, extra] of cases) {
    const ops = readPage(await build(items, extra));
    const text = ops.map((o) => o.text).join(" | ");
    const at = (value) => ops.find((o) => o.text === value)?.y;
    console.log(`\n  ${label}`);

    ok("nothing overlaps anything", overlaps(ops).length === 0, overlaps(ops).slice(0, 2).join("; "));

    // The fault that was photographed, stated directly.
    const lastRow = Math.min(...ops.filter((o) => /^(Consulting|Line item|\+ \d+ further)/.test(o.text)).map((o) => o.y));
    ok("the totals sit BELOW the last item, not on top of it",
      at("Subtotal") < lastRow && at("Total") < at("Subtotal"),
      `last row y${lastRow}, Subtotal y${at("Subtotal")}, Total y${at("Total")}`);
    ok("the totals stay clear of the notes", at("Total") > at("NOTES"),
      `Total y${at("Total")} vs NOTES y${at("NOTES")}`);

    // The two things crossed out in red.
    ok("THE PDF EXTRACTION FEE IS NOT ON THE CUSTOMER'S DOCUMENT",
      !/PDF EXTRACTION|Fee paid/i.test(text));
    ok("no transaction reference is printed on it", !/TX-\d/.test(text));
    ok("no platform tagline", !/Smart Payments|Powered by TitoPay/i.test(text));

    // What makes it formal.
    ok("the company's registration and VAT numbers appear",
      /2020\/123456\/07/.test(text) && /4123456789/.test(text));
    ok("it names the document type, number and both parties",
      new RegExp(String(extra.kind || "Invoice").toUpperCase().replace(/ /g, " ")).test(text.toUpperCase())
      && text.includes(extra.number || "INV-2026-0001")
      && text.includes("Thuso Tshiloane"));
    if (extra.disclaimer) {
      ok("it carries its own legal wording",
        text.includes(extra.disclaimer.slice(0, 40)), extra.disclaimer.slice(0, 44));
    }
  }

  // A business that has given no registration number must not have one
  // invented, and must not print an empty label either.
  const plain = readPage(await build(oneItem, {},
    Object.assign({}, USER, { registrationNumber: "", vatNumber: "" })));
  const plainText = plain.map((o) => o.text).join(" | ");
  console.log("\n  a business that has not supplied a registration number");
  ok("no registration line at all, rather than a blank one",
    !/Reg\.|VAT \d/.test(plainText) && !/not supplied/i.test(plainText));
  ok("the rest of the document is unaffected",
    plainText.includes("Total") && overlaps(plain).length === 0);

  ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
