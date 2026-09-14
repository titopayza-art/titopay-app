"use strict";

// A BUSINESS DOCUMENT MUST NOT BE ROUTED LIKE A PAYMENT.
//
// Reported with a screenshot: "Create a proforma invoice" opened Transaction
// Review, offering to deduct R602.50 from the issuer and telling them "The
// recipient receives R600.00" - the business paying the customer it meant to
// bill. The invoice total had been read as a transfer principal.
//
// The customer app dispatches a tile on service_config.action, and
// ensureDefaultServices only writes that column when the catalogue is SHORT;
// on an installed database a blank or stale action is never repaired, the
// match fails, and the tile falls through to the generic money form.
//
// Two things are checked. That the stored action is repaired, and - the part
// that matters for a payments product - that the server would have refused
// the debit anyway. Defence in depth: the screen was wrong, the money was not.

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");

const DOCUMENT_CODES = ["invoice", "quote", "proforma-invoice"];

test("a stale or blank action on a document service is repaired", async () => {
  const services = require("../src/services/service-management-service");
  await services.ensureDefaultServices();

  // Exactly the shapes an installed database has been seen to carry.
  const broken = { invoice: "", quote: "none", "proforma-invoice": "proforma" };
  for (const [code, action] of Object.entries(broken)) {
    await pool.query("UPDATE service_config SET action = $2 WHERE service_code = $1", [code, action]);
  }

  await services.ensureDefaultServices();

  const { rows } = await pool.query(
    "SELECT service_code, action FROM service_config WHERE service_code = ANY($1) ORDER BY service_code",
    [DOCUMENT_CODES]);
  for (const row of rows) {
    assert.equal(row.action, row.service_code,
      `${row.service_code} must dispatch to its document screen, not fall through to the money form`);
  }
});

test("an action an operator set deliberately is left exactly as they set it", async () => {
  const services = require("../src/services/service-management-service");
  await pool.query(
    "UPDATE service_config SET action = 'custom-operator-choice' WHERE service_code = 'quote'");
  await services.ensureDefaultServices();
  const { rows } = await pool.query(
    "SELECT action FROM service_config WHERE service_code = 'quote'");
  assert.equal(rows[0].action, "custom-operator-choice",
    "a repair that overwrites deliberate configuration is a different bug");
  // Put it back so the rest of the suite sees a healthy catalogue.
  await pool.query("UPDATE service_config SET action = 'quote' WHERE service_code = 'quote'");
});

test("THE MONEY WAS NEVER AT RISK: a document code is refused a wallet debit", async () => {
  const tx = require("../src/services/transaction-service");
  const id = uuidv4();
  const stamp = String(Date.now()).slice(-6);
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'Doc Probe',$2,$3,$4,'business','active','verified','x')`,
    [id, `docprobe_${stamp}`, `docprobe_${stamp}@test.local`, `+2782${stamp}1`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',2000)`,
    [uuidv4(), id, `${stamp}9911`]);
  const actor = { userId: id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "test" };

  for (const code of ["proforma_invoice", "invoice", "quote"]) {
    const before = (await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [id])).rows[0].available_balance;
    await assert.rejects(
      tx.createTransaction(actor, { serviceCode: code, amount: 600, recipient: `${stamp}9911` }),
      /not enabled for live processing/,
      `${code} must never debit a wallet`);
    const after = (await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1", [id])).rows[0].available_balance;
    assert.equal(String(after), String(before), `${code} moved money and must not have`);
  }
});

test.after(async () => { await pool.end().catch(() => null); });
