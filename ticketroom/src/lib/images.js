// Decides an image's type from its magic bytes — never from the client's
// header or filename. SVG is deliberately not accepted (it can carry script).
function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

// Stores a validated upload and returns its id.
async function store({ db, config, ownerId, organiserId, buffer }) {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const { bad } = require("./errors");
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad("Upload a PNG, JPEG or WebP image up to 2 MB.");
  const mime = sniff(buffer);
  if (!mime) throw bad("That file is not a PNG, JPEG or WebP image.");
  const { rows } = await db.query("INSERT INTO uploads (owner_id, organiser_id, mime_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [ownerId, organiserId || null, mime, buffer.length, crypto.createHash("sha256").update(buffer).digest("hex")]);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, rows[0].id), buffer, { mode: 0o644 });
  return rows[0].id;
}

module.exports = { sniff, store };
