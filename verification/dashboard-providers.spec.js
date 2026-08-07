// The dashboard Platform-health provider tile must agree with the Integration Centre.
const { chromium } = require("playwright");
const ADMIN = "http://127.0.0.1:8020", API = "http://127.0.0.1:8110/v1";
const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
async function api(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}
(async () => {
  console.log("\n===========================================================");
  console.log("  DASHBOARD -> Platform health -> Providers tile");
  console.log("===========================================================\n");
  const login = await api("/admin/login", { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" });
  const token = login.payload.accessToken, refresh = login.payload.refreshToken;
  check("admin signed in", Boolean(token));

  // Make Peach Collection connected so there is something to count.
  await api("/admin/integrations/peach_payments/test", {}, token);
  const cfg = await api("/admin/integrations/config", null, token);
  const provs = cfg.payload.providers || [];
  const expectedTotal = provs.length;
  const expectedLive = provs.filter((p) => ["connected", "ready"].includes(p.health?.status)).length;
  console.log(`  API reports ${expectedLive} connected/ready of ${expectedTotal} providers\n`);
  check("at least one provider is genuinely connected", expectedLive >= 1, String(expectedLive));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext();
  await ctx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({ accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now() })), [token, refresh]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${ADMIN}/dashboard/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(6000);

  const tile = await page.evaluate(() => {
    const host = document.getElementById("dashboard-health");
    if (!host) return null;
    const rows = Array.from(host.children).map((r) => r.innerText.replace(/\s+/g, " ").trim());
    return rows.find((r) => /Providers/i.test(r)) || rows.join(" | ");
  });
  check("Providers tile rendered", Boolean(tile), tile);
  check(`tile reads "${expectedLive} of ${expectedTotal} active"`,
    new RegExp(`${expectedLive}\\s+of\\s+${expectedTotal}\\s+active`, "i").test(tile || ""), tile);
  check("tile is NOT stuck at 0", !/\b0 of \d+ active/i.test(tile || ""), tile);

  // Cross-check against the Integration Centre's own counter.
  await page.goto(`${ADMIN}/integrations/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  const centre = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".metric-card")).map((c) => c.innerText.replace(/\s+/g, " ").trim());
    return cards.find((c) => /Connected \/ Ready/i.test(c)) || cards.join(" | ");
  });
  check("Integration Centre agrees", new RegExp(`\\b${expectedLive}\\b`).test(centre || ""), centre);

  await page.goto(`${ADMIN}/dashboard/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "admin-dashboard-providers.png", fullPage: false });
  check("no JavaScript errors", errors.filter((e) => !/favicon|manifest|404/i.test(e)).length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();

  const failed = results.filter((r) => !r.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
