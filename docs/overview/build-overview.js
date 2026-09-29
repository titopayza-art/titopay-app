"use strict";

// TITOPAY - PLATFORM OVERVIEW
//
// Built with the platform's own PDF stack (pdfkit, the same library behind
// statements and tickets) and its own palette, so the document looks like the
// product it describes.
//
//   cd api && NODE_PATH=$PWD/node_modules node ../docs/overview/build-overview.js
//
// It is a GENERATOR rather than a saved PDF on purpose. The overview states
// fees, limits and what is live, and every one of those changes with the
// platform. A document nobody can regenerate goes stale quietly and is then
// handed to somebody as if it were current, which is how an overview ends up
// describing partners that were never integrated.
//
// EVERY FACTUAL CLAIM IN HERE WAS READ OUT OF THE CODEBASE, not recalled:
// the service catalogue from pwa/services-default.json, the fees from
// APPROVED_PRICING_SCHEDULE, the limits from compliance-service, and the
// provider status from src/providers/*. Where something could not be verified
// from the code it is either left out or marked as not verifiable here.

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const NAVY = "#0b1f3f";
const BLUE = "#2f5cff";
const SKY = "#5b9df9";
const INK = "#12233f";
const MUTED = "#6b7a93";
const LINE = "#dbe6f2";
const BAND = "#f2f6fc";
const GOOD = "#0a7d55";
const WARN = "#9a6410";
const OFF = "#9e2b34";

const MARGIN = 52;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - MARGIN * 2;

const TAGLINE = "Smart Payments, Simplified";
const BUILD = process.env.BUILD_LABEL || "v580";
const COMMIT = process.env.COMMIT_LABEL || "d43c167";
const DATED = process.env.DATE_LABEL || "17 September 2026";

const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true,
  info: { Title: "TitoPay - Platform Overview", Author: "TitoPay (Pty) Ltd" } });

function wordmark(x, y, size) {
  doc.font("Helvetica-Bold").fontSize(size);
  const w = doc.widthOfString("Tito");
  doc.fillColor(NAVY).text("Tito", x, y, { lineBreak: false });
  doc.fillColor(BLUE).text("Pay", x + w, y, { lineBreak: false });
  return doc.widthOfString("TitoPay");
}

// Every block measures itself and asks for a page before it draws, so nothing
// is ever split across a page boundary by accident.
function room(needed) {
  if (doc.y + needed > PAGE_H - MARGIN - 34) {
    doc.addPage();
    doc.y = MARGIN;
  }
}

function h1(text) {
  room(46);
  doc.font("Helvetica-Bold").fontSize(15).fillColor(NAVY)
    .text(text, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.12);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 34, y).lineWidth(2.2).strokeColor(BLUE).stroke();
  doc.y = y + 11;
}

function h2(text) {
  room(30);
  doc.font("Helvetica-Bold").fontSize(9.6).fillColor(BLUE)
    .text(text.toUpperCase(), MARGIN, doc.y, { width: CONTENT_W, characterSpacing: 0.7 });
  doc.y += 4;
}

function body(text, opts = {}) {
  room(28);
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.4)
    .fillColor(opts.color || INK)
    .text(text, MARGIN + (opts.indent || 0), doc.y,
      { width: CONTENT_W - (opts.indent || 0), align: opts.align || "left", lineGap: 2.4 });
  doc.y += opts.gap === undefined ? 7 : opts.gap;
}

function bullets(items, opts = {}) {
  for (const item of items) {
    room(20);
    const y = doc.y;
    doc.circle(MARGIN + 3.4, y + 4.6, 1.7).fillColor(opts.color || SKY).fill();
    doc.font("Helvetica").fontSize(9.4).fillColor(INK)
      .text(item, MARGIN + 13, y, { width: CONTENT_W - 13, lineGap: 2.2 });
    doc.y += 3.5;
  }
  doc.y += 4;
}

// A panel for the things a reader must not skim past.
function panel(title, lines, tone = BLUE) {
  const padding = 12;
  doc.font("Helvetica").fontSize(9.2);
  let height = padding * 2 + 14;
  for (const line of lines) height += doc.heightOfString(line, { width: CONTENT_W - padding * 2 - 6, lineGap: 2.2 }) + 4;
  room(height + 10);
  const top = doc.y;
  doc.roundedRect(MARGIN, top, CONTENT_W, height, 7).fillColor(BAND).fill();
  doc.rect(MARGIN, top, 3, height).fillColor(tone).fill();
  doc.font("Helvetica-Bold").fontSize(9.2).fillColor(tone)
    .text(title.toUpperCase(), MARGIN + padding + 3, top + padding, { width: CONTENT_W - padding * 2, characterSpacing: 0.6 });
  let y = top + padding + 15;
  for (const line of lines) {
    doc.font("Helvetica").fontSize(9.2).fillColor(INK)
      .text(line, MARGIN + padding + 3, y, { width: CONTENT_W - padding * 2 - 6, lineGap: 2.2 });
    y = doc.y + 4;
  }
  doc.y = top + height + 12;
}

// A table that carries its own column widths, so a header can never drift from
// the values under it.
function table(columns, rows, opts = {}) {
  const totalW = columns.reduce((sum, c) => sum + c.width, 0);
  const scale = CONTENT_W / totalW;
  const cols = columns.map((c) => ({ ...c, w: c.width * scale }));

  const drawHead = () => {
    const y = doc.y;
    doc.rect(MARGIN, y, CONTENT_W, 17).fillColor(NAVY).fill();
    let x = MARGIN + 7;
    doc.font("Helvetica-Bold").fontSize(7.6).fillColor("#ffffff");
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x, y + 5.4,
        { width: c.w - 10, align: c.align || "left", characterSpacing: 0.5, lineBreak: false });
      x += c.w;
    }
    doc.y = y + 17;
  };

  room(52);
  drawHead();

  let striped = false;
  for (const row of rows) {
    doc.font("Helvetica").fontSize(8.5);
    let height = 13;
    for (const c of cols) {
      const text = String(row[c.key] === undefined || row[c.key] === null ? "" : row[c.key]);
      height = Math.max(height, doc.heightOfString(text, { width: c.w - 10 }) + 8.5);
    }
    if (doc.y + height > PAGE_H - MARGIN - 34) {
      doc.addPage();
      doc.y = MARGIN;
      drawHead();
      striped = false;
    }
    const y = doc.y;
    if (striped) doc.rect(MARGIN, y, CONTENT_W, height).fillColor("#f8fafd").fill();
    striped = !striped;
    let x = MARGIN + 7;
    for (const c of cols) {
      const text = String(row[c.key] === undefined || row[c.key] === null ? "" : row[c.key]);
      const tone = c.key === opts.toneKey ? (row.__tone || INK) : (c.muted ? MUTED : INK);
      doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(tone)
        .text(text, x, y + 4.4, { width: c.w - 10, align: c.align || "left" });
      x += c.w;
    }
    doc.moveTo(MARGIN, y + height).lineTo(MARGIN + CONTENT_W, y + height)
      .lineWidth(0.4).strokeColor(LINE).stroke();
    doc.y = y + height;
  }
  doc.y += 10;
}

/* ============================================================ COVER ===== */

doc.rect(0, 0, PAGE_W, 232).fillColor(NAVY).fill();
doc.font("Helvetica-Bold").fontSize(30);
{
  const w = doc.widthOfString("Tito");
  doc.fillColor("#ffffff").text("Tito", MARGIN, 58, { lineBreak: false });
  doc.fillColor(SKY).text("Pay", MARGIN + w, 58, { lineBreak: false });
}
doc.font("Helvetica").fontSize(11).fillColor("#93a8c9")
  .text(TAGLINE, MARGIN, 96, { characterSpacing: 0.5 });

doc.font("Helvetica-Bold").fontSize(23).fillColor("#ffffff")
  .text("Platform Overview", MARGIN, 134, { width: CONTENT_W });
doc.font("Helvetica").fontSize(10.4).fillColor("#b9cae6")
  .text("What the platform does today, what it does not do yet, and who does what.",
    MARGIN, 168, { width: CONTENT_W - 60, lineGap: 3 });

doc.y = 262;

panel("What this document is", [
  "An accurate description of TitoPay as the software actually behaves at build " + BUILD + " (" + COMMIT + "). "
  + "Every capability, fee and limit stated here was read out of the codebase rather than from a roadmap: "
  + "the service catalogue, the approved pricing schedule, the compliance limits and the provider adapters.",
  "Where a capability is built but not yet switched on, it is listed as not live rather than described in the present tense. "
  + "The distinction is the point of the document."
]);

h1("What TitoPay is");
body("TitoPay is a South African digital payments platform. It connects customers, businesses and licensed "
  + "financial service providers through a single mobile wallet, delivered as an installable web app.");
body("TitoPay is not a bank. It does not take deposits, it does not lend, and it pays no interest on wallet "
  + "balances. It provides the technology that lets people hold value in a wallet, move it to each other, pay "
  + "businesses and reach everyday services - while licensed providers handle card acquiring and bank payouts.",
  { gap: 10 });

h2("The shape of the product");
bullets([
  "A personal wallet: send and receive money, pay by QR, request money, split a bill, save in a stokvel, buy event tickets.",
  "A business wallet: take payments by QR, run a till, issue quotes, invoices and proformas, refund customers, pay out to a bank.",
  "Marketplaces built on the same wallet: TitoPro for professional services, Book for appointments, Ticketing for events.",
  "One ledger underneath all of it, double-entry, with every movement recorded against a transaction."
]);

/* ====================================================== WHAT IS LIVE ===== */

h1("What works today");
body("28 services are live in the catalogue. These are the ones that move money or produce a document, grouped "
  + "by who uses them.", { gap: 10 });

h2("Personal");
table([
  { key: "name", label: "Service", width: 150, bold: true },
  { key: "what", label: "What it does", width: 330 }
], [
  { name: "Send Money", what: "Wallet to wallet, by username, cellphone number or email address." },
  { name: "Receive Money", what: "A personal QR code and wallet number others can pay into." },
  { name: "QR Pay", what: "Scan a business QR code and pay from the wallet." },
  { name: "Top Up", what: "Load the wallet from a bank card through the card payment provider." },
  { name: "Withdraw", what: "Move wallet funds to a South African bank account." },
  { name: "Payment Request", what: "Ask another TitoPay user for a payment; they approve or decline in their app." },
  { name: "Bill Split", what: "Fan a total out to several people as individual payment requests." },
  { name: "Stokvel", what: "A savings group with a register, contributions, terms, meetings and group approval for withdrawals." },
  { name: "Send Gift", what: "Send money presented as a digital gift." },
  { name: "Tip", what: "Send a gratuity." },
  { name: "Event Tickets", what: "Buy, hold, transfer and present tickets; cashless event wristbands." },
  { name: "TitoPro", what: "Find and hire a vetted professional; rate the work afterwards." },
  { name: "Book", what: "Book an appointment with a business that runs a booking page." }
]);

h2("Business");
table([
  { key: "name", label: "Service", width: 150, bold: true },
  { key: "what", label: "What it does", width: 330 }
], [
  { name: "Make a Sale", what: "Generate a QR for an amount, or ring up a basket from a product catalogue with stock tracking." },
  { name: "Refund", what: "Return a customer's money against the original payment, capped at what they paid, once." },
  { name: "Quote / Invoice / Proforma", what: "Build a numbered business document and download it as a PDF." },
  { name: "Statements", what: "A wallet statement for a period, on screen or emailed as a PDF." },
  { name: "Payouts", what: "Settle wallet balance to a business bank account." },
  { name: "Bulk Distribution", what: "Pay many recipients from one batch - wallets or bank accounts." },
  { name: "Ticketing", what: "Create an event, sell tickets, run the door, handle refunds, pay out." },
  { name: "Staff", what: "Give staff till access or door-scanning rights without sharing the owner's credentials." },
  { name: "TitoPro listing", what: "Publish a professional profile and receive jobs, subject to verification." },
  { name: "Book", what: "A public booking page with services, resources and opening hours." }
]);

/* ================================================== WHAT IS NOT LIVE ===== */

h1("What is not live yet");
body("These appear in the platform's catalogue but do not transact. They are listed here because a document "
  + "that quietly leaves them out is the reason people are surprised later.", { gap: 10 });

panel("Value-added services are not switched on", [
  "Airtime, data, electricity, vouchers and bill payments are marked coming soon. A supplier adapter exists in the "
  + "codebase and can authenticate and list a product catalogue, but it cannot yet send a purchase, so it declares "
  + "itself unable to sell and the platform refuses the service rather than taking money it cannot deliver against.",
  "A customer who opens one of these is told it is not active yet. No wallet is debited."
], WARN);

table([
  { key: "name", label: "Service", width: 150, bold: true },
  { key: "state", label: "State", width: 96 },
  { key: "why", label: "Why", width: 234 }
], [
  { name: "Airtime, Data", state: "Coming soon", why: "No supplier able to complete a purchase." },
  { name: "Electricity", state: "Coming soon", why: "No supplier able to complete a purchase." },
  { name: "Vouchers", state: "Coming soon", why: "No supplier able to complete a purchase." },
  { name: "Pay Bills", state: "Coming soon", why: "No supplier able to complete a purchase." },
  { name: "Shop Marketplace", state: "Not enabled", why: "Flow not built." },
  { name: "Cross Border", state: "Not enabled", why: "Flow not built; would need its own licensing view." },
  { name: "Get Cash / Cash Back", state: "Not enabled", why: "Needs a cash partner; the payout rail pays banks, not tills." },
  { name: "Travel, Virtual Doctor", state: "Not enabled", why: "Flow not built." },
  { name: "Donate", state: "Not enabled", why: "Flow not built." },
  { name: "Rewards", state: "Promotions only", why: "Shows promotional codes; it is not a transacting service." }
]);

/* ============================================================= FEES ===== */

h1("What it costs");
body("Fees come from a single approved schedule held in the platform and editable by an operator in the admin "
  + "console. The figures below are that schedule as it stands at this build.", { gap: 10 });

table([
  { key: "svc", label: "Service", width: 168, bold: true },
  { key: "who", label: "Paid by", width: 92 },
  { key: "fee", label: "Fee", width: 130, align: "right" },
  { key: "note", label: "Note", width: 130, muted: true }
], [
  { svc: "Send money, wallet transfer", who: "Sender", fee: "Free", note: "" },
  { svc: "Receive money", who: "-", fee: "Free", note: "" },
  { svc: "Tip", who: "Sender", fee: "Free", note: "" },
  { svc: "QR Pay", who: "Customer", fee: "R0.50", note: "Flat, on top" },
  { svc: "QR Pay", who: "Business", fee: "1.5%", note: "Out of the credit" },
  { svc: "Wallet top-up (card)", who: "Customer", fee: "R5.00", note: "" },
  { svc: "Withdraw to bank", who: "Customer", fee: "R10.00", note: "" },
  { svc: "Payment request", who: "Requester", fee: "R1.00", note: "" },
  { svc: "Bill split", who: "Organiser", fee: "R2.00", note: "" },
  { svc: "Send gift", who: "Sender", fee: "R3.00", note: "" },
  { svc: "Stokvel contribution", who: "Member", fee: "1.5%, max R10", note: "" },
  { svc: "Business payout", who: "Business", fee: "1.5%", note: "" },
  { svc: "Refund processing", who: "Business", fee: "R1.00", note: "Customer refunded in full" },
  { svc: "Quote / Invoice / Proforma PDF", who: "Business", fee: "R2.50", note: "Creating is free" },
  { svc: "Statement PDF", who: "Business", fee: "R0.50", note: "" },
  { svc: "Book activation", who: "Business", fee: "R250.00", note: "Once off" },
  { svc: "Event ticket", who: "Buyer", fee: "R10.00", note: "Per order" },
  { svc: "Event ticket sales", who: "Organiser", fee: "10%", note: "Commission" },
  { svc: "Bulk distribution", who: "Business", fee: "3%", note: "Plus 1.5% per bank payout" },
  { svc: "TitoPro job", who: "Customer", fee: "R5.00", note: "" },
  { svc: "TitoPro job", who: "Professional", fee: "R20.00 + 1.5%", note: "" }
]);

panel("Two things worth saying plainly about fees", [
  "A QR payment is charged on both sides: the customer pays a flat R0.50 and the business pays 1.5% out of what "
  + "it is credited. On a R10.00 sale the customer pays R10.50 and the business receives R9.85.",
  "Because the customer's R0.50 is flat, it is proportionally heaviest on very small sales - half of a R1.00 sale. "
  + "There is currently no minimum QR amount."
]);

/* =========================================================== LIMITS ===== */

h1("Limits and verification");
body("Every account sits on one of three product levels. These are TitoPay's own operational limits under its risk "
  + "management and compliance programme. They are not statutory thresholds, and the platform's own documentation is "
  + "explicit on that point.", { gap: 10 });

table([
  { key: "level", label: "Level", width: 120, bold: true },
  { key: "single", label: "Per payment", width: 90, align: "right" },
  { key: "monthly", label: "Per month", width: 95, align: "right" },
  { key: "hold", label: "Max balance", width: 95, align: "right" },
  { key: "withdraw", label: "Withdrawal", width: 90, align: "right" }
], [
  { level: "Limited Access", single: "R2 500", monthly: "R25 000", hold: "R10 000", withdraw: "R1 000" },
  { level: "Basic Verified", single: "R10 000", monthly: "R200 000", hold: "R50 000", withdraw: "R10 000" },
  { level: "Fully Verified", single: "No fixed cap", monthly: "No fixed cap", hold: "No fixed cap", withdraw: "No fixed cap" }
]);

panel("What “no fixed cap” does not mean", [
  "At the top level TitoPay removes its own standing monthly ceiling. It does not remove the controls that sit on "
  + "every transaction at every level: risk banding, transaction monitoring for velocity and structuring, sanctions "
  + "screening, enhanced due diligence where it applies, account status, product rules, and whatever the payment or "
  + "payout provider itself will accept.",
  "“Fully Verified” is a TitoPay product label. It is not a regulatory classification and does not assert that every "
  + "applicable due diligence obligation has been discharged for a given customer."
]);

/* ========================================================= PROVIDERS ===== */

h1("Who does what");
body("TitoPay builds and runs the wallet, the ledger, the apps and the operations console. Regulated activity sits "
  + "with providers. The table below states what is integrated in the software at this build - which is a narrower "
  + "question than what commercial relationships exist, and the two should not be read as the same thing.", { gap: 10 });

table([
  { key: "cap", label: "Capability", width: 140, bold: true },
  { key: "who", label: "Provider in code", width: 130 },
  { key: "state", label: "Integration status", width: 210 }
], [
  { cap: "Card payments in", who: "Peach Payments", state: "Integrated. Card details are handled by the provider; TitoPay does not store card numbers.", __tone: GOOD },
  { cap: "Bank payouts out", who: "Peach Payouts", state: "Integrated. Requires its own credentials and a passing connection test before it will pay.", __tone: GOOD },
  { cap: "Identity verification", who: "Internal", state: "Performed in-platform. No third-party verification bureau is wired into the code.", __tone: WARN },
  { cap: "Value-added services", who: "Flash (partial)", state: "Can authenticate and list products. Cannot complete a purchase, so the services stay off.", __tone: WARN },
  { cap: "Banking / settlement", who: "None in code", state: "No banking adapter is present in the codebase. Any banking arrangement is operational, not software-integrated.", __tone: OFF }
], { toneKey: "state" });

panel("Read this table carefully", [
  "It describes the software. A signed commercial agreement, a bank account, or a manual process can exist without a "
  + "corresponding adapter in the code, and several probably do. What this says is narrower and more useful for "
  + "planning: which capabilities the platform can currently perform by itself, end to end, without somebody doing "
  + "something by hand.",
  "If an earlier version of this overview named partners for identity verification, value-added services or banking, "
  + "treat those as commercial intent rather than delivered integration until the adapters exist."
], OFF);

/* ========================================================= SECURITY ===== */

h1("How the money is kept honest");

h2("Double entry, always");
body("Every movement writes a transaction and its ledger entries inside one database transaction. A debit without "
  + "its matching credit cannot be committed. A payment whose recipient cannot be resolved is refused before "
  + "anything moves, rather than taking the money and crediting nobody.");

h2("Exactly once");
body("Money paths take a transaction-scoped lock and re-check for a duplicate before writing. A double tap, two "
  + "open tabs, or a mobile network retrying a request it already delivered returns the original record rather than "
  + "charging a second time.");

h2("Refusals name a reason");
body("Where the platform declines - a limit, an unlaunched service, a locked profile, a refund that would exceed "
  + "the original - it answers with a sentence a customer can act on and states whether any money moved. "
  + "“No wallet debit was made” is a literal statement, not reassurance.");

h2("It is checked, not asserted");
bullets([
  "1 768 automated tests run against a real database on every change.",
  "Browser harnesses drive the shipped bundle on real handset widths rather than a development build.",
  "A read-only reconciliation ships inside the API release and can be pointed at production: it checks every QR "
  + "payment against its own ledger entries and exits non-zero if a single one does not balance.",
  "Backups are encrypted, verified by test-restore, rotated on a 35-day cycle and copied off the server."
]);

/* =========================================================== LIMITS OF ==== */

h1("What this document does not cover");
bullets([
  "Licensing and regulatory permissions. Nothing here should be read as a statement about which licences TitoPay or "
  + "its providers hold; that belongs in the compliance pack and is not derivable from source code.",
  "Certifications. Any PCI DSS or similar standing belongs to the provider that holds it, for the scope it covers. "
  + "TitoPay's own scope is reduced by not handling card numbers, which is a design decision, not a certification.",
  "Commercial terms with banks or suppliers.",
  "Financial performance, volumes or customer numbers."
]);

panel("The one sentence to take away", [
  "TitoPay today is a working wallet, a working business toolkit and three working marketplaces, with card-in and "
  + "bank-out handled by an integrated provider - and with value-added services, marketplace and cash rails still "
  + "ahead of it rather than behind it."
]);

/* ========================================================== FOOTERS ====== */

const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i += 1) {
  doc.switchToPage(range.start + i);
  // WRITING A FOOTER MUST NOT CREATE A PAGE. pdfkit adds one the moment text
  // is placed below the bottom margin, so a five page document came out
  // fifteen: five of content and ten blank ones the footers made. Dropping the
  // bottom margin for the footer pass is the fix - the text is positioned
  // absolutely, so there is nothing for the margin to protect.
  doc.page.margins.bottom = 0;
  const y = PAGE_H - MARGIN + 6;
  doc.moveTo(MARGIN, y - 9).lineTo(MARGIN + CONTENT_W, y - 9).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.font("Helvetica").fontSize(7.2).fillColor(MUTED)
    .text("TitoPay (Pty) Ltd  ·  Confidential  ·  Describes build " + BUILD + " (" + COMMIT + ")  ·  " + DATED,
      MARGIN, y - 3, { width: CONTENT_W - 40, lineBreak: false });
  doc.text(String(i + 1) + " / " + range.count, MARGIN + CONTENT_W - 40, y - 3,
    { width: 40, align: "right", lineBreak: false });
}

const out = process.env.OUT || path.join(__dirname, "TitoPay-Platform-Overview.pdf");
doc.pipe(fs.createWriteStream(out)).on("finish", () => {
  console.log("written:", out, fs.statSync(out).size, "bytes,", range.count, "pages");
});
doc.end();
