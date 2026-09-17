"use strict";

// ONE PLACE THAT DECIDES HOW AN IDENTITY NUMBER IS HASHED.
//
// There were three sites computing this by hand: the SA ID path and the
// document path in compliance-service, and the admin screening-list route. Three
// copies of a rule that must agree exactly is how one of them ends up wrong, and
// when they disagree the failure is silent: a customer simply stops matching a
// sanctions entry.
//
// WHAT WAS WRONG. The digest was crypto.createHash("sha256") over
// `titopay-id:${digits}`. That prefix is a domain separator, not a salt and not
// a pepper: it is constant, it is in the repository, and it is the same for
// every customer. South African ID numbers are highly structured, so the whole
// valid space is about 1.46 billion numbers; a single GPU covers that in under a
// second. Anyone holding a copy of the users table recovered every customer's ID
// number, which is exactly what hashing was meant to prevent.
//
// WHAT IS RIGHT. HMAC-SHA-256 keyed with a secret that lives outside the
// database. The lookup pattern is unchanged because HMAC is deterministic, so
// every equality search still works, but a dump without the key is useless.

const crypto = require("crypto");
const { config } = require("../config/env");

/**
 * The keyed hash. Everything written from now on uses this.
 */
function identityHash(material) {
  return crypto.createHmac("sha256", config.identityPepper).update(String(material)).digest("hex");
}

/**
 * The unkeyed digest this platform used before the pepper existed.
 *
 * It is kept for exactly one reason: rows written before the migration still
 * hold it, and compliance_screening_list entries were created by an admin typing
 * a raw ID number that nobody kept. Those entries cannot be recomputed, so the
 * only way to keep sanctions matching working across the change is to be able to
 * compute the old form as well and compare like with like.
 *
 * It must never be the only value stored for a new record.
 */
function legacyIdentityHash(material) {
  return crypto.createHash("sha256").update(String(material)).digest("hex");
}

/**
 * The exact strings the previous implementation hashed. Preserved character for
 * character, because changing one would orphan every existing row.
 */
function saIdMaterial(digits) {
  return `titopay-id:${digits}`;
}

function documentMaterial(documentType, issuingCountry, number) {
  return `titopay-doc:${documentType}:${issuingCountry}:${number}`;
}

/**
 * Both forms for one identity, so a caller cannot write one and forget the
 * other.
 */
function identityHashPair(material) {
  return { hmac: identityHash(material), legacy: legacyIdentityHash(material) };
}

/**
 * Whether to keep writing the legacy digest alongside the keyed one.
 *
 * Default ON, and it must stay on until compliance_screening_list has been
 * re-ingested with keyed hashes. A customer verified after this change has no
 * legacy hash, so with dual write OFF they would not be screened against any
 * screening entry created before the change: a compliance control failing open
 * and saying nothing. Turning it off is a deliberate step taken after the list
 * is migrated, not a default.
 */
function legacyDualWriteEnabled() {
  return !["false", "0", "no", "off"].includes(
    String(process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE ?? "true").trim().toLowerCase()
  );
}

module.exports = {
  identityHash,
  legacyIdentityHash,
  identityHashPair,
  saIdMaterial,
  documentMaterial,
  legacyDualWriteEnabled
};
