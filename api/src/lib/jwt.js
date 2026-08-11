const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

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
    issuer: config.apiBaseUrl,
    audience: "titopay-api"
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, config.refreshSecret, {
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
