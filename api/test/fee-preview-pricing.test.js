"use strict";

// WHAT EVERY CUSTOMER IS CHARGED.
//
// calculateFee and feePreview decide the price of every paid action in TitoPay,
// and until now neither had a direct test. The Business Document PDF was
// mispriced at exactly double for as long as it existed and nothing caught it,
// because nothing was looking.
//
// These fix the arithmetic in place: flat, percentage, floor, cap, free, the
// QR minimum, rounding, and every junk value a client can put in the amount
// field. No database — the pricing rule is stated in each test, so a test says
// what price it is asserting instead of depending on a seeded row.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const { calculateFee, roundMoney, normalizeServiceCode } = require("../src/services/pricing-service");
const transactions = require("../src/services/transaction-service");

// A pricing rule, exactly as the database would hand it back.
function rule(overrides = {}) {
  return {
    service_code: "send_money",
    service_name: "Send Money",
    fee_type: "FIXED",
    fee_value: 0,
    flat_fee: 0,
    percentage_fee: 0,
    minimum_fee: 0,
    maximum_fee: 0,
    vat_percentage: 0,
    ...overrides
  };
}

function withRule(row, run) {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (/^(CREATE|ALTER|UPDATE|INSERT|DO)\b/i.test(query)) return { rows: [] };
    if (/FROM pricing_rules/i.test(query)) return { rows: [row] };
    return { rows: [] };
  };
  return Promise.resolve(run()).finally(() => { pool.query = originalQuery; });
}

/* ------------------------------------------------------------ rule shapes */

test("a flat fee is the same whatever the amount", async () => {
  await withRule(rule({ flat_fee: 1.5 }), async () => {
    for (const [amount, total] of [[10, 11.5], [100, 101.5], [10000, 10001.5]]) {
      const fee = await calculateFee("send_money", amount);
      assert.equal(fee.fee, 1.5, `flat fee on ${amount}`);
      assert.equal(fee.total, total);
    }
  });
});

test("a percentage fee scales with the amount", async () => {
  await withRule(rule({ fee_type: "PERCENTAGE", percentage_fee: 1.5 }), async () => {
    const hundred = await calculateFee("send_money", 100);
    assert.equal(hundred.fee, 1.5);
    assert.equal(hundred.total, 101.5);
    const thousand = await calculateFee("send_money", 1000);
    assert.equal(thousand.fee, 15);
    assert.equal(thousand.total, 1015);
  });
});

test("a minimum fee is a floor, not an addition", async () => {
  await withRule(rule({ fee_type: "PERCENTAGE", percentage_fee: 1, minimum_fee: 5 }), async () => {
    const small = await calculateFee("send_money", 100);      // 1% = 1.00, floored to 5
    assert.equal(small.fee, 5, "below the floor, the floor applies");
    const large = await calculateFee("send_money", 1000);     // 1% = 10.00, above the floor
    assert.equal(large.fee, 10, "above the floor, the percentage applies");
  });
});

test("a maximum fee is a cap the customer cannot exceed", async () => {
  await withRule(rule({ fee_type: "PERCENTAGE", percentage_fee: 2, maximum_fee: 25 }), async () => {
    const under = await calculateFee("send_money", 100);      // 2% = 2.00
    assert.equal(under.fee, 2);
    const over = await calculateFee("send_money", 100000);    // 2% = 2000, capped
    assert.equal(over.fee, 25, "the cap holds however large the transfer");
    assert.equal(over.total, 100025);
  });
});

test("a free service is free, and charges nothing on top", async () => {
  await withRule(rule({ fee_type: "FREE" }), async () => {
    const fee = await calculateFee("send_money", 250);
    assert.equal(fee.fee, 0);
    assert.equal(fee.total, 250, "no fee means the total is the amount");
  });
});

test("flat and percentage together add, they do not replace each other", async () => {
  await withRule(rule({ flat_fee: 2, percentage_fee: 1 }), async () => {
    const fee = await calculateFee("send_money", 100);        // 2.00 + 1.00
    assert.equal(fee.fee, 3);
    assert.equal(fee.total, 103);
  });
});

test("the QR fee is what the schedule says, and nothing overrides it in code", async () => {
  // There used to be `if (serviceCode === "qr_payment") fee = Math.max(fee, 0.50)`
  // here, written when the QR fee WAS a flat 50c. It silently overrode anything
  // an operator configured below that figure, which is the wrong place for a
  // floor: a floor belongs in minimum_fee, where an admin can see it and change
  // it. The schedule now carries R1.50 + 1% capped at R10.
  await withRule(rule({ service_code: "qr_payment", fee_type: "FREE", flat_fee: 0, percentage_fee: 0 }), async () => {
    const fee = await calculateFee("qr_payment", 100);
    assert.equal(fee.fee, 0, "a rule set to free must actually be free, not silently 50c");
  });
  // And a floor set where it belongs is honoured.
  await withRule(rule({ service_code: "qr_payment", flat_fee: 0, percentage_fee: 0, minimum_fee: 0.5 }), async () => {
    const fee = await calculateFee("qr_payment", 100);
    assert.equal(fee.fee, 0.5, "minimum_fee is the floor an admin can see");
  });
});

test("the QR customer fee is R1.50 + 1%, capped at R10", async () => {
  await withRule(rule({ service_code: "qr_payment", flat_fee: 1.5, percentage_fee: 1, minimum_fee: 0, maximum_fee: 10 }), async () => {
    for (const [amount, expected] of [[10, 1.6], [50, 2], [250, 4], [850, 10], [5000, 10]]) {
      const fee = await calculateFee("qr_payment", amount);
      assert.equal(fee.fee, expected, `R${amount} should charge R${expected}, charged R${fee.fee}`);
      assert.equal(fee.total, roundMoney(amount + expected), "the total is the amount plus the fee");
    }
  });
});

test("the QR merchant fee is 1.5%, and it is uncapped", async () => {
  await withRule(rule({ service_code: "merchant_qr_payment", fee_type: "PERCENTAGE", flat_fee: 0, percentage_fee: 1.5, minimum_fee: 0, maximum_fee: 0 }), async () => {
    for (const [amount, expected] of [[10, 0.15], [250, 3.75], [5000, 75]]) {
      const fee = await calculateFee("merchant_qr_payment", amount);
      assert.equal(fee.fee, expected, `R${amount} should charge the merchant R${expected}, charged R${fee.fee}`);
    }
  });
});

/* -------------------------------------------------------------- rounding */

test("money is rounded to cents, and does not drift", () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3, "the classic float case");
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(2.675), 2.68);
  assert.equal(roundMoney(-0), 0);
  assert.equal(roundMoney(1e6 / 3), 333333.33);
});

test("a percentage that lands between cents is rounded, not truncated", async () => {
  await withRule(rule({ fee_type: "PERCENTAGE", percentage_fee: 1.7 }), async () => {
    const fee = await calculateFee("send_money", 33.33);      // 1.7% = 0.566...
    assert.equal(fee.fee, 0.57, "rounded to the nearest cent");
    assert.equal(fee.total, 33.9);
    // The total must equal amount + fee to the cent — never amount + unrounded.
    assert.equal(fee.total, roundMoney(fee.amount + fee.fee));
  });
});

test("the amount and the fee always reconcile into the total", async () => {
  await withRule(rule({ flat_fee: 1.11, percentage_fee: 2.33 }), async () => {
    for (const amount of [0.01, 1, 9.99, 33.33, 100, 12345.67]) {
      const fee = await calculateFee("send_money", amount);
      assert.equal(fee.total, roundMoney(fee.amount + fee.fee), `reconciliation at ${amount}`);
    }
  });
});

/* ------------------------------------------------- what a client can send */

test("an amount that is not a positive number is refused before pricing", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [] });
  try {
    for (const amount of [0, -1, -0.01, "abc", null, undefined, NaN, Infinity, -Infinity]) {
      await assert.rejects(
        transactions.feePreview({ service: "send_money", amount }),
        (error) => error.statusCode === 400,
        `amount ${JSON.stringify(String(amount))} must be refused`
      );
    }
  } finally {
    pool.query = originalQuery;
  }
});

test("a missing service code is refused", async () => {
  await assert.rejects(
    transactions.feePreview({ amount: 100 }),
    (error) => error.statusCode === 400 && /service is required/.test(error.message)
  );
});

test("service codes are normalised, so one price cannot hide behind two spellings", () => {
  // Two spellings that resolve differently would be two prices for one product.
  assert.equal(normalizeServiceCode("Send Money"), normalizeServiceCode("send_money"));
  assert.equal(normalizeServiceCode("SEND_MONEY"), normalizeServiceCode("send_money"));
  assert.equal(normalizeServiceCode(" send_money "), normalizeServiceCode("send_money"));
});

test("no fee is ever negative, and no total is ever less than the amount", async () => {
  // A negative fee debits the customer LESS than the amount while the recipient
  // is credited the full amount, and "credits" the revenue wallet a negative
  // number — which debits it. TitoPay funds the difference. Guarded in two
  // places: updatePricingRule refuses to store one, and calculateFee floors it
  // anyway, because a bad row can also arrive from a migration or a seed.
  await withRule(rule({ flat_fee: -5, percentage_fee: -1 }), async () => {
    const fee = await calculateFee("send_money", 100);
    assert.equal(fee.fee, 0, "a negative schedule prices at zero, never below");
    assert.ok(fee.total >= fee.amount, `total ${fee.total} is less than amount ${fee.amount}`);
  });
  await withRule(rule({ flat_fee: Number.NaN }), async () => {
    const fee = await calculateFee("send_money", 100);
    assert.ok(Number.isFinite(fee.fee), `a NaN schedule produced ${fee.fee}`);
    assert.equal(fee.total, 100);
  });
});

test("a pricing rule with a negative or impossible value is refused", async () => {
  const { updatePricingRule } = require("../src/services/pricing-service");
  const actor = { userType: "admin", userId: "33333333-3333-4333-8333-333333333333" };
  const originalQuery = pool.query;
  let wrote = false;
  pool.query = async (sql) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/^UPDATE pricing_rules/i.test(q)) { wrote = true; return { rows: [{ id: "r1", service_code: "send_money" }] }; }
    return { rows: [] };
  };
  try {
    for (const payload of [
      { flatFee: -5 },
      { percentageFee: -1 },
      { minimum_fee: -0.01 },
      { maximum_fee: -1 },
      { vatPercentage: -15 },
      { percentageFee: 101 },
      { minimum_fee: 50, maximum_fee: 10 }
    ]) {
      await assert.rejects(
        updatePricingRule("r1", payload, actor),
        (error) => error.statusCode === 400,
        `${JSON.stringify(payload)} must be refused`
      );
    }
    assert.equal(wrote, false, "nothing invalid may reach the database");
  } finally {
    pool.query = originalQuery;
  }
});
