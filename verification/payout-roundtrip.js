// Save payout credentials exactly as the Admin form does, then read them back
// through the same loader the payout module uses. Byte-for-byte comparison.
const API = "http://127.0.0.1:8110/v1";
const CREDS = {
  clientId:     "PayoutClientID-ABC123xyz",
  clientSecret: "PayoutSecret!#$%^&*()_+-=[]{}|;:,.<>?/~`\"'\\SECRET",
  merchantId:   "8ac7a4c9-1234-5678-9abc-def012345678"
};
(async () => {
  const login = await (await fetch(`${API}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }) })).json();
  const token = login.accessToken;
  const H = { "content-type": "application/json", authorization: `Bearer ${token}` };

  console.log("\n--- 1. Save through the Admin endpoint (exactly what the form posts) ---");
  const save = await fetch(`${API}/admin/integrations/peach_payouts`, {
    method: "PUT", headers: H,
    body: JSON.stringify({ enabled: true, environment: "sandbox", baseUrl: "https://sandbox-payouts.peachpayments.com", ...CREDS })
  });
  console.log("   HTTP", save.status);

  console.log("\n--- 2. Read back through loadPeachPayoutConfig (what the payout module uses) ---");
  const { loadPeachPayoutConfig } = require("./api/src/services/peach-config-service");
  const cfg = await loadPeachPayoutConfig({ refresh: true });
  const cmp = (name, sent, got) => {
    const ok = sent === got;
    console.log(`   ${ok ? "MATCH  " : "DIFFER "} ${name.padEnd(13)} sent len=${sent.length} got len=${String(got).length}${ok ? "" : `\n            sent: ${JSON.stringify(sent)}\n            got : ${JSON.stringify(got)}`}`);
    return ok;
  };
  const a = cmp("clientId", CREDS.clientId, cfg.clientId);
  const b = cmp("clientSecret", CREDS.clientSecret, cfg.clientSecret);
  const c = cmp("merchantId", CREDS.merchantId, cfg.merchantId);
  console.log(`   baseUrl stored: ${JSON.stringify(cfg.baseUrl)}`);

  console.log("\n--- 3. The exact JSON body that would go to Peach ---");
  const body = JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, merchantId: cfg.merchantId });
  console.log("   " + body.replace(cfg.clientSecret, "<secret len=" + cfg.clientSecret.length + ">"));

  console.log("\n--- 4. Re-save with the secret field BLANK (the masked-placeholder case) ---");
  await fetch(`${API}/admin/integrations/peach_payouts`, {
    method: "PUT", headers: H,
    body: JSON.stringify({ enabled: true, environment: "sandbox", baseUrl: "https://sandbox-payouts.peachpayments.com", clientId: CREDS.clientId, merchantId: CREDS.merchantId, clientSecret: "" })
  });
  const cfg2 = await loadPeachPayoutConfig({ refresh: true });
  const kept = cfg2.clientSecret === CREDS.clientSecret;
  console.log(`   ${kept ? "KEPT   " : "LOST   "} secret survived a blank re-save (len ${cfg2.clientSecret.length})`);

  console.log("\n--- 5. Re-save posting the MASKED value back (browser autofill case) ---");
  await fetch(`${API}/admin/integrations/peach_payouts`, {
    method: "PUT", headers: H,
    body: JSON.stringify({ enabled: true, environment: "sandbox", baseUrl: "https://sandbox-payouts.peachpayments.com", clientId: CREDS.clientId, merchantId: CREDS.merchantId, clientSecret: "••••CRET" })
  });
  const cfg3 = await loadPeachPayoutConfig({ refresh: true });
  const poisoned = cfg3.clientSecret !== CREDS.clientSecret;
  console.log(`   ${poisoned ? "POISONED <-- BUG" : "SAFE   "} secret after posting a masked placeholder (len ${cfg3.clientSecret.length}, value ${JSON.stringify(cfg3.clientSecret.slice(0, 12))})`);

  console.log(`\n   RESULT: read path faithful = ${a && b && c}, blank-save safe = ${kept}, masked-save safe = ${!poisoned}\n`);
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
