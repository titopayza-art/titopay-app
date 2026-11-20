-- 005: the SIMULATED payment provider's own records. This stands in for an
-- external provider during development and tests. It lives in its own schema
-- and is never read by TicketRoom business logic except through the provider
-- adapter and the reconciliation report, exactly like a real provider would be.
CREATE SCHEMA IF NOT EXISTS sim_provider;
CREATE TABLE sim_provider.transactions (
  reference      text PRIMARY KEY,
  merchant_ref   text NOT NULL,
  amount_cents   bigint NOT NULL,
  refunded_cents bigint NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  notify_url     text NOT NULL,
  return_url     text NOT NULL,
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE TABLE sim_provider.refunds (
  reference      text PRIMARY KEY,
  transaction_ref text NOT NULL REFERENCES sim_provider.transactions(reference),
  amount_cents   bigint NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
