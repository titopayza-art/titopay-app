// Ticket QR payload: TR1.<code>.<version>.<signature>
// The code is random (not a database id) and the HMAC signature means a
// guessed or edited payload is rejected before any database lookup. Bumping
// qr_version (transfer, reissue) invalidates every earlier copy.
const config = require("../../config");
const { hmac, safeEqual } = require("../../lib/crypto");

const sig = (code, version) => hmac(config.keys.qr, `T|${code}|${version}`).toString("base64url").slice(0, 22);

const payloadFor = (ticket) => `TR1.${ticket.code}.${ticket.qr_version}.${sig(ticket.code, ticket.qr_version)}`;

// Returns { code, version, signed: true } for a valid signed payload,
// { code, signed: false } for a bare typed ticket code, or null.
function parse(input) {
  const s = String(input || "").trim();
  const m = s.match(/^TR1\.([2-9A-HJ-NP-TV-Z]{10})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/);
  if (m) return safeEqual(m[3], sig(m[1], Number(m[2]))) ? { code: m[1], version: Number(m[2]), signed: true } : null;
  const typed = s.toUpperCase().replace(/[\s-]/g, "");
  if (/^[2-9A-HJ-NP-TV-Z]{10}$/.test(typed)) return { code: typed, signed: false };
  return null;
}

module.exports = { payloadFor, parse };
