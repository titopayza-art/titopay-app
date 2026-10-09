const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./lib/db");
const { securityHeaders, parseCookies, loadSession, csrf, errorHandler, wrap } = require("./middleware/http");
const { notFound } = require("./lib/errors");

const PUBLIC = path.resolve(__dirname, "..", "public");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(securityHeaders);
  app.use(parseCookies);

  // Webhooks and the simulator read raw bodies; mount before the JSON parser.
  const webhooks = require("./routes/webhooks");
  app.use("/api/webhooks", webhooks.router);
  app.use("/sim", webhooks.sim);

  app.use(express.json({ limit: "100kb" }));
  app.use(wrap(loadSession));
  app.use(csrf);

  app.get("/api/health", wrap(async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true, service: "ticketroom", provider: config.payments.provider, env: config.env });
  }));
  app.get("/api/config", (_req, res) => res.json({
    operator: config.operator, provider: config.payments.provider, simulatedPayments: config.payments.provider === "simulated",
    cardPaymentsEnabled: config.payments.provider !== "none", titopayWallet: config.integrations.titopay.enabled,
    messaging: { email: config.messaging.emailProvider, sms: config.messaging.smsProvider },
    cashless: { pinThresholdCents: config.cashless.pinThresholdCents, minTopupCents: config.cashless.minTopupCents, maxTopupCents: config.cashless.maxTopupCents, maxBalanceCents: config.cashless.maxBalanceCents },
    fees: config.fees, holdMinutes: config.orders.holdMinutes,
  }));

  // PayFast hand-off: renders the signed form the buyer's browser posts to PayFast.
  app.get("/pay/payfast/:paymentId", wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, "/signin");
    const { rows } = await db.query("SELECT * FROM payments WHERE id = $1 AND user_id = $2 AND provider = 'payfast' AND status = 'pending'", [req.params.paymentId, req.user.id]);
    if (!rows[0] || !rows[0].checkout_context) throw notFound("Payment not found or already completed.");
    const payfast = require("./modules/payments/providers/payfast");
    const fields = payfast.formFields(rows[0], rows[0].checkout_context, { full_name: req.user.fullName, email: req.user.email });
    const action = config.integrations.payfast.processUrl;
    const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; form-action 'self' ${new URL(action).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to PayFast</title><link rel="stylesheet" href="/assets/tr.css"></head>
<body class="sim"><main class="sim-card"><h1>Taking you to PayFast…</h1><p class="muted">Secure payment of R${(rows[0].amount_cents / 100).toFixed(2)}.</p>
<form method="post" action="${esc(action)}" data-autosubmit>${fields.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="btn btn-primary btn-block">Continue to PayFast</button></form></main>
<script src="/assets/autosubmit.js"></script></body></html>`);
  }));

  app.use("/api/auth", require("./routes/auth").router);
  app.use("/api/public", require("./routes/public"));
  app.use("/api/me", require("./routes/account"));
  app.use("/api/organiser", require("./routes/organiser"));
  app.use("/api/staff", require("./routes/staff"));
  app.use("/api/pos", require("./routes/pos"));
  app.use("/api/admin", require("./routes/admin"));
  app.use("/api", (_req, _res, next) => next(notFound("Unknown API route.")));

  // Uploaded event images. Served with their sniffed type, never executed.
  app.get("/media/:id", wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound();
    const { rows } = await db.query("SELECT mime_type FROM uploads WHERE id = $1", [req.params.id]);
    const file = path.join(config.uploadDir, req.params.id);
    if (!rows[0] || !fs.existsSync(file)) throw notFound();
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.type(rows[0].mime_type).sendFile(file);
  }));

  app.use(express.static(PUBLIC, { index: false, maxAge: config.isProd ? "1h" : 0, extensions: ["html"] }));

  // Portal entry points (each is a small single-page app).
  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC, file));
  app.get(["/", "/events/:slug", "/checkout/:slug", "/orders/:ref", "/browse", "/signin", "/legal/:doc", "/help", "/unsubscribe", "/organisers"], page("index.html"));
  app.get(["/account", "/account/*"], page("account.html"));
  app.get(["/organiser", "/organiser/*"], page("organiser.html"));
  app.get(["/scan", "/scan/*"], page("scan.html"));
  app.get(["/pos", "/pos/*"], page("pos.html"));
  app.get(["/admin", "/admin/*"], page("admin.html"));

  app.use((req, res, next) => (req.accepts("html") ? res.status(404).sendFile(path.join(PUBLIC, "index.html")) : next(notFound())));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
