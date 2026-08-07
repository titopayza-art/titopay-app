// Drive the real Admin Portal bundle in Chromium and verify the Peach card
// shows two independent capabilities.
const { chromium } = require("playwright");
const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function api(path, body, token, method) {
  const r = await fetch(`${API}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log("\n===============================================================");
  console.log("  ADMIN PORTAL — PEACH COLLECTION + PAYOUT SECTIONS");
  console.log("===============================================================\n");

  const login = await api("/admin/login", { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" });
  const token = login.payload.accessToken;
  const refresh = login.payload.refreshToken;
  check("admin signed in", Boolean(token));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const context = await browser.newContext();
  // Seed the admin session before any page script runs, otherwise the console
  // bounces to the login screen first.
  await context.addInitScript(([t, r]) => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: t, refreshToken: r, role: "super_admin", scope: "admin",
      clientLastSeenAt: Date.now()
    }));
  }, [token, refresh]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${ADMIN}/integrations/peach-payments/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500);

  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  const loaded = /Peach Payments/i.test(text);
  check("Peach Payments page rendered", loaded, text.slice(0, 120));

  check("shows a Collection / Top-up section", /Collection \/ Top-?up/i.test(text));
  check("shows a Payout / Withdrawal section", /Payout \/ Withdrawal/i.test(text));

  // Two independent forms, each posting to its own provider key.
  const forms = await page.evaluate(() => Array.from(document.querySelectorAll(".integration-form")).map((f) => f.dataset.provider));
  check("two independent capability forms", forms.length === 2, JSON.stringify(forms));
  check("collection form targets peach_payments", forms.includes("peach_payments"));
  check("payout form targets peach_payouts", forms.includes("peach_payouts"));

  const testButtons = await page.evaluate(() => Array.from(document.querySelectorAll("[data-integration-test]")).map((b) => b.dataset.integrationTest));
  check("separate Test Connection buttons", testButtons.includes("peach_payments") && testButtons.includes("peach_payouts"), JSON.stringify(testButtons));

  // Payout form must expose its own credential fields.
  const payoutFields = await page.evaluate(() => {
    const form = Array.from(document.querySelectorAll(".integration-form")).find((f) => f.dataset.provider === "peach_payouts");
    return form ? Array.from(form.querySelectorAll("[name]")).map((i) => i.name) : [];
  });
  for (const field of ["baseUrl", "clientId", "clientSecret", "merchantId", "environment"]) {
    check(`payout form has its own ${field}`, payoutFields.includes(field), JSON.stringify(payoutFields));
  }

  // Statuses shown independently.
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll(".integration-status-strip .chip")).map((c) => c.textContent.trim()));
  check("capability status chips rendered", chips.length === 2, JSON.stringify(chips));
  check("Collection shows Connected", chips[0] === "Connected", chips[0]);
  check("Payout shows Not Configured", chips[1] === "Not Configured", chips[1]);
  check("Payout is NOT shown as Connected", chips[1] !== "Connected");

  // No secret in the DOM.
  const html = await page.content();
  check("no collection secret in the DOM", !html.includes("titopay-sandbox-client-secret"));
  check("no payout secret in the DOM", !html.includes("payout-secret-value-XYZ9"));
  check("collection secret shown masked", /••••/.test(html));

  await page.screenshot({ path: "admin-peach-split.png", fullPage: true });

  // Configure payout through the UI and confirm Collection is untouched.
  console.log("\n  --- configuring Payout through the Admin form ---");
  await page.evaluate(() => {
    const form = Array.from(document.querySelectorAll(".integration-form")).find((f) => f.dataset.provider === "peach_payouts");
    form.querySelector('[name="baseUrl"]').value = "http://127.0.0.1:4401/api";
    form.querySelector('[name="clientId"]').value = "payout-client-id";
    form.querySelector('[name="clientSecret"]').value = "payout-secret-value-XYZ9";
    form.querySelector('[name="merchantId"]').value = "payout-merchant-id";
    const enabled = form.querySelector('[name="enabled"]');
    if (enabled && !enabled.checked) enabled.click();
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  });
  await page.waitForTimeout(4000);

  const collection = await api("/admin/integrations/config/peach_payments", null, token);
  check("Collection credentials survived the payout save",
    collection.payload.provider?.clientId === "titopay-sandbox-client-id",
    collection.payload.provider?.clientId);
  const collectionTest = await api("/admin/integrations/peach_payments/test", {}, token);
  check("Collection still CONNECTED after payout save", collectionTest.payload.result?.status === "connected", collectionTest.payload.result?.status);

  const payoutCfg = await api("/admin/integrations/config/peach_payouts", null, token);
  check("Payout saved from the Admin form", payoutCfg.payload.provider?.clientId === "payout-client-id", payoutCfg.payload.provider?.clientId);

  // Test Connection button for payout.
  await page.goto(`${ADMIN}/integrations/peach-payments/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.click('[data-integration-test="peach_payouts"]');
  // The click handler re-renders twice on this path (Integration Centre then the
  // provider page), so poll for the settled state rather than guessing a delay.
  let chipsAfter = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(1500);
    chipsAfter = await page.evaluate(() => Array.from(document.querySelectorAll(".integration-status-strip .chip")).map((c) => c.textContent.trim()));
    if (chipsAfter[1] === "Connected") break;
  }
  check("Payout now shows Connected", chipsAfter[1] === "Connected", JSON.stringify(chipsAfter));
  check("Collection still shows Connected", chipsAfter[0] === "Connected", JSON.stringify(chipsAfter));

  await page.screenshot({ path: "admin-peach-both-connected.png", fullPage: true });

  const realErrors = errors.filter((e) => !/favicon|manifest|404|Failed to load resource|frame-ancestors/i.test(e));
  check("no JavaScript errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

  await browser.close();
  console.log("\n===============================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("===============================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
