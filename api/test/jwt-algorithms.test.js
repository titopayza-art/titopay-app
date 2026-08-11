"use strict";

// WHICH SIGNATURES COUNT AS A SIGNATURE.
//
// verifyAccessToken called jwt.verify with an issuer and an audience and no
// algorithms list. jsonwebtoken 9 infers a family from the secret's type, so a
// string secret already refuses alg=none — that much was measured before
// changing anything, and it is the attack everybody knows the name of:
//
//   alg=none    -> rejected
//   HS256       -> accepted
//   HS384       -> accepted      <- neither of these is what TitoPay issues
//   HS512       -> accepted      <-
//
// Accepting HS384 and HS512 is not a hole. Forging one still needs the signing
// secret, and an attacker holding that has no reason to bother. What it is, is
// a wider door than the building has. Every token this API issues is HS256;
// nothing should be able to present anything else and be believed.
//
// The value of pinning is the day the inference changes — a library upgrade, a
// secret that becomes a KeyObject, a future default — and stops doing the work
// nobody wrote down. This test writes it down.

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const { config } = require("../src/config/env");
const {
  signAccessToken, verifyAccessToken,
  signRefreshToken, verifyRefreshToken
} = require("../src/lib/jwt");

const ACCESS = { issuer: config.apiBaseUrl, audience: "titopay-api" };
const REFRESH = { issuer: config.apiBaseUrl, audience: "titopay-api-refresh" };

function forge(secret, envelope, algorithm) {
  return jwt.sign({ sub: "user-1" }, secret, { ...envelope, algorithm, expiresIn: "5m" });
}

test("a token the API itself issued still verifies", () => {
  // The point of the whole exercise: tightening must not lock out real sessions.
  const access = signAccessToken({ sub: "user-1", sid: "s1", jti: "j1", typ: "customer" });
  const decodedAccess = verifyAccessToken(access);
  assert.equal(decodedAccess.sub, "user-1");
  assert.equal(decodedAccess.sid, "s1");

  const refresh = signRefreshToken({ sub: "user-1", sid: "s1", jti: "j1", typ: "customer" });
  assert.equal(verifyRefreshToken(refresh).sub, "user-1");
});

test("what the API issues is HS256, and nothing else", () => {
  const header = JSON.parse(
    Buffer.from(signAccessToken({ sub: "user-1" }).split(".")[0], "base64url").toString("utf8")
  );
  assert.equal(header.alg, "HS256", "a change here means the pin below has to move with it");
});

test("a correctly-secreted token in another HMAC algorithm is refused", () => {
  // Signed with the real secret, real issuer, real audience, unexpired. The
  // algorithm is the only thing wrong with it, and that is enough.
  for (const algorithm of ["HS384", "HS512"]) {
    const token = forge(config.accessSecret, ACCESS, algorithm);
    assert.throws(
      () => verifyAccessToken(token),
      /invalid algorithm/i,
      `${algorithm} was accepted; verify is not pinned`
    );
  }
});

test("the refresh path is pinned too, not just the access path", () => {
  // Refresh tokens outlive access tokens by a long way, so a gap here lasts
  // longer than a gap there.
  for (const algorithm of ["HS384", "HS512"]) {
    const token = forge(config.refreshSecret, REFRESH, algorithm);
    assert.throws(() => verifyRefreshToken(token), /invalid algorithm/i,
      `${algorithm} was accepted on refresh`);
  }
});

test("alg=none stays refused", () => {
  // Already true before the pin. Asserted so it cannot quietly stop being true.
  const unsigned = jwt.sign({ sub: "user-1", ...ACCESS }, "", { algorithm: "none" });
  assert.throws(() => verifyAccessToken(unsigned));
});

test("the separation between access and refresh secrets still holds", () => {
  // Pinning the algorithm must not be mistaken for the thing that keeps these
  // apart. Audience and secret do that, and both are still doing it.
  const access = signAccessToken({ sub: "user-1" });
  assert.throws(() => verifyRefreshToken(access), /audience|signature/i);

  const refresh = signRefreshToken({ sub: "user-1" });
  assert.throws(() => verifyAccessToken(refresh), /audience|signature/i);
});
