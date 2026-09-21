"use strict";

// THE MONEY INTEGRITY ENGINE.
//
// Every movement of money on TitoPay must be authorised, recorded,
// reconciled, traceable and finalised. The wallet's displayed balance is a
// projection; the wallet_ledger is the financial record. This engine is the
// machinery that PROVES the two agree, and that shouts when they do not:
//
//   1. STATUS HISTORY   a database trigger records every transactions.status
//      transition, whoever wrote it, in the same database transaction as the
//      write itself. Leaving the terminal state 'reversed' is refused at the
//      database level. No code path can change a status silently.
//   2. INTEGRITY SWEEP  a periodic pass over recent activity that detects
//      balance/ledger mismatches, duplicate postings, orphan transactions,
//      unbalanced multi-leg entries, negative balances, stale in-flight
//      payments and provider states parked for review. Findings become
//      deduplicated alert rows that stay open until a person resolves them.
//   3. RECONCILIATION   run records and exception queues for matching the
//      internal ledger against provider statements. Exceptions are never
//      silently overwritten; each one carries its investigation to
//      resolution.
//
// Nothing here moves money. The engine observes, records and escalates.
// High-severity findings are audit-logged and, when an escalation address is
// configured, emailed to authorised personnel.
//
// Alert thresholds and sweep scope are configuration (platform_settings key
// 'money_integrity_config'), not code.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

const DEFAULT_INTEGRITY_CONFIG = {
  // A pending/processing payment older than this is stale: the provider
  // answer never arrived and a person should look.
  staleInFlightHours: 24,
  // How many recently active wallets one sweep verifies against the ledger.
  sweepWalletLimit: 500,
  // Multi-leg postings for one transaction must net to zero within this.
  netTolerance: 0.01,
  // How many days of activity each sweep re-examines.
  sweepWindowDays: 7,
  // Where high and critical alerts are escalated. Null until compliance
  // configures it; escalation then also rides the audit log either way.
  escalationEmail: null
};

const ALERT_SEVERITIES = new Set(["info", "warning", "high", "critical"]);

// The controlled transaction lifecycle. Recorded always; 'reversed' is
// enforced as terminal at the database level. The map is exported so other
// rails can consult it, and violations of it surface as alerts rather than
// broken payments.
const ALLOWED_STATUS_TRANSITIONS = {
  pending: ["processing", "completed", "failed", "declined", "cancelled", "pending"],
  processing: ["completed", "failed", "declined", "cancelled", "reversed", "processing", "pending"],
  completed: ["reversed", "refunded", "chargeback", "processing", "completed"],
  failed: ["pending", "processing", "failed"],
  declined: ["declined"],
  cancelled: ["cancelled"],
  refunded: ["refunded", "chargeback"],
  chargeback: ["chargeback"],
  reversed: ["reversed"]
};

let schemaReady = null;
function ensureIntegritySchema() {
  schemaReady ||= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS money_integrity_alerts (
        id UUID PRIMARY KEY,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        fingerprint TEXT NOT NULL UNIQUE,
        user_id UUID,
        wallet_id UUID,
        transaction_id UUID,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_by UUID,
        resolved_at TIMESTAMPTZ,
        resolved_by UUID,
        resolution_note TEXT
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS money_integrity_alerts_open_idx ON money_integrity_alerts (status, severity, created_at DESC)"
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transaction_status_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL DEFAULT 'db_trigger'
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS transaction_status_history_tx_idx ON transaction_status_history (transaction_id, changed_at)"
    );
    // The trigger pair. INSERT records the opening status; UPDATE records
    // every change and refuses to resurrect a reversed transaction. Running
    // inside the same database transaction as the status write makes the
    // history exactly as durable as the change it describes.
    await pool.query(`
      CREATE OR REPLACE FUNCTION titopay_record_tx_status() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO transaction_status_history (transaction_id, from_status, to_status)
          VALUES (NEW.id, NULL, NEW.status);
          RETURN NEW;
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          IF OLD.status = 'reversed' THEN
            RAISE EXCEPTION 'transaction % is reversed; reversed is terminal', OLD.id;
          END IF;
          INSERT INTO transaction_status_history (transaction_id, from_status, to_status)
          VALUES (NEW.id, OLD.status, NEW.status);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'titopay_tx_status_insert') THEN
          CREATE TRIGGER titopay_tx_status_insert AFTER INSERT ON transactions
          FOR EACH ROW EXECUTE FUNCTION titopay_record_tx_status();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'titopay_tx_status_update') THEN
          CREATE TRIGGER titopay_tx_status_update BEFORE UPDATE OF status ON transactions
          FOR EACH ROW EXECUTE FUNCTION titopay_record_tx_status();
        END IF;
      END $$
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_runs (
        id UUID PRIMARY KEY,
        scope TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        checked_count INT NOT NULL DEFAULT 0,
        exception_count INT NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        triggered_by UUID
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
        id UUID PRIMARY KEY,
        run_id UUID REFERENCES reconciliation_runs(id) ON DELETE SET NULL,
        exception_type TEXT NOT NULL,
        transaction_id UUID,
        wallet_id UUID,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by UUID,
        resolution_note TEXT
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS reconciliation_exceptions_open_idx ON reconciliation_exceptions (status, created_at DESC)"
    );
    // Regulatory reporting EVIDENCE, not report types: which obligations
    // apply is a legal determination, so report_type is free text mapped to
    // TitoPay's actual classification, never an enum invented here.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS regulatory_report_events (
        id UUID PRIMARY KEY,
        report_type TEXT NOT NULL,
        trigger_summary TEXT NOT NULL,
        review_note TEXT,
        decision TEXT NOT NULL,
        submission_reference TEXT,
        submitted_at TIMESTAMPTZ,
        responsible_admin UUID NOT NULL,
        related_user UUID,
        related_case UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by UUID
      )
    `);
    // Case management on the existing compliance flag queue: additive
    // columns so every historical flag becomes a case with no migration.
    await pool.query("ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS assigned_to UUID");
    await pool.query("ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS severity TEXT");
    await pool.query("ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS case_type TEXT");
    await pool.query("ALTER TABLE compliance_flags ADD COLUMN IF NOT EXISTS decision TEXT");
    // The lookups the payment rails and the sweep actually run.
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_open_status ON transactions (status, updated_at DESC) WHERE status IN ('pending','processing')"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_checkout_ref ON transactions ((metadata->>'checkoutId')) WHERE metadata ? 'checkoutId'"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_payout_ref ON transactions ((metadata->>'payoutId')) WHERE metadata ? 'payoutId'"
    );
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

async function loadIntegrityConfig() {
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'money_integrity_config' LIMIT 1"
  ).catch(() => ({ rows: [] }));
  const stored = rows[0]?.value;
  return stored && typeof stored === "object"
    ? { ...DEFAULT_INTEGRITY_CONFIG, ...stored }
    : { ...DEFAULT_INTEGRITY_CONFIG };
}

// Integrity settings are changed from the admin console, with the same
// discipline as the tier limits: a stated reason, and previous and new
// values side by side in the audit record.
async function saveIntegrityConfig(actor, value = {}, { reason = null } = {}) {
  await ensureIntegritySchema();
  const stated = String(reason || "").trim();
  if (!stated) throw new AppError(400, "State the reason for this integrity settings change. It becomes part of the audit record.");
  const previous = await loadIntegrityConfig();
  const merged = { ...DEFAULT_INTEGRITY_CONFIG };
  const numberOr = (candidate, fallback) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  merged.staleInFlightHours = numberOr(value.staleInFlightHours, previous.staleInFlightHours);
  merged.sweepWalletLimit = Math.min(5000, numberOr(value.sweepWalletLimit, previous.sweepWalletLimit));
  merged.netTolerance = numberOr(value.netTolerance, previous.netTolerance);
  merged.sweepWindowDays = Math.min(90, numberOr(value.sweepWindowDays, previous.sweepWindowDays));
  const email = String(value.escalationEmail ?? previous.escalationEmail ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError(400, "The escalation email address does not look valid.");
  }
  merged.escalationEmail = email || null;
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ('money_integrity_config', $1::JSONB, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(merged)]
  );
  await writeAuditLog({
    actorType: "admin",
    actorId: actor?.userId || null,
    action: "integrity_config_updated",
    entityType: "platform_settings",
    entityId: null,
    metadata: { reason: stated, previous, config: merged }
  });
  return merged;
}

// One alert per finding: the fingerprint deduplicates, so a condition that
// persists across sweeps stays a single open alert instead of a flood.
// High and critical alerts are escalated the moment they are first raised.
async function raiseAlert({ alertType, severity = "warning", fingerprint, userId = null, walletId = null, transactionId = null, details = {} }) {
  await ensureIntegritySchema();
  const level = ALERT_SEVERITIES.has(severity) ? severity : "warning";
  // A still-open alert dedupes silently. A RESOLVED alert whose condition
  // has come back re-opens: a recurring integrity failure must never hide
  // behind its own resolution note.
  const { rows } = await pool.query(
    `INSERT INTO money_integrity_alerts (id, alert_type, severity, fingerprint, user_id, wallet_id, transaction_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
     ON CONFLICT (fingerprint) DO UPDATE
       SET status = 'open', details = EXCLUDED.details, created_at = NOW(),
           resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
       WHERE money_integrity_alerts.status = 'resolved'
     RETURNING id`,
    [crypto.randomUUID(), alertType, level, fingerprint, userId, walletId, transactionId, JSON.stringify(details)]
  );
  if (!rows[0]) return null;
  await writeAuditLog({
    actorType: "system",
    actorId: null,
    action: "money_integrity_alert",
    entityType: "money_integrity_alert",
    entityId: rows[0].id,
    metadata: { alertType, severity: level, walletId, transactionId, ...details }
  });
  if (level === "high" || level === "critical") {
    try {
      const config = await loadIntegrityConfig();
      if (config.escalationEmail) {
        const { queueRawEmail } = require("./email-centre-service");
        await queueRawEmail({
          to: config.escalationEmail,
          subject: `TitoPay money integrity ${level} alert: ${alertType}`,
          bodyText: `A ${level} money integrity alert was raised.\n\nType: ${alertType}\nWallet: ${walletId || "n/a"}\nTransaction: ${transactionId || "n/a"}\nDetails: ${JSON.stringify(details)}\n\nReview it in the admin console under Compliance.`,
          category: "operations"
        });
      }
    } catch (error) {
      console.error("[integrity] escalation email failed", { message: error.message });
    }
  }
  return rows[0].id;
}

/* THE SWEEP. Each check is independent; a failure in one records itself and
   never blocks the others. Nothing is repaired automatically: repairing a
   financial record silently is exactly what this engine exists to prevent. */
async function runIntegritySweep({ triggeredBy = null } = {}) {
  await ensureIntegritySchema();
  const config = await loadIntegrityConfig();
  const runId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO reconciliation_runs (id, scope, triggered_by) VALUES ($1, 'internal_ledger', $2)",
    [runId, triggeredBy]
  );
  const found = { balance_mismatch: 0, duplicate_posting: 0, orphan_transaction: 0, unbalanced_entries: 0, negative_balance: 0, stale_in_flight: 0, provider_review: 0 };
  let checked = 0;
  const windowDays = Number(config.sweepWindowDays) || 7;

  // 1. Balance vs ledger. The available balance must equal the signed sum
  //    of every ledger entry for the wallet: credits and releases add,
  //    debits and reserves subtract. Checked for recently active wallets.
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.user_id, w.available_balance,
              COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN wl.amount
                                WHEN wl.entry_type IN ('debit','reserve') THEN -wl.amount
                                ELSE 0 END), 0) AS ledger_balance
       FROM wallets w
       JOIN wallet_ledger wl ON wl.wallet_id = w.id
       WHERE w.id IN (
         SELECT DISTINCT wallet_id FROM wallet_ledger
         WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         LIMIT $2
       )
       GROUP BY w.id
       HAVING ABS(w.available_balance - COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN wl.amount
                                WHEN wl.entry_type IN ('debit','reserve') THEN -wl.amount ELSE 0 END), 0)) > $3`,
      [String(windowDays), Number(config.sweepWalletLimit) || 500, Number(config.netTolerance) || 0.01]
    );
    checked += rows.length;
    for (const row of rows) {
      found.balance_mismatch += 1;
      await raiseAlert({
        alertType: "balance_mismatch", severity: "critical",
        fingerprint: `balance_mismatch:${row.id}`,
        userId: row.user_id, walletId: row.id,
        details: { availableBalance: Number(row.available_balance), ledgerBalance: Number(row.ledger_balance) }
      });
    }
  } catch (error) { console.error("[integrity] balance check failed", { message: error.message }); }

  // 2. Duplicate postings: the same transaction posting the same entry to
  //    the same wallet with the same amount AND reference more than once.
  try {
    const { rows } = await pool.query(
      `SELECT transaction_id, wallet_id, entry_type, amount, reference, COUNT(*)::INT AS copies
       FROM wallet_ledger
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL AND transaction_id IS NOT NULL
       GROUP BY transaction_id, wallet_id, entry_type, amount, reference
       HAVING COUNT(*) > 1`,
      [String(windowDays)]
    );
    for (const row of rows) {
      found.duplicate_posting += 1;
      await raiseAlert({
        alertType: "duplicate_posting", severity: "critical",
        fingerprint: `duplicate_posting:${row.transaction_id}:${row.wallet_id}:${row.entry_type}:${row.amount}`,
        walletId: row.wallet_id, transactionId: row.transaction_id,
        details: { entryType: row.entry_type, amount: Number(row.amount), reference: row.reference, copies: row.copies }
      });
    }
  } catch (error) { console.error("[integrity] duplicate check failed", { message: error.message }); }

  // 3. Orphan transactions: completed, money on the line, and not a single
  //    ledger entry to show for it.
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.user_id, t.wallet_id, t.service_code, t.total
       FROM transactions t
       WHERE t.status = 'completed' AND t.total > 0
         AND t.created_at >= NOW() - ($1 || ' days')::INTERVAL
         AND NOT EXISTS (SELECT 1 FROM wallet_ledger wl WHERE wl.transaction_id = t.id)`,
      [String(windowDays)]
    );
    for (const row of rows) {
      found.orphan_transaction += 1;
      await raiseAlert({
        alertType: "orphan_transaction", severity: "high",
        fingerprint: `orphan_transaction:${row.id}`,
        userId: row.user_id, walletId: row.wallet_id, transactionId: row.id,
        details: { serviceCode: row.service_code, total: Number(row.total) }
      });
    }
  } catch (error) { console.error("[integrity] orphan check failed", { message: error.message }); }

  // 4. Unbalanced multi-leg entries: when one transaction posts both debits
  //    and credits (a transfer and its fee, a reversal), the signed legs
  //    must net to zero. Single-leg movements (top-ups, withdrawals) are
  //    exempt by construction.
  try {
    const { rows } = await pool.query(
      `SELECT wl.transaction_id,
              SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN wl.amount ELSE -wl.amount END) AS net,
              COUNT(*) FILTER (WHERE wl.entry_type IN ('credit','release'))::INT AS credit_legs,
              COUNT(*) FILTER (WHERE wl.entry_type IN ('debit','reserve'))::INT AS debit_legs
       FROM wallet_ledger wl
       WHERE wl.created_at >= NOW() - ($1 || ' days')::INTERVAL AND wl.transaction_id IS NOT NULL
       GROUP BY wl.transaction_id
       HAVING COUNT(*) FILTER (WHERE wl.entry_type IN ('credit','release')) > 0
          AND COUNT(*) FILTER (WHERE wl.entry_type IN ('debit','reserve')) > 0
          AND ABS(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN wl.amount ELSE -wl.amount END)) > $2`,
      [String(windowDays), Number(config.netTolerance) || 0.01]
    );
    for (const row of rows) {
      found.unbalanced_entries += 1;
      await raiseAlert({
        alertType: "unbalanced_entries", severity: "critical",
        fingerprint: `unbalanced_entries:${row.transaction_id}`,
        transactionId: row.transaction_id,
        details: { net: Number(row.net), creditLegs: row.credit_legs, debitLegs: row.debit_legs }
      });
    }
  } catch (error) { console.error("[integrity] net check failed", { message: error.message }); }

  // 5. Negative balances can only mean a control failed somewhere upstream.
  try {
    const { rows } = await pool.query(
      "SELECT id, user_id, available_balance FROM wallets WHERE available_balance < 0");
    for (const row of rows) {
      found.negative_balance += 1;
      await raiseAlert({
        alertType: "negative_balance", severity: "critical",
        fingerprint: `negative_balance:${row.id}`,
        userId: row.user_id, walletId: row.id,
        details: { availableBalance: Number(row.available_balance) }
      });
    }
  } catch (error) { console.error("[integrity] negative balance check failed", { message: error.message }); }

  // 6. Stale in-flight payments: pending or processing long past any
  //    provider's answer window. This is where a top-up whose webhook and
  //    return URL both went missing finally becomes visible.
  try {
    const hours = Number(config.staleInFlightHours) || 24;
    const { rows } = await pool.query(
      `SELECT id, user_id, wallet_id, service_code, status, total, updated_at
       FROM transactions
       WHERE status IN ('pending','processing')
         AND updated_at < NOW() - ($1 || ' hours')::INTERVAL
         AND created_at >= NOW() - ($2 || ' days')::INTERVAL`,
      [String(hours), String(windowDays * 4)]
    );
    for (const row of rows) {
      found.stale_in_flight += 1;
      await raiseAlert({
        alertType: "stale_in_flight", severity: "warning",
        fingerprint: `stale_in_flight:${row.id}`,
        userId: row.user_id, walletId: row.wallet_id, transactionId: row.id,
        details: { serviceCode: row.service_code, status: row.status, total: Number(row.total), lastChangeAt: row.updated_at }
      });
    }
  } catch (error) { console.error("[integrity] stale check failed", { message: error.message }); }

  // 7. Provider states parked for human review (amount mismatches, uncertain
  //    submissions) must never sit unnoticed.
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, wallet_id, service_code, metadata->>'providerState' AS provider_state
       FROM transactions
       WHERE metadata->>'requiresReview' = 'true' AND status NOT IN ('completed','failed','cancelled','reversed')
         AND created_at >= NOW() - ($1 || ' days')::INTERVAL`,
      [String(windowDays * 4)]
    );
    for (const row of rows) {
      found.provider_review += 1;
      await raiseAlert({
        alertType: "provider_review", severity: "high",
        fingerprint: `provider_review:${row.id}`,
        userId: row.user_id, walletId: row.wallet_id, transactionId: row.id,
        details: { serviceCode: row.service_code, providerState: row.provider_state }
      });
    }
  } catch (error) { console.error("[integrity] provider review check failed", { message: error.message }); }

  const exceptionCount = Object.values(found).reduce((sum, n) => sum + n, 0);
  await pool.query(
    "UPDATE reconciliation_runs SET finished_at = NOW(), checked_count = $2, exception_count = $3, details = $4::JSONB WHERE id = $1",
    [runId, checked, exceptionCount, JSON.stringify(found)]
  );
  return { runId, checked, exceptionCount, found };
}

// PROVIDER RECONCILIATION. Entries come from a provider statement (JSON rows
// with a reference and amount); each is matched against the internal record
// and every disagreement becomes an exception that must be investigated,
// never auto-corrected.
async function runProviderReconciliation({ provider = "provider", entries = [], actor = null }) {
  await ensureIntegritySchema();
  if (!Array.isArray(entries) || !entries.length) {
    throw new AppError(400, "Provide the provider statement entries to reconcile: an array of { reference, amount, state }.");
  }
  if (entries.length > 5000) throw new AppError(400, "Reconcile at most 5000 entries per run.");
  const runId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO reconciliation_runs (id, scope, triggered_by) VALUES ($1, $2, $3)",
    [runId, `provider:${provider}`, actor?.userId || null]
  );
  let exceptions = 0;
  const addException = async (exceptionType, transactionId, details) => {
    exceptions += 1;
    await pool.query(
      `INSERT INTO reconciliation_exceptions (id, run_id, exception_type, transaction_id, details)
       VALUES ($1, $2, $3, $4, $5::JSONB)`,
      [crypto.randomUUID(), runId, exceptionType, transactionId, JSON.stringify(details)]
    );
  };
  for (const entry of entries) {
    const reference = String(entry.reference || "").trim();
    if (!reference) { await addException("unreadable_entry", null, { entry }); continue; }
    const { rows } = await pool.query(
      `SELECT id, status, total, amount FROM transactions
       WHERE reference = $1 OR metadata->>'checkoutId' = $1 OR metadata->>'payoutId' = $1 OR metadata->>'merchantTransactionId' = $1
       LIMIT 1`, [reference]);
    const tx = rows[0];
    if (!tx) { await addException("unmatched_provider_transaction", null, { provider, reference, amount: entry.amount ?? null, state: entry.state ?? null }); continue; }
    const providerAmount = Number(entry.amount);
    if (Number.isFinite(providerAmount) && Math.abs(providerAmount - Number(tx.total)) > 0.01
        && Math.abs(providerAmount - Number(tx.amount)) > 0.01) {
      await addException("amount_mismatch", tx.id, { provider, reference, providerAmount, internalTotal: Number(tx.total), internalAmount: Number(tx.amount) });
      continue;
    }
    const providerState = String(entry.state || "").toLowerCase();
    if (providerState && ["settled", "success", "successful", "completed", "paid"].includes(providerState)
        && !["completed", "reversed", "refunded"].includes(tx.status)) {
      await addException("missing_settlement", tx.id, { provider, reference, providerState, internalStatus: tx.status });
    } else if (providerState && ["failed", "declined", "cancelled", "rejected"].includes(providerState)
        && tx.status === "completed") {
      await addException("unexpected_settlement", tx.id, { provider, reference, providerState, internalStatus: tx.status });
    }
  }
  await pool.query(
    "UPDATE reconciliation_runs SET finished_at = NOW(), checked_count = $2, exception_count = $3 WHERE id = $1",
    [runId, entries.length, exceptions]
  );
  await writeAuditLog({
    actorType: actor ? "admin" : "system",
    actorId: actor?.userId || null,
    action: "reconciliation_run",
    entityType: "reconciliation_run",
    entityId: runId,
    metadata: { provider, entries: entries.length, exceptions }
  });
  return { runId, checked: entries.length, exceptions };
}

async function resolveAlert(alertId, actor, note) {
  await ensureIntegritySchema();
  const resolution = String(note || "").trim();
  if (!resolution) throw new AppError(400, "State how this alert was resolved. It becomes part of the record.");
  const { rows } = await pool.query(
    `UPDATE money_integrity_alerts
     SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution_note = $3
     WHERE id = $1 AND status <> 'resolved' RETURNING id, alert_type`,
    [alertId, actor?.userId || null, resolution]
  );
  if (!rows[0]) throw new AppError(404, "Alert not found or already resolved.");
  await writeAuditLog({
    actorType: "admin", actorId: actor?.userId || null,
    action: "money_integrity_alert_resolved",
    entityType: "money_integrity_alert", entityId: alertId,
    metadata: { alertType: rows[0].alert_type, note: resolution }
  });
  return rows[0];
}

async function resolveReconciliationException(exceptionId, actor, note) {
  await ensureIntegritySchema();
  const resolution = String(note || "").trim();
  if (!resolution) throw new AppError(400, "State how this exception was resolved. It becomes part of the record.");
  const { rows } = await pool.query(
    `UPDATE reconciliation_exceptions
     SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution_note = $3
     WHERE id = $1 AND status <> 'resolved' RETURNING id, exception_type`,
    [exceptionId, actor?.userId || null, resolution]
  );
  if (!rows[0]) throw new AppError(404, "Exception not found or already resolved.");
  await writeAuditLog({
    actorType: "admin", actorId: actor?.userId || null,
    action: "reconciliation_exception_resolved",
    entityType: "reconciliation_exception", entityId: exceptionId,
    metadata: { exceptionType: rows[0].exception_type, note: resolution }
  });
  return rows[0];
}

// Regulatory reporting evidence: trigger, review, decision, submission,
// reference, date, responsible person. Which report types exist is mapped to
// TitoPay's actual regulatory classification by compliance, never assumed
// here.
async function recordRegulatoryReportEvent(actor, payload = {}) {
  await ensureIntegritySchema();
  const reportType = String(payload.reportType || "").trim();
  const triggerSummary = String(payload.triggerSummary || "").trim();
  const decision = String(payload.decision || "").trim();
  if (!reportType) throw new AppError(400, "Name the report type as defined in TitoPay's compliance framework.");
  if (!triggerSummary) throw new AppError(400, "Describe what triggered this reporting consideration.");
  if (!decision) throw new AppError(400, "Record the decision taken (for example: submitted, not reportable, escalated).");
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO regulatory_report_events
       (id, report_type, trigger_summary, review_note, decision, submission_reference, submitted_at, responsible_admin, related_user, related_case, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12)`,
    [id, reportType, triggerSummary, payload.reviewNote || null, decision,
      payload.submissionReference || null, payload.submittedAt || null,
      payload.responsibleAdmin || actor?.userId || null, payload.relatedUser || null,
      payload.relatedCase || null, JSON.stringify(payload.metadata || {}), actor?.userId || null]
  );
  await writeAuditLog({
    actorType: "admin", actorId: actor?.userId || null,
    action: "regulatory_report_recorded",
    entityType: "regulatory_report_event", entityId: id,
    metadata: { reportType, decision, submissionReference: payload.submissionReference || null }
  });
  return { id };
}

module.exports = {
  ensureIntegritySchema,
  loadIntegrityConfig,
  saveIntegrityConfig,
  raiseAlert,
  runIntegritySweep,
  runProviderReconciliation,
  resolveAlert,
  resolveReconciliationException,
  recordRegulatoryReportEvent,
  ALLOWED_STATUS_TRANSITIONS,
  DEFAULT_INTEGRITY_CONFIG
};
