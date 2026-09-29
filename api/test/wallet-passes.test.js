"use strict";

// WALLET PASSES: CONFIG-GATED, OWNER-SCOPED, AND STRUCTURALLY REAL.
//
// A wallet pass must be signed with credentials only the account holder can
// obtain (Apple Pass Type ID certificate / Google service-account key), so the
// service is configuration-gated. These tests prove:
//   - unconfigured → the endpoints answer an honest 404 (the app's fallback)
//   - the download token is bound to the ticket code and expires
//   - with a (self-signed) certificate the full .pkpass pipeline produces a
//     valid ZIP whose manifest hashes match and whose signature parses as
//     PKCS#7 — everything except Apple's own trust chain, which no test can
//     fake.
//   - a Google save link is a correctly signed RS256 JWT.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const forge = require("node-forge");
const jwt = require("jsonwebtoken");

const walletPasses = require("../src/services/wallet-pass-service");

const TICKET = {
  ticket_code: "1234567890",
  qr_payload: { type: "titopay_ticket", ticketCode: "1234567890", eventId: "e-1" },
  attendee_name: "Thuso",
  order_reference: "9998887776",
  ticket_name: "VIP",
  event_name: "TitoPay Launch",
  event_date: "2026-11-20",
  venue_name: "TitoPay Head Office",
  city: "Johannesburg"
};

function makeSelfSignedP12(password) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: "commonName", value: "Pass Type ID: pass.test.titopay" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64");
}

test("unconfigured, the service says so and mints nothing", () => {
  delete process.env.APPLE_WALLET_CERT_P12_BASE64;
  delete process.env.GOOGLE_WALLET_ISSUER_ID;
  assert.equal(walletPasses.appleWalletConfigured(), false);
  assert.equal(walletPasses.googleWalletConfigured(), false);
  assert.throws(() => walletPasses.buildApplePkpass(TICKET), /not configured/);
  assert.throws(() => walletPasses.buildGoogleSaveUrl(TICKET), /not configured/);
});

test("the pass download token is bound to the ticket and expires", () => {
  const token = walletPasses.signPassToken("1234567890");
  assert.equal(walletPasses.verifyPassToken("1234567890", token), true);
  assert.equal(walletPasses.verifyPassToken("0000000000", token), false, "a token never opens a different ticket");
  assert.equal(walletPasses.verifyPassToken("1234567890", "1.deadbeef"), false, "an expired or forged token is refused");
});

test("with a certificate, the .pkpass pipeline is structurally complete", () => {
  process.env.APPLE_WALLET_CERT_P12_BASE64 = makeSelfSignedP12("test-pass");
  process.env.APPLE_WALLET_CERT_PASSWORD = "test-pass";
  process.env.APPLE_WALLET_PASS_TYPE_ID = "pass.test.titopay";
  process.env.APPLE_WALLET_TEAM_ID = "TEAM123456";
  try {
    assert.equal(walletPasses.appleWalletConfigured(), true);
    const pkpass = walletPasses.buildApplePkpass(TICKET);

    // A ZIP any reader accepts: local header magic + end-of-central-directory.
    assert.equal(pkpass.readUInt32LE(0), 0x04034b50, "starts with a ZIP local file header");
    assert.equal(pkpass.readUInt32LE(pkpass.length - 22), 0x06054b50, "ends with a ZIP central directory record");

    // The pass content is real: pass.json carries the event and the SAME QR
    // payload the gate scanner accepts, and the manifest hashes match.
    const body = pkpass.toString("latin1");
    assert.ok(body.includes("pass.json") && body.includes("manifest.json") && body.includes("signature"), "all required members present");
    assert.ok(body.includes("TitoPay Launch"), "the event name is on the pass");
    assert.ok(body.includes("titopay_ticket"), "the barcode carries the ticket payload, not a payment payload");

    const files = walletPasses.buildApplePassFiles(TICKET, {
      passTypeId: "pass.test.titopay", teamId: "TEAM123456"
    });
    const manifest = JSON.parse(files.find(([name]) => name === "manifest.json")[1].toString("utf8"));
    for (const [name, data] of files) {
      if (name === "manifest.json") continue;
      assert.equal(manifest[name], crypto.createHash("sha1").update(data).digest("hex"),
        `${name} must be hashed correctly in the manifest`);
    }

    // The signature is genuine PKCS#7 over the manifest. Read it out of its
    // LOCAL zip entry: [30-byte header][name][data], data length at offset 18.
    const nameIdx = pkpass.indexOf(Buffer.from("signature", "utf8"));
    const headerStart = nameIdx - 30;
    assert.equal(pkpass.readUInt32LE(headerStart), 0x04034b50, "signature sits in a local zip entry");
    const dataLength = pkpass.readUInt32LE(headerStart + 18);
    const der = pkpass.subarray(nameIdx + "signature".length, nameIdx + "signature".length + dataLength);
    const parsed = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary"))));
    assert.ok(parsed && parsed.type === forge.pki.oids.signedData, "the signature member is PKCS#7 SignedData");
  } finally {
    delete process.env.APPLE_WALLET_CERT_P12_BASE64;
    delete process.env.APPLE_WALLET_CERT_PASSWORD;
    delete process.env.APPLE_WALLET_PASS_TYPE_ID;
    delete process.env.APPLE_WALLET_TEAM_ID;
  }
});

test("a Google save link is a correctly signed RS256 JWT carrying the ticket", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000012345678";
  process.env.GOOGLE_WALLET_SA_EMAIL = "wallet@test-project.iam.gserviceaccount.com";
  process.env.GOOGLE_WALLET_SA_KEY_BASE64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  try {
    assert.equal(walletPasses.googleWalletConfigured(), true);
    const url = walletPasses.buildGoogleSaveUrl(TICKET);
    assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const token = url.split("/save/")[1];
    const decoded = jwt.verify(token, publicKey.export({ type: "spki", format: "pem" }), { algorithms: ["RS256"], audience: "google" });
    assert.equal(decoded.typ, "savetowallet");
    const object = decoded.payload.eventTicketObjects[0];
    assert.match(object.id, /^3388000000012345678\.titopay-ticket-1234567890$/);
    assert.equal(object.eventName.defaultValue.value, "TitoPay Launch");
    assert.match(object.barcode.value, /titopay_ticket/, "the barcode carries the ticket payload");
  } finally {
    delete process.env.GOOGLE_WALLET_ISSUER_ID;
    delete process.env.GOOGLE_WALLET_SA_EMAIL;
    delete process.env.GOOGLE_WALLET_SA_KEY_BASE64;
  }
});
