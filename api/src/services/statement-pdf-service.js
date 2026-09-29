"use strict";

// THE STATEMENT AS A DOCUMENT, BECAUSE THAT IS WHAT WAS PAID FOR.
//
// A customer pays a fee for an Email Statement and received an email whose
// body held a monospace block: "DATE | TYPE | AMOUNT | BALANCE | REFERENCE"
// followed by pipe-separated lines. On a phone every line wrapped across three
// rows and the columns stopped lining up, so the one thing the fee buys, a
// document you can send to a bank or a landlord, could not be used as one.
//
// This renders it properly: an A4 PDF with the TitoPay wordmark, the account
// block, the FICA-verified identity when the account has one, the totals, and
// the ledger as a real table that paginates. Built locally with pdfkit, the
// same way the ticket PDF is: no fonts fetched, no images fetched, nothing
// leaves the server to produce it.
//
// It is a record of TitoPay wallet activity and says so on every page. It is
// not a bank statement and must never present itself as one.

const PDFDocument = require("pdfkit");

const NAVY = "#0b1f3f";
const BLUE = "#5b9df9";
const INK = "#12233f";
const MUTED = "#6b7a93";
const LINE = "#dbe6f2";
const BAND = "#f2f6fc";
const CREDIT = "#0a7d55";
const DEBIT = "#9e2b34";

const MARGIN = 46;
const money = (value) => Number(value || 0).toFixed(2);
const CREDIT_KINDS = new Set(["credit", "release"]);

// Columns are declared once and used by both the header and every row, so a
// heading can never drift away from the values printed under it.
const COLUMNS = [
  { key: "date", label: "DATE", width: 96 },
  { key: "type", label: "TYPE", width: 62 },
  { key: "amount", label: "AMOUNT", width: 88, align: "right" },
  { key: "balance", label: "BALANCE", width: 88, align: "right" },
  { key: "reference", label: "REFERENCE", width: 169 }
];

function wordmark(doc, x, y, size) {
  doc.font("Helvetica-Bold").fontSize(size);
  const titoWidth = doc.widthOfString("Tito");
  doc.fillColor(NAVY).text("Tito", x, y, { lineBreak: false });
  doc.fillColor(BLUE).text("Pay", x + titoWidth, y, { lineBreak: false });
  return titoWidth + doc.widthOfString("Pay");
}

function tableHeader(doc, y) {
  const width = doc.page.width - MARGIN * 2;
  doc.rect(MARGIN, y, width, 20).fill(BAND);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED);
  let x = MARGIN + 8;
  for (const column of COLUMNS) {
    doc.text(column.label, x, y + 6.5, { width: column.width - 10, align: column.align || "left", lineBreak: false });
    x += column.width;
  }
  return y + 20;
}

function pageFurniture(doc, reference, pageNumber) {
  const bottom = doc.page.height - 34;
  doc.font("Helvetica").fontSize(7).fillColor(MUTED);
  doc.text(
    "A record of TitoPay wallet activity. This is not a bank statement.",
    MARGIN, bottom, { width: 320, lineBreak: false }
  );
  doc.text(
    `${reference}  ·  page ${pageNumber}`,
    doc.page.width - MARGIN - 220, bottom, { width: 220, align: "right", lineBreak: false }
  );
}

/**
 * @param {object} statement the shape loadEmailStatementData returns
 * @param {string} reference the customer-visible statement reference
 * @returns {Promise<Buffer>}
 */
async function renderStatementPdf(statement, reference) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const account = statement.account || {};
    const totals = statement.totals || { moneyIn: 0, moneyOut: 0 };
    const rows = Array.isArray(statement.rows) ? statement.rows : [];
    const net = Number(totals.moneyIn || 0) - Number(totals.moneyOut || 0);
    const currency = account.currency || "ZAR";
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - MARGIN * 2;
    let page = 1;

    // ---- Masthead ----------------------------------------------------------
    wordmark(doc, MARGIN, 44, 24);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY)
      .text("WALLET STATEMENT", pageWidth - MARGIN - 220, 46, { width: 220, align: "right", lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(reference, pageWidth - MARGIN - 220, 60, { width: 220, align: "right", lineBreak: false });
    doc.moveTo(MARGIN, 86).lineTo(pageWidth - MARGIN, 86).lineWidth(1).strokeColor(LINE).stroke();

    let y = 104;

    // ---- Who this belongs to, and for when --------------------------------
    doc.font("Helvetica-Bold").fontSize(15).fillColor(INK)
      .text(String(account.full_name || "TitoPay customer"), MARGIN, y, { width: contentWidth - 200, lineBreak: false });
    y += 20;
    const identity = [
      account.email,
      account.wallet_number ? `Wallet ${account.wallet_number}` : "",
      `${String(account.account_type || account.kind || "personal").replace(/^./, (c) => c.toUpperCase())} account`
    ].filter(Boolean).join("   ·   ");
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(identity, MARGIN, y, { width: contentWidth, lineBreak: false });
    y += 14;
    doc.text(`Period: ${statement.period || "All available wallet activity"}`, MARGIN, y, { width: contentWidth, lineBreak: false });
    y += 24;

    // ---- The verified identity, when there is one --------------------------
    //
    // An approved FICA review is what makes this document usable at a bank or
    // with a landlord, so it sits above the figures rather than in a footnote.
    if (statement.fica) {
      const fica = statement.fica;
      const lines = [
        fica.idNumber ? `${fica.identityKind || "Identity"}: ${fica.idNumber}` : "",
        fica.companyRegistrationNumber ? `Company registration (CIPC): ${fica.companyRegistrationNumber}` : "",
        fica.address ? `Address: ${fica.address}` : ""
      ].filter(Boolean);
      const boxHeight = 24 + lines.length * 12;
      doc.roundedRect(MARGIN, y, contentWidth, boxHeight, 6).fill(BAND);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY)
        .text("FICA-VERIFIED ACCOUNT HOLDER", MARGIN + 10, y + 8, { width: contentWidth - 20, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(INK);
      lines.forEach((line, index) => {
        doc.text(line, MARGIN + 10, y + 22 + index * 12, { width: contentWidth - 20, lineBreak: false });
      });
      y += boxHeight + 18;
    }

    // ---- The four figures that answer "what happened" ----------------------
    const summary = [
      ["Money in", `${currency} ${money(totals.moneyIn)}`, CREDIT],
      ["Money out", `${currency} ${money(totals.moneyOut)}`, DEBIT],
      ["Net movement", `${net < 0 ? "-" : ""}${currency} ${money(Math.abs(net))}`, INK],
      ["Closing balance", `${currency} ${money(account.available_balance)}`, INK]
    ];
    const cellWidth = contentWidth / summary.length;
    doc.roundedRect(MARGIN, y, contentWidth, 52, 6).fill(BAND);
    summary.forEach(([label, value, colour], index) => {
      const x = MARGIN + index * cellWidth + 12;
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(label.toUpperCase(), x, y + 11, { width: cellWidth - 20, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(colour)
        .text(value, x, y + 25, { width: cellWidth - 20, lineBreak: false });
    });
    y += 68;

    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(`${statement.totalCount || rows.length} wallet movement${(statement.totalCount || rows.length) === 1 ? "" : "s"}`
        + (statement.totalCount > rows.length ? `, showing the most recent ${rows.length}` : ""),
      MARGIN, y, { width: contentWidth, lineBreak: false });
    y += 18;

    // ---- The ledger --------------------------------------------------------
    y = tableHeader(doc, y);
    doc.font("Helvetica").fontSize(8);
    if (!rows.length) {
      doc.fillColor(MUTED).text("No wallet movements were recorded for this period.", MARGIN + 8, y + 10,
        { width: contentWidth - 16, lineBreak: false });
      y += 30;
    }
    for (const [index, row] of rows.entries()) {
      // A new page keeps the same table head, so page two is still readable on
      // its own rather than being a list of unlabelled numbers.
      if (y > doc.page.height - 76) {
        pageFurniture(doc, reference, page);
        doc.addPage({ size: "A4", margin: 0 });
        page += 1;
        y = 52;
        y = tableHeader(doc, y);
        doc.font("Helvetica").fontSize(8);
      }
      if (index % 2 === 1) doc.rect(MARGIN, y, contentWidth, 18).fill("#fafcff");
      const isCredit = CREDIT_KINDS.has(String(row.entry_type));
      const when = new Date(row.created_at);
      const values = {
        date: `${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 16)}`,
        type: String(row.entry_type || "").toUpperCase(),
        amount: `${isCredit ? "+" : "-"}${money(Math.abs(Number(row.amount || 0)))}`,
        balance: money(row.balance_after),
        reference: String(row.reference || "").slice(0, 44)
      };
      let x = MARGIN + 8;
      for (const column of COLUMNS) {
        doc.fillColor(column.key === "amount" ? (isCredit ? CREDIT : DEBIT) : INK);
        doc.font(column.key === "amount" ? "Helvetica-Bold" : "Helvetica");
        doc.text(values[column.key], x, y + 5, {
          width: column.width - 10, align: column.align || "left", lineBreak: false, ellipsis: true
        });
        x += column.width;
      }
      doc.moveTo(MARGIN, y + 18).lineTo(pageWidth - MARGIN, y + 18).lineWidth(0.5).strokeColor(LINE).stroke();
      y += 18;
    }

    pageFurniture(doc, reference, page);
    doc.end();
  });
}

module.exports = { renderStatementPdf };
