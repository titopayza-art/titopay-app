// A BUSINESS DOCUMENT MUST NEVER OPEN THE MONEY FORM.
//
// Reported twice with screenshots - once for Proforma Invoice, once for
// Invoice: tapping the tile opened TRANSACTION REVIEW, offering to deduct
// R602.50 and telling the issuer "The recipient receives R600.00". That is the
// business paying the customer it meant to bill.
//
// The app dispatches a tile on service_config.action, and openTransactionModal
// is the fall-through at the end of that dispatcher. ensureDefaultServices only
// writes `action` when the catalogue is SHORT, so on an installed database a
// blank or stale action is never repaired, the match fails, and the tile falls
// through to the money form.
//
// This drives the dispatcher with a DELIBERATELY BROKEN catalogue - the exact
// production condition - and asserts where each document service lands. A
// harness that only tested a healthy catalogue would have passed before the
// fix and proved nothing.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8197;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "ee220000-3333-4444-8555-666666666666",
  fullName: "Doc Probe", username: "docprobe",
  email: "doc@titopay.local", phone: "+27820000555",
  accountType: "business", account_type: "business", status: "active"
};

// The three document services, each with the kind of broken action an
// un-repaired database actually carries, and the heading their real screen
// shows. Nothing here is invented: the titles come from the document config.
const CASES = [
  // An invoice deliberately carries NO disclaimer: it is a demand for payment
  // and needs no "this is not X" caveat. The other two do, precisely because
  // they could be mistaken for one. Asserting a disclaimer here was this
  // harness being wrong, not the app.
  { code: "invoice", brokenAction: "", heading: /Create an invoice/i,
    prefix: "INV", kind: "Invoice", disclaimer: null },
  { code: "quote", brokenAction: "none", heading: /Create a quote/i,
    prefix: "QUO", kind: "Quote",
    // The sentence that makes a quote an offer rather than a demand.
    disclaimer: /not a request for payment/i },
  { code: "proforma-invoice", brokenAction: "proforma", heading: /Create a proforma invoice/i,
    prefix: "PRO", kind: "Proforma Invoice",
    disclaimer: /not a tax invoice/i }
];

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const wireCalls = [];
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    // Every call the document flow makes is recorded. A document that prices
    // itself through fee-preview is already wrong, whatever it does next.
    if (route.request().method() === "POST") wireCalls.push(p);
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "2000.00", reserved_balance: "0.00", wallet_number: "3382660735", status: "active" }] });
    if (p === "/chat/notifications") return json({ notifications: [] });
    return json({ items: [] });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe", refreshToken: "probe", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1800);

  console.log("\n  a catalogue whose `action` column was never repaired");
  for (const testCase of CASES) {
    const seen = await page.evaluate(async ({ code, brokenAction }) => {
      // The broken row, exactly as an un-repaired service_config serves it.
      state.services = [
        ...(state.services || []).filter((s) => s.id !== code),
        { id: code, serviceCode: code, action: brokenAction, label: code,
          status: "active", type: "transaction", fee: 2.5 }
      ];
      if (typeof closeModal === "function") closeModal();
      await new Promise((r) => setTimeout(r, 200));
      handleService(code);
      await new Promise((r) => setTimeout(r, 600));
      const card = document.querySelector(".modal-card");
      const text = card ? card.textContent : "";
      return {
        heading: card?.querySelector("h2")?.textContent.trim() || "(no modal)",
        // The two things that must never appear for a document.
        offersToDeduct: /Total deducted/i.test(text),
        namesARecipient: /The recipient receives/i.test(text)
      };
    }, testCase);

    ok(`${testCase.code} (action "${testCase.brokenAction || "blank"}") opens its document screen`,
      testCase.heading.test(seen.heading), seen.heading);
    ok(`${testCase.code} does not offer to deduct anything`, !seen.offersToDeduct);
    ok(`${testCase.code} does not name a recipient to pay`, !seen.namesARecipient);
  }

  // And a healthy row must still work, so the code match has not replaced the
  // action match with a new single point of failure.
  ok("NO DOCUMENT PRICES ITSELF THROUGH THE PAYMENT ENGINE",
    !wireCalls.some((c) => /fee-preview|^\/transactions$/.test(c)),
    wireCalls.filter((c) => /fee-preview|^\/transactions$/.test(c)).join(", ")
      || "no fee-preview, no wallet post");

  console.log("\n  and a healthy catalogue is unchanged");
  const healthy = await page.evaluate(async () => {
    state.services = [{ id: "invoice", serviceCode: "invoice", action: "invoice",
      label: "Invoice", status: "active", type: "transaction", fee: 2.5 }];
    if (typeof closeModal === "function") closeModal();
    await new Promise((r) => setTimeout(r, 200));
    handleService("invoice");
    await new Promise((r) => setTimeout(r, 600));
    return document.querySelector(".modal-card h2")?.textContent.trim() || "(no modal)";
  });
  ok("a correct action still opens the document screen", /Create an invoice/i.test(healthy), healthy);

  /* ------------------------ THE WHOLE JOURNEY: WRITE ONE AND SAVE IT */
  //
  // Routing only decides which screen opens. The form on that screen carried
  // data-form="transaction", posted to /v1/transactions, and saved the
  // document only AFTER that returned - and the codes it sends are refused
  // 503, so the post always failed and the document was NEVER saved. Creating
  // a business document had not worked at all.
  //
  // This fills each form and submits it, then checks what actually came out:
  // the right kind, the right numbering series, and the disclaimer that makes
  // a quote an offer rather than a demand for payment.
  console.log("\n  writing a document end to end");
  for (const testCase of CASES) {
    const made = await page.evaluate(async ({ code }) => {
      state.services = [{ id: code, serviceCode: code, action: "", label: code,
        status: "active", type: "transaction", fee: 2.5 }];
      state.businessDocuments = [];
      if (typeof closeModal === "function") closeModal();
      await new Promise((r) => setTimeout(r, 200));
      handleService(code);
      await new Promise((r) => setTimeout(r, 500));

      const form = document.querySelector("[data-document-form]");
      if (!form) return { error: "the document form did not open" };
      const set = (name, value) => {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) { field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); }
      };
      set("recipient", "Thuso Tshiloane");
      set("customerEmail", "thuso@example.com");
      set("customerAddress", "12 Main Road, Johannesburg");
      set("amount", "600");
      set("lineItems", "Consulting | 1 | 600");

      // THE SCREEN THAT SHOULD NEVER APPEAR. Watched for throughout the
      // submit rather than checked at the end, because the review was shown
      // and then replaced - by the time the flow settled it had gone, and a
      // check at the end saw nothing wrong.
      window.__sawReview = false;
      const watcher = new MutationObserver(() => {
        if (/Review before confirming/i.test(document.body.textContent || "")) window.__sawReview = true;
      });
      watcher.observe(document.body, { childList: true, subtree: true });

      // Submit the way a person does, through the app's own handler.
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      // The review step, when the flow shows one.
      const confirm = document.querySelector('[data-action="confirm-transaction-review"]');
      if (confirm) { confirm.click(); await new Promise((r) => setTimeout(r, 1200)); }
      watcher.disconnect();

      const card = document.querySelector(".modal-card");
      const saved = (state.businessDocuments || [])[0] || null;
      return {
        heading: card?.querySelector("h2")?.textContent.trim() || "(no modal)",
        failed: /Transaction not confirmed/i.test(card?.textContent || ""),
        sawReview: window.__sawReview === true,
        savedCount: (state.businessDocuments || []).length,
        number: saved?.number || "",
        kind: saved?.kind || "",
        disclaimer: saved?.disclaimer || "",
        total: saved?.total ?? null
      };
    }, testCase);

    const label = testCase.code;
    ok(`${label}: the form submits without a failure screen`, !made.failed,
      made.failed ? made.heading : "");
    ok(`${label}: IT NEVER SHOWS THE MONEY REVIEW`, !made.sawReview,
      made.sawReview ? "asked to confirm paying the customer it means to bill" : "");
    ok(`${label}: THE DOCUMENT IS ACTUALLY SAVED`, made.savedCount === 1,
      `${made.savedCount} saved - this is what never worked`);
    ok(`${label}: it uses its own numbering series`,
      new RegExp(`^${testCase.prefix}-`).test(made.number || ""), made.number || "(none)");
    ok(`${label}: it is saved as the right kind`,
      new RegExp(testCase.kind, "i").test(made.kind || ""), made.kind || "(none)");
    if (testCase.disclaimer) {
      ok(`${label}: it carries its own disclaimer`,
        testCase.disclaimer.test(made.disclaimer || ""),
        (made.disclaimer || "(none)").slice(0, 80));
    } else {
      ok(`${label}: carries no disclaimer, which is correct for a demand for payment`,
        !String(made.disclaimer || "").trim(), made.disclaimer || "(none)");
    }
  }

  /* ------------------------------------------- drafts, and the numbering */
  //
  // The rule worth defending is the numbering. A document number is a promise
  // about a sequence, so a draft must not consume one: abandoning a draft that
  // had taken INV-2026-0002 would leave a hole, and a numbered series with
  // gaps is the first thing an auditor queries.
  console.log("\n  saving a draft, editing it, then finalising");
  const drafts = await page.evaluate(async () => {
    const out = {};
    const fill = (values) => {
      const form = document.querySelector("[data-document-form]");
      for (const [name, value] of Object.entries(values)) {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) { field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      const row = form.querySelector("[data-doc-item]");
      row.querySelector("[data-doc-desc]").value = values.__desc;
      row.querySelector("[data-doc-qty]").value = "1";
      row.querySelector("[data-doc-unit]").value = values.__unit;
      row.querySelector("[data-doc-unit]").dispatchEvent(new Event("input", { bubbles: true }));
    };
    const openFresh = async () => {
      state.services = [{ id: "invoice", serviceCode: "invoice", action: "invoice",
        label: "Invoice", status: "active", type: "transaction", fee: 2.5 }];
      if (typeof closeModal === "function") closeModal();
      await new Promise((r) => setTimeout(r, 150));
      handleService("invoice");
      await new Promise((r) => setTimeout(r, 400));
    };

    state.businessDocuments = [];
    state.editingDocumentDraftId = null;
    // THE SERIES MARK GOES TOO, and clearing the list is no longer enough to
    // do it. A number series now remembers its high-water mark separately from
    // the documents, precisely so that a device losing its documents cannot
    // reissue a number somebody is already holding. That is the right rule and
    // it is what makes this scenario need an explicit reset: an earlier check
    // in this same page has already issued invoice numbers, so without this the
    // "first" document below starts wherever that left off.
    try { localStorage.removeItem("titopay_document_series_v1"); } catch (error) { /* private mode */ }

    // 1. A first document, finalised straight away, takes INV-...0001.
    await openFresh();
    fill({ recipient: "First Customer", __desc: "Setup", __unit: "100" });
    document.querySelector("[data-document-form]").requestSubmit();
    await new Promise((r) => setTimeout(r, 900));
    out.firstNumber = (state.businessDocuments[0] || {}).number;

    // 2. A draft. It must take NO number.
    await openFresh();
    fill({ recipient: "Draft Customer", __desc: "Consulting", __unit: "250" });
    document.querySelector('[data-action="doc-save-draft"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const draft = state.businessDocuments.find((d) => d.customerName === "Draft Customer");
    out.draftStatus = draft?.status;
    out.draftNumber = draft?.number;
    out.draftShowsNoPdf = !document.querySelector('[data-action="document-pdf"]');
    out.draftOffersFinalise = Boolean(document.querySelector("[data-document-finalise]"));

    // 3. Editing it reopens the form with what was written.
    editDocumentDraft(draft.id);
    await new Promise((r) => setTimeout(r, 500));
    const form = document.querySelector("[data-document-form]");
    out.editRestoredCustomer = form?.querySelector('[name="recipient"]')?.value;
    out.editRestoredDesc = form?.querySelector("[data-doc-desc]")?.value;
    out.editRestoredUnit = form?.querySelector("[data-doc-unit]")?.value;

    // 4. Saving it again must UPDATE the draft, not make a second one.
    document.querySelector('[data-action="doc-save-draft"]').click();
    await new Promise((r) => setTimeout(r, 600));
    out.countAfterResave = state.businessDocuments.length;

    // 5. A second finalised document must take 0002 - the draft took nothing.
    await openFresh();
    fill({ recipient: "Second Customer", __desc: "Support", __unit: "400" });
    document.querySelector("[data-document-form]").requestSubmit();
    await new Promise((r) => setTimeout(r, 900));
    out.secondNumber = state.businessDocuments.find((d) => d.customerName === "Second Customer")?.number;

    // 6. Finalising the draft gives it the next number and locks it.
    const stillDraft = state.businessDocuments.find((d) => d.customerName === "Draft Customer");
    finaliseDocumentDraft(stillDraft.id);
    await new Promise((r) => setTimeout(r, 600));
    const finalised = state.businessDocuments.find((d) => d.customerName === "Draft Customer");
    out.finalisedNumber = finalised?.number;
    out.finalisedStatus = finalised?.status;
    out.totalRecords = state.businessDocuments.length;
    out.finalOffersPdf = Boolean(document.querySelector('[data-action="document-pdf"]'));
    return out;
  });

  ok("a finalised document takes the first number", drafts.firstNumber === "INV-2026-0001",
    drafts.firstNumber);
  ok("A DRAFT TAKES NO NUMBER AT ALL", drafts.draftStatus === "draft" && !drafts.draftNumber,
    `status ${drafts.draftStatus}, number ${JSON.stringify(drafts.draftNumber)}`);
  ok("a draft offers no PDF to buy", drafts.draftShowsNoPdf);
  ok("a draft offers finalising instead", drafts.draftOffersFinalise);
  ok("editing restores what was written", drafts.editRestoredCustomer === "Draft Customer"
    && drafts.editRestoredDesc === "Consulting" && drafts.editRestoredUnit === "250",
    `${drafts.editRestoredCustomer} / ${drafts.editRestoredDesc} / ${drafts.editRestoredUnit}`);
  ok("saving a draft again updates it rather than duplicating",
    drafts.countAfterResave === 2, `${drafts.countAfterResave} records`);
  ok("THE NEXT FINALISED DOCUMENT IS 0002, NOT 0003 - the draft reserved nothing",
    drafts.secondNumber === "INV-2026-0002", drafts.secondNumber);
  ok("finalising the draft numbers it and locks it",
    drafts.finalisedNumber === "INV-2026-0003" && drafts.finalisedStatus === "final",
    `${drafts.finalisedNumber} / ${drafts.finalisedStatus}`);
  ok("finalising replaces the draft rather than leaving both",
    drafts.totalRecords === 3, `${drafts.totalRecords} records`);
  ok("a finalised document offers its PDF", drafts.finalOffersPdf);

  /* ------------------- and when a refusal DOES reach the failure screen */
  //
  // Routing now keeps documents away from the money form, but other services
  // the platform has not launched still answer 503 through other paths. That
  // screen used to say "Please try again later" for a refusal that will never
  // succeed by waiting, and send the customer to Activity to look for a
  // transaction that was never submitted.
  const failures = await page.evaluate(async () => {
    const read = () => {
      const card = document.querySelector(".modal-card");
      return {
        message: card?.querySelector(".failure-message")?.textContent.trim() || "",
        guidance: card?.querySelector(".failure-guidance")?.textContent.trim() || "",
        offersActivity: Boolean(card?.querySelector('[data-action="failure-view-activity"]'))
      };
    };
    const out = {};
    // Exactly what the API throws: AppError(503, providerPendingMessage(...)).
    if (typeof closeModal === "function") closeModal();
    await new Promise((r) => setTimeout(r, 150));
    openTransactionFailureModal(null, { status: 503,
      message: "Invoice is not enabled for live processing yet. No wallet debit was made." });
    await new Promise((r) => setTimeout(r, 300));
    out.refused = read();

    // A GENUINE transient failure must keep the advice that stops double
    // payment - removing it for everything would be a worse bug than the one
    // being fixed.
    closeModal();
    await new Promise((r) => setTimeout(r, 150));
    openTransactionFailureModal(null, { status: 408, timedOut: true, message: "timeout" });
    await new Promise((r) => setTimeout(r, 300));
    out.timedOut = read();

    // And a real outage - a 503 WITHOUT the refusal wording - still gets
    // "try again later", because for an outage that is the right advice.
    closeModal();
    await new Promise((r) => setTimeout(r, 150));
    openTransactionFailureModal(null, { status: 503, message: "upstream temporarily unavailable" });
    await new Promise((r) => setTimeout(r, 300));
    out.outage = read();
    return out;
  });

  console.log("\n  a service that is not switched on");
  ok("THE REAL REASON IS SHOWN, NOT 'try again later'",
    /not enabled for live processing/i.test(failures.refused.message),
    failures.refused.message);
  ok("it does not tell them to retry", !/try again later/i.test(failures.refused.message));
  ok("it says this is not something to retry",
    /not something to retry/i.test(failures.refused.guidance));
  ok("IT DOES NOT SEND THEM HUNTING IN ACTIVITY", !failures.refused.offersActivity,
    "nothing was submitted, so there is nothing there to find");

  console.log("\n  and the advice that prevents double payment is untouched");
  ok("a timeout still says check Activity first",
    /Check Activity/i.test(failures.timedOut.guidance) || /Check Activity/i.test(failures.timedOut.message),
    failures.timedOut.message);
  ok("a timeout still offers Check Activity", failures.timedOut.offersActivity);
  ok("a REAL outage still says try again later",
    /try again later/i.test(failures.outage.message), failures.outage.message);
  ok("a real outage still offers Check Activity", failures.outage.offersActivity);

  ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
