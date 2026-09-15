# TitoPay Email Centre deployment

## Safe deployment order

1. Back up PostgreSQL and the current API/Admin deployment directories.
2. Deploy the API files while leaving the current API process running.
3. Run `pnpm db:migrate` from `/opt/titopay-api`. This applies the additive Email Centre schema and seeds templates on first use.
4. Configure environment variables and restart `titopay-api`.
5. Start `titopay-email-worker` from `deploy/ecosystem.config.cjs` and verify its cycle log.
6. Deploy the Admin static files, including the complete `email-centre/` directory.
7. Send a test email, complete a test registration, and check Queue and Delivery Logs before enabling production volume.

Email OTP is deliberately disabled by default. Enable the global switch and only the approved event switches after SMTP/provider delivery, support procedures, and customer communication have been verified.

## Environment variables

Required existing variables remain unchanged: `POSTGRES_URL` (or `DATABASE_URL`), `JWT_ACCESS_SECRET`, and `JWT_REFRESH_SECRET`.

Email variables:

- `EMAIL_PROVIDER=smtp` (or `api`, `resend`, `postmark`, `brevo`, `mailgun`, `ses`, `sendgrid`)
- `EMAIL_FROM_NAME=TitoPay`
- `EMAIL_FROM_ADDRESS=no-reply@notify.titopay.co.za`
- `EMAIL_REPLY_TO=support@titopay.co.za`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`
- `SMTP_REJECT_UNAUTHORIZED=true`
- `EMAIL_API_URL` and `EMAIL_API_KEY` for an API provider
- `EMAIL_ENCRYPTION_KEY` (recommended independent 32+ character secret; falls back to the existing refresh secret for compatibility)
- `EMAIL_WEBHOOK_SECRET` for signed provider callbacks
- `EMAIL_WORKER_POLL_MS=2000` (optional)

Never place production values in source control. Provider credentials entered through Admin are AES-256-GCM encrypted and returned only as masks; production environment variables remain preferred.

The Email Centre reuses the existing **Integration Centre → Email / SMTP** configuration. API-provider credentials can also be supplied through the Super Admin-only provider endpoint. Resend, Postmark, Brevo, Mailgun, and SendGrid use provider-specific HTTPS payloads; Amazon SES uses its SMTP endpoint. Only the selected provider is active.

## PM2

```sh
cd /opt/titopay-api
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 status titopay-api titopay-email-worker
pm2 logs titopay-email-worker --lines 100
pm2 save
```

## Provider webhook

Configure the provider to POST JSON to `/v1/webhooks/email/{provider}` and sign the exact raw body with HMAC-SHA256 using `EMAIL_WEBHOOK_SECRET`. Send the hex digest in `X-TitoPay-Email-Signature` (an optional `sha256=` prefix is accepted). Do not place this endpoint behind Admin JWT authentication.

The webhook records every accepted provider event idempotently. Provider acceptance leaves a job at `sent`; only a verified delivered callback changes it to `delivered`. Bounce, complaint, rejection, dropped, and deferred events become failed delivery records.

## Email OTP operations

- Public login continuation: `POST /v1/auth/email-otp/verify` and `POST /v1/auth/email-otp/resend`, protected by the existing OTP limiter.
- Authenticated generation for an enabled event: `POST /v1/auth/email-otp/send`.
- Admin monitoring: `GET /v1/admin/email-otp/dashboard`, `GET /v1/admin/email-otp/logs`, and `GET /v1/admin/email-otp/settings`.
- Super Admin control: `PUT /v1/admin/email-otp/settings` and `POST /v1/admin/email-otp/{id}/revoke`.
- Authorised resend: `POST /v1/admin/email-otp/{id}/resend`.

OTP codes are generated with `crypto.randomInt`, stored only as SHA-256 hashes, expire after five minutes by default, are single use, and are revoked when replaced. The raw code exists only in the encrypted queue content needed for delivery. The Admin API, logs, variables, previews, and audit metadata redact it.

## Pricing policy

- Email OTP: **Free**
- Email Statement: **R0.10**
- Standard email notifications: **free**

These entries are registered in TitoPay's existing pricing engine. This release does not add an implicit wallet debit inside authentication or delivery handlers; billing must continue through the platform's authorised ledger workflow when the business enables collection.

## Marketing Email Production

Marketing → Email Production follows the existing request-and-approval pattern. Marketing users prepare a Personal, Business, Both, or specific-user production. A CEO or COO must approve it before one idempotent background queue job is created per matching active email recipient. Publishing does not send synchronously.

The supplied database has no dedicated marketing-email-consent field. Before production marketing use, TitoPay must confirm that the selected audience is lawfully contactable under its current consent and suppression process. Transactional messages are unaffected.

## Rollback

1. Disable sending in Email Settings and stop `titopay-email-worker`.
2. Restore the prior Admin and API release; existing routes and tables are not renamed by this release.
3. Leave additive Email Centre tables in place for a normal code rollback so queued and delivery records remain recoverable.
4. Only after a verified database backup, use `src/db/migrations/20260804_email_centre.down.sql` if permanent data removal is explicitly approved.

## Verification checklist

- API and worker are online; worker logs show successful cycles.
- `/v1/health` reports `emailWorker.status=ready`, no stale processing locks, and expected queue/dead-letter counts.
- Admin Email Centre is visible only to roles with Email permissions.
- Settings returns masked credentials and the required TitoPay sender identity.
- A queued test progresses from Queued to Sent; it is not marked Delivered until a verified provider webhook arrives.
- Personal and Business test registrations create one welcome and one verification job.
- Verification succeeds once, then rejects reuse, expiry, revocation, and an invalid token.
- Resend returns the same generic response for known and unknown addresses and observes cooldown/window limits.
- Password reset accepts the secure email link once and queues Password Changed.
- Test payments, QR payments, KYC submission, and support ticket creation complete even if the email provider is unavailable; their email job retries separately.
- Personal, Business, Admin authentication, payments, KYC, chat, QR, notifications, and support smoke tests remain green.
- With Email OTP disabled, password and existing Push Authentication behaviour is unchanged.
- With one Email OTP event enabled, password verification queues the OTP, invalid attempts decrement the remaining count, resend observes the cooldown, the old code fails, and the valid replacement completes login once.
- Pricing shows Email OTP and Email Notifications at R0.00, and Email Statements at R0.10.
- Marketing Email Production cannot publish before CEO/COO approval and duplicate approval never duplicates recipient jobs.

## Test-email procedure

Open Communications > Email Settings, select **Send test email**, enter a controlled inbox, verify the new Queue row, run the worker, then verify the Sent log. Where delivery webhooks are configured, wait for Delivered. A provider acceptance response alone must remain Sent.

## Registration end-to-end procedure

Create one Personal and one Business account with controlled inboxes. Confirm user/wallet rows commit before the queue records, verify duplicate welcome jobs are prevented by their idempotency keys, open the verification link once, confirm `users.email_verified_at`, and verify a second use is rejected without changing existing sign-in policy.

The Personal/Business web application must render the existing application-origin `/verify-email` and `/reset-password` success/failure views that call the new API endpoints. Those application sources were not present in the supplied Admin/API archives, so validate those pages in the deployed PWA before enabling registration email volume.

## Validation boundary

The source package can be syntax-checked, unit/regression-tested, and browser-tested without production credentials. A real PostgreSQL migration, SMTP/API delivery, signed provider callback, inbox rendering, and live Personal/Business journeys require TitoPay's controlled staging or production environment and must be completed using the checklist above. Never point automated local tests at the live wallet or payment database.
