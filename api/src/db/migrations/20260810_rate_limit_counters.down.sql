-- Safe to run at any time. The API falls back to per-process counting, which is
-- the behaviour from before the shared store existed, and logs that it has done
-- so. No other table refers to this one.
DROP INDEX IF EXISTS idx_rate_limit_counters_expires;
DROP TABLE IF EXISTS rate_limit_counters;
