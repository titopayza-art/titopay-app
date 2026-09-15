const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

function sixDigitOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

module.exports = { sha256, randomToken, sixDigitOtp };
