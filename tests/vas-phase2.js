const { launchOptions, BASE_URL, ROOT } = require("./lib/env");
const CATALOGUE_PATH = require("path").join(ROOT, "services-default.json");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "personal";

// Provider payloads exercising the schema features. These are TEST fixtures in
// the harness only -- nothing here is compiled into the app.
const BILLERS = [];
for (let i = 0; i < 14; i += 1) BILLERS.push({ code: `B${i}`, name: `Biller Number ${i}`, products: [] });
BILLERS.unshift({
  code: "DSTV", name: "DStv",
  fields: [
    { name: "smartcard", label: "Smartcard number", type: "number", primary: true, maxLength: 12, placeholder: "10 digits on the decoder", help: "Found on the decoder label." },
    { name: "surname", label: "Account surname", type: "text", required: true },
    { name: "package", label: "Package", options: [{ value: "premium", label: "Premium" }, { value: "compact", label: "Compact" }] },
    { name: "phone", label: "Contact number", type: "tel", required: false }
  ]
});
BILLERS.push({ code: "JHB", name: "City of Johannesburg", products: [] });

const DATA_PRODUCTS = [];
for (let i = 1; i <= 14; i += 1) DATA_PRODUCTS.push({ code: `D${i}`, name: `${i} GB bundle`, size: `${i} GB`, validity: "30 days", amount: 40 + i * 25 });

const CATALOGUE = {
  airtime: { providers: [{ code: "MTN", name: "MTN", products: [{ code: "A5", name: "R5 airtime", amount: 5 }, { code: "A12", name: "R12 airtime", amount: 12 }] }] },
  data: { providers: [{ code: "MTN", name: "MTN", products: DATA_PRODUCTS }, { code: "VOD", name: "Vodacom", products: [{ code: "V1", name: "1GB", amount: 85 }] }] },
  sms: { providers: [{ code: "MTN", name: "MTN", products: [{ code: "S50", name: "50 SMS", amount: 20 }] }] },
  voice: { providers: [{ code: "MTN", name: "MTN", products: [{ code: "M60", name: "60 minutes", validity: "30 days", amount: 75 }] }] },
  electricity: { providers: [{ code: "ESKOM", name: "Eskom prepaid", minAmount: 20, maxAmount: 3000, products: [] }] },
  voucher: { providers: [{ code: "1V", name: "1Voucher", products: [{ code: "V50", name: "R50 voucher", amount: 50 }] }] },
  bill_payment: { providers: BILLERS }
};

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf8"));
  const services = { items: cat.items.map((i) => Object.assign({}, i)) };
  const air = services.items.find((i) => i.action === "airtime");
  services.items.push(Object.assign({}, air, { id: "sms", action: "sms", service_code: "sms_bundle", serviceCode: "sms_bundle", label: "SMS Bundles" }));
  services.items.push(Object.assign({}, air, { id: "voice", action: "voice", service_code: "voice_bundle", serviceCode: "voice_bundle", label: "Voice Bundles" }));

  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));

  let txPosts = 0, lastTxBody = null, txResponse = null;
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const u = new URL(route.request().url());
    const J = (st, b) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/v1/vas/catalogue") { await sleep(140); return J(200, CATALOGUE[u.searchParams.get("service")] || { providers: [] }); }
    if (u.pathname === "/v1/vas/validate") { await sleep(120); return J(200, { validation: { customerName: "N Mokoena", accountNumber: "8812445" } }); }
    if (u.pathname === "/v1/transactions" && route.request().method() === "POST") {
      txPosts += 1; lastTxBody = route.request().postDataJSON(); await sleep(150);
      return J(200, txResponse || { transaction: { id: "t1", reference: "R1", status: "completed", amount: 50, total: 51.5 } });
    }
    if (u.pathname === "/v1/transactions/fee-preview") {
      const amt = Number((route.request().postDataJSON() || {}).amount || 0);
      return J(200, { preview: { amount: amt, fee: 1.5, thirdPartyFee: 0, total: amt + 1.5, recipientAmount: amt } });
    }
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = services;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "QA User", username: "qa", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 99999 }] };
    J(200, body);
  });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 120)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3600);

  const R = { account: ACCOUNT };
  const open = async (svc, wait = 1600) => {
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(420);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click();
    await page.waitForTimeout(wait);
    return true;
  };
  const close = async () => { await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click()); await page.waitForTimeout(320); };

  // ============ 1. PROVIDER-DEFINED BILLER FIELDS ============
  if (await open("pay-bills")) {
    R.billsSchema = await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      const host = form.querySelector("[data-vas-account]");
      return {
        fieldCount: host.querySelectorAll(".field").length,
        labels: [...host.querySelectorAll("label")].map((e) => e.textContent.trim()),
        names: [...host.querySelectorAll("[name]")].map((e) => e.name),
        types: [...host.querySelectorAll("[name]")].map((e) => e.tagName === "SELECT" ? "select" : e.type),
        maxLengths: [...host.querySelectorAll("input")].map((e) => e.getAttribute("maxlength")),
        helpText: host.querySelector(".field-hint")?.textContent.trim(),
        helpLinked: [...host.querySelectorAll("[aria-describedby]")].length,
        selectOptions: [...(host.querySelector("select")?.options || [])].map((o) => o.textContent),
        validateOnPrimary: !!host.querySelector("[data-vas-validate-anchor] [data-vas-validate]"),
        pickerActive: !!form.querySelector(".vas-picker-input"),
        pickerOptionCount: form.querySelectorAll(".vas-picker-option").length
      };
    });

    // fill every schema field, then change biller and confirm values survive
    await page.evaluate(() => {
      const host = document.querySelector("[data-vas-account]");
      host.querySelectorAll("input").forEach((el, i) => { el.value = `val${i}`; el.dispatchEvent(new Event("input", { bubbles: true })); });
      const sel = host.querySelector("select");
      if (sel) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForTimeout(300);
    R.billsFilled = await page.evaluate(() => {
      const o = {}; document.querySelectorAll("[data-vas-account] [name]").forEach((e) => { o[e.name] = e.value; }); return o;
    });
    await page.screenshot({ path: `${OUT}/p2-bills-schema.png` });

    // switch to a biller with NO schema -> single-field fallback
    R.pickerChoose = await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      const opt = [...form.querySelectorAll("[data-vas-picker-value]")].find((o) => o.dataset.vasPickerValue === "JHB");
      if (!opt) return "no-option";
      opt.click();
      return "clicked";
    });
    await page.waitForTimeout(700);
    R.billsFallback = await page.evaluate(() => {
      const host = document.querySelector("[data-vas-account]");
      return {
        fieldCount: host.querySelectorAll(".field").length,
        names: [...host.querySelectorAll("[name]")].map((e) => e.name),
        recipientKept: host.querySelector('[name="recipient"]')?.value,
        label: host.querySelector("label")?.textContent.trim()
      };
    });
    // back to DStv -> extra field values restored
    await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      [...form.querySelectorAll("[data-vas-picker-value]")].find((o) => o.dataset.vasPickerValue === "DSTV")?.click();
    });
    await page.waitForTimeout(700);
    R.billsRestored = await page.evaluate(() => {
      const o = {}; document.querySelectorAll("[data-vas-account] [name]").forEach((e) => { o[e.name] = e.value; }); return o;
    });

    // through review and back via Edit
    await page.evaluate(() => {
      const host = document.querySelector("[data-vas-account]");
      host.querySelector('[name="recipient"]').value = "1234567890";
      const sur = host.querySelector('[name="vasField_surname"]'); if (sur) sur.value = "Mokoena";
      document.querySelector('[name="amount"]').value = "450";
      document.querySelector('[name="reference"]').value = "DStv July";
    });
    R.billsValidity = await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      const invalid = [...form.querySelectorAll(":invalid")].map((e) => e.name || e.tagName);
      return { valid: form.checkValidity(), invalid };
    });
    await page.click('form[data-vas-journey] button[type="submit"]');
    await page.waitForTimeout(2200);
    R.billsReview = await page.evaluate(() => ({
      open: !!document.querySelector('[data-action="confirm-transaction-review"]'),
      rows: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => /Provider|Amount|Total/.test(t))
    }));
    const editBtn = await page.$('[data-action="edit-transaction-review"]');
    if (editBtn) { await editBtn.click(); await page.waitForTimeout(2200); }
    R.billsEditBack = await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      if (!form) return { journeyRestored: false };
      const o = { journeyRestored: true, journey: form.dataset.vasJourney };
      form.querySelectorAll("[name]").forEach((e) => { if (!e.name.startsWith("vasP") && e.name !== "serviceCode" && e.name !== "vasJourney" && e.name !== "integrationFlow") o[e.name] = e.value; });
      return o;
    });
    await close();
  }

  // ============ 2. VOUCHER PIN PROTECTION ============
  if (await open("voucher")) {
    const p = await page.$('[data-vas-product="0"]'); if (p) await p.click();
    await page.fill('[name="recipient"]', "self");
    await page.waitForTimeout(200);
    txResponse = { transaction: { id: "v1", reference: "VC-9", status: "completed", amount: 50, total: 51.5, metadata: { pin: "8812 4471 9930", serial: "SN-77120", expiresAt: "2027-01-31" } } };
    await page.click('form[data-vas-journey] button[type="submit"]');
    await page.waitForTimeout(2000);
    const c = await page.$('[data-action="confirm-transaction-review"]');
    if (c) {
      await c.click();
      await page.waitForTimeout(2300);
      const read = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll(".vas-credential")];
        return rows.map((r) => ({
          label: r.querySelector(".vas-credential-label")?.textContent.trim(),
          shown: r.querySelector(".vas-credential-value")?.textContent.trim(),
          sensitive: r.classList.contains("is-sensitive"),
          hasSecret: !!r.querySelector(".vas-credential-value")?.dataset.vasSecret,
          revealPressed: r.querySelector("[data-vas-reveal]")?.getAttribute("aria-pressed"),
          revealLabel: r.querySelector("[data-vas-reveal]")?.getAttribute("aria-label"),
          valueLabelled: !!r.querySelector(".vas-credential-value")?.getAttribute("aria-labelledby"),
          copyValue: r.querySelector("[data-vas-copy]")?.dataset.vasCopy
        }));
      });
      R.pinMasked = await read();
      // reveal via keyboard
      await page.evaluate(() => document.querySelector("[data-vas-reveal]").focus());
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      R.pinRevealed = await read();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      R.pinHiddenAgain = await read();
      await page.screenshot({ path: `${OUT}/p2-voucher-masked.png` });
    }
    await close();
  }

  // ============ 3. PRODUCT SEARCH + PICKER KEYBOARD ============
  if (await open("airtime-data")) {
    const sw = await page.$('[data-vas-kind="data"]');
    if (sw) { await sw.click(); await page.waitForTimeout(1700); }
    R.productSearch = await page.evaluate(() => {
      const form = document.querySelector("form[data-vas-journey]");
      return {
        searchPresent: !!form.querySelector("[data-vas-product-search]"),
        productCount: form.querySelectorAll(".vas-product").length,
        switchLabels: [...form.querySelectorAll("[data-vas-kind]")].map((e) => e.textContent.trim()),
        selfButton: !!form.querySelector("[data-vas-self]"),
        pickerActive: !!form.querySelector(".vas-picker-input")
      };
    });
    const search = await page.$("[data-vas-product-search]");
    if (search) {
      await search.fill("3 GB");
      await page.waitForTimeout(350);
      R.productFiltered = await page.evaluate(() => {
        const form = document.querySelector("form[data-vas-journey]");
        const cards = [...form.querySelectorAll(".vas-product")];
        return {
          visible: cards.filter((c) => !c.hidden).map((c) => c.querySelector(".vas-product-name")?.textContent.trim()),
          status: form.querySelector("[data-vas-product-status]")?.textContent.trim(),
          statusIsLive: form.querySelector("[data-vas-product-status]")?.getAttribute("aria-live")
        };
      });
      await search.fill("");
      await page.waitForTimeout(250);
    }
    // buy for myself: empty field fills silently
    R.selfEmpty = await page.evaluate(async () => {
      const btn = document.querySelector("[data-vas-self]");
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      return { value: document.querySelector('[name="recipient"]').value };
    });
    // typed value requires two presses
    await page.fill('[name="recipient"]', "+27711119999");
    await page.waitForTimeout(150);
    await page.click("[data-vas-self]");
    await page.waitForTimeout(250);
    R.selfFirstPress = await page.evaluate(() => ({ value: document.querySelector('[name="recipient"]').value, armed: document.querySelector("[data-vas-self]").dataset.confirmReplace }));
    await page.click("[data-vas-self]");
    await page.waitForTimeout(250);
    R.selfSecondPress = await page.evaluate(() => ({ value: document.querySelector('[name="recipient"]').value }));
    await page.screenshot({ path: `${OUT}/p2-data-search.png` });
    await close();
  }

  // ============ 4. VOICE APPEARS ONLY WHEN PUBLISHED ============
  if (await open("airtime-data")) {
    R.voicePublished = await page.evaluate(() => [...document.querySelectorAll("[data-vas-kind]")].map((e) => e.textContent.trim()));
    const v = await page.$('[data-vas-kind="Voice"]') || await page.$('[data-vas-kind="voice"]');
    if (v) {
      await v.click();
      await page.waitForTimeout(1700);
      R.voiceJourney = await page.evaluate(() => {
        const form = document.querySelector("form[data-vas-journey]");
        return { journey: form?.dataset.vasJourney, serviceCode: form?.querySelector('[name="serviceCode"]')?.value, products: [...form.querySelectorAll(".vas-product-name")].map((e) => e.textContent.trim()) };
      });
    }
    await close();
  }

  // ============ 5. PICKER KEYBOARD NAVIGATION ============
  if (await open("pay-bills")) {
    R.pickerKeyboard = await page.evaluate(() => {
      const i = document.querySelector(".vas-picker-input");
      return i ? { role: i.getAttribute("role"), expanded: i.getAttribute("aria-expanded"), controls: i.getAttribute("aria-controls"), label: i.getAttribute("aria-label"), listRole: document.querySelector(".vas-picker-list")?.getAttribute("role") } : null;
    });
    const inp = await page.$(".vas-picker-input");
    if (inp) {
      await inp.click();
      await inp.fill("Johannes");
      await page.waitForTimeout(300);
      R.pickerFiltered = await page.evaluate(() => ({
        options: [...document.querySelectorAll(".vas-picker-option")].map((o) => o.textContent.trim()),
        expanded: document.querySelector(".vas-picker-input").getAttribute("aria-expanded")
      }));
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
      R.pickerActiveDescendant = await page.evaluate(() => ({
        activedescendant: document.querySelector(".vas-picker-input").getAttribute("aria-activedescendant"),
        activeOption: document.querySelector(".vas-picker-option.is-active")?.textContent.trim()
      }));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      R.pickerEnterChose = await page.evaluate(() => ({
        selectValue: document.querySelector('[name="provider"]')?.value,
        providerName: document.querySelector("[data-vas-provider-name]")?.value,
        inputText: document.querySelector(".vas-picker-input")?.value,
        listClosed: document.querySelector(".vas-picker-list")?.hidden
      }));
      await inp.fill("zzzz");
      await page.waitForTimeout(300);
      R.pickerNoMatch = await page.evaluate(() => document.querySelector(".vas-picker-empty")?.textContent.trim());
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      R.pickerEscapeClosedListNotModal = await page.evaluate(() => ({
        listClosed: document.querySelector(".vas-picker-list")?.hidden,
        modalStillOpen: !!document.querySelector(".modal-card")
      }));
    }
    await close();
  }

  R.txPosts = txPosts;
  R.submittedMetadata = lastTxBody ? Object.keys(lastTxBody.metadata || {}).sort() : null;
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
