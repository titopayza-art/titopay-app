// End-to-end proof of the Peach Checkout top-up lifecycle against the real API,
// a real Postgres, and the Peach mock.
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const USER = {
  fullName: "Top Up Tester",
  email: `topup${stamp}@titopay.local`,
  phone: `+2782${String(stamp).slice(-7)}`,
  password: "TopUpTester!2026#x",
  accountType: "personal"
};

let token = "";
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "manual"
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (_e) { payload = { raw: text }; }
  return { status: response.status, payload, headers: response.headers };
}

async function peach(path, body, method = "POST") {
  const response = await fetch(`${PEACH}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

async function balance() {
  const { payload } = await call("/wallets");
  return Number((payload.items || [])[0]?.available_balance ?? NaN);
}

async function ledgerCount(reference) {
  const { payload } = await call(`/payments/topup?limit=50`);
  return payload;
}

(async () => {
  console.log("\n==================================================================");
  console.log("  PEACH CHECKOUT TOP-UP — END TO END");
  console.log("==================================================================\n");

  // -- register + sign in ------------------------------------------------
  const reg = await call("/auth/register", { method: "POST", auth: false, body: USER });
  check("customer registered", reg.status === 201, `HTTP ${reg.status}`);
  const login = await call("/auth/login", { method: "POST", auth: false, body: { identifier: USER.email, password: USER.password } });
  token = login.payload.accessToken || "";
  check("customer signed in", Boolean(token), `HTTP ${login.status}`);

  const openingBalance = await balance();
  console.log(`\n  opening wallet balance: R${openingBalance.toFixed(2)}\n`);

  // -- 1. the OLD path must now say something useful ---------------------
  console.log("--- 1. Legacy wallet-debit path rejects top-ups with a clear reason ---");
  const legacy = await call("/transactions", {
    method: "POST",
    body: { serviceCode: "wallet_top_up", amount: 100, recipient: "TitoPay Wallet", idempotencyKey: `legacy-${stamp}` }
  });
  check("legacy top-up not a generic 5xx", legacy.status === 409, `HTTP ${legacy.status}`);
  check("legacy top-up message is actionable",
    /card payment flow/i.test(legacy.payload.error || ""), JSON.stringify(legacy.payload.error));
  check("legacy top-up tells the client where to go",
    legacy.payload.details?.code === "USE_CARD_TOPUP_FLOW", JSON.stringify(legacy.payload.details));

  // -- 2. create the checkout -------------------------------------------
  console.log("\n--- 2. Create a Peach Checkout ---");
  const idem = `topup-${stamp}`;
  const created = await call("/payments/topup", {
    method: "POST",
    headers: { "idempotency-key": idem },
    body: { amount: 250.5, currency: "ZAR", idempotencyKey: idem }
  });
  check("checkout created", created.status === 201, `HTTP ${created.status} ${JSON.stringify(created.payload).slice(0, 200)}`);
  const topup = created.payload;
  check("Peach returned a checkoutId", Boolean(topup.checkoutId), topup.checkoutId || "");
  check("Peach returned a redirectUrl", Boolean(topup.redirectUrl), topup.redirectUrl || "");
  check("transaction starts pending", topup.status === "pending", topup.status);
  check("wallet NOT credited on creation", (await balance()) === openingBalance, `R${(await balance()).toFixed(2)}`);

  // -- 3. idempotent create ---------------------------------------------
  console.log("\n--- 3. Repeat submit does not create a second checkout ---");
  const repeat = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": idem },
    body: { amount: 250.5, currency: "ZAR", idempotencyKey: idem }
  });
  check("repeat returns the original", repeat.payload.transactionId === topup.transactionId, `${repeat.status}`);
  check("repeat flagged as replay", repeat.payload.idempotentReplay === true, String(repeat.payload.idempotentReplay));

  // -- 4. status while still unpaid --------------------------------------
  console.log("\n--- 4. Status before payment stays pending, never failed ---");
  const beforePay = await call(`/payments/topup/${encodeURIComponent(topup.reference)}`);
  check("status still pending", beforePay.payload.status === "pending", beforePay.payload.status);
  check("wallet still not credited", (await balance()) === openingBalance);

  // -- 5. customer pays; Peach now reports success ------------------------
  console.log("\n--- 5. Customer pays on Peach; TitoPay verifies server-side ---");
  await peach("/__complete", { checkoutId: topup.checkoutId, outcome: "successful" });
  const afterPay = await call(`/payments/topup/${encodeURIComponent(topup.reference)}`);
  check("status becomes completed", afterPay.payload.status === "completed", afterPay.payload.status);
  const creditedBalance = await balance();
  check("wallet credited exactly once", Math.abs(creditedBalance - (openingBalance + 250.5)) < 0.005,
    `R${openingBalance.toFixed(2)} -> R${creditedBalance.toFixed(2)}`);

  // -- 6. duplicate everything -------------------------------------------
  console.log("\n--- 6. Duplicate webhooks, polls and returns cannot double-credit ---");
  for (let i = 0; i < 3; i += 1) await call(`/payments/topup/${encodeURIComponent(topup.reference)}`);
  check("3 extra status polls did not credit again", Math.abs((await balance()) - creditedBalance) < 0.005, `R${(await balance()).toFixed(2)}`);

  const hook1 = await peach("/__webhook", { checkoutId: topup.checkoutId });
  const hook2 = await peach("/__webhook", { checkoutId: topup.checkoutId });
  const hook3 = await peach("/__webhook", { checkoutId: topup.checkoutId });
  await new Promise((r) => setTimeout(r, 1500));
  check("webhook 1 acknowledged 200", hook1.delivered?.status === 200, String(hook1.delivered?.status));
  check("webhook 2 acknowledged 200", hook2.delivered?.status === 200, String(hook2.delivered?.status));
  check("webhook 3 acknowledged 200", hook3.delivered?.status === 200, String(hook3.delivered?.status));
  check("3 webhooks did not credit again", Math.abs((await balance()) - creditedBalance) < 0.005, `R${(await balance()).toFixed(2)}`);

  const ret1 = await fetch(`${API}/payments/topup/return`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `merchantTransactionId=${encodeURIComponent(topup.reference)}&checkoutId=${encodeURIComponent(topup.checkoutId)}`,
    redirect: "manual"
  });
  const ret2 = await fetch(`${API}/payments/topup/return`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `merchantTransactionId=${encodeURIComponent(topup.reference)}`,
    redirect: "manual"
  });
  check("browser return redirects (303)", ret1.status === 303, `HTTP ${ret1.status} -> ${ret1.headers.get("location")}`);
  check("repeat browser return also 303", ret2.status === 303, `HTTP ${ret2.status}`);
  check("2 browser returns did not credit again", Math.abs((await balance()) - creditedBalance) < 0.005, `R${(await balance()).toFixed(2)}`);

  // -- 7. a declined payment must not credit ------------------------------
  console.log("\n--- 7. A declined card credits nothing ---");
  const idem2 = `topup-fail-${stamp}`;
  const failCreated = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": idem2 },
    body: { amount: 75, currency: "ZAR", idempotencyKey: idem2 }
  });
  await peach("/__complete", { checkoutId: failCreated.payload.checkoutId, outcome: "failed" });
  const failStatus = await call(`/payments/topup/${encodeURIComponent(failCreated.payload.reference)}`);
  check("declined payment marked failed", failStatus.payload.status === "failed", failStatus.payload.status);
  check("declined payment credited nothing", Math.abs((await balance()) - creditedBalance) < 0.005, `R${(await balance()).toFixed(2)}`);

  // -- 8. a cancelled payment must not credit -----------------------------
  console.log("\n--- 8. A cancelled payment credits nothing ---");
  const idem3 = `topup-cancel-${stamp}`;
  const cancelCreated = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": idem3 },
    body: { amount: 60, currency: "ZAR", idempotencyKey: idem3 }
  });
  await peach("/__complete", { checkoutId: cancelCreated.payload.checkoutId, outcome: "cancelled" });
  const cancelStatus = await call(`/payments/topup/${encodeURIComponent(cancelCreated.payload.reference)}`);
  check("cancelled payment marked cancelled", cancelStatus.payload.status === "cancelled", cancelStatus.payload.status);
  check("cancelled payment credited nothing", Math.abs((await balance()) - creditedBalance) < 0.005);

  // -- 9. a forged webhook must be rejected --------------------------------
  console.log("\n--- 9. An unsigned / forged webhook is rejected and credits nothing ---");
  const forged = await fetch("http://127.0.0.1:8110/v1/webhooks/provider", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `amount=999999.00&currency=ZAR&merchantTransactionId=${encodeURIComponent(cancelCreated.payload.reference)}&result.code=000.100.110`
  });
  check("unsigned webhook rejected 401", forged.status === 401, `HTTP ${forged.status}`);
  check("forged webhook credited nothing", Math.abs((await balance()) - creditedBalance) < 0.005, `R${(await balance()).toFixed(2)}`);

  // -- 10. top-up appears in Activity --------------------------------------
  console.log("\n--- 10. The top-up appears in Activity ---");
  const activity = await call("/transactions");
  const found = (activity.payload.items || []).find((t) => t.reference === topup.reference);
  check("top-up visible in Activity", Boolean(found), found ? `${found.service_code} ${found.status} R${found.amount}` : "not found");
  check("Activity shows it completed", found?.status === "completed", found?.status || "");

  console.log("\n==================================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\n  FAILED:");
    failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`));
  }
  console.log("==================================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error("HARNESS ERROR", error); process.exit(2); });
