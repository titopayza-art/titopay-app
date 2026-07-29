// v182: Merchant POS reachability, home without Recent activity, the rebuilt
// landing menu, Bulk Distribution, and the printable payment QR poster.
//
// Every assertion here is about whether a control can be reached and whether
// the screen states what it is doing. Nothing in this file submits a
// transaction: the Bulk Distribution path stops at the funding review, which
// is the screen before money is reserved.
const { chromium } = require("playwright");
const fs = require("fs");
const { CATALOGUE, BASE_URL, launchOptions } = require("./lib/env");

const SERVICES = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));

const QR_IMAGE = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwIi8+PC9zdmc+";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` (${detail})` : ""}`);
};

const BENEFICIARIES = [
  { id: "b1", unique_beneficiary_id: "STU-10021", first_name: "Naledi", surname: "Mokoena", wallet_number: "81234599", phone: "+27821110001" },
  { id: "b2", unique_beneficiary_id: "STU-10022", first_name: "Sipho", surname: "Dlamini", wallet_number: "", phone: "+27821110002" }
];

const BATCHES = [
  { id: "bt1", batch_name: "March student allowances", batch_reference: "BD-2026-0031", status: "draft_validated", valid_total: 18400, locked_total: 0, invalid_rows: 2, valid_rows: 46 },
  { id: "bt2", batch_name: "February payroll", batch_reference: "BD-2026-0022", status: "released", valid_total: 96500, locked_total: 96500, invalid_rows: 0, valid_rows: 120, released_at: "2026-03-12T14:22:00Z" },
  { id: "bt3", batch_name: "January rentals", batch_reference: "BD-2026-0011", status: "funding_locked", valid_total: 42000, locked_total: 42000, invalid_rows: 0, valid_rows: 28 }
];

// Shaped exactly as the API returns it: the batch, plus a per-row
// validationReport with the validator's own wording.
const VALIDATED = {
  id: "bt3",
  batch_name: "April allowances",
  batch_reference: "BD-2026-0044",
  status: "draft_validation_failed",
  valid_total: 12750,
  valid_rows: 48,
  invalid_rows: 2
};

const VALIDATION_REPORT = [
  { rowNumber: 1, status: "valid", errors: [], row: { uniqueBeneficiaryId: "STU-10021", amount: 250 } },
  { rowNumber: 2, status: "invalid", errors: ["Active TitoPay wallet was not found"], row: { uniqueBeneficiaryId: "STU-10022", amount: 250 } },
  { rowNumber: 3, status: "invalid", errors: ["Amount must be greater than zero", "Duplicate beneficiary in this batch"], row: { uniqueBeneficiaryId: "STU-19999", amount: 0 } }
];

function mock(acct, eligible) {
  return (route) => {
    const u = new URL(route.request().url());
    const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/health") return J({ status: "ok" });
    if (u.pathname === "/v1/maintenance/public") return J({ maintenance: { pwa: { enabled: false } } });
    if (u.pathname === "/v1/services") return J(SERVICES);
    if (u.pathname === "/v1/wallets") return J({ items: [{ wallet_id: "81234567", available_balance: 25000 }] });
    if (u.pathname === "/v1/transactions") return J({ items: [] });
    if (u.pathname === "/v1/qr/profile") return J({ qr: { id: "TPQR-81234567", reference: "TPQR-81234567", imageDataUrl: QR_IMAGE, deepLink: "https://app.titopay.co.za/pay/81234567" } });
    if (u.pathname === "/v1/qr/generate-static") return J({ qr: { id: "TIP-4471", reference: "TIP-4471", imageDataUrl: QR_IMAGE, deepLink: "https://app.titopay.co.za/pay/TIP-4471" } });
    if (u.pathname === "/v1/enterprise-distribution/eligibility") {
      return J({ eligibility: eligible ? { eligible: true, organisation: { organisation_name: "Naledi Trading Foundation" } } : { eligible: false, blockers: ["FICA verification incomplete"] } });
    }
    if (u.pathname === "/v1/enterprise-distribution/beneficiaries") return J({ items: BENEFICIARIES });
    if (u.pathname === "/v1/enterprise-distribution/batches") {
      if (route.request().method() === "POST") return J({ batch: VALIDATED, validationReport: VALIDATION_REPORT });
      return J({ items: BATCHES });
    }
    if (u.pathname === "/v1/auth/me") {
      return J({ user: { id: "u1", fullName: "Thuso Tshiloane", businessName: "Naledi Trading", username: "thuso.tshiloane", accountType: acct, status: "active", walletId: "81234567", ficaStatus: "verified", email: "t@example.com", phone: "+27821234567" } });
    }
    return J({ ok: true, items: [] });
  };
}

async function authed(browser, { acct = "business", eligible = true, width = 440, height = 956 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  await ctx.route("https://api.titopay.co.za/**", mock(acct, eligible));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE_URL}/index.html#dashboard`, { waitUntil: "networkidle" }).catch(() => {});
  await sleep(2800);
  await page.evaluate(() => document.querySelector(".install-float-wrap button:last-child")?.click());
  await sleep(400);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch(launchOptions());

  // ---- 1. Merchant POS: the primary action must be reachable -------------
  for (const [w, h] of [[1440, 760], [1280, 720], [1440, 700], [1280, 640], [1280, 560], [440, 956], [393, 852]]) {
    const { ctx, page } = await authed(browser, { width: w, height: h });
    await page.evaluate(() => { location.hash = "qr"; });
    await sleep(900);
    await page.click('[data-action="merchant-make-sale"]').catch(() => {});
    await sleep(800);
    // A real user can only scroll with the wheel or a finger. element.scrollTop
    // moves an overflow:hidden box too, so scripting it would prove nothing --
    // that is exactly how this defect hid from an earlier check.
    await page.mouse.move(w / 2, h / 2);
    await page.mouse.wheel(0, 600);
    await sleep(400);
    const m = await page.evaluate(() => {
      const card = document.querySelector(".merchant-pos-card");
      const btn = document.querySelector(".merchant-generate-btn");
      if (!card || !btn) return null;
      const b = btn.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
      return {
        insideCard: b.bottom <= c.bottom + 1,
        onScreen: b.bottom <= window.innerHeight + 1 && b.top >= -1 && b.width > 0,
        hittable: Boolean(hit && (hit === btn || btn.contains(hit))),
        keypadKeys: document.querySelectorAll(".merchant-keypad button").length
      };
    });
    check(`POS Generate QR reachable at ${w}x${h}`, Boolean(m && m.insideCard && m.onScreen && m.hittable), m ? JSON.stringify(m) : "modal not found");
    check(`POS keypad complete at ${w}x${h}`, m && m.keypadKeys === 11, m ? `${m.keypadKeys} keys` : "");
    await ctx.close();
  }

  // ---- 2. Home has no Recent activity and keeps the Activity tab ---------
  for (const acct of ["personal", "business"]) {
    const { ctx, page } = await authed(browser, { acct });
    const m = await page.evaluate(() => ({
      recent: /recent activity/i.test(document.querySelector(".screen").innerText),
      summary: /transaction summary/i.test(document.querySelector(".screen").innerText),
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
      activityTab: Boolean(document.querySelector('.bottom-nav [data-route="activity"]'))
    }));
    check(`home drops Recent activity (${acct})`, m.recent === false);
    check(`home keeps Transaction summary (${acct})`, m.summary === true);
    check(`home fits 440x956 without scrolling (${acct})`, m.overflowY <= 0, `overflow ${m.overflowY}px`);
    check(`Activity tab still present (${acct})`, m.activityTab);

    // The Activity route is where the history lives now.
    await page.evaluate(() => { location.hash = "activity"; });
    await sleep(800);
    const activityHasList = await page.evaluate(() => Boolean(document.querySelector(".screen .activity-list, .screen .empty-state")));
    check(`Activity route still renders history (${acct})`, activityHasList);
    await ctx.close();
  }

  // ---- 2b. The fixed app bar has room for the wordmark and both buttons --
  for (const [safeTop, label] of [[59, "notched"], [0, "flat"]]) {
    const { ctx, page } = await authed(browser, { acct: "business" });
    await page.evaluate((t) => document.documentElement.style.setProperty("--safe-top", t + "px"), safeTop);
    await sleep(400);
    const m = await page.evaluate(() => {
      const bar = document.querySelector("[data-app-topbar]");
      const logo = bar.querySelector(".brand-logo");
      const b = bar.getBoundingClientRect();
      const l = logo.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll(".icon-btn, .avatar")].map((el) => el.getBoundingClientRect());
      return {
        logoH: Math.round(l.height),
        clipped: buttons.some((r) => r.bottom > b.bottom + 0.5 || r.top < -0.5) || l.bottom > b.bottom + 0.5,
        buttonGap: buttons.length === 2 ? Math.round(buttons[1].left - buttons[0].right) : -1,
        rightInset: buttons.length ? Math.round(window.innerWidth - buttons[buttons.length - 1].right) : -1
      };
    });
    check(`app bar wordmark is legible (${label})`, m.logoH >= 36, `${m.logoH}px`);
    check(`app bar clips nothing (${label})`, m.clipped === false);
    check(`app bar buttons are not squashed together (${label})`, m.buttonGap >= 10, `${m.buttonGap}px`);
    check(`app bar buttons clear the edge (${label})`, m.rightInset >= 10, `${m.rightInset}px`);
    await ctx.close();
  }

  // ---- 2c. The server's lookup outcome is trusted over the heuristic -----
  //
  // A directory that answers "we looked, nobody there" must read differently
  // from a directory that could not be reached. Telling someone their contact
  // is not on TitoPay when nothing was checked is a false statement made
  // during a payment.
  for (const [label, body, status, expectUnavailable] of [
    ["server says not_found", { ok: true, registered: false, outcome: "not_found", invite: { url: "https://app.titopay.co.za", message: "Join me on TitoPay" } }, 200, false],
    ["directory unreachable", { error: "Directory temporarily unavailable" }, 503, true]
  ]) {
    const { ctx, page } = await authed(browser, { acct: "personal" });
    await page.route("https://api.titopay.co.za/v1/**", (route) => {
      const u = new URL(route.request().url());
      if (/resolve|lookup|recipient\/verify/.test(u.pathname)) {
        return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      }
      return route.fallback();
    });
    const verdict = await page.evaluate(async () => {
      const result = await lookupRegisteredRecipient("+27821119999", "wallet_transfer");
      return { registered: result.registered, lookupFailed: Boolean(result.lookupFailed) };
    });
    check(`lookup reports not-registered only when the server said so (${label})`, verdict.registered === false && verdict.lookupFailed === expectUnavailable, JSON.stringify(verdict));
    await ctx.close();
  }

  // ---- 3. Landing menu ---------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });
    await ctx.route("https://api.titopay.co.za/**", mock("personal", false));
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" }).catch(() => {});
    await sleep(2600);
    await page.evaluate(() => document.querySelector(".install-float-wrap button:last-child")?.click());
    await page.click('[data-action="landing-menu"]');
    await sleep(700);
    const m = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      const text = card.innerText;
      return {
        sections: card.querySelectorAll(".menu-section").length,
        headings: [...card.querySelectorAll(".menu-section h3")].map((h) => h.textContent.trim()),
        tags: card.querySelectorAll(".menu-tag-list li").length,
        benefits: card.querySelectorAll(".menu-benefits div").length,
        staleVersion: /version 1\.0\.0/i.test(text),
        buildShown: /app build v\d+/i.test(text),
        whatsapp: Boolean(card.querySelector('a[href^="https://wa.me/"]')),
        email: Boolean(card.querySelector('a[href^="mailto:"]')),
        privacy: Boolean(card.querySelector('a[href*="legal-privacy"]')),
        terms: Boolean(card.querySelector('a[href*="legal-terms"]')),
        blankLinks: [...card.querySelectorAll('a[target="_blank"]')].every((a) => (a.getAttribute("rel") || "").includes("noopener"))
      };
    });
    check("landing menu is sectioned", m.sections >= 8, `${m.sections} sections`);
    check("landing menu lists services from the catalogue", m.tags > 0, `${m.tags} services`);
    check("landing menu sets benefits as a list", m.benefits === 3, `${m.benefits}`);
    check("landing menu no longer claims Version 1.0.0", m.staleVersion === false);
    check("landing menu shows the real build", m.buildShown);
    check("landing menu offers WhatsApp", m.whatsapp);
    check("landing menu offers email", m.email);
    check("landing menu links privacy policy", m.privacy);
    check("landing menu links terms", m.terms);
    check("landing menu external links are rel=noopener", m.blankLinks);
    await ctx.close();
  }

  // ---- 4. Bulk Distribution ---------------------------------------------
  {
    const { ctx, page } = await authed(browser, { width: 900, height: 1000 });
    await page.evaluate(() => { location.hash = "profile"; });
    await sleep(900);
    await page.click('[data-action="enterprise-distribution"]');
    await sleep(1200);
    const dash = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        steps: card.querySelectorAll(".ed-steps li").length,
        batches: card.querySelectorAll(".ed-list .ed-row").length,
        lockButtons: card.querySelectorAll('[data-action^="enterprise-fund:"]').length,
        beneficiaryNamed: /Naledi Mokoena/.test(card.innerText),
        missingWalletFlagged: /No wallet number/i.test(card.innerText),
        adminStated: /Admin/i.test(card.innerText),
        releaseStated: /Released 12 Mar 2026/i.test(card.innerText),
        lockedStated: /Waiting for TitoPay Admin to release/i.test(card.innerText),
        progressText: [...card.querySelectorAll(".ed-progress")].map((n) => n.textContent).join(" | ")
      };
    });
    check("bulk distribution states the five steps", dash.steps === 5, `${dash.steps}`);
    check("bulk distribution lists batches and beneficiaries", dash.batches >= 5, `${dash.batches} rows`);
    check("bulk distribution offers funding only on validated batches", dash.lockButtons === 1, `${dash.lockButtons}`);
    check("bulk distribution shows beneficiary names", dash.beneficiaryNamed);
    check("bulk distribution flags a beneficiary with no wallet", dash.missingWalletFlagged);
    check("bulk distribution states Admin release", dash.adminStated);
    check("bulk distribution reports a released batch and when", dash.releaseStated, dash.progressText);
    check("bulk distribution says a locked batch is waiting", dash.lockedStated);

    // Build a batch: template, file guidance, validation result.
    await page.click('[data-action="enterprise-new-batch"]');
    await sleep(700);
    const batchModal = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        template: Boolean(card.querySelector('[data-action="enterprise-csv-template"]')),
        filePicker: Boolean(card.querySelector("[data-enterprise-csv-input]")),
        columnsShown: /uniqueBeneficiaryId/.test(card.innerText),
        saysNoFundsYet: /no funds are reserved/i.test(card.innerText)
      };
    });
    check("batch builder offers a CSV template", batchModal.template);
    check("batch builder offers a file picker", batchModal.filePicker);
    check("batch builder documents the columns", batchModal.columnsShown);
    check("batch builder states nothing is reserved", batchModal.saysNoFundsYet);

    await page.fill("#ed-batch-name", "April allowances");
    await page.fill("#ed-batch-csv", "uniqueBeneficiaryId,firstName,surname,walletNumber,amount,reference\nSTU-10021,Naledi,Mokoena,81234599,250,April");
    await page.click('[data-form="enterprise-batch"] button[type="submit"]');
    await sleep(1400);
    const result = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        text: card.innerText,
        rejectedRows: card.querySelectorAll(".ed-list .ed-row").length,
        showsReason: /Active TitoPay wallet was not found/i.test(card.innerText),
        showsEveryReason: /Amount must be greater than zero/i.test(card.innerText) && /Duplicate beneficiary in this batch/i.test(card.innerText),
        showsLineNumbers: /line 2/i.test(card.innerText) && /line 3/i.test(card.innerText),
        listsValidRow: /STU-10021/.test(card.innerText),
        showsCounts: /Rows rejected/i.test(card.innerText),
        saysNotReserved: /no funds have been reserved/i.test(card.innerText)
      };
    });
    check("validation result names the rejected rows", result.rejectedRows === 2, `${result.rejectedRows}`);
    check("validation result gives the reason per row", result.showsReason);
    check("validation result shows every reason on a row", result.showsEveryReason);
    check("validation result cites the CSV line number", result.showsLineNumbers);
    check("validation result does not list accepted rows as rejected", result.listsValidRow === false);
    check("validation result reports counts", result.showsCounts);
    check("validation result states nothing is reserved", result.saysNotReserved);

    // Funding review: must restate the amount and must NOT auto-submit.
    let fundCalls = 0;
    await page.route("https://api.titopay.co.za/v1/enterprise-distribution/batches/*/fund", (route) => {
      fundCalls += 1;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.click('.modal-card [data-action="enterprise-distribution"]');
    await sleep(1200);
    await page.click('.modal-card [data-action^="enterprise-fund:"]');
    await sleep(700);
    const review = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        restatesAmount: /R\s?18[  ,]?400/.test(card.innerText),
        showsBalance: /Wallet available now/i.test(card.innerText),
        saysNotPaid: /does not pay anyone/i.test(card.innerText),
        hasCancel: Boolean([...card.querySelectorAll("button")].find((b) => /cancel/i.test(b.textContent))),
        confirmIsExplicit: Boolean(card.querySelector('[data-action^="enterprise-fund-confirm:"]'))
      };
    });
    check("funding review restates the amount", review.restatesAmount);
    check("funding review shows the wallet balance", review.showsBalance);
    check("funding review states no one is paid yet", review.saysNotPaid);
    check("funding review can be cancelled", review.hasCancel);
    check("funding needs a second explicit confirm", review.confirmIsExplicit);
    check("reaching the review reserves nothing", fundCalls === 0, `${fundCalls} fund calls`);
    await ctx.close();
  }

  // ---- 5. Payment QR poster ----------------------------------------------
  {
    const { ctx, page } = await authed(browser);
    await page.evaluate(() => { location.hash = "profile"; });
    await sleep(900);
    const entry = await page.evaluate(() => Boolean(document.querySelector('[data-action="qr-poster"]')));
    check("profile offers the payment QR poster (business)", entry);
    await page.click('[data-action="qr-poster"]');
    await sleep(1200);
    const poster = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      const el = card.querySelector("[data-qr-poster]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        ratio: Number((r.width / r.height).toFixed(3)),
        name: /Naledi Trading/.test(el.innerText),
        payWith: /pay with titopay/i.test(el.innerText),
        qrId: /TPQR-81234567/.test(el.innerText),
        logo: Boolean(el.querySelector(".qr-poster-logo")),
        qrImage: Boolean(el.querySelector(".qr-poster-qr img")),
        printBtn: Boolean(card.querySelector('[data-action="print-qr-poster"]'))
      };
    });
    check("poster renders", Boolean(poster));
    if (poster) {
      check("poster is A4 portrait", Math.abs(poster.ratio - 210 / 297) < 0.02, `ratio ${poster.ratio}`);
      check("poster carries the business name", poster.name);
      check("poster says Pay with TitoPay", poster.payWith);
      check("poster prints the QR ID", poster.qrId);
      check("poster carries the TitoPay logo", poster.logo);
      check("poster shows the QR image", poster.qrImage);
      check("poster can be printed", poster.printBtn);
      const download = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
        page.click('[data-action="download-qr-poster-pdf"]')
      ]).then(([d]) => d);
      check("poster downloads as a real PDF", Boolean(download && /\.pdf$/i.test(download.suggestedFilename())), download ? download.suggestedFilename() : "no download event");
    }
    await ctx.close();
  }

  // Personal accounts keep Receive Money and do not get the business poster,
  // but they do get the tip poster.
  {
    const { ctx, page } = await authed(browser, { acct: "personal" });
    await page.evaluate(() => { location.hash = "profile"; });
    await sleep(900);
    const m = await page.evaluate(() => ({
      payment: Boolean(document.querySelector('[data-action="qr-poster"]')),
      tip: Boolean(document.querySelector('[data-action="tip-poster"]'))
    }));
    check("personal profile does not show the business payment poster", m.payment === false);
    check("personal profile offers the tip poster", m.tip);
    await ctx.close();
  }

  // ---- 5b. Tip poster, both account types --------------------------------
  for (const acct of ["personal", "business"]) {
    const { ctx, page } = await authed(browser, { acct });
    await page.evaluate(() => { location.hash = "profile"; });
    await sleep(900);
    await page.click('[data-action="tip-poster"]');
    await sleep(1300);
    const poster = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      const el = card.querySelector("[data-qr-poster]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const logo = el.querySelector(".qr-poster-logo").getBoundingClientRect();
      return {
        ratio: Number((r.width / r.height).toFixed(3)),
        isTip: el.classList.contains("qr-poster-tip"),
        banner: (el.querySelector(".qr-poster-banner") || {}).textContent || "",
        tagline: (el.querySelector(".qr-poster-tagline") || {}).textContent || "",
        logoShare: Number((logo.width / r.width).toFixed(2)),
        tipSteps: /choose your tip/i.test(el.innerText),
        printBtn: Boolean(card.querySelector('[data-action="print-qr-poster"]'))
      };
    });
    check(`tip poster renders (${acct})`, Boolean(poster));
    if (poster) {
      check(`tip poster is A4 portrait (${acct})`, Math.abs(poster.ratio - 210 / 297) < 0.02, `ratio ${poster.ratio}`);
      check(`tip poster is headed Tips (${acct})`, /tips/i.test(poster.banner), poster.banner);
      check(`tip poster carries the tagline (${acct})`, /Smart Payments/.test(poster.tagline), poster.tagline);
      check(`tip poster logo is at least half the sheet width (${acct})`, poster.logoShare >= 0.5, `${poster.logoShare}`);
      check(`tip poster tells the tipper to choose an amount (${acct})`, poster.tipSteps);
      check(`tip poster can be printed (${acct})`, poster.printBtn);
      const download = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
        page.click('[data-action="download-qr-poster-pdf"]')
      ]).then(([d]) => d);
      check(`tip poster downloads as a PDF (${acct})`, Boolean(download && /tip.*\.pdf$/i.test(download.suggestedFilename())), download ? download.suggestedFilename() : "no download event");
    }
    await ctx.close();
  }

  // ---- 7. Landing footer -------------------------------------------------
  for (const [w, h, label, safe] of [[440, 956, "phone", 0], [440, 956, "phone-insets", 1], [393, 852, "iphone15-insets", 1], [820, 1180, "tablet", 0], [1440, 900, "desktop", 0]]) {
    for (const acct of ["personal", "business"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });
      if (safe) await ctx.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.setProperty("--safe-top", "59px"); document.documentElement.style.setProperty("--safe-bottom", "34px"); }); });
      await ctx.route("https://api.titopay.co.za/**", mock(acct, false));
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" }).catch(() => {});
      await sleep(2600);
      if (acct === "business") { await page.click('[data-account="business"]').catch(() => {}); await sleep(700); }
      await page.evaluate(() => document.querySelector(".install-float-wrap button:last-child")?.click());
      await sleep(400);
      const m = await page.evaluate(() => {
        const el = document.querySelector(".landing-cta-footer");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          isFooter: el.tagName === "FOOTER",
          fullBleed: Math.round(r.left) === 0 && Math.round(r.right) === window.innerWidth,
          atBottom: Math.abs(Math.round(window.innerHeight - r.bottom)) <= 1,
          heading: (el.querySelector("h3") || {}).textContent || "",
          siteLinkGone: !document.querySelector(".landing-flow .landing-site-footer"),
          overflowY: document.documentElement.scrollHeight - window.innerHeight,
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          visibleTiles: [...document.querySelectorAll(".preview-grid .service-tile")].filter((t) => getComputedStyle(t).display !== "none").length,
          tallestTile: Math.round(Math.max(...[...document.querySelectorAll(".preview-grid .service-tile")].filter((t) => getComputedStyle(t).display !== "none").map((t) => t.getBoundingClientRect().height))),
          footerCta: Boolean(el.querySelector(".landing-cta-btn"))
        };
      });
      check(`landing CTA is a footer (${label} ${acct})`, Boolean(m && m.isFooter));
      if (m) {
        check(`landing footer spans the screen (${label} ${acct})`, m.fullBleed);
        check(`landing footer sits at the bottom (${label} ${acct})`, m.atBottom);
        check(`landing footer heading (${label} ${acct})`, m.heading.trim() === (acct === "business" ? "Accept Payment" : "Scan To Pay"), m.heading);
        check(`website link no longer on the landing (${label} ${acct})`, m.siteLinkGone);
        check(`landing does not scroll (${label} ${acct})`, m.overflowY <= 0 && m.overflowX <= 0, `y=${m.overflowY} x=${m.overflowX}`);
        check(`landing service grid has no orphan tile (${label} ${acct})`, m.visibleTiles % 3 === 0 && m.visibleTiles >= 6, `${m.visibleTiles} tiles`);
        check(`landing tiles are not stretched (${label} ${acct})`, m.tallestTile <= 170, `${m.tallestTile}px`);
        check(`landing footer carries the QR action (${label} ${acct})`, m.footerCta);
      }
      await ctx.close();
    }
  }

  // The website moved into the menu.
  {
    const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });
    await ctx.route("https://api.titopay.co.za/**", mock("personal", false));
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" }).catch(() => {});
    await sleep(2600);
    await page.evaluate(() => document.querySelector(".install-float-wrap button:last-child")?.click());
    await page.click('[data-action="landing-menu"]');
    await sleep(700);
    const inMenu = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return [...card.querySelectorAll("a")].some((a) => /www\.titopay\.co\.za/i.test(a.textContent));
    });
    check("website address is in the menu", inMenu);
    await ctx.close();
  }

  // ---- 6. Ineligible organisations still see the application form --------
  {
    const { ctx, page } = await authed(browser, { eligible: false });
    await page.evaluate(() => { location.hash = "profile"; });
    await sleep(900);
    await page.click('[data-action="enterprise-distribution"]');
    await sleep(1000);
    const m = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        form: Boolean(card.querySelector('[data-form="enterprise-distribution-application"]')),
        blocker: /FICA verification incomplete/.test(card.innerText),
        noDashboard: card.querySelectorAll(".ed-steps").length === 0
      };
    });
    check("ineligible organisation gets the application form", m.form);
    check("ineligible organisation sees its blockers", m.blocker);
    check("ineligible organisation gets no batch tools", m.noDashboard);
    await ctx.close();
  }

  await browser.close();
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("\nv182 feature suite passed");
})();
