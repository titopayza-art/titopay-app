"use strict";

// A BUSINESS OWNER WHO ONLY HAS A COMPANY REGISTRATION NUMBER IN FRONT OF THEM.
//
// Limits & Verification offered a South African ID, a passport and "other
// approved identity document", and nothing else. A business owner holding a
// CIPC certificate had no option on that screen at all, and the screen that did
// take a registration number, Business Verification, refused to show its form
// until the owner had already verified themselves with an ID. So the only way
// out of the loop was the ID number, which is exactly what it looked like.
//
// A company registration number is now the fourth option, on business accounts
// only. It records the BUSINESS. It does not verify the person, and this
// harness exists to make sure it never quietly starts to:
//
//   1. A business account sees four options; a personal account sees three.
//   2. Choosing the fourth swaps the form to the company fields.
//   3. Submitting it records the business, with its registration number.
//   4. The person is STILL not verified afterwards. This is the whole point.
//   5. The business is recorded as unverified, never as verified.
//   6. It cannot be submitted for verification until the person is verified.
//   7. A sole proprietor is never asked for a registration number.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/business-registration-option.js
//
// Needs the API on 8110 and the PWA served on 8010. Seeds and deletes its own
// throwaway accounts.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");

const TAG = `br${String(Date.now()).slice(-7)}`;
const PASS = "Str0ng!Pass2026";
const accounts = [];

async function seed(type, suffix, phone) {
  const id = randomUUID();
  const email = `${TAG}_${suffix}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'pending')`,
    [id, type, `${TAG} ${suffix}`, `${TAG}_${suffix}`, email, phone, await bcrypt.hash(PASS, 10)]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',0,0,'active')`, [randomUUID(), phone.slice(-9), id, type]);
  accounts.push(id);
  return { id, email };
}

async function openApp(context, account) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("http://127.0.0.1:8010/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const signedIn = await page.evaluate(async ({ email, password }) => {
    const response = await fetch("https://api.titopay.co.za/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password })
    });
    const body = await response.json();
    const token = body.accessToken || body.token || (body.tokens && body.tokens.accessToken);
    if (!token) return false;
    // Hand the running app the session it would have had, then open the screen.
    // api() reads state.auth.accessToken, and the app reads state.accountType.
    state.auth = Object.assign({}, state.auth || {}, body.tokens || {}, { accessToken: token });
    state.user = body.user || {};
    state.accountType = (body.user && body.user.accountType) || "personal";
    return true;
  }, { email: account.email, password: PASS });
  if (!signedIn) throw new Error("could not sign in");
  await page.evaluate(() => openIdentityVerificationModal());
  await page.waitForTimeout(400);
  return { page, errors };
}

const readOptions = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('form[data-form="basic-verify"] select[name="documentType"] option'))
    .map((option) => option.value));

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  let browser = null;
  try {
    const business = await seed("business", "biz", "27110000081");
    const personal = await seed("personal", "per", "27110000082");

    browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
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

    const biz = await openApp(context, business);
    const bizOptions = await readOptions(biz.page);
    assert.deepEqual(bizOptions, ["sa_id", "passport", "company_registration", "other"]);
    ok("a business account sees four options", bizOptions.join(", "));

    const per = await openApp(context, personal);
    const perOptions = await readOptions(per.page);
    assert.deepEqual(perOptions, ["sa_id", "passport", "other"]);
    ok("a personal account still sees three", perOptions.join(", "));
    await per.page.close();

    await biz.page.selectOption('form[data-form="basic-verify"] select[name="documentType"]', "company_registration");
    await biz.page.waitForTimeout(250);
    const shape = await biz.page.evaluate(() => {
      const visible = (name) => {
        const field = document.querySelector(`form[data-form="basic-verify"] [name="${name}"]`);
        return Boolean(field && field.closest("[data-doc-field]") && !field.closest("[data-doc-field]").hidden);
      };
      return {
        registrationNumber: visible("registrationNumber"),
        businessName: visible("businessName"),
        saIdNumber: visible("idNumber"),
        button: (document.querySelector("[data-basic-verify-submit]") || {}).textContent.trim()
      };
    });
    assert.equal(shape.registrationNumber, true, "the registration number field did not appear");
    assert.equal(shape.businessName, true, "the business name field did not appear");
    assert.equal(shape.saIdNumber, false, "the SA ID field is still on screen");
    assert.match(shape.button, /Add this business/);
    ok("choosing it swaps the form to the company fields", `button reads "${shape.button}"`);

    await biz.page.fill('form[data-form="basic-verify"] [name="businessName"]', `${TAG} Trading`);
    await biz.page.selectOption('form[data-form="basic-verify"] [name="businessType"]', "private_company");
    await biz.page.fill('form[data-form="basic-verify"] [name="registrationNumber"]', "2022/554433/07");
    await biz.page.click("[data-basic-verify-submit]");
    await biz.page.waitForTimeout(2500);

    const { rows: saved } = await pool.query(
      "SELECT business_name, registration_number, kyb_status FROM business_profiles WHERE account_user_id = $1", [business.id]);
    assert.equal(saved.length, 1, "the business was not recorded");
    assert.equal(saved[0].registration_number, "2022/554433/07");
    ok("the business is recorded with its registration number", saved[0].business_name);

    const { rows: person } = await pool.query("SELECT basic_verified_at, fica_status FROM users WHERE id = $1", [business.id]);
    assert.equal(person[0].basic_verified_at, null,
      "A COMPANY REGISTRATION NUMBER VERIFIED A PERSON. This is the one thing that must never happen.");
    ok("the PERSON is still not verified, which is the whole point");

    assert.equal(saved[0].kyb_status, "unverified");
    ok("and the business is recorded as unverified, never as verified");

    const refused = await biz.page.evaluate(async () => {
      const list = await api("/v1/business/verification");
      const target = list.businesses[0];
      try {
        await api(`/v1/business/verification/businesses/${target.id}/submit`, { method: "POST", body: {} });
        return "ACCEPTED";
      } catch (error) { return String(error.message || error); }
    });
    assert.match(refused, /Verify your own identity first/i, `submit was not refused: ${refused}`);
    ok("it cannot be submitted for verification until the person is", refused);

    const soleOk = await biz.page.evaluate(async (tag) => {
      try {
        await api("/v1/business/verification/businesses", {
          method: "POST", body: { businessName: `${tag} Spaza`, businessType: "sole_proprietor", role: "owner" }
        });
        return "accepted with no registration number";
      } catch (error) { return `REFUSED: ${error.message || error}`; }
    }, TAG);
    assert.match(soleOk, /accepted/, soleOk);
    ok("a sole proprietor is never asked for a registration number", soleOk);

    assert.equal(biz.errors.length, 0, biz.errors[0] || "");
    ok("no script errors through the whole journey");

    console.log(`\n  ${passed}/9 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    for (const id of accounts) {
      await pool.query("DELETE FROM business_verifications WHERE business_id IN (SELECT id FROM business_profiles WHERE account_user_id=$1)", [id]).catch(() => {});
      await pool.query("DELETE FROM business_representatives WHERE user_id=$1", [id]).catch(() => {});
      await pool.query("DELETE FROM business_profiles WHERE account_user_id=$1", [id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1", [id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
