const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

// Every token this API issues is HS256. Verification used to accept any HMAC
// algorithm, because jsonwebtoken infers the family from the secret's type when
// no list is given — which already refuses alg=none, but also accepts HS384 and
// HS512 that this service never issues. Forging one needs the signing secret,
// so this closes a wider-than-necessary door rather than an open one. Pinning
// it means the rule survives a library upgrade or a change in how the secret is
// represented, neither of which would announce itself.
const ALGORITHMS = ["HS256"];

function signAccessToken(payload) {
  return jwt.sign(payload, config.accessSecret, {
    expiresIn: config.accessTokenTtl,
    issuer: config.apiBaseUrl,
    audience: "titopay-api"
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, config.refreshSecret, {
    expiresIn: config.refreshTokenTtl,
    issuer: config.apiBaseUrl,
    audience: "titopay-api-refresh"
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.accessSecret, {
    algorithms: ALGORITHMS,
    issuer: config.apiBaseUrl,
    audience: "titopay-api"
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, config.refreshSecret, {
    algorithms: ALGORITHMS,
    issuer: config.apiBaseUrl,
    audience: "titopay-api-refresh"
  });
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
};
