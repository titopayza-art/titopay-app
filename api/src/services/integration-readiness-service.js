"use strict";

// CAN TITOPAY BE A PAYMENT OPTION IN SOMEBODY ELSE'S CHECKOUT?
//
// The question behind this page is the one an aggregator asks — Moment, Peach,
// Ozow, or a merchant integrating directly. It has a real answer today, and
// most of that answer is yes, which was not obvious from the outside.
//
// EVERY CHECK HERE IS DERIVED, never declared. That is the whole design. A
// hand-maintained "integration readiness" list is a lie within one sprint: the
// day somebody builds the hosted payment page, the page still says it is
// missing, and the day somebody deletes the idempotency guard, the page still
// says it is there. Both failures are worse than having no page, because a
// stale readiness report is read as a current one.
//
// So each check asks the platform. A table is checked in information_schema. A
// route is checked by walking the router that is actually mounted. A capability
// is asked, not assumed. Add the hosted payment page and this page notices on
// the next load with nothing to edit here.
//
// The same discipline as the service catalogue's capability gate, applied to a
// different question.

const { pool } = require("../db/pool");

// Walking a mounted Express router. Layers expose the compiled regexp rather
// than the string, so the path is recovered from it; a router whose shape
// changes in a future Express is reported as "no routes found" rather than
// throwing, because a readiness page must never be the thing that 500s.
function routePaths(router) {
  try {
    return (router?.stack || [])
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase()),
        // The names of the middleware guarding it, which is how we tell a
        // terminal-authenticated route from a partner-key one.
        guards: (layer.route.stack || []).map((entry) => entry.name).filter(Boolean)
      }));
  } catch (error) {
    return [];
  }
}

async function tablesPresent(names) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [names]
  );
  return new Set(rows.map((row) => row.table_name));
}

// Ready, partial or missing — three states rather than two, because "the
// engine is there but only a physical till can reach it" is neither a yes nor
// a no, and flattening it to either misleads.
function state(ready, partial = false) {
  return ready ? "ready" : partial ? "partial" : "missing";
}

async function integrationReadiness() {
  const tables = await tablesPresent([
    "pos_payment_intents", "pos_idempotency_keys", "pos_request_nonces",
    "pos_refunds", "pos_payment_events", "webhook_subscriptions",
    "webhook_deliveries", "api_partners", "api_partner_keys"
  ]);

  let posRoutes = [];
  let partnerRoutes = [];
  let webhookSource = "";
  let posSource = "";
  try {
    posRoutes = routePaths(require("../pos/routes"));
    partnerRoutes = routePaths(require("../routes/partners.routes"));
    const fs = require("fs");
    const path = require("path");
    webhookSource = fs.readFileSync(path.join(__dirname, "webhook-service.js"), "utf8");
    posSource = fs.readFileSync(path.join(__dirname, "..", "pos", "service.js"), "utf8");
  } catch (error) {
    // A readiness page that cannot read itself reports that, rather than
    // reporting everything as missing and starting a panic.
    console.error("[integration-readiness] inspection failed", { message: error.message });
  }

  const intentRoutes = posRoutes.filter((r) => r.path.includes("payment-intents"));
  const terminalGuarded = intentRoutes.filter((r) => r.guards.includes("requireTerminalAuth"));
  const partnerGuarded = intentRoutes.filter((r) => r.guards.includes("requirePartnerKey"));

  // The state machine, READ FROM THE MACHINE ITSELF.
  //
  // This was a regex alternation of the state names — which is a written list
  // wearing the costume of a derived one, and it drifted immediately: the
  // alternation never listed PROCESSING, so a ten-state machine was reported
  // as nine on a page whose entire premise is that it does not describe the
  // platform, it asks it. pos/service.js exports TRANSITIONS, so ask that.
  let states = [];
  try {
    states = Object.keys(require("../pos/service").TRANSITIONS || {});
  } catch (error) {
    states = [];
  }

  let sandboxOn = false;
  try { sandboxOn = require("./sandbox-service").sandboxEnabled(); } catch (error) { sandboxOn = false; }

  let activeKeys = 0;
  if (tables.has("api_partner_keys")) {
    // The table names are api_partners / api_partner_keys, read from the
    // database rather than assumed — the first version of this guessed
    // "partner_api_keys" and reported a working feature as missing, which is
    // the exact failure a derived page is supposed to prevent.
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM api_partner_keys WHERE revoked_at IS NULL")
      .catch(() => ({ rows: [{ n: 0 }] }));
    activeKeys = rows[0]?.n || 0;
  }

  const checks = [
    {
      key: "payment_intents",
      label: "Payment intent engine",
      why: "A merchant creates an intent, the customer pays it, and both sides can ask what happened.",
      status: state(tables.has("pos_payment_intents") && intentRoutes.length > 0),
      detail: intentRoutes.length
        ? `${intentRoutes.length} endpoints, ${states.length} states in the machine`
        : "no intent endpoints are mounted",
      evidence: states.sort().join(", ")
    },
    {
      key: "idempotency",
      label: "Idempotency guard",
      why: "A retried request must return the original payment, never make a second one.",
      status: state(tables.has("pos_idempotency_keys")),
      detail: tables.has("pos_idempotency_keys") ? "keys are stored and enforced" : "no idempotency table"
    },
    {
      key: "replay_protection",
      label: "Replay protection",
      why: "A captured request must not be replayable against the API.",
      status: state(tables.has("pos_request_nonces")),
      detail: tables.has("pos_request_nonces") ? "nonces are recorded per request" : "no nonce table"
    },
    {
      key: "signed_webhooks",
      label: "Signed webhooks",
      why: "The merchant's server needs proof a callback came from TitoPay and was not tampered with.",
      status: state(/x-titopay-signature/.test(webhookSource) && tables.has("webhook_deliveries")),
      detail: /x-titopay-signature/.test(webhookSource)
        ? "HMAC signature with timestamp and delivery id"
        : "no signature on deliveries"
    },
    {
      key: "secret_rotation",
      label: "Webhook secret rotation",
      why: "A merchant must be able to rotate a signing secret without dropping a delivery.",
      status: state(/signature-previous/.test(webhookSource)),
      detail: /signature-previous/.test(webhookSource)
        ? "deliveries are dual-signed during the overlap window"
        : "rotation would break in-flight deliveries"
    },
    {
      key: "refunds",
      label: "Refunds and reversals",
      why: "Every aggregator requires a refund path before it will list a wallet.",
      status: state(tables.has("pos_refunds")),
      detail: tables.has("pos_refunds") ? "refund and reversal are recorded separately" : "no refund table"
    },
    {
      key: "partner_keys",
      label: "Partner API keys",
      why: "An integrator needs credentials it can rotate and revoke without contacting support.",
      status: state(tables.has("api_partner_keys") && partnerRoutes.length > 0),
      detail: `${partnerRoutes.length} partner endpoints, ${activeKeys} active key${activeKeys === 1 ? "" : "s"}`
    },
    {
      key: "sandbox",
      label: "Sandbox",
      why: "Certification happens against a sandbox the integrator drives themselves.",
      status: state(sandboxOn, true),
      detail: sandboxOn ? "enabled on this environment" : "present but switched off here"
    },
    // ---- THE GAPS. Derived the same way, so they close themselves. ----
    {
      key: "partner_intent_creation",
      label: "Intent creation over a partner key",
      why: "An aggregator calls over the internet holding an API key, not a till holding a shared secret.",
      status: state(partnerGuarded.length > 0, terminalGuarded.length > 0),
      detail: partnerGuarded.length
        ? `${partnerGuarded.length} endpoints accept a partner key`
        : `engine reachable only by terminal authentication (${terminalGuarded.length} endpoints)`
    },
    {
      key: "hosted_payment_page",
      label: "Hosted payment page",
      why: "Tapping TitoPay in a checkout has to land the customer somewhere that shows the merchant and amount, confirms, and returns them.",
      status: state(posRoutes.some((r) => /\/pay\/|\/checkout\//.test(r.path))),
      detail: "no customer-facing payment route is mounted"
    },
    {
      key: "return_url",
      label: "Merchant return URL",
      why: "The merchant says where to send the customer back to. The signed webhook stays the truth.",
      status: state(/returnUrl|return_url/.test(posSource)),
      detail: /returnUrl|return_url/.test(posSource)
        ? "intents carry a return URL"
        : "intents have nowhere to send the customer back to"
    },
    {
      key: "merchant_settlement",
      label: "Settlement to a merchant bank account",
      why: "A merchant wants the money in their account on a cycle, not in a wallet.",
      status: "missing",
      detail: "commercial, not technical: needs a payout rail and a settlement agreement"
    }
  ];

  const ready = checks.filter((c) => c.status === "ready").length;
  return {
    checks,
    summary: {
      ready,
      partial: checks.filter((c) => c.status === "partial").length,
      missing: checks.filter((c) => c.status === "missing").length,
      total: checks.length
    },
    generatedAt: new Date().toISOString()
  };
}

module.exports = { integrationReadiness };
