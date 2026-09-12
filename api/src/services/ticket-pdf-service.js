"use strict";

// THE TICKET AS A FILE, IN THE APPROVED DESIGN. When a ticket is emailed,
// the message carries a PDF matching the approved ticket card: TitoPay
// wordmark, navy event header, right-aligned details, the QR in its own
// box, a perforation line, and the ticket code large enough to read out at
// a loud gate. Rendered entirely locally with pdfkit + qrcode - no fonts
// fetched, no images fetched, nothing leaves the server to build it.

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// The paper every printed TitoPay sheet shares -- the marketing poster, both
// QR posters and this ticket. The ticket used to carry its own approximate
// pale blue; it takes the real one now. The card stays white and the QR keeps
// its own white quiet zone inside that card, so scanning is untouched.
const PAGE_BG = "#f0f4ff";
const NAVY = "#0b1f3f";
const HEADER_NAVY = "#0a1b3d";
const BLUE = "#5b9df9";
const EYEBROW_BLUE = "#7da4f5";
const HEADER_SOFT = "#c7d7f5";
const MUTED = "#6b7a93";
const LINE = "#dbe6f2";

async function renderTicketPdf(ticket) {
  const qrPng = await QRCode.toBuffer(String(ticket.qr_payload || ticket.ticket_code), {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 480
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;

    // Page ground.
    doc.rect(0, 0, pageW, pageH).fill(PAGE_BG);

    // Wordmark: "Tito" navy, "Pay" blue, centred as one unit.
    doc.font("Helvetica-Bold").fontSize(40);
    const titoW = doc.widthOfString("Tito");
    const payW = doc.widthOfString("Pay");
    const markX = (pageW - titoW - payW) / 2;
    doc.fillColor(NAVY).text("Tito", markX, 52, { lineBreak: false });
    doc.fillColor(BLUE).text("Pay", markX + titoW, 52, { lineBreak: false });

    // The ticket card.
    const cardX = 68;
    const cardW = pageW - cardX * 2;
    const cardY = 140;
    const cardH = 610;
    const radius = 16;
    doc.roundedRect(cardX, cardY, cardW, cardH, radius).fill("#ffffff");

    // Navy header, rounded on top only.
    const headH = 152;
    doc.save();
    doc.roundedRect(cardX, cardY, cardW, headH, radius).clip();
    doc.rect(cardX, cardY, cardW, headH).fill(HEADER_NAVY);
    doc.restore();
    doc.rect(cardX, cardY + headH - radius, cardW, radius).fill(HEADER_NAVY);

    doc.font("Helvetica-Bold").fontSize(11).fillColor(EYEBROW_BLUE)
      .text("TITOPAY TICKET", cardX, cardY + 32, { width: cardW, align: "center", characterSpacing: 4 });
    doc.font("Helvetica-Bold").fontSize(27).fillColor("#ffffff")
      .text(String(ticket.event_name || "Event"), cardX + 24, cardY + 52, { width: cardW - 48, align: "center" });
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#e6ecf9")
      .text(String(ticket.when || ""), cardX, cardY + 96, { width: cardW, align: "center" });
    doc.font("Helvetica-Bold").fontSize(13).fillColor(HEADER_SOFT)
      .text(String(ticket.where || ""), cardX, cardY + 116, { width: cardW, align: "center" });

    // Details: label left, value right, exactly like the card.
    const detailX = cardX + 36;
    const detailW = cardW - 72;
    let y = cardY + headH + 28;
    const row = (label, value) => {
      if (!value) return;
      doc.font("Helvetica-Bold").fontSize(13).fillColor(MUTED).text(label, detailX, y, { width: detailW, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(13).fillColor(NAVY).text(String(value), detailX, y, { width: detailW, align: "right" });
      y += 26;
    };
    row("Ticket", ticket.ticket_name || "General admission");
    row("Holder", ticket.attendee_name || ticket.owner_name);
    row("Order", ticket.order_reference);

    // QR in its own soft box.
    const qrBox = 200;
    const qrBoxX = cardX + (cardW - qrBox) / 2;
    const qrBoxY = y + 14;
    doc.roundedRect(qrBoxX, qrBoxY, qrBox, qrBox, 12).lineWidth(1.2).strokeColor(LINE).stroke();
    doc.image(qrPng, qrBoxX + 12, qrBoxY + 12, { width: qrBox - 24, height: qrBox - 24 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(MUTED)
      .text("Scan at the entrance", cardX, qrBoxY + qrBox + 10, { width: cardW, align: "center" });

    // Perforation with edge notches.
    const perfY = qrBoxY + qrBox + 36;
    doc.save();
    doc.moveTo(cardX + 24, perfY).lineTo(cardX + cardW - 24, perfY)
      .lineWidth(1.4).dash(5, { space: 5 }).strokeColor("#b9c4d8").stroke();
    doc.undash();
    doc.circle(cardX, perfY, 13).fill(PAGE_BG);
    doc.circle(cardX + cardW, perfY, 13).fill(PAGE_BG);
    doc.restore();

    // Ticket code, large and spaced.
    doc.font("Helvetica-Bold").fontSize(11).fillColor(MUTED)
      .text("TICKET CODE", cardX, perfY + 24, { width: cardW, align: "center", characterSpacing: 4 });
    doc.font("Helvetica-Bold").fontSize(32).fillColor(NAVY)
      .text(String(ticket.ticket_code || ""), cardX, perfY + 42, { width: cardW, align: "center", characterSpacing: 8 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(MUTED)
      .text("Present this ticket at the entrance. Do not share the code publicly.",
        cardX + 24, perfY + 86, { width: cardW - 48, align: "center" });

    // Sign-off under the card.
    doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY)
      .text("Smart Payments. Simplified.", 0, cardY + cardH + 22, { width: pageW, align: "center" });

    doc.end();
  });
}

module.exports = { renderTicketPdf };
