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

// THE LAST STEP OF THE DOCUMENT JOURNEY: PAYING FOR THE PDF.
//
// Reported from the app after everything else was fixed: the document saved,
// the PDF screen opened correctly, and the charge came back "Business document
// pdf is not enabled for live processing yet."
//
// assertLiveTransactionSupported refuses anything it does not recognise. Every
// refusal above it says "this endpoint is the wrong door" - a card top-up, a
// payout and a VAS purchase each owe something on the other side that
// createTransaction cannot do. A fee-only service is the opposite: TitoPay
// sells it itself, the debit IS the fee, and nothing is owed to anyone else.
// It simply had no case in that gate, while the rest of the file - including
// feePreview - had been written to support it.

test("the PDF fee can actually be charged", async () => {
  const tx = require("../src/services/transaction-service");
  const id = uuidv4();
  const walletId = uuidv4();
  const stamp = String(Date.now()).slice(-6);
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'PDF Fee Probe',$2,$3,$4,'business','active','verified','x')`,
    [id, `pdffee_${stamp}`, `pdffee_${stamp}@test.local`, `+2782${stamp}5`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',1000)`,
    [walletId, id, `${stamp}55`]);
  const actor = { userId: id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "test" };

  const before = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);
  const result = await tx.createTransaction(actor, { serviceCode: "business_document_pdf", amount: 0 });
  const after = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);

  assert.equal(Number(result.amount), 0, "a fee-only service has no principal");
  assert.equal(Number(result.fee), 2.5);
  assert.equal(Number(result.total), 2.5, "the total IS the fee");
  assert.equal(Number((before - after).toFixed(2)), 2.5, "the wallet moves by the fee and nothing more");

  // Balanced: the customer's debit and revenue's credit are the same figure.
  const { rows: ledger } = await pool.query(
    "SELECT entry_type, amount FROM wallet_ledger WHERE transaction_id = $1 ORDER BY entry_type",
    [result.transactionId]);
  assert.equal(ledger.length, 2, "one debit, one credit");
  assert.equal(ledger.find((r) => r.entry_type === "debit").amount, "2.50");
  assert.equal(ledger.find((r) => r.entry_type === "credit").amount, "2.50");
});

test("a client cannot name its own price for a fee-only service", async () => {
  // The document total is not a principal. An amount sent by the app is
  // discarded before pricing, so nobody can be charged their invoice total
  // for a PDF - which is the shape of the bug this whole sequence began with.
  const tx = require("../src/services/transaction-service");
  const id = uuidv4();
  const walletId = uuidv4();
  const stamp = String(Date.now()).slice(-6);
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,'PDF Price Probe',$2,$3,$4,'business','active','verified','x')`,
    [id, `pdfprice_${stamp}`, `pdfprice_${stamp}@test.local`, `+2782${stamp}6`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
     VALUES ($1,$2,'personal','ZAR',$3,'active',1000)`,
    [walletId, id, `${stamp}66`]);
  const actor = { userId: id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "test" };

  const before = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);
  const result = await tx.createTransaction(actor,
    { serviceCode: "business_document_pdf", amount: 9999 });
  const after = Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);

  assert.equal(Number(result.total), 2.5, "the schedule decides the price, not the caller");
  assert.equal(Number((before - after).toFixed(2)), 2.5);
});

test.after(async () => { await pool.end().catch(() => null); });
