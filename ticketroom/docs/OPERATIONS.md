# Deployment, rollback, monitoring and incident response

> Nothing has been deployed. These are instructions for TitoPay's team. Do not change DNS, Cloudflare or production hosting without explicit approval.

## Hosting requirements

TitoPay's PWA is static hosting on Afrihost. **TicketRoom needs a Node.js runtime and PostgreSQL**, so it cannot run on the same static host. Options, in order of preference:

1. The same platform that runs `api.titopay.co.za` (not visible from this repo). A separate service, separate database, same operational tooling.
2. A small VM or container platform in a South African region (data residency): 2 vCPU / 4 GB for the app, plus managed PostgreSQL 16 with PITR backups. Indicative cost is in the R1,500–R4,000 per month range depending on provider and backup retention. **Get a quote before committing.**

## Database roles (required)

```sql
CREATE ROLE ticketroom_owner LOGIN PASSWORD '…';           -- runs migrations; owns tables
CREATE DATABASE ticketroom OWNER ticketroom_owner;
CREATE ROLE ticketroom_app LOGIN PASSWORD '…';              -- the running app
-- after `npm run migrate` as owner:
GRANT USAGE ON SCHEMA tr, sim_provider TO ticketroom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tr, sim_provider TO ticketroom_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tr TO ticketroom_app;
-- ticketroom_app does not own tables, so it cannot DISABLE TRIGGER or ALTER them.
```

## First deployment (staging first, always)

```bash
git checkout claude/ticketroom-platform && cd ticketroom
npm ci --omit=dev                                  # exact versions from package-lock.json
cp .env.example .env && $EDITOR .env               # real keys from the secret manager
DATABASE_URL=<owner url> npm run migrate           # deliberate step, not on boot
NODE_ENV=production DATABASE_URL=<app url> node server.js    # behind a process manager
curl -s https://staging.ticketroom.co.za/api/health
```

Put Cloudflare or another reverse proxy in front: TLS, `TRUST_PROXY=true`, WAF and rate rules on `/api/auth/*`, `/api/webhooks/*` and `/api/pos/*`. Serve on `ticketroom.co.za` only after the staging sign-off.

Do **not** run `npm run seed` in production. It refuses to run when `NODE_ENV=production`.

## Releases and rollback

1. Take a database snapshot (PITR marker) before every release.
2. Migrations are additive where possible. Every migration has a `.down.sql`.
3. Deploy the new build to staging, run `npm test` and `npm run test:ui` against it, then promote.
4. **Rollback the app:** redeploy the previous build. It stays compatible unless the release contained a migration.
5. **Rollback a migration:** `DATABASE_URL=<owner url> npm run migrate:down -- 1`. ⚠ Down migrations **drop tables and lose data**. In production, prefer roll-forward fixes. Never revert `003` (the ledger) after real transactions exist. Restore from the snapshot instead, and reconcile against the provider.
6. **Remove TicketRoom completely from the repository:** `git rm -r ticketroom .github/workflows/ticketroom.yml`. TitoPay is unaffected because no TitoPay file was changed.

## Environment variables

See `.env.example` (every variable, with no real values). Production refuses to start if any key (`QR_SIGNING_KEY`, `TAG_PEPPER`, `DATA_ENCRYPTION_KEY`, `LINK_SIGNING_KEY`, `SIM_PROVIDER_WEBHOOK_SECRET`) or `DATABASE_URL` is missing. It also refuses `PAYMENT_PROVIDER=simulated` unless explicitly allowed.

⚠ Rotating `QR_SIGNING_KEY` invalidates every issued ticket QR, and rotating `TAG_PEPPER` orphans every registered tag. Both need key-versioning support before rotation (not built). `DATA_ENCRYPTION_KEY` rotation needs re-encryption of `organisers.bank_account_enc`.

## Backups

* PostgreSQL PITR with ≥ 30 days retention, plus a nightly logical dump to separate storage.
* `UPLOAD_DIR` (event images) backed up nightly.
* **Restore drill:** before the pilot, restore to a scratch instance, run `npm run migrate` (no-op), then `GET /api/admin/reconciliation` (ledger integrity) and `GET /api/admin/audit/verify`. **Not yet performed.**

## Monitoring and alerts

| Signal | Source | Alert when |
|---|---|---|
| Liveness | `GET /api/health` (checks DB) | 2 consecutive failures |
| Ledger balanced | `/api/admin/dashboard` → `ledger.balanced` | Ever false (page immediately) |
| Provider clearing check | same → `ledger.clearing[].ok` | false |
| Audit chain | `/api/admin/audit/verify` (daily) | `ok: false` |
| Webhook failures/rejections | `ops.webhook_problems` | > 0 in 15 min |
| Stale pending payments | `ops.stale_payments` | > 0 for 30 min |
| Paid but unfulfilled orders | `ops.unfulfilled` | > 0 |
| Failed refunds | `ops.refunds_failed` | > 0 |
| Reconciliation exceptions | `ops.recon_exceptions` | > 0 after the daily run |
| Message failures | `ops.messages_failed` | > 10/hour |
| 5xx rate | proxy logs (`[error] <request id>` in app logs) | > 1% over 5 min |
| Terminal heartbeat | `terminals.last_seen_at` | Active terminal silent > 10 min during an event |

The dashboard endpoint needs a platform session. For an external monitor, add a token-protected `/api/ops/status` (not built) or poll the database directly.

## Incident response

| Incident | Immediate action | Then |
|---|---|---|
| Suspected double charge | Check `payments` and `pos_sales` by reference. Duplicate keys are impossible by constraint. Look for two distinct requests. | Refund through the normal maker-checker flow. Note in the case. |
| Provider outage | POS shows "offline — cannot confirm". Checkout errors with "nothing charged". | Pending orders are not expired while the provider is unreachable. Run a reconciliation after recovery. |
| Webhooks not arriving | Admin → Payments → "Re-check" queries the provider directly | Fix the provider notify URL or firewall. Run reconciliation. |
| Lost or stolen terminal | Organiser or admin: suspend the terminal | Register a new terminal. Review that terminal's `pos_sales`. |
| Cloned or abused tag | Block the tag (desk, support or admin) | Review `tag_events` and `pos_sales` for the tag. Refund the attendee if fraudulent. |
| Ledger unbalanced or audit chain broken | **Stop financial operations** (suspend events, POS terminals) | Preserve the DB snapshot. Investigate who had owner-level DB access. |
| Data breach | Follow TitoPay's breach procedure. POPIA s22 requires notifying the Information Regulator and affected persons "as soon as reasonably possible". | Rotate keys, revoke sessions (`UPDATE sessions SET revoked_at = now()`) |

Escalation contacts and on-call rota: **to be supplied by TitoPay**.
