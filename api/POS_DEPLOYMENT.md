# POS Deployment and Rollback

## Pre-deployment

1. Back up the PostgreSQL database and verify restore access.
2. Deploy the API archive without deleting the existing `.env`.
3. Configure `POS_PROVIDER_WEBHOOK_SECRET` and `POS_TERMINAL_ENCRYPTION_KEY` as
   separate new high-entropy secrets. Keep the terminal encryption key stable
   across deployments so registered terminals remain usable.
4. Confirm `POS_QR_LINK_BASE`, QR expiry, signature tolerance, and maximum amount.
5. Run `npm run db:migrate`; the migration only adds `pos_*` tables and three
   POS pricing codes.
6. Run `npm test`.

## Smoke checks

- Existing `/v1/webhooks/provider` GET returns readiness JSON and its POST still
  validates the Peach signature.
- Existing customer, merchant, admin, wallet, transaction, QR, and HR endpoints
  retain their original authentication.
- Unsigned POS terminal calls return 401.
- Register one sandbox terminal; save its one-time terminal secret securely.
- Create, resolve, confirm, poll, refund, and reconcile a low-value sandbox
  payment.

## Rollback

Roll back the application release first. The added tables do not alter existing
wallet, merchant, authentication, Peach webhook, or transaction columns, so they
may remain in place during application rollback. Do not drop POS tables until
their transaction and audit records have been retained according to policy.
