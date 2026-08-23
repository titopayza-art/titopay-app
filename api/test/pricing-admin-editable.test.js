"use strict";

// EVERY PRICING RULE MUST BE EDITABLE FROM THE ADMIN PORTAL.
//
// A fee nobody can change without a deploy is a fee that gets changed in code
// under time pressure, which is how a price ends up differing between what the
// engine charges and what the console shows. These tests walk the exact path
// the Pricing Engine screen uses - GET /pricing then PUT /pricing/:id - and
// assert that every rule the API hands back can actually be written back.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  listPricingRules,
  updatePricingRule,
  getPricingRule,
  calculateFee,
  APPROVED_PRICING_SCHEDULE
} = require("../src/services/pricing-service");

const ADMIN_JS = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "assets", "admin.js"), "utf8");
const ACTOR = { userId: null, userType: "admin", ipAddress: "127.0.0.1", userAgent: "test" };

// Every column the admin form posts. If the service stops persisting one of
// these, the console will silently discard whatever the operator typed.
const EDITABLE_FIELDS = [
  "service_name", "fee_type", "fee_value", "flat_fee", "percentage_fee",
  "minimum_fee", "maximum_fee", "vat_percentage", "enabled", "effective_date", "active"
];

test("the API hands the console a row id for every rule, so every row can be PUT back", async () => {
  const rules = await listPricingRules();
  assert.ok(rules.length >= APPROVED_PRICING_SCHEDULE.length,
    `the console should see at least the ${APPROVED_PRICING_SCHEDULE.length} scheduled rules, saw ${rules.length}`);
  const missingId = rules.filter((r) => !r.id).map((r) => r.service_code);
  assert.deepEqual(missingId, [],
    `PUT /pricing/:id is addressed by id - these rules could never be edited: ${missingId.join(", ")}`);
});

test("the service persists every field the admin pricing form posts", () => {
  // The whitelist in updatePricingRule is the gate. A field the form sends but
  // the whitelist omits is dropped without an error, which reads to the
  // operator as "saved" while nothing changed.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "pricing-service.js"), "utf8");
  const allowed = src.match(/const allowed = \[([^\]]+)\]/);
  assert.ok(allowed, "updatePricingRule must declare its allowed fields");
  for (const field of EDITABLE_FIELDS) {
    assert.match(allowed[1], new RegExp(`"${field}"`),
      `${field} is posted by the admin form but is not persisted by updatePricingRule`);
  }
});

test("the admin pricing form posts every editable field", () => {
  const start = ADMIN_JS.indexOf("function renderPricingEditor");
  assert.ok(start >= 0, "the pricing editor must exist in the admin console");
  const form = ADMIN_JS.slice(start, ADMIN_JS.indexOf("async function renderPricing()", start));
  for (const field of ["service_name", "flat_fee", "percentage_fee", "minimum_fee",
    "maximum_fee", "vat_percentage", "effective_date", "enabled"]) {
    assert.match(form, new RegExp(`name="${field}"`),
      `the pricing editor has no input for ${field}, so it cannot be changed from the console`);
  }
});

test("the pricing table renders every rule, unfiltered and untruncated", () => {
  const start = ADMIN_JS.indexOf("async function renderPricing()");
  assert.ok(start >= 0, "renderPricing must exist");
  // to the end of the function, not a fixed window - the Edit button sits past
  // the 3000th character and a short slice silently misses it
  const end = ADMIN_JS.indexOf("\n}", ADMIN_JS.indexOf("tableCard(\"Pricing Management\"", start));
  const body = ADMIN_JS.slice(start, end);
  // Every row must carry an Edit button, and the table must be fed the whole
  // list - a .slice( or a .filter( on the way into renderRows would hide rules.
  assert.match(body, /renderRows\(rows,/,
    "the pricing table must be fed every rule, not a filtered subset");
  assert.match(body, /data-pricing-edit="\$\{row\.id\}"/,
    "every rendered pricing row must offer an Edit button");
});

test("every rule the console lists can actually be written back and takes effect", async () => {
  const rules = await listPricingRules();
  const failures = [];

  for (const rule of rules) {
    const before = {
      service_name: rule.service_name,
      flat_fee: Number(rule.flat_fee || 0),
      percentage_fee: Number(rule.percentage_fee || 0),
      minimum_fee: Number(rule.minimum_fee || 0),
      maximum_fee: Number(rule.maximum_fee || 0),
      vat_percentage: Number(rule.vat_percentage || 0),
      effective_date: rule.effective_date,
      enabled: rule.enabled !== false,
      active: rule.active !== false
    };
    // A figure no rule in the schedule uses, so a stale read cannot pass by luck.
    const probe = 7.77;
    try {
      const saved = await updatePricingRule(rule.id, {
        ...before, flat_fee: probe, percentage_fee: 0, minimum_fee: 0, maximum_fee: 0
      }, ACTOR);
      if (Number(saved.flat_fee) !== probe) {
        failures.push(`${rule.service_code}: update did not persist (got ${saved.flat_fee})`);
      } else {
        // and the engine must actually charge the new number
        const quoted = await calculateFee(rule.service_code, 100);
        if (quoted.fee !== probe) {
          failures.push(`${rule.service_code}: saved ${probe} but calculateFee charged ${quoted.fee}`);
        }
      }
    } catch (error) {
      failures.push(`${rule.service_code}: ${error.message}`);
    } finally {
      await updatePricingRule(rule.id, before, ACTOR).catch(() => {});
    }
  }

  assert.deepEqual(failures, [],
    `these pricing rules could not be updated from the console:\n  ${failures.join("\n  ")}`);
});

test("loading the pricing screen does not fire one query per rule", async () => {
  // listPricingRules seeds missing rules first. That seed used to be a loop with
  // an awaited upsert per rule - over a hundred sequential round-trips before
  // the Pricing Engine page could render, on the same pool that serves sign-in.
  const { pool } = require("../src/db/pool");
  const real = pool.query.bind(pool);
  let queries = 0;
  pool.query = (...args) => { queries += 1; return real(...args); };
  try {
    await listPricingRules();
  } finally {
    pool.query = real;
  }
  assert.ok(queries <= 10,
    `loading the pricing screen issued ${queries} queries; it must not scale with the number of rules`);
});

test("the console reports a pending approval instead of claiming the fee changed", () => {
  // A protected fee returns 202 pendingApproval and is NOT saved until a second
  // admin approves. Showing "Pricing rule updated" there is a lie on a money
  // screen: the operator leaves believing the price moved.
  const start = ADMIN_JS.indexOf('const pricingForm = event.target.closest("#pricing-edit-form")');
  assert.ok(start >= 0, "the pricing submit handler must exist");
  const handler = ADMIN_JS.slice(start, start + 1600);
  assert.match(handler, /pendingApproval/,
    "the pricing submit handler must distinguish a pending approval from a saved change");
});

test("a restored rule matches the approved schedule again", async () => {
  // The sweep above writes and restores every rule; this proves the restore is
  // faithful, so the suite cannot leave the pricing table quietly wrong.
  for (const [code, expectedFlat, expectedPct] of [
    ["send_money", 0, 0], ["wallet_top_up", 5, 0], ["withdraw_money_to_bank", 10, 0],
    ["qr_payment", 0.50, 0], ["merchant_qr", 0, 1.5], ["stockvel", 0, 1.5]
  ]) {
    const rule = await getPricingRule(code);
    assert.equal(Number(rule.flat_fee), expectedFlat, `${code} flat fee was not restored`);
    assert.equal(Number(rule.percentage_fee), expectedPct, `${code} percentage was not restored`);
  }
});
