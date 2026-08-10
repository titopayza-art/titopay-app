// Password hashing — same algorithm, same cost, off the event loop where possible.
//
// bcryptjs is the pure-JavaScript build, which means the hash runs on the event
// loop. At cost factor 12 that is roughly 320ms during which this process can
// answer nothing at all: not a balance check, not a Peach webhook, not another
// customer's request. Measured with a 5ms timer running alongside one hash, it
// fired 4 times where it should have fired 64.
//
// The native build does the identical work in a libuv thread. Same 5ms timer:
// 50 ticks out of an expected 52. Four hashes at once go from 1273ms to 251ms.
//
// It is loaded optionally and on purpose. Native modules compile at install
// time, and if the host has no build toolchain — plausible on shared hosting —
// npm skips an optionalDependency rather than failing the install, and this
// falls back to bcryptjs. Worst case is the performance we have today, never a
// deployment that will not start.
//
// The two are interchangeable at rest. Cost factor 12 is unchanged, and the
// hash format is the same bcrypt format, so this is verified in both
// directions: the native build reads an existing bcryptjs $2a$ hash and
// bcryptjs reads a native $2b$ hash. NO CUSTOMER HAS TO RESET A PASSWORD, in
// either direction, including on rollback.

const COST_FACTOR = 12;

let bcrypt;
let implementation;

try {
  bcrypt = require("bcrypt");
  implementation = "native";
} catch (error) {
  bcrypt = require("bcryptjs");
  implementation = "javascript";
}

// One line at boot, because "why did login get slow again" should be answerable
// from the log rather than by guessing at the install.
console.log("[passwords] bcrypt implementation:", implementation,
  implementation === "javascript"
    ? "(pure JS — hashing runs on the event loop; install the optional native bcrypt to move it off)"
    : "(hashing runs in a worker thread)");

async function hashPassword(value) {
  return bcrypt.hash(value, COST_FACTOR);
}

async function verifyPassword(value, hash) {
  return bcrypt.compare(value, hash);
}

module.exports = { hashPassword, verifyPassword, passwordImplementation: implementation, COST_FACTOR };
