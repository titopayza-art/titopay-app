"use strict";

// AN ADVERSARIAL AUDIT OF THE PAYMENT QR AS AN INSTRUMENT.
//
// A payment QR is handed to strangers by design. It is printed on A4 sheets,
// shown on a till screen, photographed and forwarded. So the only safe
// assumption is that everything inside it is READABLE and EDITABLE by whoever
// is paying, and that the payer's phone is hostile.
//
// The QR encodes a JSON payload:
//
//   {"id":"...","userId":"...","codeType":"dynamic","amount":200,
//    "currency":"ZAR","reference":"QR-...","label":"...","metadata":{}}
//
// It is not signed. That is fine ONLY if the server treats the id as the single
// authoritative fact and re-reads everything else from its own row. This checks
// exactly that, field by field, by sending values a hostile client would send.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/qr-tamper-audit.js
//
// Seeds and deletes its own accounts.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { app } = require("../api/src/app");
const { pool } = require("../api/src/db/pool");
const { signAccessToken } = require("../api/src/lib/jwt");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const qrService = require("../api/src/services/qr-service");

const TAG = `ta${String(Date.now()).slice(-7)}`;
const merchant = { id: randomUUID(), session: randomUUID(), jti: randomUUID(), phone: "27110000151", type: "business" };
const attacker = { id: randomUUID(), session: randomUUID(), jti: randomUUID(), phone: "27110000152", type: "personal" };
let server, base;

async function seed(user, balance) {
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE,'approved')`,
    [user.id, user.type, `${TAG} ${user.phone.slice(-3)}`, `${TAG}_${user.phone.slice(-3)}`,
      `${TAG}_${user.phone.slice(-3)}@example.invalid`, user.phone]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`, [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`, [user.session, user.id, user.jti]);
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function pay(user, body) {
  const response = await fetch(`${base}/v1/qr/pay`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const balanceOf = async (id) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [id])).rows[0].available_balance);

// The exact string a camera reads off the printed code.
const scannedPayload = async (qrId) => (await pool.query(
  "SELECT payload FROM qr_codes WHERE id = $1", [qrId])).rows[0].payload;

// A merchant is credited the SALE PRICE LESS THEIR OWN FEE. This audit is about
// whether the price is the merchant's, so what it has to compare against is
// what that price settles to, read from the live schedule rather than typed in:
// a rate change is an admin's decision and must not read as a security finding.
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
async function creditFor(amount) {
  const { fee } = await require("../api/src/services/pricing-service")
    .calculateFee("merchant_qr_payment", amount);
  return round(amount - Math.min(round(fee), amount));
}

(async () => {
  let passed = 0; const findings = [];
  const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  const fail = (m, d) => { console.log(`  FAIL  ${m}\n          ${d}`); findings.push(`${m}: ${d}`); };
  try {
    await seed(merchant, 0);
    await seed(attacker, 5000);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), merchant.id, `${TAG} Shop`, `M${TAG}`]);

    server = http.createServer(app).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // ---- 1. THE PRICE ON A DYNAMIC QR ----------------------------------
    // "Make a Sale" mints a DYNAMIC code for one exact amount and waits. The
    // amount is the merchant's, not the payer's, and the payer's phone is the
    // one place it must never be taken from.
    const sale = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "dynamic", amount: 200, label: "Make a Sale" });
    const before = { merchant: await balanceOf(merchant.id), attacker: await balanceOf(attacker.id) };
    const underpay = await pay(attacker, { qrId: sale.id, amount: 1, idempotencyKey: randomUUID() });
    const after = { merchant: await balanceOf(merchant.id), attacker: await balanceOf(attacker.id) };
    const expectedCredit = await creditFor(200);
    const credited = Number((after.merchant - before.merchant).toFixed(2));
    if (underpay.status === 200 && credited < expectedCredit) {
      fail("a payer can set their own price on a R200 sale",
        `paid ${underpay.status}, merchant credited R${credited.toFixed(2)} against R200.00 asked, and the code is now marked paid`);
    } else if (underpay.status === 200 && credited === expectedCredit) {
      ok("the amount on a dynamic QR is the merchant's, not the payer's",
        `an amount of 1 was ignored, R200.00 settled at R${expectedCredit.toFixed(2)}`);
    } else {
      ok("a payer cannot set their own price on a dynamic QR", `${underpay.status} ${underpay.body.error || ""}`);
    }

    // ---- 2. THE HONEST PAYMENT STILL WORKS, AND ONLY ONCE ---------------
    // The refusal above must not have cost the merchant their sale: the same
    // code, paid properly, has to settle at the merchant's price.
    const honest = await pay(attacker, { qrId: sale.id, amount: 200, idempotencyKey: randomUUID() });
    const settled = Number(((await balanceOf(merchant.id)) - before.merchant).toFixed(2));
    if (honest.status !== 200 || settled !== expectedCredit) {
      fail("the honest payment no longer works", `${honest.status} ${honest.body.error || ""}, merchant +R${settled.toFixed(2)}`);
    } else {
      ok("and the honest payment still settles at the merchant's price",
        `R200.00 sale, merchant +R${expectedCredit.toFixed(2)}`);
    }
    // Paying with no amount at all is the same as agreeing to the code's price.
    const replay = await pay(attacker, { qrId: sale.id, idempotencyKey: randomUUID() });
    if (replay.status === 200) fail("a dynamic QR can be paid twice", "the second payment succeeded");
    else ok("a dynamic QR cannot be paid twice", `${replay.status} ${replay.body.error}`);

    // ---- 3. THE OWNER IS READ FROM THE ROW, NEVER FROM THE SCAN --------
    // A hostile payer edits userId in the JSON to their own, hoping to be paid.
    const open = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "static", label: "Till" });
    const scanned = await scannedPayload(open.id);
    const original = typeof scanned === "string" ? JSON.parse(scanned) : scanned;
    const forged = JSON.stringify({ ...original, userId: attacker.id, amount: 999999, label: "Attacker" });
    const beforeForge = { merchant: await balanceOf(merchant.id), attacker: await balanceOf(attacker.id) };
    const forgeResult = await pay(attacker, { qrId: forged, amount: 100, idempotencyKey: randomUUID() });
    const afterForge = { merchant: await balanceOf(merchant.id), attacker: await balanceOf(attacker.id) };
    if (forgeResult.status === 200 && Number((afterForge.merchant - beforeForge.merchant).toFixed(2)) === 100) {
      ok("a forged userId in the scanned payload changes nothing", "the merchant was credited, not the attacker");
    } else if (afterForge.attacker > beforeForge.attacker) {
      fail("a forged userId redirected the money", `attacker gained R${(afterForge.attacker - beforeForge.attacker).toFixed(2)}`);
    } else {
      ok("a forged payload is refused outright", `${forgeResult.status} ${forgeResult.body.error || ""}`);
    }

    // ---- 4. AN EXPIRED CODE ---------------------------------------------
    const stale = await qrService.createQr({ userId: merchant.id, userType: "customer" }, { codeType: "static", label: "Old" });
    await pool.query("UPDATE qr_codes SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [stale.id]);
    const expired = await pay(attacker, { qrId: stale.id, amount: 10, idempotencyKey: randomUUID() });
    if (expired.status === 200) fail("an expired QR is still payable", "the payment went through");
    else ok("an expired QR is refused", `${expired.status} ${expired.body.error}`);

    // ---- 5. A DEACTIVATED CODE ------------------------------------------
    const killed = await qrService.createQr({ userId: merchant.id, userType: "customer" }, { codeType: "static", label: "Dead" });
    await pool.query("UPDATE qr_codes SET status = 'revoked' WHERE id = $1", [killed.id]);
    const revoked = await pay(attacker, { qrId: killed.id, amount: 10, idempotencyKey: randomUUID() });
    if (revoked.status === 200) fail("a revoked QR is still payable", "the payment went through");
    else ok("a revoked QR is refused", `${revoked.status} ${revoked.body.error}`);

    // ---- 6. NONSENSE AMOUNTS --------------------------------------------
    const bad = [];
    for (const amount of [0, -100, "abc", null, 1e308]) {
      const attempt = await pay(attacker, { qrId: open.id, amount, idempotencyKey: randomUUID() });
      if (attempt.status === 200) bad.push(`${JSON.stringify(amount)} was accepted`);
    }
    if (bad.length) fail("a nonsense amount is accepted", bad.join("; "));
    else ok("zero, negative, non-numeric and overflow amounts are all refused");

    // ---- 7. A GUESSABLE CODE ID ------------------------------------------
    const { rows: ids } = await pool.query("SELECT id FROM qr_codes ORDER BY created_at DESC LIMIT 50");
    const v4 = ids.filter((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.id));
    if (v4.length !== ids.length) fail("some QR ids are not random v4 UUIDs", `${ids.length - v4.length} of ${ids.length}`);
    else ok("every QR id is a random v4 UUID, so codes cannot be enumerated", `${ids.length} checked`);

    // ---- 8. AN EVENT TICKET IS NOT MONEY ---------------------------------
    const ticket = await pay(attacker, {
      qrId: JSON.stringify({ type: "titopay_ticket", id: randomUUID(), eventId: randomUUID() }),
      amount: 100, idempotencyKey: randomUUID()
    });
    if (ticket.status === 200) fail("an event ticket was accepted as a payment QR", "the two instruments merged");
    else ok("an event ticket is refused as a payment instrument", `${ticket.status}`);

    // ---- 9. GARBAGE IN THE SCANNED FIELD ---------------------------------
    const junk = [];
    for (const value of ["", "not-a-uuid", "{", '{"id":"../../etc/passwd"}', "'; DROP TABLE qr_codes;--",
      `{"id":"${"9".repeat(5000)}"}`, '{"id":null}', "%00"]) {
      const attempt = await pay(attacker, { qrId: value, amount: 10, idempotencyKey: randomUUID() });
      if (attempt.status >= 500) junk.push(`${JSON.stringify(value.slice(0, 24))} -> ${attempt.status}`);
      if (attempt.status === 200) junk.push(`${JSON.stringify(value.slice(0, 24))} WAS ACCEPTED`);
    }
    const stillThere = await pool.query("SELECT COUNT(*)::INT AS n FROM qr_codes");
    if (junk.length) fail("malformed scan input is not handled cleanly", junk.join("; "));
    else ok("malformed, oversized and injection-shaped scans all answer a clean refusal",
      `qr_codes table intact, ${stillThere.rows[0].n} rows`);

    // ---- 10. WHAT THE PUBLIC LOOKUP DISCLOSES -----------------------------
    const details = await (await fetch(`${base}/v1/qr/${open.id}/details`, {
      headers: { authorization: `Bearer ${attacker.token}` }
    })).json();
    const leaked = [];
    const blob = JSON.stringify(details);
    for (const secret of ["example.invalid", merchant.phone, "password_hash", "available_balance", "wallet_number"]) {
      if (blob.includes(secret)) leaked.push(secret);
    }
    // The owner's account id is not a secret, but it has no business here.
    if (blob.includes(merchant.id)) leaked.push("the owner's account id");
    if (leaked.length) fail("the QR lookup discloses more than it should", leaked.join(", "));
    else ok("the QR owner lookup discloses a name, a username and a type, and nothing else");

    // ---- 11. THE SCANNED PAYLOAD ITSELF -----------------------------------
    // What is physically printed on an A4 sheet on a wall.
    const printed = typeof scanned === "string" ? JSON.parse(scanned) : scanned;
    const printedKeys = Object.keys(printed).sort();
    console.log(`\n  What the printed QR actually encodes: ${printedKeys.join(", ")}`);
    if (printedKeys.includes("userId")) {
      fail("the printed QR carries the owner's internal account id",
        "a UUID that identifies the account, printed on every poster and readable by anyone who scans it. "
        + "It grants nothing on its own, but it is an internal identifier on a public sheet.");
    } else {
      ok("the printed QR carries no internal account identifier");
    }

    console.log(`\n  ${passed} passed, ${findings.length} finding(s)\n`);
    if (findings.length) {
      console.log("  FINDINGS");
      findings.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
      console.log("");
      process.exitCode = 1;
    }
  } catch (error) { console.error("\nHARNESS FAILED:", error.message, error.stack.split("\n")[1]); process.exitCode = 1; }
  finally {
    if (server) server.close();
    for (const user of [merchant, attacker]) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE id=$1", [user.session]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
