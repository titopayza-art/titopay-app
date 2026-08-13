"use strict";

// THE TICKET AS A FILE. When a ticket is emailed, the message now carries a
// PDF the holder can save, print or forward: event, ticket type, holder,
// date, venue, the QR the door scans, and the code in clear text underneath
// for the night the scanner will not focus. Rendered entirely locally with
// pdfkit + qrcode - no fonts fetched, no images fetched, nothing leaves the
// server to build it.

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const NAVY = "#0b1f3f";
const BLUE = "#168ac2";
const MUTED = "#5b6b82";
const LINE = "#dbe6f2";

async function renderTicketPdf(ticket) {
  const qrPng = await QRCode.toBuffer(String(ticket.qr_payload || ticket.ticket_code), {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 480
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 36 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - 72;

    // Brand head.
    doc.font("Helvetica-Bold").fontSize(20).fillColor(BLUE).text("TitoPay", 36, 40, { continued: true })
      .fillColor(NAVY).text(" Ticket");
    doc.moveTo(36, 70).lineTo(36 + width, 70).lineWidth(1).strokeColor(LINE).stroke();

    // Event.
    doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY)
      .text(String(ticket.event_name || "Event"), 36, 84, { width });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(11).fillColor(MUTED)
      .text(String(ticket.ticket_name || "General admission"), { width });

    const detail = (label, value) => {
      if (!value) return;
      doc.moveDown(0.55);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE).text(label.toUpperCase(), { width });
      doc.font("Helvetica").fontSize(11).fillColor(NAVY).text(String(value), { width });
    };
    detail("When", ticket.when);
    detail("Where", ticket.where);
    detail("Ticket holder", ticket.attendee_name || ticket.owner_name);
    detail("Order", ticket.order_reference);

    // QR, centred, with the code beneath it.
    const qrSize = 170;
    const qrX = 36 + (width - qrSize) / 2;
    let qrY = doc.y + 16;
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
    qrY += qrSize + 10;
    doc.font("Courier-Bold").fontSize(15).fillColor(NAVY)
      .text(String(ticket.ticket_code || ""), 36, qrY, { width, align: "center" });

    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text("Show this QR code, or read out the ticket code, at the entrance. A ticket admits once: keep this document private, because anyone holding it can enter with it.",
        36, qrY + 26, { width, align: "center" });
    doc.text(`Copyright © ${new Date().getUTCFullYear()} TitoPay. All Rights Reserved.`,
      36, doc.page.height - 52, { width, align: "center" });

    doc.end();
  });
}

module.exports = { renderTicketPdf };
