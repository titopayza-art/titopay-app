#!/usr/bin/env node
"use strict";

// Diagnose a Peach Payouts authentication failure from the API server.
//
//   node scripts/diagnose-peach-payout.js
//
// Reads the payout credentials TitoPay actually stored (decrypting them exactly
// as the payout module does), reports their shape without revealing them, then
// calls Peach directly and prints the real status and body.
//
// This deliberately bypasses the TitoPay payout module, so a failure here is
// Peach rejecting the credentials, and a success here with a failing Test
// Connection would be a TitoPay bug.
//
// Nothing is written. No credential is printed.

const { loadPeachPayoutConfig, loadPeachConfig } = require("../src/services/peach-config-service");
const { payoutBaseUrl, AUTH_SERVICE_URLS, OAUTH_TOKEN_PATH } = require("../src/services/peach-payout-service");

function shape(label, value) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  const notes = [];
  if (!trimmed) notes.push("EMPTY");
  if (text !== trimmed) notes.push("HAS SURROUNDING WHITESPACE");
  if (/^•{4}/.test(trimmed)) notes.push("STILL A MASKED PLACEHOLDER — re-enter this field");
  if (/\s/.test(trimmed)) notes.push("CONTAINS A SPACE OR NEWLINE");
  console.log(
    `  ${label.padEnd(14)} length ${String(trimmed.length).padStart(3)}` +
    `  last4 ${trimmed.length > 4 ? trimmed.slice(-4) : "(too short)"}` +
    (notes.length ? `  <-- ${notes.join(", ")}` : "  ok")
  );
  return trimmed;
}

(async () => {
  console.log("\n=================================================================");
  console.log("  PEACH PAYOUT AUTHENTICATION DIAGNOSTIC");
  console.log("=================================================================\n");

  const payout = await loadPeachPayoutConfig({ refresh: true });
  const collection = await loadPeachConfig({ refresh: true });

  console.log(`Environment      : ${payout.environment}`);
  console.log(`Enabled          : ${payout.enabled}`);
  console.log(`Config source    : ${payout.source}`);
  console.log(`Payout base URL  : ${payout.baseUrl || "(not set)"}`);
  try {
    console.log(`Resolved to      : ${payoutBaseUrl(payout)}`);
  } catch (error) {
    console.log(`Resolved to      : INVALID — ${error.message}`);
  }

  console.log("\nStored payout credentials (shape only, never the value):");
  const clientId = shape("clientId", payout.clientId);
  const clientSecret = shape("clientSecret", payout.clientSecret);
  const merchantId = shape("merchantId", payout.merchantId);

  // A very common mix-up: pasting the Checkout credentials into Payout.
  if (clientId && clientId === String(collection.clientId || "").trim()) {
    console.log("\n  !! payout clientId is IDENTICAL to the Collection clientId.");
    console.log("     Payout credentials are created separately in the Peach Dashboard");
    console.log("     under Payouts -> Settings. Checkout credentials will be rejected.");
  }
  if (merchantId && merchantId === String(collection.merchantId || "").trim()) {
    console.log("\n  !! payout merchantId is IDENTICAL to the Collection merchantId.");
    console.log("     Check whether Payouts -> Settings shows a different merchant ID.");
  }

  if (!clientId || !clientSecret || !merchantId) {
    console.log("\nStop: a credential is missing. Re-enter it in Admin and save.\n");
    process.exit(1);
  }

  const authBase = payout.environment === "production" ? AUTH_SERVICE_URLS.production : AUTH_SERVICE_URLS.sandbox;
  const authEndpoint = `${authBase}${OAUTH_TOKEN_PATH}`;
  console.log(`\nCalling Peach directly: POST ${authEndpoint}`);

  let response;
  const startedAt = Date.now();
  try {
    response = await fetch(authEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ clientId, clientSecret, merchantId })
    });
  } catch (error) {
    console.log(`\n  NETWORK FAILURE after ${Date.now() - startedAt}ms: ${error.message}`);
    console.log("  The server could not reach Peach. Check outbound HTTPS/firewall.\n");
    process.exit(2);
  }

  const body = await response.text().catch(() => "");
  console.log(`\n  HTTP ${response.status} in ${Date.now() - startedAt}ms`);
  console.log(`  Body: ${body.slice(0, 400) || "(empty)"}`);

  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; } catch (_error) { payload = {}; }

  if (response.ok && (payload.access_token || payload.accessToken)) {
    console.log("\n  RESULT: Peach ACCEPTED these payout credentials.");
    console.log("  If Admin still shows Failed, the fault is in TitoPay — send me this output.\n");
    process.exit(0);
  }

  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    console.log("\n  RESULT: PEACH-SIDE PROBLEM, not your credentials.");
    console.log("  Peach's own service answered with an error or timed out, so these");
    console.log("  credentials were never actually checked. Wait and run this again.");
    console.log("  If Admin shows Failed with this status, that is Peach being down,");
    console.log("  not a configuration fault.\n");
    process.exit(4);
  }

  console.log("\n  RESULT: Peach REJECTED these payout credentials.");
  console.log("  TitoPay is reporting Peach's answer correctly. Check, in order:");
  console.log("   1. Were they created under Payouts -> Settings (not Checkout)?");
  console.log("   2. For sandbox, were they taken from the SANDBOX Dashboard?");
  console.log("   3. Is Payouts enabled on this merchant account? Ask Peach support if unsure.");
  console.log("   4. Re-copy each value — a trailing space or truncated paste looks the same here.\n");
  process.exit(1);
})().catch((error) => {
  console.error("Diagnostic failed:", error.message);
  process.exit(3);
});
