"use strict";

// THE APPROVED TITOPAY PRICING SCHEDULE, LOCKED SHUT.
//
// Every check below maps to a numbered validation requirement from the approved
// schedule sign-off. A fee is money leaving a customer's wallet, so each figure
// is asserted explicitly rather than derived - if someone edits the schedule,
// these say exactly which line moved and what it should have been.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPROVED_PRICING_SCHEDULE,
  normalizeServiceCode,
  calculateFee
} = require("../src/services/pricing-service");

const bySchedule = new Map(APPROVED_PRICING_SCHEDULE.map((r) => [r.serviceCode, r]));
function rule(code) {
  const found = bySchedule.get(code);
  assert.ok(found, `${code} is missing from the approved pricing schedule`);
  return found;
}
const flat = (code) => Number(rule(code).flatFee);
const pct = (code) => Number(rule(code).percentageFee);
const cap = (code) => Number(rule(code).maximumFee);
const isFree = (code) => flat(code) === 0 && pct(code) === 0;

// -- 1. aliases resolve to identical numbers ------------------------------
test("every alias group carries identical pricing", () => {
  const ALIASES = [
    ["wallet_top_up", "top_up"],
    ["withdraw_money_to_bank", "withdraw", "bank_transfer", "bank_withdrawal", "cash_withdrawal", "withdraw_cash"],
    ["qr_payment", "qr_pay", "customer_qr_payment"],
    ["merchant_qr", "merchant_qr_payment"],
    ["airtime", "data", "airtime_data"],
    ["voucher", "vouchers"],
    ["pay_bills", "bill_payments"],
    ["stockvel", "stockvel_contribution"],
    ["business_payout", "payouts", "merchant_payout", "merchant_payouts"],
    ["refund_processing", "refund"],
    ["invoice_creation", "invoice_pdf", "invoice"],
    ["quote_creation", "quote_pdf", "quote"],
    ["pro_forma_creation", "proforma_invoice_pdf", "proforma_invoice"],
    ["book_business_activation", "book"],
    ["bulk_distribution_fee", "bulk_distribution_batch_fee", "enterprise_distribution"],
    ["ticket_purchase", "ticket_sales", "tickets"],
    ["ticket_business_commission", "ticketing"],
    ["ticket_refund_processing", "ticket_refund"],
    ["ticket_staff_access", "business_ticketing_staff"],
    ["marketplace_seller_commission", "marketplace_commission"],
    ["statement_pdf", "statements", "email_statement"],
    ["payment_request", "request_money"]
  ];
  for (const group of ALIASES) {
    const [head, ...rest] = group;
    for (const alias of rest) {
      assert.equal(flat(alias), flat(head), `${alias} flat fee must match ${head}`);
      assert.equal(pct(alias), pct(head), `${alias} percentage must match ${head}`);
      assert.equal(cap(alias), cap(head), `${alias} maximum fee must match ${head}`);
    }
  }
});

// -- 2. no duplicate rules -------------------------------------------------
test("no service code appears twice in the schedule", () => {
  const codes = APPROVED_PRICING_SCHEDULE.map((r) => r.serviceCode);
  const seen = new Set();
  const dupes = [];
  for (const c of codes) {
    if (seen.has(c)) dupes.push(c);
    seen.add(c);
  }
  assert.deepEqual(dupes, [], `duplicate pricing rules: ${dupes.join(", ")}`);
});

test("every service code is already in normalized form", () => {
  // pricing lookups normalize before querying; a schedule entry that is not
  // itself normalized can never be found and silently falls back to free.
  const bad = APPROVED_PRICING_SCHEDULE
    .map((r) => r.serviceCode)
    .filter((c) => normalizeServiceCode(c) !== c);
  assert.deepEqual(bad, [], `these codes would never be matched: ${bad.join(", ")}`);
});

// -- 3/4/5. the arithmetic: percentages, caps, free ------------------------
test("percentage services carry a percentage and no flat fee", () => {
  const PERCENT = {
    merchant_qr: 1.5, merchant_qr_payment: 1.5,
    make_a_sale: 1.5, business_payout: 1.5, seller_payout: 1.5,
    bulk_distribution_fee: 3, bulk_distribution_bank_payout: 1.5,
    ticket_business_commission: 10, marketplace_seller_commission: 10,
    card_payments: 1.9, card_topups: 2,
    stockvel: 1.5
  };
  for (const [code, expected] of Object.entries(PERCENT)) {
    assert.equal(pct(code), expected, `${code} must be ${expected}%`);
    assert.equal(flat(code), 0, `${code} must not also carry a flat fee`);
  }
});

test("stokvel is capped at R10 and the cap actually binds", async () => {
  for (const code of ["stockvel", "stockvel_contribution"]) {
    assert.equal(pct(code), 1.5, `${code} must be 1.5%`);
    assert.equal(cap(code), 10, `${code} must cap at R10`);
  }
  // 1.5% of R10 000 is R150; the cap must hold it at R10.
  const capped = await calculateFee("stockvel", 10000);
  assert.equal(capped.fee, 10, "a large stokvel contribution must be capped at R10");
  // and below the cap it must still scale
  const under = await calculateFee("stockvel", 100);
  assert.equal(under.fee, 1.5, "1.5% of R100 is R1.50, below the cap");
});

test("free services are free at every amount", async () => {
  const FREE = [
    "personal_wallet", "monthly_wallet_fee", "receive_money", "send_money",
    "wallet_transfer", "tip", "business_wallet", "business_registration",
    "business_profile", "receive_payments", "ticket_purchase", "ticket_sales",
    "ticket_scanning", "ticket_staff_access", "business_staff", "marketplace",
    "transactions", "transaction_history", "fica", "profile_security",
    "in_app_notifications", "email_notifications", "email_otp", "otp_sms",
    "security_sms", "rewards", "bulk_distribution_wallet_payout"
  ];
  for (const code of FREE) {
    assert.ok(isFree(code), `${code} must be free in the schedule`);
  }
  for (const code of ["send_money", "wallet_transfer", "otp_sms", "security_sms"]) {
    const r = await calculateFee(code, 25000);
    assert.equal(r.fee, 0, `${code} must return R0.00 even on a large amount`);
  }
});

// -- 6/7/8. the explicitly signed-off figures -------------------------------
test("KYC is priced R30 personal and R60 business", () => {
  assert.equal(flat("personal_kyc"), 30, "Personal KYC must be R30.00");
  assert.equal(flat("business_kyc"), 60, "Business KYC must be R60.00");
  assert.ok(isFree("fica"), "FICA verification stays free");
});

test("event marketing SMS is R0.60 and optional SMS is R0.30", () => {
  assert.equal(flat("event_marketing_sms"), 0.60, "Event Marketing SMS must be R0.60");
  assert.equal(flat("optional_sms_notifications"), 0.30, "Optional SMS Notifications must be R0.30");
});

test("the headline wallet and money-movement fees match the approved schedule", () => {
  const FLAT = {
    wallet_top_up: 5,
    withdraw_money_to_bank: 10, cash_withdrawal: 10,
    payment_request: 1, bill_split: 2, send_gift: 3,
    qr_payment: 0.50, event_tag: 1,
    airtime: 1, data: 1, electricity: 5, voucher: 3, pay_bills: 5,
    refund_processing: 1, business_statement_pdf: 0.50,
    business_document_pdf: 2.50, invoice_creation: 2.50,
    book_business_activation: 250,
    ticket_buyer_service_fee: 10, ticket_refund_processing: 1,
    marketplace_buyer_service_fee: 5, marketplace_refund_processing: 1,
    statement_pdf: 0.50,
    bulk_distribution_failed_item_fee: 1, bulk_distribution_reversal_fee: 1,
    cash_services: 10, gift_cards: 3
  };
  for (const [code, expected] of Object.entries(FLAT)) {
    assert.equal(flat(code), expected, `${code} must be R${expected.toFixed(2)}`);
  }
});

// -- 10. nothing in the app is left unpriced -------------------------------
test("every active service in the app catalogue resolves to a schedule rule", () => {
  const catalogue = require("../../pwa/services-default.json").items;
  const known = new Set(APPROVED_PRICING_SCHEDULE.map((r) => r.serviceCode));
  const unpriced = catalogue
    .filter((s) => s.status === "active")
    .map((s) => normalizeServiceCode(s.service_code))
    .filter((c) => !known.has(c));
  assert.deepEqual(unpriced, [],
    `these live services match no pricing rule and would be charged nothing: ${unpriced.join(", ")}`);
});

// -- the shipping mechanism itself -----------------------------------------
test("a schedule change ships through a keyed one-shot fixup, not the seed alone", () => {
  // syncApprovedPricingSchedule only runs from db:init, so editing the schedule
  // never reaches a live database on its own. If this export disappears, a
  // future price change would silently not apply in production.
  const pricing = require("../src/services/pricing-service");
  assert.equal(typeof pricing.applyApprovedScheduleFixupOnce, "function",
    "the approved schedule must ship through a one-shot fixup");
  assert.match(String(pricing.APPROVED_SCHEDULE_FIXUP_KEY || ""), /^pricing_schedule_/,
    "the fixup must be recorded under a versioned platform_settings key");
  const wiring = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "..", "src", "services", "service-management-service.js"), "utf8");
  assert.match(wiring, /applyApprovedScheduleFixupOnce\(\)/,
    "the fixup must actually be invoked at boot, or the schedule never lands");
});
