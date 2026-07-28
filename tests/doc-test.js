const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  let posted = null;
  await ctx.route("https://api.titopay.co.za/**", (route) => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/v1/transactions/fee-preview") { const a = Number((route.request().postDataJSON() || {}).amount || 0); return J({ preview: { amount: a, fee: 0, thirdPartyFee: 0, total: a, recipientAmount: a } }); }
    if (u.pathname === "/v1/transactions" && m === "POST") { posted = route.request().postDataJSON(); return J({ transaction: { id: "d1", reference: "DOC1", status: "completed" } }); }
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "Naledi Mokoena", businessName: "Naledi Trading", businessEmail: "hello@naleditrading.co.za", accountType: "business", status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(body);
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 140)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const R = {};
  const open = async (svc) => {
    for (let i = 0; i < 4; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(400);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click(); await page.waitForTimeout(900); return true;
  };

  for (const svc of ["invoice", "quote", "proforma-invoice"]) {
    if (!(await open(svc))) { R[svc] = { opened: false }; continue; }
    R[svc] = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        eyebrow: c.querySelector(".eyebrow")?.textContent.trim(),
        heading: c.querySelector("h2")?.textContent.trim(),
        sections: [...c.querySelectorAll(".doc-section legend")].map((e) => e.textContent.trim()),
        dateLabel: c.querySelector('label[for="doc-due"]')?.textContent.trim(),
        terms: [...c.querySelectorAll("[data-doc-term]")].map((b) => b.textContent.trim()),
        activeTerm: c.querySelector("[data-doc-term].is-active")?.textContent.trim(),
        disclaimer: c.querySelector(".doc-disclaimer")?.textContent.trim().slice(0, 70),
        rows: c.querySelectorAll("[data-doc-item]").length,
        submitDisabled: c.querySelector('button[type="submit"]')?.disabled,
        warningShown: !c.querySelector("[data-doc-warning]")?.hidden,
        removeDisabled: c.querySelector("[data-doc-remove-item]")?.disabled,
        hiddenLineItems: c.querySelector('[name="lineItems"]')?.value,
        hiddenAmount: c.querySelector('[name="amount"]')?.value,
        issueDate: c.querySelector("[data-doc-issue]")?.value,
        dueDate: c.querySelector("[data-doc-due]")?.value,
        vatDefault: c.querySelector('[name="vat"]')?.value
      };
    });
  }

  // Build a full invoice
  await open("invoice");
  await page.fill('[name="recipient"]', "Thabo Ndlovu");
  await page.fill('[name="customerEmail"]', "thabo@example.co.za");
  await page.fill("[data-doc-desc]", "Website design");
  await page.fill("[data-doc-qty]", "1");
  await page.fill("[data-doc-unit]", "8500");
  await page.waitForTimeout(350);
  R.afterFirstLine = await page.evaluate(() => ({
    lineTotal: document.querySelector("[data-doc-line-total]").textContent.trim(),
    totals: [...document.querySelectorAll("[data-doc-totals] div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
    hiddenLineItems: document.querySelector('[name="lineItems"]').value,
    hiddenAmount: document.querySelector('[name="amount"]').value,
    submitDisabled: document.querySelector('button[type="submit"]').disabled,
    warningShown: !document.querySelector("[data-doc-warning]").hidden
  }));

  await page.click('[data-action="doc-add-item"]');
  await page.waitForTimeout(300);
  const rows = await page.$$("[data-doc-item]");
  await rows[1].$eval("[data-doc-desc]", (e) => { e.value = "Hosting setup"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await rows[1].$eval("[data-doc-qty]", (e) => { e.value = "3"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await rows[1].$eval("[data-doc-unit]", (e) => { e.value = "450", e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(350);
  R.afterSecondLine = await page.evaluate(() => ({
    lineTotals: [...document.querySelectorAll("[data-doc-line-total]")].map((e) => e.textContent.trim()),
    totals: [...document.querySelectorAll("[data-doc-totals] div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
    hiddenLineItems: document.querySelector('[name="lineItems"]').value,
    hiddenAmount: document.querySelector('[name="amount"]').value,
    removeEnabled: [...document.querySelectorAll("[data-doc-remove-item]")].every((b) => !b.disabled)
  }));

  await page.selectOption('[name="vat"]', "Include VAT 15%");
  await page.waitForTimeout(350);
  R.withVat = await page.evaluate(() => [...document.querySelectorAll("[data-doc-totals] div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()));

  await page.click('[data-doc-term="7"]');
  await page.waitForTimeout(300);
  R.term7 = await page.evaluate(() => ({ due: document.querySelector("[data-doc-due]").value, active: document.querySelector("[data-doc-term].is-active")?.textContent.trim() }));

  await page.screenshot({ path: `${OUT}/doc-invoice-filled.png` });

  // remove a line
  const removes = await page.$$("[data-doc-remove-item]");
  await removes[1].click();
  await page.waitForTimeout(300);
  R.afterRemove = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-doc-item]").length,
    hiddenLineItems: document.querySelector('[name="lineItems"]').value,
    hiddenAmount: document.querySelector('[name="amount"]').value
  }));

  // re-add and submit
  await page.click('[data-action="doc-add-item"]');
  await page.waitForTimeout(250);
  const rows2 = await page.$$("[data-doc-item]");
  await rows2[1].$eval("[data-doc-desc]", (e) => { e.value = "Hosting setup"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await rows2[1].$eval("[data-doc-qty]", (e) => { e.value = "3"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await rows2[1].$eval("[data-doc-unit]", (e) => { e.value = "450"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(350);
  await page.click('.modal-card form button[type="submit"]');
  await page.waitForTimeout(1800);
  R.review = await page.evaluate(() => ({
    open: !!document.querySelector('[data-action="confirm-transaction-review"]'),
    rows: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).slice(0, 8)
  }));
  if (R.review.open) {
    await page.click('[data-action="confirm-transaction-review"]');
    await page.waitForTimeout(1800);
    R.saved = await page.evaluate(() => ({
      heading: document.querySelector(".modal-card h2")?.textContent.trim(),
      feeCard: [...document.querySelectorAll(".document-fee-card div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
      actions: [...document.querySelectorAll(".auth-actions button")].map((b) => b.textContent.trim())
    }));
    R.postedMetadataKeys = posted ? Object.keys(posted.metadata || {}).sort() : null;
    R.postedAmount = posted ? posted.amount : null;
    R.postedLineItems = posted ? posted.metadata.lineItems : null;
    R.storedDoc = await page.evaluate(() => {
      const docs = JSON.parse(localStorage.getItem("titopay_business_documents_v1") || "[]");
      const d = docs[0];
      return d ? { number: d.number, kind: d.kind, issueDate: d.issueDate, dueDate: d.dueDate, dateLabel: d.dateLabel, disclaimer: d.disclaimer, items: d.items, totals: d.totals } : null;
    });
    await page.screenshot({ path: `${OUT}/doc-invoice-saved.png` });
  }

  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
