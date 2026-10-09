// Local stand-ins for TicketRoom's external APIs, for development and tests.
//
//   /titopay/v1/partner/*   TitoPay Partner API (wallet linking + payments) — the
//                            contract in docs/TITOPAY-PARTNER-API.md
//   /titopay                 approval console (approve/decline wallet payments, see OTPs)
//   /yoco/api/checkouts*     Yoco Checkout API shape + hosted page /yoco/pay/:id
//   /payfast/eng/process     PayFast hosted page + /payfast/eng/query/validate
//   /bulksms/v1/messages     BulkSMS JSON API shape
//   /clickatell/v1/message   Clickatell One API shape
//   /mock/messages           every SMS received
//
// Run:  node scripts/mock-services.js      (port 8090, TicketRoom on 8080)
// NEVER point a production TicketRoom at this. Config refuses *_ENV=mock in production.
const crypto = require("crypto");
const express = require("express");

function createMockServices({ ticketroomUrl = process.env.MOCK_TICKETROOM_URL || "http://127.0.0.1:8080", fixedOtp = process.env.MOCK_TITOPAY_FIXED_OTP || null, autoApprove = process.env.MOCK_TITOPAY_AUTO_APPROVE === "true" } = {}) {
  const config = require("../src/config");
  const s = { ticketroomUrl, wallets: new Map(), linkRequests: new Map(), links: new Map(), payments: new Map(), refunds: new Map(), idem: new Map(),
    yoco: new Map(), payfast: new Map(), payfastItns: new Set(), sms: [], fail: {} };
  // Demo wallets: any +27 number gets one with R1 000; set balances in tests via s.wallets.
  const wallet = (msisdn) => { if (!s.wallets.has(msisdn)) s.wallets.set(msisdn, { walletId: `w_${crypto.randomBytes(5).toString("hex")}`, msisdn, balanceCents: 100000, handle: `@${msisdn.slice(-4)}` }); return s.wallets.get(msisdn); };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;max-width:560px;margin:24px auto;padding:0 16px}.b{background:#fff3da;padding:10px;border-radius:8px;font-weight:700}button{padding:10px 16px;margin:4px;border-radius:8px;border:1px solid #ccc;font:inherit;cursor:pointer}table{width:100%;border-collapse:collapse}td{padding:6px;border-bottom:1px solid #eee}</style><p class="b">MOCK SERVICE — not a real provider. No money moves.</p>${body}`;

  const app = express();
  app.use("/payfast", express.urlencoded({ extended: false }));
  app.use(express.json());

  // ---------------------------------------------------------------- TitoPay Partner API
  const tp = config.integrations.titopay;
  const tpAuth = (req, res, next) => {
    const [id, secret] = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString().split(":");
    if (id !== tp.clientId || secret !== tp.clientSecret) return res.status(401).json({ error: { code: "unauthorized", message: "Bad partner credentials" } });
    next();
  };
  const idem = (req, res, key) => { const k = `${key}:${req.headers["idempotency-key"]}`; if (req.headers["idempotency-key"] && s.idem.has(k)) { res.json(s.idem.get(k)); return true; } return false; };
  const remember = (req, key, body) => { if (req.headers["idempotency-key"]) s.idem.set(`${key}:${req.headers["idempotency-key"]}`, body); return body; };
  const signTp = (raw) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac("sha256", tp.webhookSecret).update(`${t}.${raw}`).digest("hex")}`; };
  async function notifyTp(p, type) {
    const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(8).toString("hex")}`, type, data: { paymentId: p.paymentId, amountCents: p.amountCents, merchantReference: p.merchantReference } });
    try { await fetch(p.callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-titopay-signature": signTp(raw) }, body: raw }); } catch (e) { console.warn("[mock titopay] webhook failed:", e.message); }
  }
  async function decide(p, approve) {
    if (p.status !== "pending_approval") return p;
    const w = [...s.wallets.values()].find((x) => x.walletId === p.walletId);
    if (approve && w.balanceCents >= p.amountCents) { w.balanceCents -= p.amountCents; p.status = "completed"; } else p.status = "declined";
    p.completedAt = new Date().toISOString();
    await notifyTp(p, p.status === "completed" ? "payment.completed" : "payment.declined");
    return p;
  }

  app.get("/titopay/v1/partner/health", tpAuth, (_req, res) => res.json({ status: "ok", environment: "mock" }));
  app.post("/titopay/v1/partner/wallet-links/requests", tpAuth, (req, res) => {
    const { msisdn, partnerUserRef } = req.body || {};
    if (!/^\+27[6-8]\d{8}$/.test(msisdn || "")) return res.status(422).json({ error: { code: "invalid_msisdn", message: "Not a valid TitoPay mobile number." } });
    if (s.fail.unknownWallet === msisdn) return res.status(404).json({ error: { code: "wallet_not_found", message: "No TitoPay wallet uses that number." } });
    const w = wallet(msisdn);
    const requestId = `lr_${crypto.randomBytes(6).toString("hex")}`;
    const otp = fixedOtp || String(crypto.randomInt(100000, 1000000));
    s.linkRequests.set(requestId, { requestId, walletId: w.walletId, otp, partnerUserRef, expiresAt: new Date(Date.now() + 600e3).toISOString(), status: "pending" });
    console.log(`[mock titopay] OTP for ${msisdn}: ${otp}`);
    res.status(201).json({ requestId, expiresAt: s.linkRequests.get(requestId).expiresAt, channel: "titopay_app", devOtp: otp });
  });
  app.post("/titopay/v1/partner/wallet-links/requests/:id/confirm", tpAuth, (req, res) => {
    const r = s.linkRequests.get(req.params.id);
    if (!r || r.status !== "pending") return res.status(404).json({ error: { code: "link_request_not_found", message: "Link request not found." } });
    if (String(req.body?.otp) !== r.otp) return res.status(409).json({ error: { code: "otp_incorrect", message: "That code is not correct." } });
    r.status = "confirmed";
    const walletToken = `wtk_${crypto.randomBytes(16).toString("hex")}`;
    const w = [...s.wallets.values()].find((x) => x.walletId === r.walletId);
    s.links.set(walletToken, { walletId: w.walletId, active: true });
    res.json({ walletId: w.walletId, walletToken, displayHandle: `TitoPay ${w.handle}` });
  });
  app.post("/titopay/v1/partner/wallet-links/revoke", tpAuth, (req, res) => { const l = s.links.get(req.body?.walletToken); if (l) l.active = false; res.json({ revoked: true }); });
  app.post("/titopay/v1/partner/payments", tpAuth, async (req, res) => {
    if (idem(req, res, "pay")) return;
    const { walletToken, amountCents, merchantReference, description, callbackUrl } = req.body || {};
    const link = s.links.get(walletToken);
    if (!link?.active) return res.status(409).json({ error: { code: "wallet_link_revoked", message: "This wallet link is no longer active. Link your wallet again." } });
    const p = { paymentId: `tpp_${crypto.randomBytes(8).toString("hex")}`, walletId: link.walletId, amountCents, merchantReference, description, callbackUrl, status: "pending_approval", refundedCents: 0, createdAt: new Date().toISOString() };
    s.payments.set(p.paymentId, p);
    const body = remember(req, "pay", { paymentId: p.paymentId, status: p.status, approvalExpiresAt: new Date(Date.now() + 600e3).toISOString() });
    res.status(201).json(body);
    if (autoApprove) setTimeout(() => decide(p, true), 300);
  });
  app.get("/titopay/v1/partner/payments/:id", tpAuth, (req, res) => {
    const p = s.payments.get(req.params.id);
    if (!p) return res.status(404).json({ error: { code: "not_found", message: "Payment not found." } });
    res.json({ paymentId: p.paymentId, status: p.status, amountCents: p.amountCents, refundedCents: p.refundedCents, merchantReference: p.merchantReference });
  });
  app.post("/titopay/v1/partner/payments/:id/refunds", tpAuth, (req, res) => {
    if (idem(req, res, "refund")) return;
    const p = s.payments.get(req.params.id);
    const amt = Number(req.body?.amountCents);
    if (!p || p.status !== "completed") return res.status(409).json({ error: { code: "not_refundable", message: "Payment is not refundable." } });
    if (p.refundedCents + amt > p.amountCents) return res.status(409).json({ error: { code: "exceeds_payment", message: "Refund exceeds the payment." } });
    p.refundedCents += amt;
    [...s.wallets.values()].find((x) => x.walletId === p.walletId).balanceCents += amt;
    res.status(201).json(remember(req, "refund", { refundId: `tpr_${crypto.randomBytes(6).toString("hex")}`, status: "completed" }));
  });
  app.get("/titopay/v1/partner/settlements", tpAuth, (req, res) => {
    const from = new Date(req.query.from), to = new Date(req.query.to);
    res.json({ transactions: [...s.payments.values()].filter((p) => new Date(p.createdAt) >= from && new Date(p.createdAt) < to && p.status !== "pending_approval").map((p) => ({ paymentId: p.paymentId, amountCents: p.amountCents, refundedCents: p.refundedCents, status: p.status, feeCents: 0 })) });
  });
  // Approval console standing in for the TitoPay app.
  app.get("/titopay", (_req, res) => {
    const pend = [...s.payments.values()].filter((p) => p.status === "pending_approval");
    const otps = [...s.linkRequests.values()].filter((r) => r.status === "pending");
    res.send(page("TitoPay (mock)", `<h1>TitoPay app (mock)</h1><h2>Payment approvals</h2>${pend.length ? `<table>${pend.map((p) => `<tr><td>${esc(p.description)}<br><small>R${(p.amountCents / 100).toFixed(2)}</small></td><td><form method="post" action="/titopay/approve/${p.paymentId}"><button>Approve</button></form><form method="post" action="/titopay/decline/${p.paymentId}"><button>Decline</button></form></td></tr>`).join("")}</table>` : "<p>No payments waiting.</p>"}
      <h2>Link codes (OTP)</h2>${otps.length ? otps.map((r) => `<p>${esc(r.requestId)}: <b>${esc(r.otp)}</b></p>`).join("") : "<p>None.</p>"}<h2>Wallets</h2><table>${[...s.wallets.values()].map((w) => `<tr><td>${esc(w.msisdn)}</td><td>R${(w.balanceCents / 100).toFixed(2)}</td></tr>`).join("")}</table>`));
  });
  app.post(["/titopay/approve/:id", "/titopay/decline/:id"], express.urlencoded({ extended: false }), async (req, res) => {
    const p = s.payments.get(req.params.id);
    if (p) await decide(p, req.path.includes("/approve/"));
    res.redirect(303, "/titopay");
  });

  // ---------------------------------------------------------------- Yoco
  const yc = config.integrations.yoco;
  const yocoAuth = (req, res, next) => (req.headers.authorization === `Bearer ${yc.secretKey}` ? next() : res.status(401).json({ message: "Unauthorized" }));
  async function notifyYoco(ch, type) {
    const id = `evt_${crypto.randomBytes(8).toString("hex")}`, ts = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ id, type, createdDate: new Date().toISOString(), payload: { id: `p_${crypto.randomBytes(6).toString("hex")}`, amount: ch.amount, currency: "ZAR", status: type === "payment.succeeded" ? "succeeded" : "failed", metadata: { checkoutId: ch.id, ...ch.metadata } } });
    const sig = crypto.createHmac("sha256", Buffer.from(yc.webhookSecret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
    try { await fetch(`${s.ticketroomUrl}/api/webhooks/yoco`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` }, body: raw }); } catch (e) { console.warn("[mock yoco] webhook failed:", e.message); }
  }
  app.post("/yoco/api/checkouts", yocoAuth, (req, res) => {
    if (idem(req, res, "yoco")) return;
    const ch = { id: `ch_${crypto.randomBytes(8).toString("hex")}`, status: "created", refunded: 0, ...req.body };
    s.yoco.set(ch.id, ch);
    res.json(remember(req, "yoco", { id: ch.id, status: ch.status, redirectUrl: `${req.protocol}://${req.get("host")}/yoco/pay/${ch.id}` }));
  });
  app.get("/yoco/api/checkouts/:id", yocoAuth, (req, res) => { const ch = s.yoco.get(req.params.id); return ch ? res.json({ id: ch.id, status: ch.status, amount: ch.amount }) : res.status(404).json({ message: "Not found" }); });
  app.post("/yoco/api/checkouts/:id/refund", yocoAuth, (req, res) => {
    if (idem(req, res, "yrefund")) return;
    const ch = s.yoco.get(req.params.id);
    if (!ch || ch.status !== "completed" || ch.refunded + req.body.amount > ch.amount) return res.status(400).json({ message: "Not refundable" });
    ch.refunded += req.body.amount;
    res.json(remember(req, "yrefund", { refundId: `rf_${crypto.randomBytes(6).toString("hex")}`, status: "succeeded" }));
  });
  app.get("/yoco/pay/:id", (req, res) => { const ch = s.yoco.get(req.params.id); res.send(page("Yoco (mock)", ch ? `<h1>Pay R${(ch.amount / 100).toFixed(2)}</h1><form method="post" action="/yoco/pay/${ch.id}/ok"><button>Pay (mock card)</button></form><form method="post" action="/yoco/pay/${ch.id}/fail"><button>Card declined</button></form>` : "Unknown checkout")); });
  app.post("/yoco/pay/:id/:outcome", async (req, res) => {
    const ch = s.yoco.get(req.params.id);
    if (!ch) return res.status(404).end();
    ch.status = req.params.outcome === "ok" ? "completed" : "failed";
    await notifyYoco(ch, ch.status === "completed" ? "payment.succeeded" : "payment.failed");
    res.redirect(303, ch.status === "completed" ? ch.successUrl : ch.failureUrl);
  });

  // ---------------------------------------------------------------- PayFast
  const pf = () => require("../src/modules/payments/providers/payfast");
  app.post("/payfast/eng/process", (req, res) => {
    const entries = Object.entries(req.body);
    const sigOk = pf().sign(entries) === req.body.signature;
    const id = `pf_${crypto.randomBytes(5).toString("hex")}`;
    s.payfast.set(id, { ...req.body, pf_payment_id: String(crypto.randomInt(1e6, 1e7)) });
    res.send(page("PayFast (mock)", sigOk ? `<h1>Pay R${esc(req.body.amount)}</h1><p>${esc(req.body.item_name)}</p><form method="post" action="/payfast/complete/${id}/COMPLETE"><button>Complete payment</button></form><form method="post" action="/payfast/complete/${id}/CANCELLED"><button>Cancel</button></form>` : "<h1>Signature mismatch</h1><p>The merchant's signature did not verify.</p>"));
  });
  app.post("/payfast/complete/:id/:status", async (req, res) => {
    const f = s.payfast.get(req.params.id);
    if (!f) return res.status(404).end();
    const itn = [["m_payment_id", f.m_payment_id], ["pf_payment_id", f.pf_payment_id], ["payment_status", req.params.status], ["item_name", f.item_name], ["amount_gross", f.amount], ["amount_fee", "0.00"], ["amount_net", f.amount], ["name_first", f.name_first], ["name_last", f.name_last], ["email_address", f.email_address], ["merchant_id", f.merchant_id]].filter(([, v]) => v !== undefined);
    const body = new URLSearchParams([...itn, ["signature", pf().sign(itn)]]).toString();
    s.payfastItns.add(pf().paramString(itn, false));
    try { await fetch(f.notify_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); } catch (e) { console.warn("[mock payfast] ITN failed:", e.message); }
    res.redirect(303, req.params.status === "COMPLETE" ? f.return_url : f.cancel_url);
  });
  app.post("/payfast/eng/query/validate", express.text({ type: "*/*" }), (req, res) => {
    const raw = typeof req.body === "string" ? req.body : new URLSearchParams(req.body).toString();
    res.type("text/plain").send(s.payfastItns.has(raw) ? "VALID" : "INVALID");
  });

  // ---------------------------------------------------------------- SMS
  const bs = config.integrations.bulksms;
  app.post("/bulksms/v1/messages", (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${bs.tokenId}:${bs.tokenSecret}`).toString("base64")}`) return res.status(401).json({ title: "Unauthorized" });
    if (s.fail.sms) return res.status(503).json({ title: "Service unavailable" });
    const msgs = (Array.isArray(req.body) ? req.body : [req.body]).map((m) => { const id = String(crypto.randomInt(1e9, 2e9)); s.sms.push({ gateway: "bulksms", id, to: m.to, body: m.body }); return { id, to: m.to, status: { type: "ACCEPTED" } }; });
    res.status(201).json(msgs);
  });
  const ck = config.integrations.clickatell;
  app.post("/clickatell/v1/message", (req, res) => {
    if (req.headers.authorization !== ck.apiKey) return res.status(401).json({ error: "Unauthorized" });
    const messages = (req.body?.messages || []).map((m) => { const id = crypto.randomBytes(8).toString("hex"); s.sms.push({ gateway: "clickatell", id, to: m.to, body: m.content }); return { apiMessageId: id, accepted: true, to: m.to }; });
    res.status(202).json({ messages, error: null });
  });
  app.get("/mock/messages", (_req, res) => res.json(s.sms));

  return { app, state: s, decide };
}

module.exports = { createMockServices };

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 8090);
  const { app } = createMockServices();
  app.listen(port, () => console.log(`Mock services on http://127.0.0.1:${port}  (TitoPay console: /titopay)`));
}
