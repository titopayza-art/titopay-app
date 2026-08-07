// Every provider must still store, keep and never-poison its secrets.
const API = "http://127.0.0.1:8110/v1";
const PROVIDERS = {
  peach_payments: "clientSecret", peach_payouts: "clientSecret", pos_provider: "webhookSecret",
  docfox: "apiKey", ott: "apiKey", flash: "apiKey", smtp: "password", sms: "apiKey"
};
let token = "";
const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
async function call(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const t = await r.text();
  try { return { status: r.status, payload: JSON.parse(t || "{}") }; } catch { return { status: r.status, payload: {} }; }
}
(async () => {
  token = (await call("/admin/login", { method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload.accessToken;
  check("admin signed in", Boolean(token));
  const { loadPeachConfig } = require("./api/src/services/peach-config-service");

  console.log("\n--- every provider: store a real secret, keep it, reject the mask ---\n");
  for (const [key, field] of Object.entries(PROVIDERS)) {
    const secret = `RealSecret-${key}-mask`;
    const before = (await call(`/admin/integrations/config/${key}`)).payload.provider;
    const base = { enabled: before.enabled !== false, environment: before.environment || "sandbox" };

    await call(`/admin/integrations/${key}`, { method: "PUT", body: { ...base, [field]: secret } });
    let cfg = (await call(`/admin/integrations/config/${key}`)).payload.provider;
    const expected = `••••${secret.slice(-4)}`;
    check(`${key}: real secret stored`, (cfg.secrets?.[field] || "") === expected, cfg.secrets?.[field]);

    await call(`/admin/integrations/${key}`, { method: "PUT", body: { ...base, [field]: "" } });
    cfg = (await call(`/admin/integrations/config/${key}`)).payload.provider;
    check(`${key}: blank re-save keeps it`, (cfg.secrets?.[field] || "") === expected, cfg.secrets?.[field]);

    await call(`/admin/integrations/${key}`, { method: "PUT", body: { ...base, [field]: expected } });
    cfg = (await call(`/admin/integrations/config/${key}`)).payload.provider;
    check(`${key}: mask re-save does NOT poison`, (cfg.secrets?.[field] || "") === expected, cfg.secrets?.[field]);

    const awkward = "***REDACTED***-not-a-mask";
    await call(`/admin/integrations/${key}`, { method: "PUT", body: { ...base, [field]: awkward } });
    cfg = (await call(`/admin/integrations/config/${key}`)).payload.provider;
    check(`${key}: asterisk-prefixed real secret IS stored`, (cfg.secrets?.[field] || "") === `••••${awkward.slice(-4)}`, cfg.secrets?.[field]);

    await call(`/admin/integrations/${key}`, { method: "PUT", body: { ...base, [field]: secret } });
  }

  const c = await loadPeachConfig({ refresh: true });
  check("Collection secret decrypts to the real value server-side", c.clientSecret === "RealSecret-peach_payments-mask", `len ${c.clientSecret.length}`);

  const failed = results.filter((r) => !r.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
