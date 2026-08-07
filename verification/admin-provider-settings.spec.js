// The exact page from the screenshot: Platform / API Provider Settings.
const { chromium } = require("playwright");
const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";
const results = [];
function check(n, p, d = "") { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); }
async function api(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}
(async () => {
  console.log("\n=============================================================");
  console.log("  ADMIN -> Platform / API Provider Settings");
  console.log("=============================================================\n");
  const login = await api("/admin/login", { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" });
  const token = login.payload.accessToken, refresh = login.payload.refreshToken;
  check("admin signed in", Boolean(token));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext();
  await ctx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({ accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now() })), [token, refresh]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${ADMIN}/api-provider-settings/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500);

  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  check("page rendered", /Peach Payments/i.test(text), text.slice(0, 90));

  // Only ONE Peach card, not two.
  const headings = await page.evaluate(() => Array.from(document.querySelectorAll(".integration-card h3")).map((h) => h.textContent.trim()));
  check("one Peach card, not a duplicate", headings.filter((h) => /Peach/i.test(h)).length === 1, JSON.stringify(headings.filter((h) => /Peach/i.test(h))));

  // Both capability statuses shown on that card.
  const chips = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".integration-card")).find((c) => /Peach/i.test(c.querySelector("h3")?.textContent || ""));
    return {
      parent: card.querySelector(".integration-card-header .chip")?.textContent.trim(),
      caps: Array.from(card.querySelectorAll(".integration-status-strip .chip")).map((c) => c.textContent.trim()),
      summaries: Array.from(card.querySelectorAll("details summary")).map((s) => s.textContent.trim()),
      forms: Array.from(card.querySelectorAll(".integration-form")).map((f) => f.dataset.provider),
      tests: Array.from(card.querySelectorAll("[data-integration-test]")).map((b) => b.dataset.integrationTest)
    };
  });
  check("Collection status shown", chips.caps[0] === "Connected", JSON.stringify(chips.caps));
  check("Payout status shown separately", chips.caps[1] === "Not Configured", JSON.stringify(chips.caps));
  check("parent card reads Partially configured", chips.parent === "Partially configured", chips.parent);

  check("a Configure panel per capability", chips.summaries.length === 2, JSON.stringify(chips.summaries));
  check("Collection configure panel", chips.summaries.some((s) => /Collection/i.test(s)), JSON.stringify(chips.summaries));
  check("Payout configure panel", chips.summaries.some((s) => /Payout/i.test(s)), JSON.stringify(chips.summaries));
  check("two forms, one per capability", chips.forms.join(",") === "peach_payments,peach_payouts", JSON.stringify(chips.forms));
  check("a Test Connection button for EACH capability", chips.tests.includes("peach_payments") && chips.tests.includes("peach_payouts"), JSON.stringify(chips.tests));

  // Payout form must carry its own fields.
  const payoutFields = await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll(".integration-form")).find((x) => x.dataset.provider === "peach_payouts");
    return f ? Array.from(f.querySelectorAll("[name]")).map((i) => i.name) : [];
  });
  for (const field of ["baseUrl", "clientId", "clientSecret", "merchantId", "environment"]) {
    check(`payout form has ${field}`, payoutFields.includes(field), JSON.stringify(payoutFields));
  }

  // Test payout right here on this page.
  await page.click('[data-integration-test="peach_payouts"]');
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".integration-card")).find((c) => /Peach/i.test(c.querySelector("h3")?.textContent || ""));
    return Array.from(card.querySelectorAll(".integration-status-strip .chip")).map((c) => c.textContent.trim());
  });
  check("payout Test Connection works from this page", after.length === 2, JSON.stringify(after));
  check("Collection unaffected by the payout test", after[0] === "Connected", JSON.stringify(after));

  await page.screenshot({ path: "admin-api-provider-settings.png", fullPage: false });
  const real = errors.filter((e) => !/favicon|manifest|404|Failed to load resource|frame-ancestors/i.test(e));
  check("no JavaScript errors", real.length === 0, real.slice(0, 2).join(" | "));
  await browser.close();

  const failed = results.filter((r) => !r.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
