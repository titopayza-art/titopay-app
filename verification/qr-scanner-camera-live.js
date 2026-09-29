"use strict";

// THE CAMERA SCANNER, DRIVEN WITH A REAL CAMERA FEED.
//
// Everything else about a QR has been proven by handing the app a code id or by
// decoding a poster image off the page. Neither of those touches the part a
// customer actually uses: point the phone at a code and wait.
//
// So this builds a real video of a real TitoPay payment QR and feeds it to
// Chromium as the camera. The app is not told anything: it opens the Scan
// screen, asks for the camera, gets these frames, and has to find the code in
// them on its own.
//
//   1. A video of a live QR code is generated from the code's own payload.
//   2. The app's scanner opens the camera and reads it.
//   3. What it recovers is the code's real id.
//   4. It reaches the QR ID field, which is what the payment then uses.
//   5. A frame with no code in it does not produce a false read.
//   6. A code minted BEFORE the payload was trimmed still scans, because the
//      id is the only field anything has ever read.
//   7. A dynamic code fills its own price in, locked, so the payer never types
//      a figure the till is already showing them.
//   8. An open code with no price leaves the amount box empty and editable.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/qr-scanner-camera-live.js
//
// Needs the API on 8110 and the PWA on 8010.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const { chromium } = require("playwright");
const qrService = require("../api/src/services/qr-service");

const TAG = `sc${String(Date.now()).slice(-7)}`;
const PASS = "Str0ng!Pass2026";
const WIDTH = 640, HEIGHT = 480, FRAMES = 90;
const merchant = { id: randomUUID(), phone: "27110000171", type: "business" };
const payer = { id: randomUUID(), phone: "27110000172", type: "personal" };

// A .y4m of the QR, painted from the code's own module matrix. No image decoder
// in the loop, so what the camera sees is exactly what the code says.
function writeY4m(file, text) {
  const frameY = Buffer.alloc(WIDTH * HEIGHT, 255);
  const frameU = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 128);
  const frameV = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 128);
  if (text) {
    const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const data = qr.modules.data;
    // As large as fits, with a quiet zone, centred: a phone held at a till.
    const scale = Math.max(2, Math.floor((Math.min(WIDTH, HEIGHT) * 0.8) / size));
    const side = size * scale;
    const left = Math.floor((WIDTH - side) / 2);
    const top = Math.floor((HEIGHT - side) / 2);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (!data[row * size + col]) continue;
        for (let y = 0; y < scale; y += 1) {
          const line = (top + row * scale + y) * WIDTH + left + col * scale;
          frameY.fill(0, line, line + scale);
        }
      }
    }
  }
  const out = [Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F25:1 Ip A1:1 C420mpeg2\n`)];
  for (let i = 0; i < FRAMES; i += 1) out.push(Buffer.from("FRAME\n"), frameY, frameU, frameV);
  fs.writeFileSync(file, Buffer.concat(out));
  return file;
}

async function seed(user, balance) {
  user.email = `${TAG}_${user.phone.slice(-3)}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status,basic_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'approved',NOW())`,
    [user.id, user.type, `${TAG} ${user.phone.slice(-3)}`, `${TAG}_${user.phone.slice(-3)}`,
      user.email, user.phone, await bcrypt.hash(PASS, 10)]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`, [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
}

async function scanWith(videoFile, signIn) {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${videoFile}`]
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      serviceWorkers: "block", permissions: ["camera"]
    });
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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto("http://127.0.0.1:8010/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.evaluate(signIn, { email: payer.email, password: PASS });

    // The real screen, opened the way a customer opens it.
    await page.evaluate(() => openQrPayModal());
    await page.waitForSelector('form[data-form="qr-pay"] input[name="qrId"]', { timeout: 10000 });
    await page.evaluate(() => startQrScanner());
    // The scanner polls for up to twenty seconds.
    await page.waitForFunction(() => {
      const input = document.querySelector('form[data-form="qr-pay"] input[name="qrId"]');
      const note = document.querySelector("#qr-scanner-output");
      return (input && input.value) || (note && /No QR detected|unavailable|permission|not a TitoPay/i.test(note.textContent));
    }, { timeout: 30000 }).catch(() => {});
    const seen = await page.evaluate(() => {
      const amount = document.querySelector('form[data-form="qr-pay"] input[name="amount"]');
      return {
        value: (document.querySelector('form[data-form="qr-pay"] input[name="qrId"]') || {}).value || "",
        note: ((document.querySelector("#qr-scanner-output") || {}).textContent || "").trim().slice(0, 140),
        amount: amount ? amount.value : "(no field)",
        amountLocked: amount ? amount.readOnly : null
      };
    });
    return { ...seen, errors };
  } finally { await browser.close().catch(() => {}); }
}

const signInFn = async ({ email, password }) => {
  const response = await fetch("https://api.titopay.co.za/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password })
  });
  const body = await response.json();
  const token = body.accessToken || body.token || (body.tokens && body.tokens.accessToken);
  if (!token) throw new Error("sign in failed");
  state.auth = Object.assign({}, state.auth || {}, body.tokens || {}, { accessToken: token });
  state.user = body.user || {};
  state.accountType = (body.user && body.user.accountType) || "personal";
  await refreshData().catch(() => {});
};

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrcam-"));
  try {
    await seed(merchant, 0);
    await seed(payer, 5000);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), merchant.id, `${TAG} Cafe`, `M${TAG}`]);

    const sale = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "dynamic", amount: 388, label: "Make a Sale" });
    const payloadText = JSON.stringify((await pool.query(
      "SELECT payload FROM qr_codes WHERE id = $1", [sale.id])).rows[0].payload);

    const withCode = writeY4m(path.join(dir, "qr.y4m"), payloadText);
    ok("a video of a live TitoPay payment QR was generated", `${WIDTH}x${HEIGHT}, ${FRAMES} frames`);

    const result = await scanWith(withCode, signInFn);
    assert.ok(result.value, `the scanner read nothing. It said: "${result.note}"`);
    ok("the app's scanner opened the camera and found the code", result.note || "captured");

    assert.equal(result.value, sale.id, `it recovered "${result.value}" instead of the code's id`);
    ok("and what it recovered is the code's real id", result.value);

    assert.equal(result.errors.length, 0, result.errors[0] || "");
    ok("with no script errors on the page");

    // The long form every poster printed before build 47 carried. It has to keep
    // scanning: those sheets are on walls and cannot be recalled.
    const legacyPayload = JSON.stringify({
      id: sale.id, userId: merchant.id, codeType: "dynamic", amount: 388,
      currency: "ZAR", reference: "QR-1786913478810", label: "Make a Sale", metadata: {}
    });
    const legacy = await scanWith(writeY4m(path.join(dir, "legacy.y4m"), legacyPayload), signInFn);
    assert.equal(legacy.value, sale.id, `an already-printed code read as "${legacy.value}"`);
    ok("a code printed before the payload was trimmed still scans", `${legacyPayload.length} chars, still resolves`);

    assert.equal(result.amount, "388.00", `the amount box held "${result.amount}" instead of the merchant's price`);
    assert.equal(result.amountLocked, true, "the merchant's price must not be editable by the payer");
    assert.match(result.note, /R\s?388/, `the capture note read: "${result.note}"`);
    ok("the merchant's price is filled in and locked", `R${result.amount}, "${result.note}"`);

    // An OPEN code names no price, so the payer still names one.
    const open = await qrService.createQr({ userId: merchant.id, userType: "customer" },
      { codeType: "static", label: "Till" });
    const openPayload = JSON.stringify((await pool.query(
      "SELECT payload FROM qr_codes WHERE id = $1", [open.id])).rows[0].payload);
    const openScan = await scanWith(writeY4m(path.join(dir, "open.y4m"), openPayload), signInFn);
    assert.equal(openScan.value, open.id);
    assert.equal(openScan.amount, "", `an open code prefilled "${openScan.amount}"`);
    assert.equal(openScan.amountLocked, false, "an open code must leave the amount editable");
    ok("an open code leaves the amount empty and editable", `"${openScan.note}"`);

    const blank = writeY4m(path.join(dir, "blank.y4m"), "");
    const nothing = await scanWith(blank, signInFn);
    assert.equal(nothing.value, "", `a blank camera produced a false read: "${nothing.value}"`);
    assert.match(nothing.note, /No QR detected/i, `a blank camera said: "${nothing.note}"`);
    ok("a camera with no code in front of it does not produce a false read", nothing.note);

    console.log(`\n  ${passed}/8 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const user of [merchant, payer]) {
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
