const crypto = require("crypto");
const config = require("../config");

const b64url = (buf) => buf.toString("base64url");
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const hmac = (keyHex, data) => crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(String(data)).digest();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Unambiguous alphabet for human-typed codes (no 0/O, 1/I/L, U).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomCode(length) {
  const out = [];
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 240 && out.length < length) out.push(ALPHABET[byte % 30]);
    }
  }
  return out.join("");
}
const reference = (prefix) => `${prefix}-${randomCode(8)}`;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(hash)}`;
}
function verifySecret(plain, stored) {
  if (!stored) return false;
  const [algo, N, r, p, salt, hash] = String(stored).split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(String(plain), Buffer.from(salt, "base64url"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}
// A real hash to compare against when the user does not exist, so login
// timing does not reveal which emails are registered.
const DUMMY_HASH = hashSecret("ticketroom-timing-equaliser");

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(config.keys.data, "hex"), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(enc)}`;
}
function decrypt(payload) {
  const [v, iv, tag, enc] = String(payload).split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(config.keys.data, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
}

// Signed, expiring links (unsubscribe, transfer claim) — not secrets, just tamper-proof.
function signLink(data, ttlSeconds) {
  const body = b64url(Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${b64url(hmac(config.keys.links, body)).slice(0, 32)}`;
}
function verifyLink(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !safeEqual(sig, b64url(hmac(config.keys.links, body)).slice(0, 32))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return data.exp >= Math.floor(Date.now() / 1000) ? data : null;
  } catch {
    return null;
  }
}

module.exports = { randomToken, sha256, hmac, safeEqual, randomCode, reference, hashSecret, verifySecret, DUMMY_HASH, encrypt, decrypt, signLink, verifyLink, b64url };
