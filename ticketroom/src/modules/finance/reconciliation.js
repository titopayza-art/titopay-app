// Daily reconciliation: TicketRoom's payment records against the provider's
// own report. Every difference becomes an exception item that finance must
// resolve with a note. Nothing is auto-corrected.
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { getProvider } = require("../payments/providers");
const { bad } = require("../../lib/errors");

const PROVIDER_TO_INTERNAL = { paid: ["confirmed", "refunded", "partially_refunded"], failed: ["failed", "cancelled"], cancelled: ["cancelled", "failed"] };

function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  if (idx("reference") < 0 || idx("amount_cents") < 0 || idx("status") < 0) throw bad("CSV needs columns: reference, amount_cents, status[, refunded_cents, fee_cents]");
  return lines.filter(Boolean).map((l) => {
    const c = l.split(",").map((x) => x.trim());
    return { reference: c[idx("reference")], amountCents: Number(c[idx("amount_cents")]), status: c[idx("status")], refundedCents: Number(c[idx("refunded_cents")] || 0), feeCents: Number(c[idx("fee_cents")] || 0) };
  });
}

async function run(actor, { provider, from, to, csv }) {
  const report = csv ? parseCsv(csv) : await getProvider(provider).settlementReport({ from, to });
  const { rows: internal } = await db.query(
    "SELECT * FROM payments WHERE provider = $1 AND created_at >= $2 AND created_at < $3 AND provider_reference IS NOT NULL", [provider, from, to]);
  const byRef = new Map(internal.map((p) => [p.provider_reference, p]));
  const items = [];
  for (const r of report) {
    const p = byRef.get(r.reference);
    byRef.delete(r.reference);
    if (!p) {
      const { rows } = await db.query("SELECT * FROM payments WHERE provider = $1 AND provider_reference = $2", [provider, r.reference]);
      if (!rows[0]) { items.push({ ref: r.reference, provider: r, outcome: "missing_internal" }); continue; }
      items.push(compare(r, rows[0]));
      continue;
    }
    items.push(compare(r, p));
  }
  for (const p of byRef.values()) {
    if (["confirmed", "refunded", "partially_refunded"].includes(p.status)) items.push({ ref: p.provider_reference, internal: p, outcome: "missing_provider" });
  }
  const summary = items.reduce((acc, i) => ({ ...acc, [i.outcome]: (acc[i.outcome] || 0) + 1 }), {});
  summary.providerTotalCents = report.filter((r) => r.status === "paid").reduce((s, r) => s + r.amountCents, 0);
  summary.internalTotalCents = internal.filter((p) => PROVIDER_TO_INTERNAL.paid.includes(p.status)).reduce((s, p) => s + p.amount_cents, 0);
  summary.exceptions = items.filter((i) => i.outcome !== "matched").length;

  return db.withTx(async (c) => {
    const { rows } = await c.query(
      "INSERT INTO reconciliation_runs (provider, period_start, period_end, source, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [provider, from, to, csv ? "csv_upload" : "provider_api", summary, actor?.id || null]);
    for (const i of items) {
      await c.query(
        `INSERT INTO reconciliation_items (run_id, provider_reference, payment_id, provider_amount_cents, internal_amount_cents, provider_status, internal_status, outcome, resolved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rows[0].id, i.ref, i.internal?.id || null, i.provider?.amountCents ?? null, i.internal?.amount_cents ?? null, i.provider?.status || null, i.internal?.status || null, i.outcome, i.outcome === "matched"]);
    }
    await audit.record(c, { actor, action: "reconciliation.run", entityType: "reconciliation_run", entityId: rows[0].id, details: summary });
    return rows[0];
  });
}

function compare(r, p) {
  const base = { ref: r.reference, provider: r, internal: p };
  if (!(PROVIDER_TO_INTERNAL[r.status] || []).includes(p.status)) return { ...base, outcome: "status_mismatch" };
  if (r.status === "paid" && (r.amountCents !== p.amount_cents || (r.refundedCents || 0) !== p.refunded_cents)) return { ...base, outcome: "amount_mismatch" };
  return { ...base, outcome: "matched" };
}

// Ledger-wide integrity checks independent of any provider.
async function ledgerIntegrity() {
  const { rows: total } = await db.query("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s, COUNT(*)::int AS n FROM ledger_entries");
  const { rows: unbalanced } = await db.query("SELECT journal_id FROM ledger_entries GROUP BY journal_id HAVING SUM(amount_cents) <> 0 LIMIT 10");
  const { rows: clearing } = await db.query(
    `SELECT a.code, COALESCE(SUM(e.amount_cents),0)::bigint AS ledger_cents FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.code LIKE 'provider_clearing:%' GROUP BY a.code`);
  const out = [];
  for (const c of clearing) {
    const provider = c.code.split(":")[1];
    const { rows } = await db.query("SELECT COALESCE(SUM(amount_cents - refunded_cents),0)::bigint AS s FROM payments WHERE provider = $1 AND status IN ('confirmed','refunded','partially_refunded')", [provider]);
    // Provider clearing should equal net captured, less what the provider has already settled to our bank.
    const { rows: settled } = await db.query(
      `SELECT COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_entries e JOIN journals j ON j.id = e.journal_id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE j.kind = 'provider_settlement' AND a.code = $1`, [c.code]);
    out.push({ account: c.code, ledgerCents: c.ledger_cents, expectedCents: rows[0].s + settled[0].s, ok: c.ledger_cents === rows[0].s + settled[0].s });
  }
  return { entries: total[0].n, sumCents: total[0].s, balanced: total[0].s === 0 && unbalanced.length === 0, unbalancedJournals: unbalanced.map((r) => r.journal_id), clearing: out };
}

module.exports = { run, ledgerIntegrity, parseCsv };
