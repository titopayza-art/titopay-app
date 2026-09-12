// Local stand-in for the Peach Payouts API (documented shape only).
//   POST /api/oauth/token                          -> access_token
//   GET  /api/merchants/{merchantId}/balance       -> balance
//   POST /api/merchants/{merchantId}/payouts       -> payout request
const http = require("http");
const VALID = { clientId: "payout-client-id", clientSecret: "payout-secret-value-XYZ9", merchantId: "payout-merchant-id" };
const seen = [];
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", c => raw += c);
  req.on("end", () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    seen.push({ method: req.method, url: req.url, auth: String(req.headers.authorization || "").slice(0, 24) });
    console.log(`[fake-payouts] ${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/api/oauth/token") {
      const ok = body.clientId === VALID.clientId && body.clientSecret === VALID.clientSecret && body.merchantId === VALID.merchantId;
      return ok
        ? send(200, { access_token: "payout.access.token", expires_in: "1800", token_type: "Bearer" })
        : send(400, { message: "Invalid client ID or secret." });
    }
    if (!String(req.headers.authorization || "").startsWith("Bearer payout.access.token")) {
      return send(401, { message: "invalid authentication information" });
    }
    const bal = req.url.match(/^\/api\/merchants\/([^/]+)\/balance$/);
    if (req.method === "GET" && bal) {
      if (bal[1] !== VALID.merchantId) return send(404, { message: "merchant not found" });
      return send(200, { balance: 15000.00, currency: "ZAR", lastTransactionDate: "2026-08-07T00:00:00Z" });
    }
    if (req.method === "POST" && /^\/api\/merchants\/[^/]+\/payouts$/.test(req.url)) {
      if (!Array.isArray(body.payouts) || !body.payouts.length) return send(400, { message: "payouts array required" });
      return send(200, { payoutRequestId: "por_local_1", payouts: body.payouts.map((p, i) => ({ payoutId: p.payoutId || `po_${i}`, status: "PROCESSING" })) });
    }
    if (req.method === "GET" && req.url === "/__seen") return send(200, { seen });
    return send(404, { message: "Not found" });
  });
});
server.listen(4401, "127.0.0.1", () => console.log("[fake-payouts] on http://127.0.0.1:4401"));
