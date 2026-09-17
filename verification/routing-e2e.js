// Prove each app service reaches the correct Peach capability:
//   Top Up   -> Collection (Checkout V2)
//   Withdraw / Payouts -> Payout capability, and never Checkout.
const API = "http://127.0.0.1:8110/v1";
const stamp = Date.now();
let userToken = "";
let adminToken = "";
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  const t = options.admin ? adminToken : userToken;
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, {
    method: options.method || "GET", headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await r.text();
  try { return { status: r.status, payload: JSON.parse(text || "{}") }; } catch { return { status: r.status, payload: { raw: text } }; }
}

const WITHDRAW_CODES = ["withdraw", "withdraw_money_to_bank", "withdraw_cash", "bank_withdrawal", "cash_withdrawal"];
const PAYOUT_CODES = ["payouts", "business_payout", "merchant_payout", "merchant_payouts", "seller_payout"];
const TOPUP_CODES = ["wallet_top_up", "top_up", "card_topups", "card_payments"];

(async () => {
  console.log("\n===============================================================");
  console.log("  APP SERVICE -> PEACH CAPABILITY ROUTING");
  console.log("===============================================================\n");

  adminToken = (await call("/admin/login", { method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload.accessToken;
  const user = {
    fullName: "Routing Tester", email: `route${stamp}@titopay.local`,
    phone: `+2787${String(stamp).slice(-7)}`, password: "RouteTester!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: user });
  userToken = (await call("/auth/login", { method: "POST", body: { identifier: user.email, password: user.password } })).payload.accessToken;
  check("test accounts ready", Boolean(adminToken && userToken));

  // ---------------------------------------------------------------- TOP UP
  console.log("\n--- TOP UP must reach Peach COLLECTION (Checkout V2) ---");
  const topup = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": `route-${stamp}` },
    body: { amount: 120, currency: "ZAR", idempotencyKey: `route-${stamp}` }
  });
  check("top-up created a Peach checkout", topup.status === 201 && Boolean(topup.payload.checkoutId), `HTTP ${topup.status}`);
  check("top-up redirect points at the CHECKOUT host (4400)",
    String(topup.payload.redirectUrl || "").includes("127.0.0.1:4400"), topup.payload.redirectUrl);
  check("top-up did NOT touch the payout host (4401)",
    !String(topup.payload.redirectUrl || "").includes("4401"), topup.payload.redirectUrl);

  for (const code of TOPUP_CODES) {
    const r = await call("/transactions", { method: "POST", body: { serviceCode: code, amount: 50, recipient: "TitoPay Wallet", idempotencyKey: `${code}-${stamp}` } });
    check(`"${code}" is routed to the card top-up flow`, r.payload.details?.code === "USE_CARD_TOPUP_FLOW", `HTTP ${r.status} ${r.payload.error}`);
  }

  // ------------------------------------------------------------- WITHDRAW
  console.log("\n--- WITHDRAW / PAYOUT must consult the Peach PAYOUT capability ---");

  // Payout capability currently connected in this environment.
  const payoutCfg = await call("/admin/integrations/config/peach_payouts", { admin: true });
  console.log(`  (payout capability health: ${payoutCfg.payload.provider?.health?.status})`);

  for (const code of [...WITHDRAW_CODES, ...PAYOUT_CODES]) {
    const preview = await call("/transactions/fee-preview", { method: "POST", body: { serviceCode: code, amount: 100 } });
    const confirm = await call("/transactions", { method: "POST", body: { serviceCode: code, amount: 100, recipient: "Bank", idempotencyKey: `${code}-${stamp}` } });
    // Blocked at PREVIEW in both states — a connected provider does not open
    // withdrawals on its own.
    const message = String(preview.payload.error || confirm.payload.error || "");
    check(`"${code}" blocked at fee preview`, preview.status === 503, `preview HTTP ${preview.status}`);
    check(`"${code}" says no wallet debit was made`, /No wallet debit was made/i.test(message), message.slice(0, 80));
  }

  // ---- disable the payout capability: withdrawals must follow it ---------
  console.log("\n--- Disabling the PAYOUT capability disables withdrawals ---");
  await call("/admin/integrations/peach_payouts/disable", { method: "POST", admin: true, body: {} });
  const disabledPreview = await call("/transactions/fee-preview", { method: "POST", body: { serviceCode: "withdraw", amount: 100 } });
  check("withdraw blocked while payout is disabled", disabledPreview.status === 503, `HTTP ${disabledPreview.status}`);
  check("message reflects the payout capability", /disabled|not configured|verified/i.test(String(disabledPreview.payload.error || "")), disabledPreview.payload.error);

  // ---- collection must be completely unaffected --------------------------
  const collectionTest = await call("/admin/integrations/peach_payments/test", { method: "POST", admin: true, body: {} });
  check("COLLECTION still connected while payout is disabled", collectionTest.payload.result?.status === "connected", collectionTest.payload.result?.status);
  const topup2 = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": `route2-${stamp}` },
    body: { amount: 75, currency: "ZAR", idempotencyKey: `route2-${stamp}` }
  });
  check("TOP UP still works while payout is disabled", topup2.status === 201 && Boolean(topup2.payload.checkoutId), `HTTP ${topup2.status}`);

  // ---- restore ----------------------------------------------------------
  await call("/admin/integrations/peach_payouts", {
    method: "PUT", admin: true,
    body: {
      enabled: true, environment: "sandbox", baseUrl: "http://127.0.0.1:4401/api",
      clientId: "payout-client-id", clientSecret: "payout-secret-value-XYZ9", merchantId: "payout-merchant-id"
    }
  });
  await call("/admin/integrations/peach_payouts/test", { method: "POST", admin: true, body: {} });

  // ---- unrelated wallet services still work ------------------------------
  console.log("\n--- Unrelated services unchanged ---");
  const transfer = await call("/transactions/fee-preview", { method: "POST", body: { serviceCode: "wallet_transfer", amount: 100 } });
  check("wallet transfer preview still works", transfer.status === 200, `HTTP ${transfer.status}`);
  const qr = await call("/transactions/fee-preview", { method: "POST", body: { serviceCode: "qr_payment", amount: 50 } });
  check("QR payment preview still works", qr.status === 200, `HTTP ${qr.status}`);
  const airtime = await call("/transactions/fee-preview", { method: "POST", body: { serviceCode: "airtime", amount: 50 } });
  check("airtime still blocked by its own provider gate", airtime.status === 503, `HTTP ${airtime.status}`);

  console.log("\n===============================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("===============================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
