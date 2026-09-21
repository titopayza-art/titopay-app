-- Reverses the default only. The row values are NOT put back to FALSE: doing
-- that would strip the transfer setting from organisers who deliberately left
-- it on after the up migration, and there is no record of which rows were
-- touched by the backfill and which were chosen since.
ALTER TABLE event_ticket_types ALTER COLUMN transfer_allowed SET DEFAULT FALSE;
