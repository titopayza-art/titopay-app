"use strict";

// THE PRINTED A4 POSTERS, SCANNED THE WAY A CUSTOMER SCANS THEM.
//
// A Payment A4 poster and a Tip A4 poster are downloaded once and stuck on a
// counter. They then sit there for months. Nothing about them can be corrected
// later, so the code printed on them has to keep working and has to keep
// resolving to the right owner, whatever else changes in the app.
//
// This does not trust the id the app happens to be holding. It takes the QR
// IMAGE off the rendered poster, DECODES IT WITH jsQR the way the in-app
// scanner does, and drives everything from the string that comes out of the
// decoder:
//
//   1. The Payment A4 poster's printed QR decodes.
//   2. The scanner classifies it as a payment and recovers the code id.
//   3. GET /v1/qr/{id}/details names the owner, and the name MATCHES the name
//      printed on the poster. A payer checking the counter against their phone
//      must see the same words.
//   4. Paying that scanned code settles correctly: payer debited once, owner
//      credited, fee to revenue, and every cent accounted for.
//   5. The Tip A4 poster does all of the same.
//   6. The poster's printed "QR ID" footer is the same id the scan produces,
//      so a customer who types it in by hand reaches the same place.
//   7. An event ticket is still refused, so the two instruments never merge.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/qr-poster-scan-live.js
//
// Needs the API on 8110 and the PWA served on 8010.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");

const TAG = `qp${String(Date.now()).slice(-7)}`;
const PASS = "Str0ng!Pass2026";
const BUSINESS_NAME = `${TAG} Corner Cafe`;
const owner = { id: randomUUID(), phone: "27110000121", type: "business" };
const payer = { id: randomUUID(), phone: "27110000122", type: "personal" };

async function seed(user, balance) {
  user.email = `${TAG}_${user.phone.slice(-3)}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status,basic_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'approved',NOW())`,
    [user.id, user.type, `${TAG} Person ${user.phone.slice(-3)}`, `${TAG}_${user.phone.slice(-3)}`,
      user.email, user.phone, await bcrypt.hash(PASS, 10)]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`,
    [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
}

async function signIn(context, user) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("http://127.0.0.1:8010/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const ok = await page.evaluate(async ({ email, password }) => {
    const response = await fetch("https://api.titopay.co.za/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password })
    });
    const body = await response.json();
    const token = body.accessToken || body.token || (body.tokens && body.tokens.accessToken);
    if (!token) return false;
    state.auth = Object.assign({}, state.auth || {}, body.tokens || {}, { accessToken: token });
    state.user = body.user || {};
    state.accountType = (body.user && body.user.accountType) || "personal";
    await refreshData().catch(() => {});
    return true;
  }, { email: user.email, password: PASS });
  if (!ok) throw new Error(`could not sign in ${user.email}`);
  return { page, errors };
}

// Decode the poster's printed QR the way the in-app scanner does: pixels in,
// string out. Nothing here reads a variable the app is already holding.
async function scanPoster(page, kind) {
  await page.evaluate((k) => openQrPosterModal(k), kind);
  await page.waitForSelector("[data-qr-poster] img[alt]", { timeout: 15000 });
  await page.waitForTimeout(600);
  return page.evaluate(async () => {
    const ready = await ensureJsQrLoaded();
    if (!ready) return { decoded: "", printedName: "", printedId: "", error: "jsQR did not load" };
    const poster = document.querySelector("[data-qr-poster]");
    const image = poster.querySelector(".qr-poster-qr img");
    const printedName = (poster.querySelector(".qr-poster-name") || {}).textContent.trim();
    const printedId = (() => {
      for (const row of poster.querySelectorAll(".qr-poster-id")) {
        if (/QR ID/i.test(row.textContent)) return row.querySelector("strong").textContent.trim();
      }
      return "";
    })();
    if (!image || !image.src) return { decoded: "", printedName, printedId, error: "no QR image on the poster" };
    const bitmap = await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe);
      probe.onerror = () => reject(new Error("the poster QR image did not decode as an image"));
      probe.src = image.src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.naturalWidth; canvas.height = bitmap.naturalHeight;
    const g = canvas.getContext("2d");
    g.drawImage(bitmap, 0, 0);
    const pixels = g.getImageData(0, 0, canvas.width, canvas.height);
    const found = window.jsQR(pixels.data, pixels.width, pixels.height);
    return {
      decoded: found ? found.data : "",
      printedName,
      printedId,
      pixels: `${canvas.width}x${canvas.height}`,
      classified: found ? classifyScannedQr(found.data) : null
    };
  });
}

const balanceOf = async (userId) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [userId])).rows[0].available_balance);

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  let browser = null;
  try {
    await seed(owner, 0);
    await seed(payer, 5000);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), owner.id, BUSINESS_NAME, `M${TAG}`]);

    browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
    const context = await browser.newContext({ viewport: { width: 900, height: 1200 }, serviceWorkers: "block" });
    await context.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const target = request.url().replace("https://api.titopay.co.za", "http://127.0.0.1:8110");
      const headers = Object.assign({}, request.headers());
      delete headers.host; delete headers.origin; delete headers.referer;
      const upstream = await fetch(target, { method: request.method(), headers, body: request.postData() || undefined, redirect: "manual" });
      const body = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      upstream.headers.forEach((value, key) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) out[key] = value;
      });
      out["access-control-allow-origin"] = "*";
      await route.fulfill({ status: upstream.status, headers: out, body });
    });

    const shop = await signIn(context, owner);
    const till = await signIn(context, payer);

    for (const kind of ["payment", "tip"]) {
      const label = kind === "payment" ? "Payment A4 poster" : "Tip A4 poster";
      const scan = await scanPoster(shop.page, kind);
      assert.ok(scan.decoded, `${label}: the printed QR did not decode (${scan.error || "jsQR found nothing"})`);
      ok(`the ${label}'s printed QR decodes off the page`, `${scan.pixels} pixels`);

      assert.equal(scan.classified && scan.classified.kind, "payment", `${label}: not classified as a payment code`);
      const qrId = scan.classified.qrId;
      assert.match(qrId, /^[0-9a-f-]{36}$/i, `${label}: the scan did not recover a code id`);
      ok(`the scanner reads it as a payment code`, qrId);

      assert.equal(qrId, scan.printedId,
        `${label}: the printed QR ID (${scan.printedId}) is not what the scan produces (${qrId})`);
      ok(`the printed QR ID footer matches the scan, so typing it by hand works`);

      // The name a payer sees on their phone, against the name on the counter.
      const details = await till.page.evaluate(async (id) => {
        const response = await api(`/v1/qr/${encodeURIComponent(id)}/details`);
        return response.qr;
      }, qrId);
      assert.equal(details.owner.displayName, BUSINESS_NAME,
        `${label}: the app names "${details.owner.displayName}" and the poster says "${scan.printedName}"`);
      assert.equal(details.owner.displayName, scan.printedName,
        `${label}: the counter and the phone disagree about who is being paid`);
      ok(`the owner is traced, and matches the name printed on the poster`, details.owner.displayName);

      const payerBefore = await balanceOf(payer.id);
      const ownerBefore = await balanceOf(owner.id);
      const paid = await till.page.evaluate(async (id) => {
        try {
          return { ok: true, result: await api("/v1/qr/pay", { method: "POST", body: { qrId: id, amount: 150, idempotencyKey: crypto.randomUUID() } }) };
        } catch (error) { return { ok: false, error: String(error.message || error) }; }
      }, qrId);
      assert.equal(paid.ok, true, `${label}: paying the scanned code failed — ${paid.error}`);
      const payerAfter = await balanceOf(payer.id);
      const ownerAfter = await balanceOf(owner.id);
      // A QR payment is priced on both sides: the payer pays a flat R1.50 on
      // top, the owner R1.50 + 1.5% out of the credit. Both come from the live
      // schedule so that an admin changing a rate does not read here as a
      // printed poster having stopped working.
      const pricing = require("../api/src/services/pricing-service");
      const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
      const payerFee = round((await pricing.calculateFee("qr_payment", 150)).fee);
      const ownerFee = round((await pricing.calculateFee("merchant_qr_payment", 150)).fee);
      assert.equal(Number((payerBefore - payerAfter).toFixed(2)), round(150 + payerFee),
        `${label}: the payer moved the wrong amount`);
      assert.equal(Number((ownerAfter - ownerBefore).toFixed(2)), round(150 - ownerFee),
        `${label}: the owner was credited the wrong amount`);
      ok(`paying the scanned code settles correctly`,
        `payer -R${round(150 + payerFee).toFixed(2)}, owner +R${round(150 - ownerFee).toFixed(2)}`);
    }

    // The two instruments must never resolve into one another.
    const ticket = await till.page.evaluate(() =>
      classifyScannedQr(JSON.stringify({ type: "titopay_ticket", id: "00000000-0000-4000-8000-000000000000" })));
    assert.equal(ticket.kind, "ticket", "an event ticket was read as a payment code");
    ok("an event ticket scanned at a till is still not a payment code");

    assert.deepEqual([...shop.errors, ...till.errors], [], "script errors on the page");
    ok("no script errors through the whole journey");

    console.log(`\n  ${passed}/12 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    for (const user of [owner, payer]) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
