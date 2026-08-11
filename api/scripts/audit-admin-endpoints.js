"use strict";

const API_BASE = (process.env.API_BASE || "https://api.titopay.co.za/v1").replace(/\/+$/, "");
const TOKEN = process.env.ADMIN_ACCESS_TOKEN || process.env.TITOPAY_ADMIN_TOKEN || "";

const ENDPOINTS = [
  "/admin/me",
  "/admin/dashboard/overview",
  "/admin/users",
  "/admin/wallets",
  "/admin/chat-monitor/overview",
  "/admin/global-search",
  "/pricing",
  "/admin/transactions",
  "/admin/merchants",
  "/admin/module-health",
  "/admin/support/tickets",
  "/admin/support/conversations",
  "/admin/compliance/queue",
  "/admin/revenue",
  "/admin/security",
  "/admin/security-summary",
  "/admin/integrations/config",
  "/admin/integrations/health",
  "/admin/integrations/logs",
  "/admin/integrations/webhooks",
  "/admin/provider-routing",
  "/admin/features",
  "/admin/company-documents",
  "/admin/marketing/sms-campaigns",
  "/admin/audit",
  "/admin/roles"
];

async function testEndpoint(path) {
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
    }
  });
  const body = await response.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch (_error) {
    json = null;
  }
  return {
    path,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    requestId: json?.requestId || response.headers.get("x-request-id") || null,
    error: json?.error || null,
    bodyPreview: body.slice(0, 240)
  };
}

async function main() {
  if (!TOKEN) {
    console.warn("ADMIN_ACCESS_TOKEN is not set. Protected routes will return 401.");
  }
  console.log(`Auditing TitoPay Admin API at ${API_BASE}`);
  const results = [];
  for (const endpoint of ENDPOINTS) {
    try {
      const result = await testEndpoint(endpoint);
      results.push(result);
      const marker = result.status >= 500 ? "FAIL" : result.ok ? "OK" : "WARN";
      console.log(`${marker} ${result.status} ${String(result.durationMs).padStart(4)}ms ${endpoint}${result.error ? ` - ${result.error}` : ""}`);
    } catch (error) {
      const result = {
        path: endpoint,
        status: 0,
        ok: false,
        durationMs: 0,
        error: error.message
      };
      results.push(result);
      console.log(`FAIL 000 ----ms ${endpoint} - ${error.message}`);
    }
  }
  const failed500 = results.filter((item) => item.status >= 500);
  if (failed500.length) {
    console.error("\nHTTP 500 endpoints:");
    for (const item of failed500) {
      console.error(JSON.stringify(item, null, 2));
    }
    process.exit(1);
  }
  console.log("\nAdmin API audit complete. No HTTP 500 responses detected.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
