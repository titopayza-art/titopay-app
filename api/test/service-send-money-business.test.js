"use strict";

// SEND MONEY IS NOT A PERSONAL-ONLY ACT.
//
// send-money seeded with business_visible = FALSE, so a business account had
// no tile for paying anybody from its own wallet - a supplier, a driver, a
// walk-in refund - though it is the same wallet transfer a personal account
// has always had. There was no rule behind the flag, only a default.
//
// service_config seeds ON CONFLICT DO NOTHING, so changing DEFAULT_SERVICES
// reaches a fresh installation and nothing else. The fixup is what reaches a
// database that already has the row, and this drives it directly rather than
// through ensureDefaultServices, so a broken fixup fails here instead of being
// covered by the seed on its way past.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const services = require("../src/services/service-management-service");

const FIXUP_KEY = "service_fixup_send_money_business_visible";

async function resetFixup() {
  await pool.query("DELETE FROM platform_settings WHERE key = $1", [FIXUP_KEY]);
}

test.after(async () => {
  await pool.end();
});

test("the default catalogue offers Send Money to both account types", () => {
  const row = services.DEFAULT_SERVICES.find((item) => item[0] === "send-money");
  assert.ok(row, "send-money is in DEFAULT_SERVICES");
  // [code, name, icon, action, description, status, personalVisible, businessVisible, ...]
  assert.equal(row[6], true, "personal accounts keep it");
  assert.equal(row[7], true, "and business accounts get it");
});

test("THE FIXUP TURNS IT ON FOR A DATABASE THAT ALREADY HAS THE ROW", async () => {
  await services.ensureDefaultServices();
  await resetFixup();
  await pool.query("UPDATE service_config SET business_visible = FALSE WHERE service_code = 'send-money'");

  const before = await pool.query(
    "SELECT business_visible FROM service_config WHERE service_code = 'send-money'");
  assert.equal(before.rows[0].business_visible, false, "the state this repairs");

  await services.openSendMoneyToBusinessOnce();

  const after = await pool.query(
    "SELECT business_visible, personal_visible FROM service_config WHERE service_code = 'send-money'");
  assert.equal(after.rows[0].business_visible, true, "a business account can now see it");
  assert.equal(after.rows[0].personal_visible, true, "and a personal account still can");
});

test("it runs once, so an operator who hides it again keeps that decision", async () => {
  await services.openSendMoneyToBusinessOnce();
  const marker = await pool.query("SELECT 1 FROM platform_settings WHERE key = $1", [FIXUP_KEY]);
  assert.equal(marker.rows.length, 1, "the run is recorded");

  // The operator's decision, made after the repair.
  await pool.query("UPDATE service_config SET business_visible = FALSE WHERE service_code = 'send-money'");
  await services.openSendMoneyToBusinessOnce();
  const { rows } = await pool.query(
    "SELECT business_visible FROM service_config WHERE service_code = 'send-money'");
  assert.equal(rows[0].business_visible, false, "the fixup does not override a choice");

  // Leave the catalogue as the platform intends it.
  await pool.query("UPDATE service_config SET business_visible = TRUE WHERE service_code = 'send-money'");
});

test("it never throws, because it sits on the path of every catalogue read", async () => {
  await resetFixup();
  const original = pool.query;
  pool.query = async () => { throw new Error("database is down"); };
  try {
    await assert.doesNotReject(() => services.openSendMoneyToBusinessOnce());
  } finally {
    pool.query = original;
  }
  await resetFixup();
  await services.openSendMoneyToBusinessOnce();
  await pool.query("UPDATE service_config SET business_visible = TRUE WHERE service_code = 'send-money'");
});
