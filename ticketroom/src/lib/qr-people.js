// QR codes people make for posters and links (organiser event QR, admin QR
// maker). Same rules as php/api/lib/qr.php: plain #RRGGBB colours with enough
// contrast to scan; the text never appears in the SVG, only the squares.
const QRCode = require("qrcode");
const { bad, invalid } = require("./errors");

const colour = (c, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(c || "").trim()) ? String(c).trim().toUpperCase() : fallback);
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
async function qrForPeople(text, o = {}) {
  if (!text || Buffer.byteLength(text) > 1200) throw bad("Use between 1 and 1,200 characters.");
  const dark = colour(o.dark, "#0B1A33");
  const light = colour(o.light, "#FFFFFF");
  const ld = luminance(dark), ll = luminance(light);
  if (ld >= ll || (ll + 0.05) / (ld + 0.05) < 3) throw invalid({ dark: "Pick a darker colour for the squares, or a lighter background. Phones cannot read low-contrast codes." });
  const ecc = ["M", "Q", "H"].includes(o.ecc) ? o.ecc : "M";
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: ecc, margin: 4, color: { dark, light } });
}
module.exports = { qrForPeople };
