SET search_path TO tr;
DROP INDEX IF EXISTS orders_test_idx;
ALTER TABLE tickets DROP COLUMN IF EXISTS test;
ALTER TABLE orders DROP COLUMN IF EXISTS test;
ALTER TABLE payments DROP COLUMN IF EXISTS environment;
