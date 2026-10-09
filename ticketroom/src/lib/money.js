// All money is integer cents (ZAR). Never floats.
const config = require("../config");

function assertCents(n, label = "amount") {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be integer cents`);
  return n;
}

// Rounds half away from zero: bps of cents.
const bpsOf = (cents, bps) => Math.round((assertCents(cents) * bps) / 10000);

function ticketFee(priceCents) {
  if (priceCents === 0) return 0;
  return config.fees.ticketFeeFixedCents + bpsOf(priceCents, config.fees.ticketFeeBps);
}

// "150", "150.5", "150.50", "R 1 250,00" -> cents. Rejects anything else.
function parseRand(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    return Math.round(input * 100);
  }
  const s = String(input || "").replace(/^R\s*/i, "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

function formatZar(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${rands}.${String(abs % 100).padStart(2, "0")}`;
}

module.exports = { assertCents, bpsOf, ticketFee, parseRand, formatZar };
