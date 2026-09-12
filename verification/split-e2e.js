// Prove Collection and Payout are two independent Peach capabilities.
const API = "http://127.0.0.1:8110/v1";
let token = "";
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, {
    method: options.method || "GET", headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const t = await r.text();
  try { return { status: r.status, payload: JSON.parse(t || "{}") }; } catch { return { status: r.status, payload: { raw: t } }; }
}
const cfg = async (key) => (await call(`/admin/integrations/config/${key}`)).payload.provider;
const test = async (key) => (await call(`/admin/integrations/${key}/test`, { method: "POST", body: {} })).payload.result;

(async () => {
  console.log("\n================================================================");
  console.log("  PEACH COLLECTION vs PAYOUT — INDEPENDENCE");
  console.log("================================================================\n");

  token = (await call("/admin/login", { method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload.accessToken;
  check("admin signed in", Boolean(token));

  // ---- 1. both capabilities exist and are separate ----------------------
  console.log("\n--- 1. Two capabilities, one Peach group ---");
  const collection = await cfg("peach_payments");
  const payout = await cfg("peach_payouts");
  check("collection capability present", collection?.capability === "collection", collection?.capabilityLabel);
  check("payout capability present", payout?.capability === "payout", payout?.capabilityLabel);
  check("both grouped under Peach Payments",
    collection?.peachGroup === "peach_payments" && payout?.peachGroup === "peach_payments");
  check("payout advertises the documented sandbox endpoint",
    payout?.defaultBaseUrl === "https://sandbox-payouts.peachpayments.com/api", payout?.defaultBaseUrl);
  check("payout is not routing-eligible",
    !(await call("/admin/provider-routing")).payload.providers?.some((p) => p.key === "peach_payouts"));

  // ---- 2. collection still connected ------------------------------------
  console.log("\n--- 2. Collection is untouched and still CONNECTED ---");
  const collectionTest = await test("peach_payments");
  check("collection Test Connection = connected", collectionTest.status === "connected", collectionTest.status);
  check("collection issued a real access token", collectionTest.providerResponse?.accessTokenIssued === true);
  check("collection credentials preserved",
    collection.clientId === "titopay-sandbox-client-id" && collection.merchantId === "titopay-sandbox-merchant-id",
    `${collection.clientId} / ${collection.merchantId}`);
  check("collection client secret still masked, never returned",
    /^••••/.test(collection.secrets?.clientSecret || ""), collection.secrets?.clientSecret);

  // ---- 3. payout unconfigured -------------------------------------------
  console.log("\n--- 3. Payout is NOT connected just because Collection is ---");
  const payoutTest = await test("peach_payouts");
  check("payout status is not_configured", payoutTest.status === "not_configured", payoutTest.status);
  check("payout reports PAYOUT_NOT_CONFIGURED", payoutTest.errorMessage?.includes("not configured"), payoutTest.errorMessage);
  check("payout did NOT report connected", payoutTest.status !== "connected");

  // ---- 4. configure payout with its OWN credentials ----------------------
  console.log("\n--- 4. Configure payout independently ---");
  const saved = await call("/admin/integrations/peach_payouts", {
    method: "PUT",
    body: {
      enabled: true, environment: "sandbox",
      baseUrl: "http://127.0.0.1:4401/api",
      clientId: "payout-client-id", clientSecret: "payout-secret-value-XYZ9", merchantId: "payout-merchant-id"
    }
  });
  check("payout configuration saved", saved.status === 200, `HTTP ${saved.status}`);

  const collectionAfter = await cfg("peach_payments");
  check("COLLECTION CREDENTIALS UNTOUCHED after saving payout",
    collectionAfter.clientId === "titopay-sandbox-client-id" && collectionAfter.merchantId === "titopay-sandbox-merchant-id",
    `${collectionAfter.clientId} / ${collectionAfter.merchantId}`);
  const collectionStillWorks = await test("peach_payments");
  check("collection STILL CONNECTED after saving payout", collectionStillWorks.status === "connected", collectionStillWorks.status);

  const payoutAfter = await cfg("peach_payouts");
  check("payout stored its own client id", payoutAfter.clientId === "payout-client-id", payoutAfter.clientId);
  check("payout stored its own merchant id", payoutAfter.merchantId === "payout-merchant-id", payoutAfter.merchantId);
  check("payout secret masked, never returned", /^••••/.test(payoutAfter.secrets?.clientSecret || ""), payoutAfter.secrets?.clientSecret);
  check("payout client secret is NOT the collection secret",
    payoutAfter.secrets?.clientSecret !== collectionAfter.secrets?.clientSecret,
    `${payoutAfter.secrets?.clientSecret} vs ${collectionAfter.secrets?.clientSecret}`);

  // ---- 5. payout test hits the PAYOUT endpoint ---------------------------
  console.log("\n--- 5. Payout Test Connection uses the payout endpoint only ---");
  const payoutTest2 = await test("peach_payouts");
  check("payout test now attempts a real call", payoutTest2.status !== "not_configured", payoutTest2.status);
  check("payout test targeted the payout base URL",
    String(payoutTest2.providerResponse?.endpoint || "").includes("127.0.0.1:4401"), payoutTest2.providerResponse?.endpoint);
  check("payout test did NOT touch the checkout host",
    !String(payoutTest2.providerResponse?.endpoint || "").includes("4400"), payoutTest2.providerResponse?.endpoint);
  check("payout Test Connection = connected against the payout provider", payoutTest2.status === "connected", payoutTest2.status);
  check("payout issued its OWN access token", payoutTest2.providerResponse?.accessTokenIssued === true);

  // ---- 6. statuses are independent --------------------------------------
  console.log("\n--- 6. Independent statuses ---");
  const c = await cfg("peach_payments");
  const p = await cfg("peach_payouts");
  check("collection health = connected", c.health?.status === "connected", c.health?.status);
  check("payout health = connected (its own, independent test)", p.health?.status === "connected", p.health?.status);
  check("each capability has its own health record", c.health?.lastTestedAt !== p.health?.lastTestedAt);

  // ---- 7. saving collection must not wipe payout -------------------------
  console.log("\n--- 7. Saving Collection does not overwrite Payout ---");
  await call("/admin/integrations/peach_payments", {
    method: "PUT",
    body: {
      enabled: true, environment: "sandbox",
      clientId: "titopay-sandbox-client-id", merchantId: "titopay-sandbox-merchant-id",
      entityId: "8ac7a4c88b1e4a5a018b1e6f2c0a0001", callbackUrl: "http://127.0.0.1:8110/v1/webhooks/provider"
    }
  });
  const payoutStill = await cfg("peach_payouts");
  check("PAYOUT CONFIG SURVIVED a collection save",
    payoutStill.clientId === "payout-client-id" && payoutStill.baseUrl === "http://127.0.0.1:4401/api",
    `${payoutStill.clientId} / ${payoutStill.baseUrl}`);
  check("payout secret survived", /^••••/.test(payoutStill.secrets?.clientSecret || ""));
  const collectionFinal = await test("peach_payments");
  check("collection connected after re-save (secret kept when left blank)", collectionFinal.status === "connected", collectionFinal.status);

  // ---- 8. no secrets anywhere in admin responses -------------------------
  console.log("\n--- 8. No secret ever reaches the browser ---");
  const listing = await call("/admin/integrations/config");
  const blob = JSON.stringify(listing.payload) + JSON.stringify(c) + JSON.stringify(p);
  check("collection secret absent", !blob.includes("titopay-sandbox-client-secret"));
  check("payout secret absent", !blob.includes("payout-secret-value-XYZ9"));
  check("no access token leaked", !/local\.checkout\.access\.token/.test(blob));

  console.log("\n================================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("================================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
