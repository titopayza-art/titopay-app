-- ---------------------------------------------------------------------------
-- Reverse the banking integration foundation.
--
-- Dropped in dependency order: events and transitions reference intents,
-- intents reference transactions and users. Nothing outside this migration is
-- touched, and no financial table is read or written, so reversing this cannot
-- alter a single balance.
--
-- This is never run by a deploy. `scripts/apply-migrations.js` only ever
-- applies .up.sql files; reversing is a decision a person takes deliberately,
-- with a backup.
--
-- ONE THING TO KNOW BEFORE RUNNING IT: banking_state_transitions and
-- banking_provider_events are the audit trail of every bank conversation the
-- platform has had. If any provider has ever been live, dropping them destroys
-- that history, and no other table holds a copy. Reverse this on a deployment
-- where the banking layer was never activated, or export first.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS banking_provider_events;
DROP TABLE IF EXISTS banking_state_transitions;
DROP TABLE IF EXISTS banking_payment_intents;
DROP TABLE IF EXISTS banking_capability_approvals;
