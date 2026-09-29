"use strict";

// APPLE WALLET AND GOOGLE WALLET PASSES FOR EVENT TICKETS.
//
// A wallet pass is a SIGNED object: Apple validates a PKCS#7 signature made
// with a Pass Type ID certificate issued to the account holder, and Google
// validates an RS256 JWT signed with a Google Wallet service-account key.
// Neither can be faked or self-signed — so this whole service is switched on
// by configuration, and until the credentials are supplied it reports itself
// unconfigured and the app shows its honest fallback (the QR remains valid).
//
// Apple configuration (all required together):
//   APPLE_WALLET_CERT_P12_BASE64   the Pass Type ID certificate + key (.p12), base64
//   APPLE_WALLET_CERT_PASSWORD     the .p12 password
//   APPLE_WALLET_PASS_TYPE_ID      e.g. pass.za.co.titopay.ticket
//   APPLE_WALLET_TEAM_ID           the 10-character Apple Developer team id
//   APPLE_WALLET_WWDR_PEM_BASE64   Apple's WWDR intermediate certificate (PEM), base64
//
// Google configuration (all required together):
//   GOOGLE_WALLET_ISSUER_ID        numeric issuer id from the Google Wallet console
//   GOOGLE_WALLET_SA_EMAIL         the service account email
//   GOOGLE_WALLET_SA_KEY_BASE64    the service account's PRIVATE KEY (PEM), base64
//
// See WALLET_PASSES_SETUP.md for the exact steps to obtain each credential.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const forge = require("node-forge");
const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

const ICON_PATH = path.join(__dirname, "..", "assets", "wallet-icon.png");

/* ---- configuration ------------------------------------------------------- */

function appleConfig() {
  const p12 = process.env.APPLE_WALLET_CERT_P12_BASE64 || "";
  const password = process.env.APPLE_WALLET_CERT_PASSWORD || "";
  const passTypeId = process.env.APPLE_WALLET_PASS_TYPE_ID || "";
  const teamId = process.env.APPLE_WALLET_TEAM_ID || "";
  const wwdr = process.env.APPLE_WALLET_WWDR_PEM_BASE64 || "";
  if (!p12 || !passTypeId || !teamId) return null;
  return { p12, password, passTypeId, teamId, wwdr };
}

function googleConfig() {
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID || "";
  const email = process.env.GOOGLE_WALLET_SA_EMAIL || "";
  const key = process.env.GOOGLE_WALLET_SA_KEY_BASE64 || "";
  if (!issuerId || !email || !key) return null;
  return { issuerId, email, key: Buffer.from(key, "base64").toString("utf8") };
}

function appleWalletConfigured() {
  return Boolean(appleConfig());
}

function googleWalletConfigured() {
  return Boolean(googleConfig());
}

/* ---- short-lived download token ------------------------------------------
   Safari fetches the .pkpass by plain navigation, which cannot carry the
   Bearer header — so the authenticated endpoint hands out a short-lived HMAC
   token bound to the ticket code, and the download route checks it. */

const PASS_TOKEN_TTL_MS = 15 * 60 * 1000;

function signPassToken(ticketCode) {
  const expires = Date.now() + PASS_TOKEN_TTL_MS;
  const mac = crypto.createHmac("sha256", config.accessSecret)
    .update(`ticket-pass:${ticketCode}:${expires}`)
    .digest("base64url");
  return `${expires}.${mac}`;
}

function verifyPassToken(ticketCode, token) {
  const [expiresRaw, mac] = String(token || "").split(".");
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now() || !mac) return false;
  const expected = crypto.createHmac("sha256", config.accessSecret)
    .update(`ticket-pass:${ticketCode}:${expires}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- minimal ZIP writer ---------------------------------------------------
   A .pkpass is an ordinary ZIP; stored (uncompressed) entries are valid and
   keep this dependency-free. Local file headers, then a central directory. */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function zipStored(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // method: stored
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x5761, 12);       // date (fixed, deterministic)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5761, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += 30 + nameBytes.length + data.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ---- Apple pass ----------------------------------------------------------- */

function buildApplePassJson(ticket, cfg) {
  const eventDate = ticket.event_date ? new Date(ticket.event_date) : null;
  const venue = [ticket.venue_name, ticket.city].filter(Boolean).join(", ");
  const barcodeMessage = ticket.qr_payload && Object.keys(ticket.qr_payload || {}).length
    ? JSON.stringify(ticket.qr_payload)
    : JSON.stringify({ type: "titopay_ticket", ticketCode: ticket.ticket_code });
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    organizationName: "TitoPay",
    serialNumber: ticket.ticket_code,
    description: `TitoPay ticket for ${ticket.event_name || "a TitoPay event"}`,
    logoText: "TitoPay",
    foregroundColor: "rgb(255,255,255)",
    backgroundColor: "rgb(6,26,61)",
    labelColor: "rgb(143,177,255)",
    barcodes: [{ format: "PKBarcodeFormatQR", message: barcodeMessage, messageEncoding: "iso-8859-1", altText: ticket.ticket_code }],
    eventTicket: {
      primaryFields: [{ key: "event", label: "EVENT", value: ticket.event_name || "TitoPay event" }],
      secondaryFields: [
        ...(venue ? [{ key: "venue", label: "VENUE", value: venue }] : []),
        ...(eventDate ? [{ key: "date", label: "DATE", value: eventDate.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) }] : [])
      ],
      auxiliaryFields: [
        ...(ticket.ticket_name ? [{ key: "type", label: "TICKET", value: ticket.ticket_name }] : []),
        ...(ticket.attendee_name ? [{ key: "holder", label: "HOLDER", value: ticket.attendee_name }] : [])
      ],
      backFields: [
        { key: "code", label: "Ticket code", value: ticket.ticket_code },
        ...(ticket.order_reference ? [{ key: "order", label: "Order", value: ticket.order_reference }] : []),
        { key: "note", label: "TitoPay", value: "Present this pass at the entrance. Do not share the code publicly. Smart Payments. Simplified." }
      ]
    }
  };
  if (eventDate && !Number.isNaN(eventDate.getTime())) pass.relevantDate = eventDate.toISOString();
  return pass;
}

// The unsigned file set. Exported separately so tests can hold the manifest to
// its hashes without a real Apple certificate.
function buildApplePassFiles(ticket, cfg) {
  const icon = fs.readFileSync(ICON_PATH);
  const files = [
    ["pass.json", Buffer.from(JSON.stringify(buildApplePassJson(ticket, cfg)), "utf8")],
    ["icon.png", icon],
    ["icon@2x.png", icon],
    ["logo.png", icon]
  ];
  const manifest = {};
  for (const [name, data] of files) {
    manifest[name] = crypto.createHash("sha1").update(data).digest("hex");
  }
  files.push(["manifest.json", Buffer.from(JSON.stringify(manifest), "utf8")]);
  return files;
}

function signManifest(manifestBuffer, cfg) {
  const p12Der = forge.util.decode64(cfg.p12);
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12Der), cfg.password || "");
  let signerKey = null;
  let signerCert = null;
  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) signerKey = safeBag.key;
      if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) signerCert = safeBag.cert;
    }
  }
  if (!signerKey || !signerCert) throw new Error("The Apple Wallet .p12 does not contain a certificate and private key");
  const signed = forge.pkcs7.createSignedData();
  signed.content = forge.util.createBuffer(manifestBuffer.toString("binary"));
  signed.addCertificate(signerCert);
  if (cfg.wwdr) {
    const wwdrPem = Buffer.from(cfg.wwdr, "base64").toString("utf8");
    signed.addCertificate(forge.pki.certificateFromPem(wwdrPem));
  }
  signed.addSigner({
    key: signerKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  signed.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(signed.toAsn1()).getBytes(), "binary");
}

// The finished .pkpass for a ticket row (as selected by the pass routes).
function buildApplePkpass(ticket) {
  const cfg = appleConfig();
  if (!cfg) throw new Error("Apple Wallet is not configured");
  const files = buildApplePassFiles(ticket, cfg);
  const manifest = files.find(([name]) => name === "manifest.json")[1];
  files.push(["signature", signManifest(manifest, cfg)]);
  return zipStored(files);
}

function applePassDownloadUrl(ticketCode) {
  return `${config.apiBaseUrl}/v1/ticketing/tickets/${encodeURIComponent(ticketCode)}/pass.pkpass?token=${encodeURIComponent(signPassToken(ticketCode))}`;
}

/* ---- Google Wallet -------------------------------------------------------- */

function buildGoogleSaveUrl(ticket) {
  const cfg = googleConfig();
  if (!cfg) throw new Error("Google Wallet is not configured");
  const venue = [ticket.venue_name, ticket.city].filter(Boolean).join(", ");
  const objectId = `${cfg.issuerId}.titopay-ticket-${String(ticket.ticket_code).replace(/[^a-zA-Z0-9]/g, "")}`;
  const barcodeMessage = ticket.qr_payload && Object.keys(ticket.qr_payload || {}).length
    ? JSON.stringify(ticket.qr_payload)
    : JSON.stringify({ type: "titopay_ticket", ticketCode: ticket.ticket_code });
  const ticketObject = {
    id: objectId,
    classId: `${cfg.issuerId}.titopay-event-ticket`,
    state: "ACTIVE",
    heroImage: undefined,
    barcode: { type: "QR_CODE", value: barcodeMessage, alternateText: ticket.ticket_code },
    eventName: { defaultValue: { language: "en", value: ticket.event_name || "TitoPay event" } },
    ticketHolderName: ticket.attendee_name || undefined,
    ticketType: ticket.ticket_name ? { defaultValue: { language: "en", value: ticket.ticket_name } } : undefined,
    venue: venue ? { name: { defaultValue: { language: "en", value: venue } } } : undefined,
    hexBackgroundColor: "#061a3d"
  };
  const token = jwt.sign(
    {
      iss: cfg.email,
      aud: "google",
      typ: "savetowallet",
      payload: { eventTicketObjects: [ticketObject] }
    },
    cfg.key,
    { algorithm: "RS256" }
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = {
  appleWalletConfigured,
  googleWalletConfigured,
  signPassToken,
  verifyPassToken,
  buildApplePassFiles,
  buildApplePkpass,
  applePassDownloadUrl,
  buildGoogleSaveUrl,
  // Exported for tests: the zip writer must produce archives any unzip reads.
  zipStored,
  crc32
};
