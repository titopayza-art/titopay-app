"use strict";

// WHETHER AN OPERATOR HAS TURNED A CAPABILITY ON, read without a deploy.
//
// The problem this solves. Whether TitoPay can sell airtime used to be one
// hardcoded boolean in an adapter file, so switching the VAS rail on, moving
// it to a different supplier, or killing it during a supplier outage all
// needed a code change and a release. That is the wrong place for an
// operational decision: the person who knows the supplier is down at 21:00 on
// a Friday is not the person holding a deploy key.
//
// So activation moves to the Integration Centre, which already stores the
// provider choice, the credentials, the environment, an enabled flag and the
// result of the last connection test — Super Admin only, encrypted, audited.
// This module makes that state readable by the capability gate.
//
// WHAT IT CANNOT DO, and this is the important half.
//
// It is an AND, never an OR. A capability is live only when the adapter
// declares it can send a purchase AND an operator has switched it on. The
// console can therefore only ever CLOSE the gate further, never open one the
// code cannot honour. That matters because the adapter's declaration is not a
// preference — it is the presence of code that speaks the supplier's protocol,
// and no configuration field brings that into existence. A console switch that
// published a service with no adapter behind it would debit a customer, get a
// 503, class it as unknown rather than refused, and hold their money against a
// voucher that can never exist.
//
// SYNCHRONOUS ON PURPOSE. applyCapabilityGate runs on every read of every
// service, on every surface. It cannot await a database round trip, so the
// state is cached here and refreshed: at boot, whenever an operator saves an
// integration, and on a slow timer as a backstop for a process that missed a
// save. Between refreshes the cache is stale by at most REFRESH_MS, and stale
// in the safe direction is what the default gives — see below.

const { pool } = require("../db/pool");

// Which platform_settings rows can activate which capability. The key format
// is the Integration Centre's own: `integration_<providerKey>`.
const CAPABILITY_SOURCES = {
  vas: ["integration_flash"]
};

// A connection test that passed. The Integration Centre writes the provider's
// own word when it has one and falls back to "connected", so both are accepted
// and anything else — not_tested, failed, error — is not.
const HEALTHY = new Set(["connected", "ready", "ok", "healthy", "passed"]);

const REFRESH_MS = 30000;

// FALSE UNTIL PROVEN OTHERWISE. Before the first refresh completes, and after
// any failure to read, every capability reads as not activated. A service that
// is briefly not offered is a disappointment; a service offered that cannot
// transact takes money. The cache only ever fails towards the first.
let activated = new Map();
let lastRefreshedAt = 0;
let inFlight = null;

async function loadActivation() {
  const keys = Object.values(CAPABILITY_SOURCES).flat();
  if (!keys.length) return new Map();
  const { rows } = await pool.query(
    "SELECT key, value FROM platform_settings WHERE key = ANY($1)",
    [keys]
  );
  const byKey = new Map(rows.map((row) => [row.key, row.value || {}]));
  const next = new Map();
  for (const [capability, sources] of Object.entries(CAPABILITY_SOURCES)) {
    // Any one configured, enabled and tested integration activates the
    // capability. There is normally one; more than one is a migration between
    // suppliers, and during that the capability should stay up.
    next.set(capability, sources.some((key) => {
      const value = byKey.get(key);
      if (!value) return false;
      const healthy = HEALTHY.has(String(value.health?.status || "").toLowerCase());
      return value.enabled === true && value.configured === true && healthy;
    }));
  }
  return next;
}

async function refreshCapabilityActivation() {
  // Collapsed, so a burst of reads at boot makes one query rather than many.
  if (inFlight) return inFlight;
  inFlight = loadActivation()
    .then((next) => {
      activated = next;
      lastRefreshedAt = Date.now();
      return next;
    })
    .catch((error) => {
      // The previous snapshot is kept rather than cleared. Clearing would take
      // a live capability down because of one failed query, which is a worse
      // outcome than briefly trusting the last known good answer — and the
      // adapter's own declaration is still required regardless.
      console.error("[capability-activation] refresh failed", { message: error.message });
      return activated;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// The synchronous read the gate uses. Kicks off a refresh when the cache is
// older than REFRESH_MS but never waits for it: this answer is about the state
// as last known, and the next caller gets the newer one.
function capabilityActivated(capability) {
  if (Date.now() - lastRefreshedAt > REFRESH_MS) refreshCapabilityActivation();
  return activated.get(capability) === true;
}

// What the console shows an operator about why a capability is or is not on.
// Returned alongside the adapter's own declaration so the two halves are
// visible separately — "the code cannot" and "nobody switched it on" are
// different problems with different fixes.
function activationDetail(capability) {
  return {
    capability,
    activated: activated.get(capability) === true,
    sources: CAPABILITY_SOURCES[capability] || [],
    lastRefreshedAt: lastRefreshedAt ? new Date(lastRefreshedAt).toISOString() : null
  };
}

module.exports = {
  capabilityActivated,
  refreshCapabilityActivation,
  activationDetail,
  CAPABILITY_SOURCES
};
