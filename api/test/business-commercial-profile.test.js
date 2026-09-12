"use strict";

// WHAT A BUSINESS DOES, AND WHERE ITS MONEY COMES FROM.
//
// The two things that matter most in this file are what it does NOT do: it
// does not move kyb_status, and it does not go anywhere near the Support
// approval queue that a business NAME change goes through. Both are asserted,
// because both are the kind of thing that gets wired in later by accident.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const reference = require("../src/config/business-profile-reference");
const service = require("../src/services/business-verification-service");
const { pool } = require("../src/db/pool");

async function seedBusiness() {
  await service.ensureBusinessSchema();
  const userId = crypto.randomUUID();
  const businessId = crypto.randomUUID();
  const suffix = crypto.randomBytes(5).toString("hex");
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, password_hash, account_type)
     VALUES ($1,'Biz Owner',$2,$3,$4,'x','business')`,
    [userId, `biz_${suffix}`, `biz_${suffix}@example.invalid`,
     `+2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  await pool.query(
    `INSERT INTO business_profiles (id, account_user_id, business_name, business_type, created_by)
     VALUES ($1,$2,'Kasi Kitchen','sole_proprietor',$2)`,
    [businessId, userId]
  );
  await pool.query(
    `INSERT INTO business_representatives (id, business_id, person_user_id, role, status)
     VALUES ($1,$2,$3,'owner','active')`,
    [crypto.randomUUID(), businessId, userId]
  ).catch(async () => {
    // Column set differs on some installs; the authorisation join only needs
    // these three, so retry with the minimum.
    await pool.query(
      `INSERT INTO business_representatives (business_id, person_user_id, role, status)
       VALUES ($1,$2,'owner','active')`,
      [businessId, userId]
    );
  });
  return { userId, businessId };
}

async function cleanup(seed) {
  if (!seed) return;
  await pool.query("DELETE FROM business_representatives WHERE business_id=$1", [seed.businessId]).catch(() => {});
  await pool.query("DELETE FROM business_profiles WHERE id=$1", [seed.businessId]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [seed.userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [seed.userId]).catch(() => {});
}

/* ============================================================ the reference */

test("the industry list is TitoPay's, not a generic bank's", () => {
  const keys = reference.INDUSTRY_KEYS;
  // The businesses that actually use TitoPay have to be findable.
  for (const expected of ["retail_general", "food_drink", "transport_logistics",
                          "beauty_personal_care", "construction_trades", "funeral_services"]) {
    assert.ok(keys.includes(expected), `${expected} must be offerable`);
  }
  // Every entry is usable: a key, a label, and a hint that says who it is for.
  for (const item of reference.INDUSTRIES) {
    assert.match(item.key, /^[a-z0-9_]+$/, `${item.key} must be a stable key`);
    assert.ok(item.label && item.label.length > 2);
    assert.ok(item.hint && item.hint.length > 2, `${item.key} needs a hint`);
  }
  // Keys are unique, or a stored row would be ambiguous.
  assert.equal(new Set(keys).size, keys.length);
});

test("the sources of funds cover how a small business is actually paid", () => {
  for (const expected of ["trading_income", "professional_fees", "contract_tender",
                          "grants_donations", "owner_contribution", "asset_disposal"]) {
    assert.ok(reference.SOURCE_KEYS.includes(expected), `${expected} must be offerable`);
  }
  assert.equal(new Set(reference.SOURCE_KEYS).size, reference.SOURCE_KEYS.length);
  assert.equal(reference.MAX_SOURCES_OF_FUNDS, 5);
});

/* ================================================================ the flow */

test("a business can declare what it does and where its money comes from", async () => {
  const seed = await seedBusiness();
  try {
    const before = await service.getCommercialProfile(seed.userId, seed.businessId);
    assert.equal(before.industry, null, "nothing is assumed on a new business");
    assert.deepEqual(before.sourcesOfFunds, []);
    assert.ok(before.options.industries.length > 10, "the screen gets its options from the server");

    const after = await service.updateCommercialProfile(seed.userId, seed.businessId, {
      industry: "food_drink",
      sourcesOfFunds: ["trading_income", "contract_tender"]
    });
    assert.equal(after.industry, "food_drink");
    assert.equal(after.industryLabel, "Food and drink");
    assert.deepEqual(after.sourcesOfFunds, ["trading_income", "contract_tender"]);
    assert.equal(after.primarySourceOfFunds, "trading_income", "the first entry is the primary");
    assert.ok(after.updatedAt, "when they told us is recorded");
  } finally { await cleanup(seed); }
});

test("the order of sources is preserved, because the first one is the primary", async () => {
  const seed = await seedBusiness();
  try {
    const a = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { sourcesOfFunds: ["grants_donations", "trading_income"] });
    assert.equal(a.primarySourceOfFunds, "grants_donations");
    const b = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { sourcesOfFunds: ["trading_income", "grants_donations"] });
    assert.equal(b.primarySourceOfFunds, "trading_income", "reordering changes the primary");
  } finally { await cleanup(seed); }
});

test("an unknown industry or source is refused rather than stored", async () => {
  const seed = await seedBusiness();
  try {
    await assert.rejects(
      async () => service.updateCommercialProfile(seed.userId, seed.businessId, { industry: "cryptomining" }),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
    await assert.rejects(
      async () => service.updateCommercialProfile(seed.userId, seed.businessId,
        { sourcesOfFunds: ["trading_income", "smuggling"] }),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
    const profile = await service.getCommercialProfile(seed.userId, seed.businessId);
    assert.equal(profile.industry, null, "a refused update stores nothing");
  } finally { await cleanup(seed); }
});

test("more than five sources is refused, and duplicates are collapsed not refused", async () => {
  const seed = await seedBusiness();
  try {
    await assert.rejects(
      async () => service.updateCommercialProfile(seed.userId, seed.businessId, {
        sourcesOfFunds: ["trading_income", "professional_fees", "contract_tender",
                         "commission", "rental_income", "investment_income"]
      }),
      /up to 5/i
    );
    // Picking the same thing twice is a slip, not something to stop somebody for.
    const ok = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { sourcesOfFunds: ["trading_income", "trading_income", "commission"] });
    assert.deepEqual(ok.sourcesOfFunds, ["trading_income", "commission"]);
  } finally { await cleanup(seed); }
});

test("\"Something else\" requires the business to say what it means", async () => {
  const seed = await seedBusiness();
  try {
    await assert.rejects(
      async () => service.updateCommercialProfile(seed.userId, seed.businessId, { industry: "other" }),
      /what the business does/i
    );
    const saved = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { industry: "other", industryOther: "Mobile car detailing at office parks" });
    assert.equal(saved.industryOther, "Mobile car detailing at office parks");

    // And the free text is dropped the moment they pick a real option, so a
    // stale sentence cannot sit behind a chosen industry.
    const changed = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { industry: "motor_automotive" });
    assert.equal(changed.industryOther, null);
  } finally { await cleanup(seed); }
});

/* ============================================== what it must NOT touch */

test("declaring an industry does not verify anybody: kyb_status never moves", async () => {
  const seed = await seedBusiness();
  try {
    const before = await pool.query("SELECT kyb_status, kyb_reviewed_at FROM business_profiles WHERE id=$1", [seed.businessId]);
    await service.updateCommercialProfile(seed.userId, seed.businessId, {
      industry: "professional_services",
      sourcesOfFunds: ["professional_fees"]
    });
    const after = await pool.query("SELECT kyb_status, kyb_reviewed_at FROM business_profiles WHERE id=$1", [seed.businessId]);
    assert.deepEqual(after.rows[0], before.rows[0],
      "a self-declared commercial profile is not verification");
  } finally { await cleanup(seed); }
});

test("it does not create a Support approval request", async () => {
  const seed = await seedBusiness();
  try {
    await service.updateCommercialProfile(seed.userId, seed.businessId, { industry: "retail_general" });
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM profile_change_requests WHERE user_id=$1", [seed.userId]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    assert.equal(rows[0].n, 0,
      "industry is the business describing itself, not an identity change needing a human");
  } finally { await cleanup(seed); }
});

test("somebody who is not on the business cannot read or change it", async () => {
  const mine = await seedBusiness();
  const theirs = await seedBusiness();
  try {
    await assert.rejects(
      async () => service.getCommercialProfile(theirs.userId, mine.businessId),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
    await assert.rejects(
      async () => service.updateCommercialProfile(theirs.userId, mine.businessId, { industry: "food_drink" }),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
  } finally { await cleanup(mine); await cleanup(theirs); }
});

test("the change is audited, with the keys and not the customer's own words", async () => {
  const seed = await seedBusiness();
  try {
    await service.updateCommercialProfile(seed.userId, seed.businessId, {
      industry: "other", industryOther: "Something private about my trade"
    });
    const { rows } = await pool.query(
      "SELECT action, metadata FROM audit_logs WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 1",
      [seed.userId]
    );
    assert.equal(rows[0].action, "business_commercial_profile_updated");
    const serialised = JSON.stringify(rows[0].metadata);
    assert.match(serialised, /other/);
    assert.ok(!serialised.includes("Something private about my trade"),
      "free text is not copied into a second place by default");
  } finally { await cleanup(seed); }
});

test("a partial update leaves the other half alone", async () => {
  const seed = await seedBusiness();
  try {
    await service.updateCommercialProfile(seed.userId, seed.businessId, {
      industry: "beauty_personal_care", sourcesOfFunds: ["trading_income"]
    });
    // Only the sources are sent this time.
    const after = await service.updateCommercialProfile(seed.userId, seed.businessId,
      { sourcesOfFunds: ["trading_income", "commission"] });
    assert.equal(after.industry, "beauty_personal_care", "the industry must survive");
    assert.deepEqual(after.sourcesOfFunds, ["trading_income", "commission"]);
  } finally { await cleanup(seed); }
});
