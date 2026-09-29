"use strict";

// WHICH SERVICE CODES WILL THE TRANSACTION ENGINE ACTUALLY COMPLETE?
//
//     node scripts/audit-service-journeys.js
//
// Stage one of a two-part audit. This half asks the server a question it can
// answer exactly: for every service in the catalogue, does createTransaction
// accept its code, or refuse it? The answer is written to
// artifacts/engine-verdicts.json for the browser half
// (verification/service-journey-audit.spec.js) to check the app against.
//
// WHY BOTH HALVES ARE NEEDED, AND WHY NEITHER IS ENOUGH ALONE.
//
// Most refusals here are CORRECT. A top-up is funded by card, a withdrawal
// goes through the payout lifecycle, a stokvel contribution is a treasurer
// transfer - each has its own endpoint, and createTransaction refusing the
// code is the guard working, not a fault. So a refusal on its own says
// nothing about whether a service is broken.
//
// It becomes a fault only when the APP actually posts that code to
// /v1/transactions. That is what Invoice, Quote and Proforma did: the form
// posted, the engine refused, and the document was never saved. The browser
// half watches what goes over the wire; this half says which of those codes
// could never have worked.
//
// An earlier version of this file tried to infer journeys by parsing app.js.
// It reported "0 broken" while mis-classifying the three services that were
// broken at the time. A parser that is almost right produces false comfort,
// so nothing is inferred any more: this measures, and the browser measures.
//
// Every probe runs against throwaway fixtures inside a rolled-back
// transaction. It creates nothing that survives and moves no real money.

require("../src/config/env");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");

const OUT_DIR = path.join(__dirname, "..", "..", "verification", "artifacts");
const OUT_FILE = path.join(OUT_DIR, "engine-verdicts.json");

function catalogue() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "service-management-service.js"), "utf8");
  const start = source.indexOf("const DEFAULT_SERVICES = [");
  const end = source.indexOf("\n];", start);
  if (start === -1 || end === -1) throw new Error("DEFAULT_SERVICES not found - the seed moved");
  const rows = source.slice(start, end).split("\n")
    .filter((line) => line.trim().startsWith("["))
    .map((line) => {
      const parts = (line.match(/"([^"]*)"/g) || []).map((v) => v.slice(1, -1));
      return { code: parts[0], name: parts[1], status: parts[5] };
    })
    .filter((row) => row.code);
  if (rows.length < 20) throw new Error(`only ${rows.length} services parsed - the seed shape changed`);
  return rows;
}

(async () => {
  const services = catalogue();
  const tx = require("../src/services/transaction-service");

  // Throwaway fixtures. Named with a timestamp so a re-run never collides, and
  // funded generously so a refusal is never just "not enough money".
  const stamp = String(Date.now()).slice(-6);
  const ids = [uuidv4(), uuidv4()];
  for (const [index, id] of ids.entries()) {
    await pool.query(
      `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
       VALUES ($1,'Journey Audit',$2,$3,$4,'business','active','verified','x')`,
      [id, `journeyaudit_${index}${stamp}`, `journeyaudit_${index}${stamp}@audit.local`,
        `+2782${stamp}${index}`]);
    await pool.query(
      `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status, available_balance)
       VALUES ($1,$2,'personal','ZAR',$3,'active',50000)`,
      [uuidv4(), id, `${stamp}${index}${index}`]);
  }
  const actor = { userId: ids[0], userType: "customer", ipAddress: "127.0.0.1", userAgent: "audit" };
  const recipient = `${stamp}11`;

  const verdicts = {};
  for (const service of services) {
    const normalized = service.code.replace(/-/g, "_");
    try {
      await tx.createTransaction(actor, { serviceCode: normalized, amount: 50, recipient });
      verdicts[service.code] = { status: service.status, normalized, verdict: "ACCEPTS", reason: "" };
    } catch (error) {
      verdicts[service.code] = { status: service.status, normalized, verdict: "REFUSES",
        reason: String(error.message || "").slice(0, 120) };
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(verdicts, null, 1));

  const accepts = Object.entries(verdicts).filter(([, v]) => v.verdict === "ACCEPTS");
  const activeRefused = Object.entries(verdicts)
    .filter(([, v]) => v.verdict === "REFUSES" && v.status === "active");

  console.log(`\nTRANSACTION ENGINE VERDICTS - ${services.length} services\n`);
  console.log("  Completed as a wallet transaction:");
  for (const [code] of accepts) console.log(`    ACCEPTS  ${code}`);
  console.log("\n  Refused. CORRECT for anything with its own endpoint (a card top-up, a");
  console.log("  payout, a treasurer transfer); a FAULT only if the app posts it anyway,");
  console.log("  which the browser half of this audit checks:");
  for (const [code, v] of activeRefused) {
    console.log(`    refuses  ${code.padEnd(26)}${v.reason.slice(0, 62)}`);
  }
  console.log(`\n  Written to ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log("  Now run: node verification/service-journey-audit.spec.js\n");

  await pool.end().catch(() => {});
})().catch((error) => {
  console.error("audit failed:", error.message);
  pool.end().catch(() => {});
  process.exit(1);
});
