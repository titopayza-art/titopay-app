-- ---------------------------------------------------------------------------
-- Banking integration foundation.
--
-- Four tables. NOT ONE OF THEM HOLDS A BALANCE, and not one of them can move
-- money. `wallets`, `wallet_ledger`, `revenue_ledger` and `transactions` remain
-- the only financial record TitoPay has, and nothing here is additive to a
-- balance, subtractive from one, or consulted when computing one.
--
-- What these tables ARE: the lifecycle of a payment inside a BANK, recorded
-- beside the transaction it describes. A bank has states TitoPay's transaction
-- lifecycle has no word for (a consent requested, a consent granted, an
-- instruction submitted, an outcome nobody can yet establish), and writing them
-- into `transactions.status` would mean redefining a column that is read across
-- the platform and protected by triggers. So they live here and map down.
--
-- Additive only. No ALTER, no DROP, no DELETE, no TRUNCATE, and no existing
-- table is touched. Reversible: see the matching .down.sql.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Capability approvals.
--
-- The record that a named capability, from a named provider, in a named
-- environment, has actually been agreed: commercially, contractually and where
-- relevant by a regulator. It is one of four gates, and it is the only one that
-- represents a decision taken outside this codebase.
--
-- A ROW HERE DOES NOT ACTIVATE ANYTHING. The server flag must also be set, the
-- adapter must implement the operation, and its configuration must resolve.
-- This exists so that "somebody ticked a box in a console" can never be the
-- whole story behind a bank rail being live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_capability_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Free text, deliberately. A provider is a configuration value, not a schema
  -- change: adding a bank must never require a migration. (The older
  -- pos_terminals/pos_payment_intents tables pin their provider with a CHECK
  -- listing four bank names; that is the pattern this one does not repeat.)
  provider TEXT NOT NULL,
  -- TitoPay's own capability vocabulary, so a CHECK here is a check on our
  -- words rather than a supplier's.
  capability TEXT NOT NULL CHECK (capability IN (
    'CUSTOMER_PAYMENT_INITIATION','ACCOUNT_INFORMATION','ACCOUNT_VERIFICATION',
    'TRANSACTION_HISTORY','PAYMENT_STATUS','WITHDRAWAL','PAYOUT','REFUND',
    'RECONCILIATION','SETTLEMENT','CONSENT_MANAGEMENT'
  )),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  -- Who decided, on what evidence. A capability approved with no reference to
  -- anything is an approval nobody can audit later.
  approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  approval_reference TEXT,
  reason TEXT,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, capability, environment)
);
CREATE INDEX IF NOT EXISTS idx_banking_approvals_lookup
  ON banking_capability_approvals (provider, environment, capability)
  WHERE approved AND revoked_at IS NULL;


-- ---------------------------------------------------------------------------
-- 2. The sidecar: a payment's lifecycle inside the bank.
--
-- ONE INTENT PER TRANSACTION, enforced by a unique constraint on
-- transaction_id, and the transaction must already exist. That ordering is
-- taken from the card top-up path, which writes its transaction row BEFORE it
-- calls the provider, so that there is never a provider-side payment with no
-- TitoPay record of it. An intent describes a transaction; it never substitutes
-- for one.
--
-- `canonical_state` is TitoPay's word for where the payment sits. It maps to
-- `transactions.status`, which keeps its own lifecycle and its own triggers.
-- Where the two disagree, the transaction is authoritative for money and this
-- is authoritative for the bank conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Explicit ownership. RESTRICT rather than CASCADE: a transaction with a bank
  -- conversation attached to it is not something to remove quietly.
  transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  capability TEXT NOT NULL CHECK (capability IN (
    'CUSTOMER_PAYMENT_INITIATION','WITHDRAWAL','PAYOUT','REFUND'
  )),
  canonical_state TEXT NOT NULL CHECK (canonical_state IN (
    'CREATED','CONSENT_PENDING','AUTHORISED','PAYMENT_PENDING','SUCCESS',
    'FAILED','REJECTED','EXPIRED','IN_DOUBT','CANCELLED','REFUNDED'
  )),
  -- A copy of what the server authorised, so a provider's answer can be checked
  -- against something immutable. It is evidence, never a balance.
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The provider's side of the conversation, kept in the provider's own words.
  provider_transaction_id TEXT,
  provider_reference TEXT,
  provider_status TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  -- Required, and unique per provider. Idempotency is a precondition of
  -- creating an intent, not something bolted on afterwards.
  idempotency_key TEXT NOT NULL,
  failure_reason TEXT,
  requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A retried request finds the original instead of starting a second payment.
  UNIQUE (provider, idempotency_key),
  -- One provider-side payment can only ever attach to one intent, so a replayed
  -- or duplicated provider identifier cannot quietly spawn a second record.
  UNIQUE (provider, environment, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_banking_intents_state
  ON banking_payment_intents (canonical_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_banking_intents_user
  ON banking_payment_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_banking_intents_provider_ref
  ON banking_payment_intents (provider, provider_reference);
-- The operator's queue: everything unresolved, newest last.
CREATE INDEX IF NOT EXISTS idx_banking_intents_review
  ON banking_payment_intents (created_at)
  WHERE requires_review OR canonical_state = 'IN_DOUBT';


-- ---------------------------------------------------------------------------
-- 3. State history. Append only, and never written by hand.
--
-- The same idea as transaction_status_history, for the bank-side lifecycle:
-- every canonical state change recorded with what caused it, so that "how did
-- this reach SUCCESS?" is answerable months later without a provider's logs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_state_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES banking_payment_intents(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  -- What moved it: a status query, a callback, an operator, a sweep. A state
  -- that changed because of a callback alone is visible here as exactly that.
  source TEXT NOT NULL,
  provider_status TEXT,
  actor_type TEXT,
  actor_id UUID,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_banking_transitions_intent
  ON banking_state_transitions (intent_id, created_at);


-- ---------------------------------------------------------------------------
-- 4. Provider events (callbacks).
--
-- THIS TABLE EXISTS BECAUSE platform_settings WAS BEING USED FOR THIS.
-- Webhook idempotency keys were written as settings rows, which is why the
-- sandbox database holds 234 of them against a fresh database's 4, and why
-- going live carries a written warning never to copy that table. Bank callbacks
-- get a real home with a real unique constraint.
--
-- A ROW HERE IS NOT EVIDENCE THAT MONEY MOVED. It records that something
-- arrived and whether its signature checked out. What actually happened is
-- established by asking the provider directly, and only that answer may settle
-- anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  -- The provider's own identifier for this delivery. The idempotency constraint
  -- below is the reason duplicate delivery cannot produce duplicate effect.
  event_id TEXT NOT NULL,
  event_type TEXT,
  -- Whether the signature verified. Recorded rather than assumed, so a run of
  -- unverifiable deliveries is visible as a security signal instead of silence.
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  intent_id UUID REFERENCES banking_payment_intents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  request_id TEXT,
  source_ip TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_banking_events_unprocessed
  ON banking_provider_events (received_at)
  WHERE status IN ('received','processing','failed');
CREATE INDEX IF NOT EXISTS idx_banking_events_intent
  ON banking_provider_events (intent_id, received_at DESC);
