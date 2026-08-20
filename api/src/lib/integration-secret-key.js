"use strict";

// THE ONE KEY FOR STORED SECRETS, DEFINED ONCE.
//
// On 20 August 2026 a routine JWT rotation broke every stored credential on
// the platform - the Email Centre's SMTP password, the Integrations store,
// and (latently) the saved Peach configuration - because the derivation
// `sha256(refreshSecret)` was COPY-PASTED into five files, every copy keyed
// to a secret whose whole purpose is to be rotatable. Fixing one copy at a
// time then split the brain: the admin save path encrypted under one key
// while the worker's read path decrypted with another.
//
// So the derivation now lives here and only here, and a test bans any file
// from declaring its own. The precedence is what makes rotation safe:
//
//   1. a caller's explicit key (e.g. POS_TERMINAL_ENCRYPTION_KEY, or the
//      Email Centre's EMAIL_ENCRYPTION_KEY-first compatibility order)
//   2. INTEGRATION_ENCRYPTION_KEY  - explicit pin for this vault alone
//   3. EMAIL_ENCRYPTION_KEY        - the key operators are told to pin once
//   4. the JWT secrets             - legacy fallback only, for deployments
//                                    that never pinned anything. Rotating
//                                    them breaks this vault; the preflight
//                                    says so before it can happen.
//
// Set once, never change. Recovering from a rotation that already happened:
// pin EMAIL_ENCRYPTION_KEY to the OLD refresh secret and every store
// decrypts again - which is exactly how production was recovered.

const crypto = require("crypto");
const { config } = require("../config/env");

function keyMaterial(preferred = []) {
  for (const value of preferred) {
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return process.env.INTEGRATION_ENCRYPTION_KEY
    || process.env.EMAIL_ENCRYPTION_KEY
    || config.refreshSecret
    || config.accessSecret;
}

function integrationEncryptionKey(...preferred) {
  return crypto.createHash("sha256").update(keyMaterial(preferred)).digest();
}

module.exports = { integrationEncryptionKey };
