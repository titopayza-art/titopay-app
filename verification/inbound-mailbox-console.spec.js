// THE INBOUND MAIL PANEL, RENDERED IN A REAL BROWSER.
//
// admin.js is one classic script, not a module, so its functions cannot be
// imported the way admin-marketing.js can. They are lifted out by name and
// evaluated against stubbed console helpers instead - the same approach the
// quick-replies harness takes, and the only one that exercises the real source
// rather than a copy of it.
//
// The behaviour worth proving here is the password field. The stored
// credential is never sent to the page, and an untouched field must be OMITTED
// from the save rather than sent empty: sending "" would be read as "set the
// password to nothing" and would lock the mailbox out on the next poll. That
// is a mistake nobody notices until support mail quietly stops arriving.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ADMIN = process.env.ADMIN_ROOT || path.join(__dirname, "..", "admin");
const source = fs.readFileSync(path.join(ADMIN, "assets", "admin.js"), "utf8");

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

// Lifted by slicing between two known landmarks rather than by counting
// braces. Brace counting looked tidier and was wrong: these functions build
// HTML in template literals full of braces inside strings, so the count closed
// early and produced source that would not parse. The two panel functions sit
// together immediately before renderEmailSettings, so that boundary is the
// honest one - and if either landmark ever moves, this throws instead of
// quietly testing a fragment.
function extractPanelSource() {
  const start = source.indexOf("async function renderInboundMailbox(");
  const end = source.indexOf("async function renderEmailSettings(");
  if (start === -1) throw new Error("renderInboundMailbox is not in admin.js");
  if (end === -1 || end < start) throw new Error("the panel no longer sits before renderEmailSettings");
  const slice = source.slice(start, end);
  if (!slice.includes("async function renderInboundUnrouted(")) {
    throw new Error("renderInboundUnrouted is not in the extracted range");
  }
  return slice;
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head>
    <body><div id="page-content"><div id="inbound-mailbox-panel"></div></div></body></html>`,
  { waitUntil: "load" });

  const fns = extractPanelSource();

  const result = await page.evaluate(async ({ fns }) => {
    window.__calls = [];
    window.__toasts = [];
    const settings = {
      enabled: false, host: "imap.titopay.co.za", port: 993,
      username: "support@titopay.co.za", mailbox: "INBOX",
      pollSeconds: 60, maxMessagesPerPoll: 25,
      // What the API actually returns: a flag, never the secret.
      password: "••••••••", hasPassword: true,
      lastSuccessAt: null, lastError: "Connection refused", consecutiveFailures: 3
    };
    const unrouted = [{ id: "e1", from_email: "thabo@example.com", subject: "Cannot pay",
      status: "failed", failure_reason: "too_large", received_at: "2026-09-14T08:00:00Z" }];

    const scope = {
      escapeHtml: (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
      formatDate: (v) => String(v || ""),
      adminErrorMessage: (e) => String((e && e.message) || e),
      showToast: (m) => window.__toasts.push(m),
      apiFetch: async (url, options = {}) => {
        window.__calls.push({ url, method: options.method || "GET", body: options.body || null });
        if (url.endsWith("/inbound/settings") && (options.method || "GET") === "GET") return { settings };
        if (url.endsWith("/inbound/unrouted")) return { items: unrouted };
        return { settings, result: { ok: true, waiting: 0, routed: true } };
      }
    };
    // eslint-disable-next-line no-new-func
    const build = new Function("escapeHtml", "formatDate", "adminErrorMessage", "showToast", "apiFetch",
      `${fns}; return { renderInboundMailbox, renderInboundUnrouted };`);
    const api = build(scope.escapeHtml, scope.formatDate, scope.adminErrorMessage,
      scope.showToast, scope.apiFetch);

    await api.renderInboundMailbox({});
    await new Promise((r) => setTimeout(r, 150));

    const form = document.getElementById("inbound-mailbox-form");
    const passwordField = form.querySelector('[name="password"]');
    const panelText = document.getElementById("inbound-mailbox-panel").textContent;

    // Submit WITHOUT touching the password, which is the dangerous path.
    window.__calls.length = 0;
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const save = window.__calls.find((c) => c.method === "PUT");

    return {
      rendered: Boolean(form),
      passwordValue: passwordField ? passwordField.value : null,
      passwordType: passwordField ? passwordField.getAttribute("type") : null,
      secretInMarkup: document.getElementById("inbound-mailbox-panel").innerHTML.includes("hunter"),
      saysUnverified: /unverified/i.test(panelText),
      showsFailure: /Last poll failed/i.test(panelText),
      showsUnrouted: /Cannot pay/.test(panelText),
      savedBody: save ? JSON.parse(save.body) : null
    };
  }, { fns });

  console.log("\n  the inbound mail panel");
  ok("the panel renders", result.rendered);
  ok("the stored password is never put in the page", result.passwordValue === "" && !result.secretInMarkup,
    `field value ${JSON.stringify(result.passwordValue)}`);
  ok("the password field is masked", result.passwordType === "password");
  ok("the panel states that emailed requests are unverified", result.saysUnverified);
  ok("a failing mailbox is reported to the operator", result.showsFailure);
  ok("mail that could not be routed is listed for someone to fix", result.showsUnrouted);

  console.log("\n  saving without retyping the password");
  const body = result.savedBody || {};
  ok("a save happened", Boolean(result.savedBody));
  ok("AN UNTOUCHED PASSWORD IS OMITTED, NOT SENT BLANK",
    !Object.prototype.hasOwnProperty.call(body, "password"),
    `body keys: ${Object.keys(body).join(", ")}`);
  ok("the rest of the settings are still sent", body.host === "imap.titopay.co.za" && body.port === 993,
    `host ${body.host}, port ${body.port}`);
  ok("numbers are sent as numbers, not strings",
    typeof body.port === "number" && typeof body.pollSeconds === "number");
  ok("the toggle is sent as a boolean", typeof body.enabled === "boolean");
  ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));

  await browser.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
