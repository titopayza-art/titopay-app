SET search_path TO tr;
DROP TABLE IF EXISTS reconciliation_items, reconciliation_runs, payouts, refund_tickets, refunds,
  pos_sale_items, pos_sales, terminals, products, vendor_members, vendors;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_topup_fk;
DROP TABLE IF EXISTS wallet_topups;
DROP TRIGGER IF EXISTS tag_events_append_only ON tag_events;
DROP TABLE IF EXISTS tag_events, tags, tag_batches;
DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
DROP TRIGGER IF EXISTS journals_append_only ON journals;
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
DROP TRIGGER IF EXISTS journals_no_truncate ON journals;
DROP TABLE IF EXISTS ledger_entries, journals, ledger_accounts;
DROP FUNCTION IF EXISTS assert_journal_balanced();
DROP FUNCTION IF EXISTS assert_journal_has_entries();
