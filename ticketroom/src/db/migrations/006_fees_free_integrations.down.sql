SET search_path TO tr;
DROP TABLE IF EXISTS integration_calls, wallet_link_requests, wallet_links;
DROP INDEX IF EXISTS refunds_one_open_wallet;
CREATE UNIQUE INDEX refunds_one_open_wallet ON refunds (user_id, event_id)
  WHERE kind = 'wallet_balance' AND status IN ('requested','approved','processing');
UPDATE refunds SET status = 'processing' WHERE status = 'manual_pending';
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('requested','approved','rejected','processing','completed','failed'));
ALTER TABLE payments DROP COLUMN IF EXISTS method, DROP COLUMN IF EXISTS checkout_context;
DROP TRIGGER IF EXISTS ticket_types_free_event ON ticket_types;
DROP FUNCTION IF EXISTS assert_free_event_prices();
ALTER TABLE events DROP COLUMN IF EXISTS is_free;
ALTER TABLE refunds DROP COLUMN IF EXISTS organiser_fee_cents;
ALTER TABLE orders DROP COLUMN IF EXISTS organiser_fee_cents;
ALTER TABLE organisers DROP COLUMN IF EXISTS commission_bps;
