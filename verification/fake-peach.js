// Local stand-in for the Peach Payments sandbox: Authentication API +
// Checkout V2 + signed webhooks. Behaviour and payload shapes are taken from
// the live sandbox and the published documentation.
//
//   POST /api/oauth/token                     -> access_token
//   POST /v2/checkout                         -> checkoutId + redirectUrl
//   GET  /v2/checkout/{id}/status             -> flat dotted fields incl. result.code
//   POST /__complete   {checkoutId,outcome}   -> test hook: settle a checkout
//   POST /__webhook    {checkoutId}           -> test hook: deliver a signed webhook
const http = require("http");
const crypto = require("crypto");

const VALID = {
  clientId: "titopay-sandbox-client-id",
  clientSecret: "titopay-sandbox-client-secret",
  merchantId: "titopay-sandbox-merchant-id"
};
const ENTITY_ID = "8ac7a4c88b1e4a5a018b1e6f2c0a0001";
const WEBHOOK_SECRET = process.env.FAKE_PEACH_WEBHOOK_SECRET || "local-webhook-secret";
const TARGET_WEBHOOK_URL = process.env.FAKE_PEACH_WEBHOOK_URL || "http://127.0.0.1:8110/v1/webhooks/provider";

const RESULT_CODES = {
  successful: ["000.100.110", "Request successfully processed in 'Merchant in Integrator Test Mode'"],
  pending: ["000.200.000", "transaction pending"],
  cancelled: ["100.396.101", "Cancelled by user"],
  failed: ["800.100.152", "transaction declined by authorization system"]
};

const checkouts = new Map();
const log = [];

function send(res, status, body, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type });
  res.end(text);
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function deliverWebhook(checkout) {
  const body = formEncode({
    amount: checkout.amount.toFixed(2),
    currency: checkout.currency,
    checkoutId: checkout.checkoutId,
    merchantTransactionId: checkout.merchantTransactionId,
    "merchant.name": "TitoPay Sandbox Merchant",
    paymentType: "DB",
    paymentBrand: "VISA",
    id: checkout.paymentId,
    "result.code": RESULT_CODES[checkout.outcome][0],
    "result.description": RESULT_CODES[checkout.outcome][1],
    timestamp: new Date().toISOString()
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `wh_${crypto.randomBytes(8).toString("hex")}`;
  const message = `${timestamp}.${webhookId}.${TARGET_WEBHOOK_URL}.${body}`;
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(message).digest("hex");

  const response = await fetch(TARGET_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-webhook-signature-algorithm": "hmac-sha256",
      "x-webhook-timestamp": timestamp,
      "x-webhook-id": webhookId,
      "x-webhook-signature": signature
    },
    body
  });
  const text = await response.text().catch(() => "");
  log.push({ kind: "webhook", checkoutId: checkout.checkoutId, status: response.status });
  console.log(`[fake-peach] webhook -> ${response.status} ${text.slice(0, 120)}`);
  return { status: response.status, body: text, webhookId };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_e) { body = {}; }
    console.log(`[fake-peach] ${req.method} ${path}`);

    if (req.method === "POST" && path === "/api/oauth/token") {
      const ok = body.clientId === VALID.clientId && body.clientSecret === VALID.clientSecret && body.merchantId === VALID.merchantId;
      if (!ok) return send(res, 400, { message: "Invalid client ID or secret." });
      return send(res, 200, { access_token: "local.checkout.access.token", expires_in: "1800", token_type: "Bearer" });
    }

    const bearer = String(req.headers.authorization || "");
    if (path.startsWith("/v2/checkout") && !bearer.toLowerCase().startsWith("bearer ")) {
      return send(res, 401, { result: { code: "800.900.300", description: "invalid authentication information" } });
    }

    if (req.method === "POST" && path === "/v2/checkout") {
      const missing = ["merchantTransactionId", "amount", "currency", "nonce", "shopperResultUrl"].filter((f) => body[f] === undefined || body[f] === "");
      if (!body.authentication || !body.authentication.entityId) missing.push("authentication.entityId");
      if (missing.length) return send(res, 400, { result: { code: "200.300.404", description: `invalid or missing parameter: ${missing.join(", ")}` } });
      if (body.authentication.entityId !== ENTITY_ID) {
        return send(res, 403, { result: { code: "800.900.201", description: "invalid entityId" } });
      }
      const checkoutId = crypto.randomBytes(16).toString("hex");
      const checkout = {
        checkoutId,
        merchantTransactionId: String(body.merchantTransactionId),
        amount: Number(body.amount),
        currency: String(body.currency),
        notificationUrl: body.notificationUrl,
        shopperResultUrl: body.shopperResultUrl,
        outcome: "pending",
        paymentId: crypto.randomBytes(16).toString("hex")
      };
      checkouts.set(checkoutId, checkout);
      log.push({ kind: "create", checkoutId, merchantTransactionId: checkout.merchantTransactionId, amount: checkout.amount });
      return send(res, 200, { checkoutId, redirectUrl: `http://127.0.0.1:4400/pay/${checkoutId}` });
    }

    const statusMatch = path.match(/^\/v2\/checkout\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      const checkout = checkouts.get(statusMatch[1]);
      if (!checkout) return send(res, 404, { result: { code: "200.300.404", description: "checkout not found" } });
      const [code, description] = RESULT_CODES[checkout.outcome];
      log.push({ kind: "status", checkoutId: checkout.checkoutId, outcome: checkout.outcome });
      return send(res, 200, {
        amount: checkout.amount.toFixed(2),
        currency: checkout.currency,
        checkoutId: checkout.checkoutId,
        merchantTransactionId: checkout.merchantTransactionId,
        id: checkout.paymentId,
        "merchant.name": "TitoPay Sandbox Merchant",
        paymentBrand: "VISA",
        paymentType: "DB",
        "result.code": code,
        "result.description": description,
        timestamp: new Date().toISOString()
      });
    }

    // Stand-in for the hosted Checkout payment page. "Pay" marks the checkout
    // successful and POSTs the customer back to shopperResultUrl, exactly as
    // Peach does.
    const payMatch = path.match(/^\/pay\/([^/]+)$/);
    if (req.method === "GET" && payMatch) {
      const checkout = checkouts.get(payMatch[1]);
      if (!checkout) return send(res, 404, "<h1>Unknown checkout</h1>", "text/html");
      const outcome = url.searchParams.get("outcome") || "successful";
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Peach Payments (mock)</title></head>
<body style="font-family:system-ui;padding:32px">
  <h1>Peach Payments</h1>
  <p>Pay <strong>${checkout.currency} ${checkout.amount.toFixed(2)}</strong></p>
  <p>Reference: ${checkout.merchantTransactionId}</p>
  <form id="f" method="POST" action="${checkout.shopperResultUrl}">
    <input type="hidden" name="merchantTransactionId" value="${checkout.merchantTransactionId}">
    <input type="hidden" name="checkoutId" value="${checkout.checkoutId}">
    <input type="hidden" name="amount" value="${checkout.amount.toFixed(2)}">
    <input type="hidden" name="currency" value="${checkout.currency}">
    <button id="pay" type="submit">Pay now</button>
  </form>
  <script>
    document.getElementById("pay").addEventListener("click", function(e){
      e.preventDefault();
      fetch("/__complete",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({checkoutId:"${checkout.checkoutId}",outcome:"${outcome}"})})
        .then(function(){ document.getElementById("f").submit(); });
    });
  </script>
</body></html>`, "text/html");
    }

    // ---- test hooks ----
    if (req.method === "POST" && path === "/__complete") {
      const checkout = checkouts.get(body.checkoutId) || [...checkouts.values()].find((c) => c.merchantTransactionId === body.merchantTransactionId);
      if (!checkout) return send(res, 404, { error: "unknown checkout" });
      checkout.outcome = body.outcome || "successful";
      return send(res, 200, { ok: true, checkoutId: checkout.checkoutId, outcome: checkout.outcome });
    }
    if (req.method === "POST" && path === "/__webhook") {
      const checkout = checkouts.get(body.checkoutId) || [...checkouts.values()].find((c) => c.merchantTransactionId === body.merchantTransactionId);
      if (!checkout) return send(res, 404, { error: "unknown checkout" });
      const result = await deliverWebhook(checkout).catch((e) => ({ status: 0, body: String(e.message) }));
      return send(res, 200, { ok: true, delivered: result });
    }
    if (req.method === "GET" && path === "/__log") return send(res, 200, { log, checkouts: [...checkouts.values()] });
    if (req.method === "GET" && path === "/__entity") return send(res, 200, { entityId: ENTITY_ID });

    return send(res, 404, { message: "Not found" });
  });
});

server.listen(4400, "127.0.0.1", () => console.log("[fake-peach] Checkout mock on http://127.0.0.1:4400"));
