-- 014: payment sandbox. Every payment records the environment of the
-- provider that took it (live, sandbox, test, mock). Orders paid in test mode
-- (the TicketRoom sandbox, a provider's sandbox or test keys) are test orders:
-- their tickets never open a gate and their money is booked to "test:" ledger
-- accounts that never reach an organiser's balance, a payout or sales totals.
-- The local simulator and mocks ("mock") stand in for a live provider in
-- development and automated tests.
SET search_path TO tr;

ALTER TABLE payments ADD COLUMN environment text NOT NULL DEFAULT 'live';
UPDATE payments SET environment = 'mock' WHERE provider = 'simulated';
UPDATE payments SET environment = 'test' WHERE provider = 'sandbox';

ALTER TABLE orders ADD COLUMN test boolean NOT NULL DEFAULT false;
ALTER TABLE tickets ADD COLUMN test boolean NOT NULL DEFAULT false;
UPDATE orders SET test = true WHERE id IN (SELECT order_id FROM payments WHERE order_id IS NOT NULL AND environment IN ('sandbox','test'));
UPDATE tickets SET test = true WHERE order_id IN (SELECT id FROM orders WHERE test);
CREATE INDEX orders_test_idx ON orders (test) WHERE test;
