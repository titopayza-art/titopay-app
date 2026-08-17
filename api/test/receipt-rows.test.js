"use strict";

// WHOSE SLIP IS THIS, AND WHAT BELONGS ON IT.
//
// The payer's copy and the merchant's copy are built by different functions
// and rendered by ONE shared function, receiptRows. Two fields differ by whose
// slip it is, and both had already been wrong once:
//
//   Merchant ID   the merchant's trading id on their slip; on the payer's copy
//                 the same field falls through to the QR CODE'S id, so a
//                 customer was shown a raw UUID identifying nothing
//   the net line  what LEFT the payer's wallet, or what ARRIVED in the
//                 merchant's. Printing one on the other's slip told a customer
//                 who had just been debited R51.50 that they paid R47.75
//
// receiptRows lives in the PWA bundle, which has no module system, so it is
// read out of the source and evaluated here with the two helpers it needs.
// That is deliberately the SHIPPING source rather than a copy: a divergence
// between what is tested and what is served is the whole problem.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer in pwa/app.js`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`could not read ${name} out of pwa/app.js`);
}

// money() formats rands; the real one is elsewhere in the bundle and its
// formatting is not what is under test here.
const receiptRows = new Function(
  "money",
  `${extract("receiptRows")}; return receiptRows;`
)((value) => `R ${Number(value || 0).toFixed(2)}`);

const rowsFor = (receipt) => new Map(receiptRows(receipt));

const PAYER_SLIP = {
  receiptRole: "payer",
  merchantName: "Corner Cafe",
  merchantId: "e2186835-f16c-4c8d-83ce-ec242302154f", // the QR code's id
  customerName: "Thuso Tshiloane",
  reference: "TX-1786925617841-3GZAZO",
  transactionId: "000f3cb5-e7c5-4db3-9f3c-708926f6e7f0",
  date: "2026-08-17T00:13:37.841Z",
  amount: 50, fees: 1.5, netLabel: "Total paid", netAmount: 51.5, status: "PAID"
};

const MERCHANT_SLIP = {
  receiptRole: "merchant",
  merchantName: "Corner Cafe",
  merchantId: "MTP-000841",
  customerName: "Thuso Tshiloane",
  reference: "TX-1786925617841-3GZAZO",
  transactionId: "000f3cb5-e7c5-4db3-9f3c-708926f6e7f0",
  date: "2026-08-17T00:13:37.841Z",
  amount: 50, fees: 2.25, payerFee: 1.5, netAmount: 47.75, status: "PAID"
};

test("the payer's copy does not show a Merchant ID", () => {
  const rows = rowsFor(PAYER_SLIP);
  assert.equal(rows.has("Merchant ID"), false,
    "the customer is being shown a raw id that identifies nothing they can act on");
  // The name is what actually tells them who they paid, and it stays.
  assert.equal(rows.get("Merchant Name"), "Corner Cafe");
});

test("the merchant's copy keeps its Merchant ID", () => {
  const rows = rowsFor(MERCHANT_SLIP);
  assert.equal(rows.get("Merchant ID"), "MTP-000841",
    "the merchant lost the id they quote to Support and reconcile against");
});

test("a receipt saved before this change keeps the row rather than losing an identifier", () => {
  // Old slips carry no role. Hiding on unknown would strip a real identifier
  // off every merchant receipt already saved on a phone.
  const legacy = { ...MERCHANT_SLIP };
  delete legacy.receiptRole;
  assert.equal(rowsFor(legacy).get("Merchant ID"), "MTP-000841");
});

test("the net line is labelled for whoever is holding the slip", () => {
  // The payer sees what left their wallet.
  assert.equal(rowsFor(PAYER_SLIP).get("Total paid"), "R 51.50");
  assert.equal(rowsFor(PAYER_SLIP).has("Net Amount"), false);
  // The merchant sees what arrived in theirs.
  assert.equal(rowsFor(MERCHANT_SLIP).get("Net Amount"), "R 47.75");
});

test("neither slip shows the other side's figure", () => {
  // The specific fault that shipped: the MERCHANT'S net printed on the
  // CUSTOMER'S slip, so a R50 sale that debited R51.50 read as R47.75.
  const payer = rowsFor(PAYER_SLIP);
  assert.doesNotMatch([...payer.values()].join(" "), /47\.75/,
    "the merchant's net is on the customer's receipt again");
  const merchant = rowsFor(MERCHANT_SLIP);
  assert.doesNotMatch([...merchant.values()].join(" "), /51\.50/,
    "the customer's total is on the merchant's receipt");
});

test("each slip states its own fee, and they are different figures", () => {
  assert.equal(rowsFor(PAYER_SLIP).get("Fees"), "R 1.50");
  assert.equal(rowsFor(MERCHANT_SLIP).get("Fees"), "R 2.25");
});
