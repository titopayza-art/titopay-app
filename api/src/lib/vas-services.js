"use strict";

// WHICH SERVICE CODES ARE VALUE-ADDED SERVICES — ONE LIST, READ BY EVERYONE.
//
// This exists because the same list was written down twice and the two copies
// disagreed. The catalogue gate knew about the alias codes the app actually
// uses ("airtime-and-data" is the real service_code behind the Airtime & Data
// tile); the transaction engine's copy listed only the plain ones. So the tile
// was correctly held at "coming soon" while the ENGINE would have accepted
// airtime_and_data straight through to a bare wallet debit — money out of a
// customer's wallet with no airtime on the other side, and no supplier
// contracted to deliver any.
//
// Nothing reached it in the app, because the tile was gated. But an endpoint
// does not care what a tile says: the service code comes from the request.
//
// Two spellings are unavoidable — the catalogue stores hyphens
// ("pay-bills") and the transaction engine normalizes to underscores
// ("pay_bills") — so membership is asked through a function that normalizes
// first, rather than by matching a string against whichever copy of the list
// the caller happened to import.

const VAS_SERVICE_CODES = [
  "airtime",
  "data",
  "mobile-data",
  "airtime-data",
  "airtime-and-data",
  "airtime-data-bundles",
  "electricity",
  "voucher",
  "vouchers",
  "pay-bills",
  "bill-payments"
];

// Matches normalizeServiceCode in pricing-service: lower-cased, with spaces
// and hyphens folded to underscores. Kept local so this module can be imported
// anywhere without dragging pricing in behind it.
function normalizeVasCode(code) {
  return String(code || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const VAS_NORMALIZED = new Set(VAS_SERVICE_CODES.map(normalizeVasCode));

// True for every spelling of every value-added service, in either form.
function isVasService(code) {
  return VAS_NORMALIZED.has(normalizeVasCode(code));
}

module.exports = {
  VAS_SERVICE_CODES,
  VAS_NORMALIZED,
  normalizeVasCode,
  isVasService
};
