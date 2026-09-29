"use strict";

// TITOPAY - INVESTOR AND BANKING PRESENTATION
//
//   cd api && NODE_PATH=$PWD/node_modules node ../docs/overview/build-deck.js
//
// A presentation, not a report: landscape, one idea per slide, short lines.
//
// TWO RULES THIS FILE KEEPS, because the audience is a bank or an investor and
// both will rely on it:
//
//   1. No invented numbers. Every figure here - the fee schedule, the
//      verification limits, what is live - comes from the platform itself.
//      There are no market-size or adoption statistics, because this
//      repository is not a source for them. They belong in the deck, but they
//      have to come from the business with a citation behind them.
//
//   2. Nothing is described as delivered unless it is. Roadmap is presented as
//      roadmap, which is ordinary and expected in a deck, and a capability
//      that is not live is not written in the present tense.

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const NAVY = "#0b1f3f";
const DEEP = "#071630";
const BLUE = "#2f5cff";
const SKY = "#5b9df9";
const PALE = "#b9cae6";
const INK = "#12233f";
const MUTED = "#6b7a93";
const LINE = "#dce6f4";
const WASH = "#f3f7fd";
const GOLD = "#c9a227";

const W = 841.89;
const H = 595.28;
const M = 54;
const CW = W - M * 2;

// The brand line, in one place. It appears on the cover and the closing
// slide, and a tagline that differs between two slides of the same deck is
// the first thing a reader notices and the last thing anybody checks.
const TAGLINE = "Smart Payments, Simplified";

const doc = new PDFDocument({ size: [W, H], margin: 0, bufferPages: true,
  info: { Title: "TitoPay - Investor Overview", Author: "TitoPay (Pty) Ltd" } });

let slideNo = 0;

function wordmark(x, y, size, light) {
  doc.font("Helvetica-Bold").fontSize(size);
  const w = doc.widthOfString("Tito");
  doc.fillColor(light ? "#ffffff" : NAVY).text("Tito", x, y, { lineBreak: false });
  doc.fillColor(light ? SKY : BLUE).text("Pay", x + w, y, { lineBreak: false });
}

// Every slide starts the same way so the deck has one rhythm.
//
// THE HEADING OWNS ITS OWN SPACE. This used to park the cursor on a fixed
// y after drawing the title, which is only safe while every title is one
// line. A title that wrapped to two ran past that fixed line and the body
// copy was drawn straight over it. The bottom of the title is measured here
// instead, so the heading can be any length and the copy still clears it.
function slide(kicker, title, opts = {}) {
  if (slideNo > 0) doc.addPage();
  slideNo += 1;
  doc.rect(0, 0, W, H).fillColor("#ffffff").fill();
  // A thin brand edge down the left of every slide.
  doc.rect(0, 0, 6, H).fillColor(BLUE).fill();
  if (kicker) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE)
      .text(kicker.toUpperCase(), M, 48, { characterSpacing: 2.2, lineBreak: false });
  }
  let bottom = 96;
  if (title) {
    const size = opts.size || 30;
    const width = opts.titleWidth || CW;
    doc.font("Helvetica-Bold").fontSize(size).fillColor(NAVY);
    bottom = 68 + doc.heightOfString(title, { width, lineGap: 1 });
    doc.text(title, M, 68, { width, lineGap: 1 });
  }
  doc.y = bottom + (opts.gap === undefined ? 26 : opts.gap);
}

// Move down to a chosen line, but never backwards. The slides below place
// their blocks on a deliberate grid; this keeps that grid while making it
// impossible for a block to be pulled back up into the heading.
function flow(y) {
  doc.y = Math.max(doc.y, y);
}

function lead(text, width) {
  doc.font("Helvetica").fontSize(13).fillColor(MUTED)
    .text(text, M, doc.y, { width: width || CW - 120, lineGap: 4 });
  doc.y += 14;
}

// A row of cards. The workhorse of the deck.
function cards(items, opts = {}) {
  const perRow = opts.perRow || items.length;
  const gap = 16;
  const cardW = (CW - gap * (perRow - 1)) / perRow;
  // THE CARD SIZES TO ITS CONTENT, rather than to a number typed in per slide.
  // Fixed heights left a band of dead space under the shortest card on every
  // row, which on a deck reads as an unfinished slide. Measured here so a
  // reworded card cannot reintroduce it.
  const cardH = opts.height || (() => {
    let tallest = 0;
    for (const item of items) {
      let h = 20;
      if (item.big) h += 38;
      doc.font("Helvetica-Bold").fontSize(12.5);
      h += doc.heightOfString(item.title, { width: cardW - 36, lineGap: 1 }) + 6;
      if (item.body) {
        doc.font("Helvetica").fontSize(10);
        h += doc.heightOfString(item.body, { width: cardW - 36, lineGap: 2.6 });
      }
      tallest = Math.max(tallest, h + 22);
    }
    return Math.max(tallest, 118);
  })();
  let x = M;
  let y = doc.y;
  items.forEach((item, i) => {
    if (i > 0 && i % perRow === 0) { x = M; y += cardH + gap; }
    doc.roundedRect(x, y, cardW, cardH, 10)
      .fillColor(opts.dark ? "#10294f" : WASH).fill();
    if (!opts.dark) doc.roundedRect(x, y, cardW, cardH, 10).lineWidth(0.7).strokeColor(LINE).stroke();
    let ty = y + 20;
    if (item.big) {
      doc.font("Helvetica-Bold").fontSize(30).fillColor(opts.dark ? SKY : BLUE)
        .text(item.big, x + 18, ty, { width: cardW - 36, lineBreak: false });
      ty += 38;
    }
    doc.font("Helvetica-Bold").fontSize(12.5).fillColor(opts.dark ? "#ffffff" : NAVY)
      .text(item.title, x + 18, ty, { width: cardW - 36, lineGap: 1 });
    ty = doc.y + 6;
    if (item.body) {
      doc.font("Helvetica").fontSize(10).fillColor(opts.dark ? PALE : MUTED)
        .text(item.body, x + 18, ty, { width: cardW - 36, lineGap: 2.6 });
    }
    x += cardW + gap;
  });
  doc.y = y + cardH + 18;
}

function ticks(items, opts = {}) {
  const perCol = Math.ceil(items.length / (opts.cols || 1));
  const colW = (CW - 28) / (opts.cols || 1);
  const startY = doc.y;
  let maxY = startY;
  items.forEach((item, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = M + col * (colW + 28);
    const y = startY + row * (opts.rowH || 30);
    // THE TICK IS DRAWN, NOT TYPED. U+2713 is not in WinAnsiEncoding, which
    // is what pdfkit uses for the built-in Helvetica, and it was written into
    // the page as its raw code point - two bytes that come out as an
    // apostrophe followed by nothing. Two strokes give a tick on any reader.
    const cx = x + 6;
    const cy = y + 7;
    doc.circle(cx, cy, 6).fillColor(opts.tone || BLUE).fill();
    doc.moveTo(cx - 2.7, cy + 0.2).lineTo(cx - 0.8, cy + 2.1).lineTo(cx + 2.9, cy - 2.3)
      .lineWidth(1.3).lineCap("round").lineJoin("round").strokeColor("#ffffff").stroke();
    doc.font("Helvetica").fontSize(11.5).fillColor(INK)
      .text(item, x + 20, y, { width: colW - 24, lineGap: 2 });
    maxY = Math.max(maxY, doc.y);
  });
  doc.y = maxY + 12;
}

function feeTable(rows) {
  const cols = [
    { key: "svc", w: 0.42, label: "Service" },
    { key: "who", w: 0.22, label: "Paid by" },
    { key: "fee", w: 0.36, label: "Fee", align: "right" }
  ];
  const y0 = doc.y;
  doc.rect(M, y0, CW, 24).fillColor(NAVY).fill();
  let x = M + 14;
  doc.font("Helvetica-Bold").fontSize(8.4).fillColor("#ffffff");
  cols.forEach((c) => {
    doc.text(c.label.toUpperCase(), x, y0 + 8,
      { width: CW * c.w - 20, align: c.align || "left", characterSpacing: 1, lineBreak: false });
    x += CW * c.w;
  });
  let y = y0 + 24;
  rows.forEach((row, i) => {
    const h = 25;
    if (i % 2 === 1) doc.rect(M, y, CW, h).fillColor("#f8fafd").fill();
    let cx = M + 14;
    cols.forEach((c) => {
      doc.font(c.key === "svc" ? "Helvetica-Bold" : "Helvetica").fontSize(10.4)
        .fillColor(c.key === "fee" ? BLUE : INK)
        .text(row[c.key], cx, y + 7, { width: CW * c.w - 20, align: c.align || "left", lineBreak: false });
      cx += CW * c.w;
    });
    doc.moveTo(M, y + h).lineTo(M + CW, y + h).lineWidth(0.4).strokeColor(LINE).stroke();
    y += h;
  });
  doc.y = y + 16;
}

/* =============================================================== 1. COVER */

doc.rect(0, 0, W, H).fillColor(NAVY).fill();
doc.rect(0, 0, W, 6).fillColor(BLUE).fill();
// A soft accent block, so the cover is not a flat rectangle.
doc.roundedRect(W - 250, -70, 330, 330, 40).fillColor("#10294f").fill();
doc.roundedRect(W - 180, 300, 300, 300, 40).fillColor("#0e2447").fill();

wordmark(M, 96, 44, true);
doc.font("Helvetica").fontSize(13).fillColor(PALE)
  .text(TAGLINE, M, 152, { characterSpacing: 0.6, lineBreak: false });

doc.font("Helvetica-Bold").fontSize(40).fillColor("#ffffff")
  .text("One wallet for\neveryday payments\nin South Africa.", M, 232, { width: 470, lineGap: 6 });

doc.font("Helvetica").fontSize(12.5).fillColor(PALE)
  .text("People use it to pay and to get paid. Businesses use it to sell, invoice and settle.",
    M, 420, { width: 430, lineGap: 4 });

doc.font("Helvetica").fontSize(9).fillColor("#6d86ad")
  .text("Investor and banking overview  ·  Confidential", M, H - 62, { lineBreak: false });
slideNo = 1;

/* ========================================================= 2. THE PICTURE */

slide("The opportunity", "Everyday money still runs on\nbranch-era accounts.");
lead("South Africans pay each other, run small businesses and get paid every day. The accounts and card "
  + "machines they use were built around branches and rental contracts, and both are a poor fit for a "
  + "phone or a market stall.", 580);

flow(250);
cards([
  { title: "People", body: "A person wants to send money, receive it and pay a shop without a branch visit or a form to fill in." },
  { title: "Small businesses", body: "A trader wants to take a payment, issue an invoice and get settled without a merchant onboarding process." },
  { title: "Licensed providers", body: "Providers hold the licences and the rails. What they need is reach and a product customers open every day." }
], { perRow: 3 });

doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(MUTED)
  .text("Market sizing and adoption figures are held separately and should be presented with their sources.",
    M, H - 72, { width: CW });

/* ============================================================ 3. WHAT WE ARE */

slide("What TitoPay is", "One account, three parts.");
flow(190);

cards([
  { big: "01", title: "The wallet", body: "Send, receive, pay by QR, request money, split a bill, save in a group, top up by card and withdraw to a bank." },
  { big: "02", title: "The business side", body: "Take payments, run a till with stock, issue quotes and invoices, refund customers and settle to the bank." },
  { big: "03", title: "The marketplaces", body: "TitoPro for professional services, Book for appointments and a full platform for event ticketing." }
], { perRow: 3 });

doc.font("Helvetica").fontSize(11.5).fillColor(MUTED)
  .text("All three run on one balance, one identity and one record of every movement.", M, H - 88, { width: CW });

/* ========================================================== 4. THE WALLET */

slide("For people", "What a customer can do.");
flow(186);
ticks([
  "Send money by username, cellphone or email",
  "Pay any business by scanning its QR code",
  "Request money and get paid back",
  "Split a bill across a group",
  "Save together in a stokvel, with a proper register",
  "Top up from a bank card",
  "Withdraw to a South African bank account",
  "Buy and hold event tickets",
  "Hire a vetted professional",
  "Book an appointment"
], { cols: 2, rowH: 34 });

/* ======================================================== 5. THE BUSINESS */

slide("For business", "What a business can do.");
flow(186);
ticks([
  "Take payment by QR, with no terminal and no rental",
  "Ring up a basket from a product catalogue",
  "Track stock, restocks and stock takes",
  "Issue quotes, invoices and proformas as PDFs",
  "Refund a customer against the original sale",
  "Settle to a business bank account",
  "Pay many people at once from one batch",
  "Give staff till or door access safely",
  "Sell tickets and run the door",
  "Publish a booking page customers can use"
], { cols: 2, rowH: 34 });

/* ===================================================== 6. THE MARKETPLACES */

slide("Where it goes further", "Three marketplaces run on\nthe same balance.");
flow(200);
cards([
  { title: "TitoPro", body: "Customers find and hire vetted professionals for trades, home services and creative work. Ratings, reporting and moderation are built in." },
  { title: "Book", body: "Any business with a diary gets a public booking page carrying its services, staff or rooms, opening hours and confirmations." },
  { title: "Ticketing", body: "Events from approval to the door: ticket types, seating, promoters, coupons, scanning, refunds and cashless wristbands." }
], { perRow: 3 });

doc.font("Helvetica").fontSize(11.5).fillColor(MUTED)
  .text("Each one brings its own customers into the wallet, and each one earns on what flows through it.",
    M, H - 84, { width: CW });

/* ======================================================= 7. HOW WE EARN */

slide("The model", "TitoPay earns a fee when\nmoney moves.");
flow(168);
lead("Every service carries a published fee taken from a single schedule. The customer sees the fee before "
  + "confirming the payment.", 580);

flow(238);
cards([
  { big: "1.5%", title: "On business takings", body: "Charged to the business on QR sales and on settlement to the bank." },
  { big: "10%", title: "On ticket sales", body: "Commission to the organiser, plus a service fee on each order." },
  { big: "R20", title: "On TitoPro jobs", body: "A flat fee plus 1.5%, charged to the professional on completed work." },
  { big: "3%", title: "On bulk payouts", body: "Payroll, grants, allowances and distributions." }
], { perRow: 4 });

/* =============================================================== 8. FEES */

slide("The schedule", "One published fee schedule,\nthe same for everybody.", { size: 26 });
flow(150);
feeTable([
  { svc: "Send or receive money", who: "Customer", fee: "Free" },
  { svc: "QR payment", who: "Customer", fee: "R0.50" },
  { svc: "QR payment", who: "Business", fee: "1.5% of the sale" },
  { svc: "Wallet top-up by card", who: "Customer", fee: "R5.00" },
  { svc: "Withdrawal to a bank", who: "Customer", fee: "R10.00" },
  { svc: "Settlement to a business bank account", who: "Business", fee: "1.5%" },
  { svc: "Quote, invoice or proforma PDF", who: "Business", fee: "R2.50" },
  { svc: "Refund to a customer", who: "Business", fee: "R1.00" },
  { svc: "Event ticket", who: "Buyer", fee: "R10.00 per order" },
  { svc: "Event ticket sales", who: "Organiser", fee: "10% commission" }
]);
doc.font("Helvetica").fontSize(9.5).fillColor(MUTED)
  .text("Operators can adjust the schedule centrally. Customers always see the fee before confirming.",
    M, doc.y, { width: CW });

/* ========================================================= 9. COMPLIANCE */

slide("Risk and compliance", "Limits follow the level\nof verification.");
flow(162);
lead("Every account sits on a verification level that sets what it may move and hold. These limits are "
  + "TitoPay's own operational controls, applied on top of monitoring, screening and account status.", 600);

flow(240);
cards([
  { big: "01", title: "Limited access", body: "Lower ceilings apply while identity verification is outstanding.\n\nR2 500 per payment\nR25 000 a month" },
  { big: "02", title: "Basic verified", body: "Identity has been confirmed.\n\nR10 000 per payment\nR200 000 a month" },
  { big: "03", title: "Fully verified", body: "Identity and documentary due diligence are complete.\n\nNo fixed monthly ceiling. Activity is monitored throughout." }
], { perRow: 3 });

/* ============================================================ 10. TRUST */

slide("Trust", "How the money is kept\naccounted for.");
flow(190);
cards([
  { title: "Double-entry ledger", body: "Every movement is written as matching entries in one step. Money cannot appear or disappear between accounts." },
  { title: "Card details never held", body: "Card payments are processed by a licensed provider. TitoPay does not store card numbers." },
  { title: "Charged once", body: "A repeated tap or a retried request returns the original transaction rather than charging again." },
  { title: "Monitored and backed up", body: "Transaction monitoring, screening and audit trails run throughout. Backups are encrypted, verified and held off-site." }
], { perRow: 2 });

/* ========================================================== 11. TODAY */

slide("Where it stands", "Live today.");
flow(156);
lead("The platform is built and operating. Everything on this slide is in customers' hands today.", 600);

flow(220);
cards([
  { big: "28", title: "Services live", body: "Across personal and business accounts." },
  { big: "3", title: "Marketplaces", body: "TitoPro, Book and Ticketing, all operating." },
  { big: "2", title: "Money rails", body: "Card payments in, bank settlement out." },
  { big: "1", title: "Ledger", body: "One record behind every product." }
], { perRow: 4 });

doc.font("Helvetica").fontSize(11.5).fillColor(MUTED)
  .text("Card acquiring and bank payouts run through Peach Payments.", M, H - 92, { width: CW });

/* ========================================================== 12. NEXT */

slide("What comes next", "The next rails to open.");
flow(162);
lead("Each of these is already built into the platform and is waiting on a supply agreement.", 600);

flow(232);
cards([
  { title: "Prepaid and utilities", body: "Airtime, data, electricity, vouchers and bill payments, which are the most frequent reasons a customer opens a wallet." },
  { title: "Cash in and out", body: "Reaching the customers who still need somewhere physical to load or draw cash." },
  { title: "Marketplace and beyond", body: "Goods, cross-border payments and further services on the same wallet and the same ledger." }
], { perRow: 3 });

/* ============================================================ 13. CLOSE */

doc.addPage();
slideNo += 1;
doc.rect(0, 0, W, H).fillColor(NAVY).fill();
doc.rect(0, 0, W, 6).fillColor(BLUE).fill();
doc.roundedRect(W - 210, -80, 320, 320, 40).fillColor("#10294f").fill();

wordmark(M, 92, 34, true);
doc.font("Helvetica-Bold").fontSize(34).fillColor("#ffffff")
  .text("The platform is built.\nThe next step is reach.", M, 220, { width: 520, lineGap: 7 });

doc.font("Helvetica").fontSize(12.5).fillColor(SKY)
  .text(TAGLINE, M, 404, { characterSpacing: 0.4, lineBreak: false });
doc.font("Helvetica").fontSize(12).fillColor(PALE)
  .text("TitoPay (Pty) Ltd", M, 436, { lineBreak: false });
doc.font("Helvetica").fontSize(11).fillColor("#6d86ad")
  .text("titopay.co.za", M, 458, { lineBreak: false });

/* =========================================================== SLIDE NUMBERS */

const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i += 1) {
  doc.switchToPage(range.start + i);
  // The bottom margin is dropped for this pass: pdfkit adds a page the moment
  // text is placed below it, and a footer must never create a slide.
  doc.page.margins.bottom = 0;
  const dark = i === 0 || i === range.count - 1;
  if (i === 0) continue;
  doc.font("Helvetica").fontSize(9).fillColor(dark ? "#6d86ad" : MUTED)
    .text(String(i + 1).padStart(2, "0"), W - M - 30, H - 42, { width: 30, align: "right", lineBreak: false });
  if (!dark) {
    doc.font("Helvetica").fontSize(8.4).fillColor("#b6c2d4")
      .text("TitoPay  ·  Confidential", M, H - 42, { lineBreak: false });
  }
}

const out = process.env.OUT || path.join(__dirname, "TitoPay-Investor-Overview.pdf");
doc.pipe(fs.createWriteStream(out)).on("finish", () => {
  console.log("written:", out, fs.statSync(out).size, "bytes,", range.count, "slides");
});
doc.end();
