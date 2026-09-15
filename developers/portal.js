"use strict";

/*
 * TitoPay Developer Portal - one classic script, no build step.
 *
 * Everything a POS vendor needs to complete an integration without a TitoPay
 * engineer: self-service registration, key management, sandbox provisioning,
 * a payment simulator that signs REAL terminal requests in the browser
 * (WebCrypto HMAC-SHA256, the same canonical request production verifies),
 * webhook tooling with delivery logs, and usage dashboards.
 *
 * State lives in localStorage on the developer's machine only. Secrets shown
 * once by the API are offered for local storage with that caveat spelled out.
 */

const STORE_KEY = "titopay_dev_portal_v1";
const DEFAULT_BASE = "https://api-sandbox.titopay.co.za";

const state = load();
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}
function apiBase() {
  return String(state.apiBase || DEFAULT_BASE).replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ helpers */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
}
async function api(path, { method = "GET", body, auth } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth === "partner" && state.partnerKey) headers["X-TitoPay-Api-Key"] = state.partnerKey;
  if (auth === "merchant" && state.merchant?.accessToken) headers.Authorization = `Bearer ${state.merchant.accessToken}`;
  const response = await fetch(`${apiBase()}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.error || `Request failed (${response.status})`);
  }
  return json;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A REAL signed terminal request - identical maths to production's
// requireTerminalAuth: HMAC-SHA256 over timestamp\nnonce\nMETHOD\npath\nsha256(body).
async function terminalRequest(method, path, bodyObj) {
  if (!state.terminal?.secret) throw new Error("Provision a sandbox terminal first (Sandbox section)");
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(new TextEncoder().encode(body));
  const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join("\n");
  const signature = await hmacHex(state.terminal.secret, canonical);
  const headers = {
    "x-titopay-terminal-id": state.terminal.terminalId,
    "x-titopay-timestamp": timestamp,
    "x-titopay-nonce": nonce,
    "x-titopay-signature": `sha256=${signature}`
  };
  if (bodyObj !== undefined) headers["Content-Type"] = "application/json";
  if (method.toUpperCase() === "POST") headers["Idempotency-Key"] = `portal-${nonce}`;
  const response = await fetch(`${apiBase()}${path}`, { method, headers, body: bodyObj === undefined ? undefined : body });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json.error || `Request failed (${response.status})`);
  return json;
}

function secretBox(label, value) {
  return `<div class="secret-box"><strong>${esc(label)} - shown once, stored only in this browser</strong><code class="block">${esc(value)}</code></div>`;
}
function statusLine(id) {
  return `<p class="status-line" id="${id}"></p>`;
}
function setStatus(id, message, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

/* -------------------------------------------------------------------- views */

const views = {
  overview() {
    const ready = {
      key: Boolean(state.partnerKey),
      merchant: Boolean(state.merchant),
      terminal: Boolean(state.terminal),
      webhook: Boolean(state.webhookSubscriptionId)
    };
    const step = (n, done, title, body) => `
      <div class="step"><div class="no">${done ? "✓" : n}</div>
        <div><strong>${esc(title)}</strong> ${done ? '<span class="chip good">DONE</span>' : ""}
        <p class="note">${body}</p></div></div>`;
    return `
      <h1>Integrate TitoPay payments</h1>
      <p class="lead">Everything on this page runs against the sandbox - a full deployment of the production platform with test money. Work through the five steps; each unlocks the next. No TitoPay engineer required.</p>
      <div class="card">
        ${step(1, ready.key, "Register and get your sandbox API key", 'One form, instant key. <button class="small" data-go="keys">Open API Keys</button>')}
        ${step(2, ready.merchant, "Provision a test merchant", 'One call creates a verified merchant, its wallet and a funded test customer. <button class="small" data-go="sandbox">Open Sandbox</button>')}
        ${step(3, ready.terminal, "Register a terminal", "Real HMAC credentials - your device signs sandbox requests exactly as it will sign production ones.")}
        ${step(4, ready.webhook, "Subscribe a webhook endpoint", 'Signed, retried, replayable deliveries. <button class="small" data-go="webhooks">Open Webhooks</button>')}
        ${step(5, false, "Run the payment loop", 'Create a QR payment, watch it complete, refund it, break it on purpose. <button class="small" data-go="simulator">Open Simulator</button>')}
      </div>
      <h2>What the sandbox is</h2>
      <div class="card"><p class="note">The sandbox is the same codebase as production with its own database and test money. The payment engine, state machine, terminal signature verification, idempotency and webhook pipeline are the production code paths - a passing sandbox integration is a production integration awaiting production keys, which TitoPay issues after partner approval.</p></div>`;
  },

  keys() {
    const key = state.partnerKey;
    return `
      <h1>API Keys</h1>
      <p class="lead">Partner keys identify your organisation. Sandbox keys (<code class="inline">tpk_test_</code>) are self-service; production keys (<code class="inline">tpk_live_</code>) are issued by TitoPay once your organisation is approved.</p>
      ${key ? "" : `
      <div class="card">
        <h2>Register your organisation</h2>
        <div class="grid2">
          <div class="field"><label>Company name</label><input id="reg-company" placeholder="Acme POS (Pty) Ltd"></div>
          <div class="field"><label>Contact name</label><input id="reg-contact" placeholder="Integration lead"></div>
          <div class="field"><label>Contact email</label><input id="reg-email" type="email" placeholder="dev@acmepos.co.za"></div>
        </div>
        <div class="row"><button class="primary" id="btn-register">Create partner account</button></div>
        ${statusLine("reg-status")}
        <div id="reg-result"></div>
      </div>`}
      ${key ? `
      <div class="card">
        <h2>This browser's key</h2>
        <p class="note">Stored locally. Prefix: <code class="inline">${esc(key.slice(0, 12))}…</code></p>
        <div class="row">
          <button class="secondary" id="btn-refresh-keys">List all keys</button>
          <button class="secondary" id="btn-new-key">Create additional sandbox key</button>
          <button class="small" id="btn-forget-key">Forget key on this browser</button>
        </div>
        ${statusLine("keys-status")}
        <div id="keys-list"></div>
        <div id="keys-result"></div>
      </div>` : ""}`;
  },

  sandbox() {
    return `
      <h1>Sandbox</h1>
      <p class="lead">Provision the principals your integration needs. Every credential below is shown once by the API and kept only in this browser.</p>
      <div class="card">
        <h2>1 · Test merchant + funded customer</h2>
        <div class="field"><label>Business name</label><input id="sbx-name" placeholder="Demo Cafe" value="${esc(state.merchant?.businessName || "")}"></div>
        <div class="row"><button class="primary" id="btn-make-merchant">Create sandbox merchant</button></div>
        ${statusLine("sbx-m-status")}
        ${state.merchant ? `<p class="note">Current merchant: <code class="inline">${esc(state.merchant.merchantId)}</code> (${esc(state.merchant.businessName)}) · test customer wallet R ${esc(String(state.merchant.customerBalance ?? 10000))}</p>` : ""}
        <div id="sbx-m-result"></div>
      </div>
      <div class="card">
        <h2>2 · Terminal with signing credentials</h2>
        <p class="note">Registered through the production registration path; the secret signs requests exactly as a production terminal will.</p>
        <div class="row"><button class="primary" id="btn-make-terminal" ${state.merchant ? "" : "disabled"}>Register sandbox terminal</button></div>
        ${statusLine("sbx-t-status")}
        ${state.terminal ? `<p class="note">Current terminal: <code class="inline">${esc(state.terminal.terminalId)}</code></p>` : ""}
        <div id="sbx-t-result"></div>
      </div>
      <div class="card">
        <h2>Reset</h2>
        <p class="note">Deletes every sandbox merchant, customer, terminal and payment this partner provisioned. The partner account and keys stay.</p>
        <div class="row"><button class="small" id="btn-reset-sbx">Reset my sandbox</button></div>
        ${statusLine("sbx-r-status")}
      </div>`;
  },

  simulator() {
    const pay = state.lastPayment;
    return `
      <h1>Payment Simulator</h1>
      <p class="lead">Create a payment with a request this page signs using your terminal secret - the identical HMAC production verifies - then drive it to any outcome through the real engine. Watch the deliveries arrive under Event Logs.</p>
      <div class="card">
        <h2>Create a QR payment</h2>
        <div class="grid2">
          <div class="field"><label>Amount (ZAR)</label><input id="pay-amount" value="149.50" inputmode="decimal"></div>
          <div class="field"><label>Merchant reference</label><input id="pay-ref" value="TILL-7-${Math.floor(Math.random() * 900 + 100)}"></div>
        </div>
        <div class="row"><button class="primary" id="btn-create-pay" ${state.terminal ? "" : "disabled"}>Create payment intent (signed)</button></div>
        ${statusLine("pay-status")}
        ${pay ? `
          <p class="note">Payment <code class="inline">${esc(pay.paymentId)}</code> · R ${esc(String(pay.amount))} · created ${esc(pay.createdAt)}</p>
          <code class="block">${esc(pay.qrPayload)}</code>` : ""}
      </div>
      ${pay ? `
      <div class="card">
        <h2>Drive it to an outcome</h2>
        <div class="row">
          <button class="secondary" data-sim="scan">Scan</button>
          <button class="secondary" data-sim="complete">Complete</button>
          <button class="secondary" data-sim="insufficient">Insufficient funds</button>
          <button class="secondary" data-sim="expire">Expire</button>
          <button class="secondary" data-sim="cancel">Cancel</button>
          <button class="secondary" data-sim="refund">Refund R 49.50</button>
          <button class="secondary" data-sim="reverse">Reverse</button>
          <button class="small" id="btn-pay-status">Poll status (signed GET)</button>
        </div>
        ${statusLine("sim-status")}
        <div id="sim-result"></div>
      </div>` : ""}`;
  },

  webhooks() {
    return `
      <h1>Webhooks</h1>
      <p class="lead">Subscribe an HTTPS endpoint on your sandbox merchant, receive signed deliveries, and prove your verification code before production. Deliveries retry at 1m/5m/15m/1h/6h, then park dead for replay.</p>
      <div class="card">
        <h2>Subscribe an endpoint</h2>
        <div class="field"><label>Endpoint URL (public HTTPS)</label><input id="wh-url" placeholder="https://yourdomain.example/hooks/titopay" value="${esc(state.webhookUrl || "")}"></div>
        <div class="row">
          <button class="primary" id="btn-wh-create" ${state.merchant ? "" : "disabled"}>Create subscription</button>
          <button class="secondary" id="btn-wh-list" ${state.merchant ? "" : "disabled"}>List subscriptions</button>
        </div>
        ${statusLine("wh-status")}
        <div id="wh-result"></div>
        <div id="wh-list"></div>
      </div>
      <div class="card">
        <h2>Fire test traffic</h2>
        <div class="row">
          <button class="secondary" id="btn-wh-ping" ${state.webhookSubscriptionId ? "" : "disabled"}>Send test.ping now</button>
          <select id="wh-gen-type">
            ${["payment.created","payment.scanned","payment.completed","payment.failed","payment.cancelled","payment.expired","refund.created","refund.completed","settlement.completed"].map((t) => `<option>${t}</option>`).join("")}
          </select>
          <button class="secondary" id="btn-wh-generate" ${state.merchant ? "" : "disabled"}>Generate synthetic event</button>
        </div>
        <p class="note">Synthetic events carry <code class="inline">data.sandboxGenerated: true</code> and travel the real signed delivery pipeline - verifying one proves your production verification.</p>
        ${statusLine("wh-fire-status")}
      </div>`;
  },

  events() {
    return `
      <h1>Event Logs</h1>
      <p class="lead">Every delivery attempt on your subscription: status, response code, retry schedule and the per-attempt log. Replay re-sends the frozen payload immediately.</p>
      <div class="row">
        <select id="ev-filter"><option value="">all</option><option>delivered</option><option>failed</option><option>pending</option><option>dead</option></select>
        <button class="secondary" id="btn-ev-refresh" ${state.webhookSubscriptionId ? "" : "disabled"}>Refresh</button>
      </div>
      ${statusLine("ev-status")}
      <div id="ev-list">${state.webhookSubscriptionId ? "" : '<p class="empty">Create a webhook subscription first.</p>'}</div>`;
  },

  usage() {
    return `
      <h1>Usage</h1>
      <p class="lead">Your organisation's API traffic, webhook delivery health and terminal activity across the last 30 days.</p>
      <div class="row"><button class="secondary" id="btn-usage-refresh" ${state.partnerKey ? "" : "disabled"}>Refresh</button></div>
      ${statusLine("usage-status")}
      <div id="usage-stats"></div>
      <div id="usage-table"></div>`;
  },

  docs() {
    return `
      <h1>Integration Guide</h1>
      <p class="lead">The complete references ship with the platform; this page carries the two recipes every integrator needs by heart.</p>
      <div class="card">
        <h2>Documents</h2>
        <ul>
          <li><code class="inline">docs/webhooks/WEBHOOKS.md</code> - webhook events, signature verification (Node.js, Java, PHP, Kotlin), retry contract</li>
          <li><code class="inline">docs/webhooks/openapi-webhooks.yaml</code> - webhook management API, OpenAPI 3.1</li>
          <li><code class="inline">docs/openapi-titopay.yaml</code> - POS payments, terminals, sandbox and partner APIs, OpenAPI 3.1</li>
          <li><code class="inline">docs/sdk-starters/</code> - runnable starter clients for Node.js, Java, PHP and Android/Kotlin</li>
        </ul>
      </div>
      <div class="card">
        <h2>Recipe 1 · Signing a terminal request</h2>
<pre>canonical = timestamp + "\\n" + nonce + "\\n" + METHOD + "\\n" + path + "\\n" + sha256hex(rawBody)
signature = "sha256=" + hmacSha256Hex(terminalSecret, canonical)

headers:
  X-TitoPay-Terminal-Id: TERM-...
  X-TitoPay-Timestamp:   unix milliseconds (±5 minutes)
  X-TitoPay-Nonce:       unique per request (12-160 chars) - replays are refused
  X-TitoPay-Signature:   sha256=...
  Idempotency-Key:       required on money-creating POSTs</pre>
        <p class="note">path is the full path without query, e.g. <code class="inline">/v1/pos/payment-intents</code>. An empty body still hashes: sha256 of zero bytes.</p>
      </div>
      <div class="card">
        <h2>Recipe 2 · Verifying a webhook</h2>
<pre>signed  = timestamp + "\\n" + eventId + "\\n" + sha256hex(rawBody)
expect  = hmacSha256Hex(endpointSecret, signed)
compare = constant-time equals(expect, header X-TitoPay-Signature minus "sha256=")

then: reject stale timestamps (±5 min) · dedupe on event id · answer 2xx fast
rotation: also accept X-TitoPay-Signature-Previous during the 24h overlap</pre>
      </div>
      <div class="card">
        <h2>The payment loop</h2>
<pre>POST /v1/pos/payment-intents        (terminal-signed)  -> paymentId + qrPayload (120s QR)
customer scans + confirms in the TitoPay app
webhook payment.completed            -> your till closes the sale
GET  /v1/pos/payment-intents/{id}   (terminal-signed)  -> the reconciliation truth
POST .../refund | .../cancel        as needed, idempotent</pre>
      </div>`;
  }
};

/* ------------------------------------------------------------------ actions */

const actions = {
  async "btn-register"() {
    const payload = {
      companyName: document.getElementById("reg-company").value,
      contactName: document.getElementById("reg-contact").value,
      email: document.getElementById("reg-email").value
    };
    const result = await api("/v1/partners/register", { method: "POST", body: payload });
    state.partnerKey = result.sandboxKey;
    save();
    document.getElementById("reg-result").innerHTML =
      secretBox("Sandbox API key", result.sandboxKey) +
      `<p class="note">Partner <strong>${esc(result.partner.companyName)}</strong> created (status: ${esc(result.partner.status)}). The key has been stored in this browser.</p>`;
    setStatus("reg-status", "Partner account created.", true);
    setTimeout(render, 1600);
  },
  async "btn-refresh-keys"() {
    const result = await api("/v1/partners/keys", { auth: "partner" });
    document.getElementById("keys-list").innerHTML = `<div class="tablewrap"><table>
      <tr><th>Prefix</th><th>Env</th><th>Status</th><th>Expires</th><th>Last used</th><th></th></tr>
      ${result.keys.map((key) => `<tr>
        <td><code class="inline">${esc(key.keyPrefix)}…</code></td>
        <td>${esc(key.environment)}</td>
        <td><span class="chip ${key.status === "active" ? "good" : "bad"}">${esc(key.status.toUpperCase())}</span></td>
        <td>${key.expiresAt ? esc(new Date(key.expiresAt).toLocaleString()) : "-"}</td>
        <td>${key.lastUsedAt ? esc(new Date(key.lastUsedAt).toLocaleString()) : "-"}</td>
        <td>${key.status === "active" ? `<button class="small" data-rotate="${esc(key.id)}">Rotate</button> <button class="small" data-revoke="${esc(key.id)}">Revoke</button>` : ""}</td>
      </tr>`).join("")}
    </table></div>`;
    setStatus("keys-status", `${result.keys.length} key(s).`, true);
  },
  async "btn-new-key"() {
    const result = await api("/v1/partners/keys", { method: "POST", auth: "partner", body: { environment: "sandbox" } });
    document.getElementById("keys-result").innerHTML = secretBox("New sandbox key", result.plaintext);
    setStatus("keys-status", "Key created - copy it now.", true);
  },
  "btn-forget-key"() {
    delete state.partnerKey; save(); render();
  },
  async "btn-make-merchant"() {
    const result = await api("/v1/sandbox/merchants", { method: "POST", auth: "partner",
      body: { businessName: document.getElementById("sbx-name").value } });
    state.merchant = {
      merchantId: result.merchant.merchantId,
      businessName: result.merchant.businessName,
      accessToken: result.merchant.accessToken,
      customerBalance: result.testCustomer.walletBalance
    };
    delete state.terminal; delete state.lastPayment; delete state.webhookSubscriptionId;
    save();
    document.getElementById("sbx-m-result").innerHTML =
      secretBox("Merchant login", `${result.merchant.login.username} / ${result.merchant.login.password}`) +
      secretBox("Test customer login", `${result.testCustomer.login.username} / ${result.testCustomer.login.password}`) +
      `<p class="note">Merchant code <code class="inline">${esc(result.merchant.merchantId)}</code>. The merchant access token was stored for webhook management from this page.</p>`;
    setStatus("sbx-m-status", "Merchant + funded customer created.", true);
    setTimeout(render, 2600);
  },
  async "btn-make-terminal"() {
    const result = await api("/v1/sandbox/terminals", { method: "POST", auth: "partner",
      body: { merchantId: state.merchant.merchantId } });
    state.terminal = { terminalId: result.terminal.terminal_id, secret: result.terminalSecret };
    save();
    document.getElementById("sbx-t-result").innerHTML =
      secretBox("Terminal secret", result.terminalSecret) +
      `<p class="note">Terminal <code class="inline">${esc(result.terminal.terminal_id)}</code> registered. The Simulator now signs requests with it, in this browser, exactly as your device will.</p>`;
    setStatus("sbx-t-status", "Terminal registered.", true);
    setTimeout(render, 2600);
  },
  async "btn-reset-sbx"() {
    const result = await api("/v1/sandbox/reset", { method: "POST", auth: "partner" });
    delete state.merchant; delete state.terminal; delete state.lastPayment; delete state.webhookSubscriptionId;
    save();
    setStatus("sbx-r-status", `Cleared ${result.cleared.merchants} merchant(s) and ${result.cleared.customers} customer(s).`, true);
    setTimeout(render, 1200);
  },
  async "btn-create-pay"() {
    const amount = Number(document.getElementById("pay-amount").value);
    const reference = document.getElementById("pay-ref").value;
    const result = await terminalRequest("POST", "/v1/pos/payment-intents", {
      merchantId: state.merchant.merchantId,
      terminalId: state.terminal.terminalId,
      amount, currency: "ZAR", merchantReference: reference
    });
    const payment = result.payment || result;
    state.lastPayment = {
      paymentId: payment.paymentId,
      amount,
      qrPayload: payment.qrPayload,
      token: String(payment.qrPayload || "").split("/").pop(),
      createdAt: new Date().toLocaleTimeString()
    };
    save(); render();
    toast("Payment intent created - the signature verified.");
  },
  async "btn-pay-status"() {
    const result = await terminalRequest("GET", `/v1/pos/payment-intents/${state.lastPayment.paymentId}`);
    const payment = result.payment || result;
    document.getElementById("sim-result").innerHTML = `<code class="block">${esc(JSON.stringify(payment, null, 2))}</code>`;
    setStatus("sim-status", `Status: ${payment.status}`, true);
  },
  async "btn-wh-create"() {
    const url = document.getElementById("wh-url").value;
    const result = await api("/v1/webhooks/subscriptions", { method: "POST", auth: "merchant",
      body: { endpointUrl: url, events: [] } });
    state.webhookUrl = url;
    state.webhookSubscriptionId = result.subscription.id;
    save();
    document.getElementById("wh-result").innerHTML = secretBox("Endpoint signing secret", result.secret);
    setStatus("wh-status", "Subscription created - copy the secret now.", true);
  },
  async "btn-wh-list"() {
    const result = await api("/v1/webhooks/subscriptions", { auth: "merchant" });
    if (result.subscriptions[0]) { state.webhookSubscriptionId = result.subscriptions[0].id; save(); }
    document.getElementById("wh-list").innerHTML = `<div class="tablewrap"><table>
      <tr><th>Endpoint</th><th>Events</th><th>Status</th><th>Failures</th></tr>
      ${result.subscriptions.map((sub) => `<tr>
        <td>${esc(sub.endpointUrl)}</td>
        <td>${sub.events.length ? esc(sub.events.join(", ")) : "all"}</td>
        <td><span class="chip ${sub.status === "active" ? "good" : "warn"}">${esc(sub.status.toUpperCase())}</span></td>
        <td>${esc(String(sub.consecutiveFailures))}</td>
      </tr>`).join("") || '<tr><td colspan="4" class="empty">None yet.</td></tr>'}
    </table></div>`;
    setStatus("wh-status", `${result.subscriptions.length} subscription(s).`, true);
  },
  async "btn-wh-ping"() {
    const result = await api(`/v1/webhooks/subscriptions/${state.webhookSubscriptionId}/test`, { method: "POST", auth: "merchant" });
    setStatus("wh-fire-status", result.delivered ? `test.ping delivered (HTTP ${result.statusCode}).` : `Not delivered: ${result.error || `HTTP ${result.statusCode}`}`, result.delivered);
  },
  async "btn-wh-generate"() {
    const eventType = document.getElementById("wh-gen-type").value;
    const result = await api("/v1/sandbox/webhooks/generate", { method: "POST", auth: "partner", body: { eventType } });
    setStatus("wh-fire-status", `${eventType}: ${result.queued} queued, ${result.delivered} delivered, ${result.retrying} retrying.`, true);
  },
  async "btn-ev-refresh"() {
    const filter = document.getElementById("ev-filter").value;
    const result = await api(`/v1/webhooks/subscriptions/${state.webhookSubscriptionId}/deliveries${filter ? `?status=${filter}` : ""}`, { auth: "merchant" });
    document.getElementById("ev-list").innerHTML = `<div class="tablewrap"><table>
      <tr><th>Event</th><th>Type</th><th>Status</th><th>Attempts</th><th>Response</th><th>Next retry</th><th></th></tr>
      ${result.deliveries.map((d) => `<tr>
        <td><code class="inline">${esc(String(d.eventId).slice(0, 18))}…</code></td>
        <td>${esc(d.eventType)}</td>
        <td><span class="chip ${d.status === "delivered" ? "good" : d.status === "dead" ? "bad" : "warn"}">${esc(d.status.toUpperCase())}</span></td>
        <td>${esc(String(d.attempts))}</td>
        <td>${d.responseCode ? esc(String(d.responseCode)) : esc(d.lastError || "-")}</td>
        <td>${d.status === "failed" ? esc(new Date(d.nextRetryAt).toLocaleTimeString()) : "-"}</td>
        <td><button class="small" data-replay="${esc(d.id)}">Replay</button></td>
      </tr>`).join("") || '<tr><td colspan="7" class="empty">No deliveries yet - fire something from Webhooks or the Simulator.</td></tr>'}
    </table></div>`;
    setStatus("ev-status", `${result.deliveries.length} delivery record(s).`, true);
  },
  async "btn-usage-refresh"() {
    const [overview, usage] = await Promise.all([
      api("/v1/partners/overview", { auth: "partner" }),
      api("/v1/partners/usage?days=30", { auth: "partner" })
    ]);
    const o = overview.overview;
    document.getElementById("usage-stats").innerHTML = `<div class="stat-row">
      <div class="stat"><b>${esc(String(o.last30Days.requests))}</b><span>API requests · 30d</span></div>
      <div class="stat"><b>${esc(String(o.last30Days.errors))}</b><span>API errors · 30d</span></div>
      <div class="stat"><b>${esc(String(o.webhookDeliveries.delivered))}/${esc(String(o.webhookDeliveries.total))}</b><span>webhooks delivered</span></div>
      <div class="stat"><b>${esc(String(o.webhookDeliveries.dead))}</b><span>dead-lettered</span></div>
      <div class="stat"><b>${esc(String(o.terminalActivity.terminals))}</b><span>terminals</span></div>
      <div class="stat"><b>${esc(String(o.terminalActivity.completed))}</b><span>completed payments</span></div>
      <div class="stat"><b>R ${esc(o.terminalActivity.completedAmount.toFixed(2))}</b><span>completed value</span></div>
    </div>`;
    document.getElementById("usage-table").innerHTML = `<div class="card tablewrap"><table>
      <tr><th>Day</th><th>Requests</th><th>Errors</th></tr>
      ${usage.usage.map((row) => `<tr><td>${esc(String(row.day).slice(0, 10))}</td><td>${esc(String(row.requests))}</td><td>${esc(String(row.errors))}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">No traffic yet.</td></tr>'}
    </table></div>`;
    setStatus("usage-status", `Environment: ${o.environment}.`, true);
  }
};

async function simulate(outcome) {
  const body = { outcome };
  if (["scan", "complete", "insufficient"].includes(outcome)) body.token = state.lastPayment.token;
  if (outcome === "refund") body.amount = 49.5;
  const result = await api(`/v1/sandbox/payments/${state.lastPayment.paymentId}/simulate`, {
    method: "POST", auth: "partner", body
  });
  document.getElementById("sim-result").innerHTML = `<code class="block">${esc(JSON.stringify(result, null, 2))}</code>`;
  setStatus("sim-status", `Outcome ${outcome}: ${result.status || (result.refusedWith ? `refused - ${result.refusedWith.error}` : "done")}`, true);
}

/* ------------------------------------------------------------------- wiring */

let currentView = "overview";
function render() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === currentView);
  });
  document.getElementById("main").innerHTML = views[currentView]();
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest(".nav-item");
  if (nav) { currentView = nav.dataset.view; render(); return; }
  const go = event.target.closest("[data-go]");
  if (go) { currentView = go.dataset.go; render(); return; }
  const sim = event.target.closest("[data-sim]");
  if (sim) {
    try { await simulate(sim.dataset.sim); } catch (error) { setStatus("sim-status", error.message, false); }
    return;
  }
  const rotate = event.target.closest("[data-rotate]");
  if (rotate) {
    try {
      const result = await api(`/v1/partners/keys/${rotate.dataset.rotate}/rotate`, { method: "POST", auth: "partner" });
      document.getElementById("keys-result").innerHTML = secretBox("Replacement key (old key valid 24h)", result.plaintext);
      await actions["btn-refresh-keys"]();
    } catch (error) { setStatus("keys-status", error.message, false); }
    return;
  }
  const revoke = event.target.closest("[data-revoke]");
  if (revoke) {
    try {
      await api(`/v1/partners/keys/${revoke.dataset.revoke}/revoke`, { method: "POST", auth: "partner" });
      await actions["btn-refresh-keys"]();
    } catch (error) { setStatus("keys-status", error.message, false); }
    return;
  }
  const replay = event.target.closest("[data-replay]");
  if (replay) {
    try {
      await api(`/v1/webhooks/subscriptions/${state.webhookSubscriptionId}/deliveries/${replay.dataset.replay}/replay`,
        { method: "POST", auth: "merchant" });
      toast("Replay queued - refresh in a few seconds.");
    } catch (error) { setStatus("ev-status", error.message, false); }
    return;
  }
  const button = event.target.closest("button[id]");
  if (button && actions[button.id]) {
    button.disabled = true;
    try {
      await actions[button.id]();
    } catch (error) {
      const status = document.querySelector(".status-line");
      toast(error.message);
      if (status) { status.textContent = error.message; status.className = "status-line err"; }
    } finally {
      button.disabled = false;
    }
  }
});

const baseInput = document.getElementById("api-base");
baseInput.value = apiBase();
baseInput.addEventListener("change", () => {
  state.apiBase = baseInput.value.trim();
  save();
  toast(`API base set to ${apiBase()}`);
});

render();
