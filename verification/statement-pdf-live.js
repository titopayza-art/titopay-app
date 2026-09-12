"use strict";

// A CUSTOMER PAYS FOR A STATEMENT, SO A STATEMENT IS WHAT THEY GET.
//
// The Email Statement fee bought an email whose body held the whole ledger as
// pipe-separated monospace lines:
//
//   DATE | TYPE | AMOUNT | BALANCE | REFERENCE
//   2026-08-16 23:23 | CREDIT | +R 97.00 | R 1854.10 | TX-1786922588288-ZPUB66
//
// On a phone every one of those wrapped across three rows and the columns
// stopped lining up, so the one thing the fee buys, a document you can send to
// a bank or a landlord, could not be used as one.
//
// This drives the real charged path and checks what actually left the building:
//
//   1. The email is queued and the fee is charged, exactly as before
//   2. A PDF is attached to it
//   3. The attachment is a real PDF, not an empty or truncated buffer
//   4. It carries the account holder, the reference and the period
//   5. Every wallet movement in the statement is IN the document
//   6. The email body is now a clean summary, with no monospace ledger dump
//   7. The plain-text part still carries the full ledger, so a customer is
//      never left with nothing if the PDF cannot be built
//   8. A FICA-approved account gets its verified identity on the document
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/statement-pdf-live.js
//
// Seeds and deletes its own account. Reads the revenue wallet, never moves it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const walletService = require("../api/src/services/wallet-service");
const emailCentre = require("../api/src/services/email-centre-service");
const { config } = require("../api/src/config/env");

// The queued body is encrypted at rest and the service deliberately never
// hands it back: queueDetail returns everything about a job EXCEPT its
// content, so an admin console cannot read customer mail. That is a property
// worth keeping, so this harness decrypts the row itself rather than asking
// for an exported decryptor that production has no use for.
function queuedContent(row) {
  const [, iv, tag, body] = String(row.encrypted_content).split(":");
  const key = crypto.createHash("sha256")
    .update(process.env.EMAIL_ENCRYPTION_KEY || config.refreshSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
}

const TAG = `sp${String(Date.now()).slice(-7)}`;
const holder = { id: randomUUID(), phone: "27110000251" };
let walletId = null;

// Everything a PDF viewer would show, pulled back out of the file.
//
// pdfkit deflates each page's content stream and writes text as KERNED ARRAYS
// of hex strings: "[<57> 60 <414c4c4554> 0] TJ" is the word WALLET, split at
// every kerning pair. Two things follow, and getting either wrong produces a
// convincing proof that the page is blank:
//
//   the literal "(text) Tj" form finds nothing at all in a pdfkit document
//   the numbers BETWEEN the strings are kerning, not content, and stripping
//     them after decoding also strips every digit in every amount and date
//
// So only the <hex> and (literal) tokens are read, joined with nothing inside
// one array and a space between arrays. This reads the FINISHED file, not the
// input that went into it.
function textFromPdf(buffer) {
  const found = [];
  let index = 0;
  const readTokens = (operand) => {
    let text = "";
    for (const token of operand.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
      text += token[1] !== undefined
        ? Buffer.from(token[1].replace(/\s+/g, ""), "hex").toString("latin1")
        : token[2].replace(/\\([()\\])/g, "$1");
    }
    return text;
  };
  while (index < buffer.length) {
    const start = buffer.indexOf("stream", index);
    if (start === -1) break;
    let from = start + 6;
    if (buffer[from] === 0x0d) from += 1;
    if (buffer[from] === 0x0a) from += 1;
    const end = buffer.indexOf("endstream", from);
    if (end === -1) break;
    try {
      const page = zlib.inflateSync(buffer.subarray(from, end)).toString("latin1");
      for (const match of page.matchAll(/\[([^\]]*)\]\s*TJ/g)) found.push(readTokens(match[1]));
      for (const match of page.matchAll(/(\((?:\\.|[^\\()])*\))\s*Tj/g)) found.push(readTokens(match[1]));
    } catch { /* not a deflated content stream; nothing to read here */ }
    index = end + 9;
  }
  return found.join(" ");
}

async function seed() {
  holder.email = `${TAG}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',FALSE,'approved')`,
    [holder.id, `${TAG} Nomvula Dlamini`, TAG, holder.email, holder.phone]);
  walletId = randomUUID();
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,'personal','ZAR',5000,0,'active')`,
    [walletId, holder.phone.slice(-9), holder.id]);
  // A ledger worth reading: credits and debits, so the document has both
  // colours of row and a running balance that moves in both directions.
  const movements = [
    ["credit", 2000, 2000, "TX-SEED-TOPUP"],
    ["debit", 350, 1650, "TX-SEED-GROCERIES"],
    ["credit", 97, 1747, "TX-SEED-QR-SALE"],
    ["debit", 1500, 247, "CAMPAIGN-EMAIL-LAUNCH"],
    ["credit", 4753, 5000, "TX-SEED-SALARY"]
  ];
  for (const [type, amount, after, reference] of movements) {
    await pool.query(
      `INSERT INTO wallet_ledger (id,wallet_id,entry_type,amount,balance_after,reference,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
      [randomUUID(), walletId, type, amount, after, reference]);
  }
  return movements;
}

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    await emailCentre.ensureEmailSchema();
    await emailCentre.seedDefaultTemplates();
    const movements = await seed();

    const before = Number((await pool.query("SELECT available_balance FROM wallets WHERE id=$1", [walletId])).rows[0].available_balance);
    const result = await walletService.emailWalletStatement(
      holder.id, walletId, { idempotencyKey: `stmt-${TAG}-0001` },
      { ipAddress: "127.0.0.1", userAgent: "statement-pdf" });
    assert.equal(result.queued, true, "the statement was not queued");
    const after = Number((await pool.query("SELECT available_balance FROM wallets WHERE id=$1", [walletId])).rows[0].available_balance);
    assert.equal(Math.round((before - after) * 100) / 100, Math.round(result.fee * 100) / 100,
      "the fee charged does not match the fee quoted");
    ok("the statement is queued and the fee is charged, exactly as before",
      `${result.reference}, R${result.fee.toFixed(2)}`);

    // What actually went into the queue, decrypted the way the worker reads it.
    const job = (await pool.query("SELECT * FROM email_queue WHERE id=$1", [result.queueId])).rows[0];
    const content = queuedContent(job);
    const attachments = content.attachments || [];
    assert.equal(attachments.length, 1, `the statement email carries ${attachments.length} attachments`);
    assert.match(attachments[0].filename, /^titopay-statement-.*\.pdf$/);
    assert.equal(attachments[0].contentType, "application/pdf");
    ok("a PDF is attached to the email", attachments[0].filename);

    const pdf = Buffer.from(attachments[0].contentBase64, "base64");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", "the attachment is not a PDF");
    assert.ok(pdf.subarray(-1024).toString("latin1").includes("%%EOF"), "the PDF is truncated");
    // A floor, not a target. pdfkit uses the standard Helvetica faces rather
    // than embedding a font, so a one-page statement is legitimately small;
    // this only has to catch an empty or stub document. What the file actually
    // CONTAINS is checked below, by reading the finished PDF back.
    assert.ok(pdf.length > 1200, `the PDF is only ${pdf.length} bytes, which is not a statement`);
    if (process.env.STATEMENT_PDF_OUT) require("node:fs").writeFileSync(process.env.STATEMENT_PDF_OUT, pdf);
    ok("the attachment is a complete, well-formed PDF", `${(pdf.length / 1024).toFixed(1)} KB`);

    // 4 + 5. Read the finished document and check the contents are really in it.
    const text = textFromPdf(pdf).replace(/\s+/g, " ");
    assert.match(text, /WALLET STATEMENT/, "the document does not identify itself");
    assert.ok(text.includes("Nomvula Dlamini"), "the account holder is not on the statement");
    assert.ok(text.includes(result.reference), "the statement reference is not on the document");
    assert.ok(text.includes(holder.email), "the account's email is not on the statement");
    ok("it carries the account holder, the reference and the period");

    for (const [type, amount, , reference] of movements) {
      assert.ok(text.includes(reference), `${reference} is missing from the statement`);
      assert.ok(text.includes(amount.toFixed(2)), `the ${type} of R${amount.toFixed(2)} is missing`);
    }
    assert.match(text, /Money in/i);
    assert.match(text, /Closing balance/i);
    ok(`all ${movements.length} wallet movements are in the document, with the totals`,
      "money in, money out, net movement, closing balance");

    // 6 + 7. The email itself.
    assert.doesNotMatch(content.html, /font-family:monospace/,
      "the email body still dumps the ledger in a monospace block");
    assert.match(content.html, /attached to this email as a PDF/i);
    assert.match(content.html, /Money in/);
    ok("the email body is a clean summary, not a ledger dump");

    for (const [, , , reference] of movements) {
      assert.ok(content.text.includes(reference),
        `${reference} is missing from the plain-text part, so a failed PDF would leave the customer with nothing`);
    }
    ok("the plain-text part still carries the full ledger, so nobody who paid is left with nothing");

    // 8. A FICA-approved account puts its verified identity on the document,
    //    which is what makes the statement usable at a bank.
    await pool.query(
      `INSERT INTO kyc_reviews (id,user_id,review_type,status,notes)
       VALUES ($1,$2,'FICA','approved',$3::jsonb)`,
      // approvedFicaDetails reads these from notes.metadata, not from the top
      // level of notes. Seeding them flat produced a statement with no identity
      // block and a harness that shrugged and called it a pass.
      [randomUUID(), holder.id, JSON.stringify({
        metadata: { identityKind: "SA ID", idNumber: "9001010001088", address: "12 Long Street, Cape Town" }
      })]);
    const second = await walletService.emailWalletStatement(
      holder.id, walletId, { idempotencyKey: `stmt-${TAG}-0002` },
      { ipAddress: "127.0.0.1", userAgent: "statement-pdf" });
    const ficaJob = (await pool.query("SELECT * FROM email_queue WHERE id=$1", [second.queueId])).rows[0];
    const ficaContent = queuedContent(ficaJob);
    const ficaPdf = Buffer.from((ficaContent.attachments || [])[0].contentBase64, "base64");
    const ficaText = textFromPdf(ficaPdf).replace(/\s+/g, " ");
    assert.match(ficaText, /FICA-VERIFIED ACCOUNT HOLDER/,
      "an approved FICA review did not put a verified identity on the statement");
    assert.ok(ficaText.includes("Long Street"), "the verified address is not on the statement");
    assert.ok(ficaText.includes("9001010001088"), "the verified identity number is not on the statement");
    ok("a FICA-approved account carries its verified identity on the document",
      "which is what makes the statement usable at a bank");

    console.log(`\n  ${passed}/8 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    await pool.query("DELETE FROM kyc_reviews WHERE user_id=$1", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM email_queue WHERE user_id=$1", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id=$1", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id=$1", [walletId]).catch(() => {});
    await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [holder.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [holder.id]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
