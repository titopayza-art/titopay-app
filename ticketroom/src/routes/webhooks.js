const express = require("express");
const config = require("../config");
const db = require("../lib/db");
const { limit } = require("../lib/ratelimit");
const { wrap } = require("../middleware/http");
const payments = require("../modules/payments/service");

const router = express.Router();

// Raw body is required for signature verification.
router.post("/:provider", limit("webhook", 600, 60e3), express.raw({ type: "*/*", limit: "64kb" }), wrap(async (req, res) => {
  if (!/^[a-z]+$/.test(req.params.provider)) return res.status(404).end();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const out = await payments.handleWebhook(req.params.provider, raw, req.headers);
  res.json({ ok: true, ...out });
}));

// --- SIMULATED provider hosted checkout page (development and tests only) ---
const sim = express.Router();
sim.use((req, res, next) => (config.payments.allowSimulated ? next() : res.status(404).end()));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/assets/tr.css"></head><body class="sim"><main class="sim-card">${body}</main></body></html>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

sim.get("/pay/:ref", wrap(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM sim_provider.transactions WHERE reference = $1", [req.params.ref]);
  const tx = rows[0];
  if (!tx) return res.status(404).send(page("Not found", "<h1>Unknown payment</h1>"));
  const { formatZar } = require("../lib/money");
  res.send(page("Simulated payment", `
    <p class="sim-banner">SIMULATED PAYMENT PROVIDER — no real money moves. For development and testing only.</p>
    <h1>Pay ${esc(formatZar(tx.amount_cents))}</h1>
    <p class="muted">${esc(tx.description || "")}</p><p class="muted small">Reference ${esc(tx.reference)} · status ${esc(tx.status)}</p>
    ${tx.status === "pending" ? `
    <form method="post" action="/sim/pay/${esc(tx.reference)}/approve"><button class="btn btn-primary btn-block">Approve payment</button></form>
    <form method="post" action="/sim/pay/${esc(tx.reference)}/decline"><button class="btn btn-ghost btn-block">Decline</button></form>
    <form method="post" action="/sim/pay/${esc(tx.reference)}/approve-silent"><button class="btn btn-link btn-block">Approve without webhook (tests reconciliation)</button></form>`
    : `<a class="btn btn-primary btn-block" href="${esc(tx.return_url)}">Return to TicketRoom</a>`}`));
}));

for (const [action, outcome, opts] of [["approve", "approve", {}], ["decline", "decline", {}], ["approve-silent", "approve", { sendWebhook: false }]]) {
  sim.post(`/pay/:ref/${action}`, express.urlencoded({ extended: false }), wrap(async (req, res) => {
    const provider = require("../modules/payments/providers/simulated");
    const tx = await provider.complete(req.params.ref, outcome, opts);
    const { rows } = await db.query("SELECT return_url FROM sim_provider.transactions WHERE reference = $1", [req.params.ref]);
    if (!rows[0]) return res.status(404).end();
    res.redirect(303, rows[0].return_url + (tx ? "" : ""));
  }));
}

module.exports = { router, sim };
