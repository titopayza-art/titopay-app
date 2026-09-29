-- MAKE event_ticket_types.transfer_allowed MEAN WHAT IT SAYS.
--
-- The column has existed since the table was written, defaulting to FALSE, and
-- nothing ever read it: /tickets/claim moved a ticket into whoever's account
-- presented the code, regardless. No UI ever set it either, so EVERY ticket
-- type on the platform carries FALSE — not because an organiser chose that,
-- but because `Boolean(undefined)` is false and nobody was asking.
--
-- The claim now enforces the column. Enforcing it against the data as it
-- stands would switch gifting off for every ticket already sold, which is a
-- capability holders have today and have done nothing to lose. So the data is
-- corrected to describe the behaviour that has actually been in force:
--
--   * existing rows are set to TRUE, once, by this migration. They were
--     created in a world where transfer always worked; TRUE is the honest
--     record of that, and FALSE would be retroactively revoking something.
--   * the column default becomes TRUE, so a ticket type created by an
--     organiser who does not mention transfer keeps behaving the way the
--     platform always has.
--
-- Being a tracked migration is the point: it runs exactly once. An organiser
-- who deliberately switches transfer off after this will not have it switched
-- back on by the next deploy.

ALTER TABLE event_ticket_types ALTER COLUMN transfer_allowed SET DEFAULT TRUE;

UPDATE event_ticket_types SET transfer_allowed = TRUE WHERE transfer_allowed = FALSE;
