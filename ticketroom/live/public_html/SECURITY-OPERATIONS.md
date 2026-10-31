# TicketRoom production security requirements

This package is an application release, not a complete production
infrastructure. Do not mark a deployment production-ready until every control
below is implemented and evidenced by the hosting team.

## Before first setup

1. Install a valid TLS certificate for `ticketroom.co.za`; HTTP is redirected
   and must never be used for setup or sign-in.
2. Create `ticketroom-data` beside `public_html`, owned by the PHP user and
   inaccessible from the web. New installations refuse a data folder inside
   `public_html`.
3. Generate a unique 32+ character bootstrap secret in
   `ticketroom-data/bootstrap-secret`; open `/setup.php` over HTTPS within 15
   minutes and create the owner account. The file is deleted on success. Wrong
   guesses are audited and do not delete the file; keep the setup window brief.
4. Store a 64-hex-character `TICKETROOM_MASTER_KEY` in the hosting secret
   manager/environment before saving production integration credentials. Do
   not introduce it to an existing site without migrating its encrypted values:
   the old generated data key is required to decrypt them.
5. TicketRoom staff logins require a password plus a one-time six-digit code
   sent to the staff account's verified email address. Protect that mailbox
   with its own MFA, unique credentials, and recovery controls. Also turn on
   MFA for cPanel, CDN, and payment providers. Before staff begin using the
   release, test OTP delivery to every staff mailbox and confirm mail delivery
   remains monitored (SPF/DKIM/DMARC and bounce handling).

## Existing installation data migration

Older releases can keep `data/` or `tr-data/` below `public_html` so an
upgrade does not silently switch databases. This compatibility behavior is
not a security boundary: `.htaccess` denial is only defence in depth. The
locked deploy check now marks an in-web-root data folder as **Fix** and probes
the common database, key, config, WAL/SHM and upload URLs.

To migrate without changing or deleting the current installation:

1. Schedule a maintenance window. Enable maintenance, pause `api/cron.php`
   temporarily, and have the host make a consistent SQLite backup (including
   the current WAL state) plus a separate backup of keys, config and uploads.
2. Create `ticketroom-data` beside `public_html` with the PHP account as owner
   and restrictive directory/file permissions. Copy the complete contents of
   the active data directory, including `.installed`, `keys.php`, `config.php`,
   the SQLite database and its uploads. Do not generate new signing keys.
3. Keep the original directory untouched. Open the site and confirm that the
   new private directory is selected, the same users/events/orders are present,
   an existing ticket still validates, and configured integrations decrypt.
   Then run the locked deploy check and confirm the database/key/config/upload
   URL probes are all denied (403 or 404).
4. Resume cron and test login, a free order, mail, and provider connection.
   Only after verification and a recoverable backup should the host remove the
   old web-root copy. Do not delete either copy during the migration window.

If the host cannot create a private directory beside the document root, use a
hosting plan that supports it rather than leaving production data under the
website folder.

## Email domain authentication

SPF is present on the domain, but DMARC is currently `p=none` (monitoring
only). Before tightening it, enumerate every legitimate sender used by
TicketRoom, ensure each uses the domain's single SPF record or aligned DKIM,
and configure DKIM in the mail provider. Publish a DMARC reporting address
controlled by the organisation and review reports for at least two weeks.
Then move gradually to `p=quarantine` (for example `pct=10`, then 100) and
finally `p=reject` when reports show legitimate mail passes alignment. Make
these DNS changes in the authoritative DNS provider and verify them with
external DNS lookups; do not publish a strict policy before all transactional
and support-mail senders are known, as it can suppress real ticket emails.

Sessions expire after 15 minutes without activity and have a 14-day maximum
lifetime. Existing sessions receive at most a 15-minute grace period on upgrade;
authenticated requests then maintain the inactivity deadline. Staff do not need
to sign out solely because of this release.

## Application request hardening

This release adds an Origin and Fetch Metadata check to every state-changing
browser API request, alongside the existing session-bound CSRF token. Requests
marked `Sec-Fetch-Site: cross-site` are rejected, and any supplied `Origin`
must match the configured canonical site origin. Signed payment-provider
webhooks continue through their own signature checks. Sign-in, checkout and
back-office page shells are served with `no-store` and `noindex`; the site
also sends Cross-Origin-Opener-Policy and sets the legacy cross-domain policy
header to `none`. The public app shell used by offline ticket wallets and
scanners remains available to the service worker; private API responses are
not cached there.

After deployment, verify this in staging: a normal same-origin account action
should still work; a state-changing request with a different `Origin` or
`Sec-Fetch-Site: cross-site` should return 403; a provider webhook should only
be accepted with its configured signature; and account/admin/checkout pages
should return `Cache-Control: no-store`. Do not use a live customer account or
payment to test these rejection cases.

These application checks complement, and do not replace, the host controls
below. They do not prove the database is outside the document root, backups
are protected, secrets are isolated, or administrator access is secure.

## Required host controls

- Terminate TLS at the edge, redirect all HTTP traffic, and monitor certificate
  expiry. Do not forward untrusted `X-Forwarded-Proto` headers to PHP.
- Use a WAF/CDN with DDoS protection and login/API rate-limit monitoring.
- Disable directory listing and PHP execution outside the application; add
  web-server deny rules for data, backups, source, and deployment archives.
- Use least-privilege filesystem ownership. The web user may write only the
  private data directory, never application code.
- Keep an encrypted off-host backup of the database, keys, and uploads; test a
  complete restore at least quarterly. Preserve the QR/link keys with backups.
  The site makes a consistent database copy (`VACUUM INTO`) daily, before every
  upgrade and on demand, in `ticketroom-data/backups` (newest 14 kept; Admin
  portal, Backups; downloads are audited). These are on the same server, so
  they do not replace the off-host copy.
- Run `api/cron.php` at least every five minutes under the site account, with
  the full PHP path (`/usr/local/bin/php /home/USER/public_html/api/cron.php
  >/dev/null 2>&1`); do not rely on visitor traffic for payment expiry, mail,
  retention, backups or campaigns. It prints only on failure and exits 1.
- Monitor `/api/health` for `"healthy":true` (job freshness, cron, email
  backlog and backup age). The owner also gets one alert email at most every
  six hours while something is stuck.
- PHP errors are never displayed; they go to `ticketroom-data/php-errors.log`.
  A stray `error_log` file in `public_html` is blocked by `.htaccess`.
- HSTS is sent for `ticketroom.co.za` only. Add `includeSubDomains` (in
  `.htaccess` and `api/lib/core.php`) only once every subdomain (mail.,
  cpanel., webmail. and any others) has a valid certificate.
- If `ticketroom-data` or `keys.php` disappears on an installed site, the site
  stops (503) and logs why rather than starting an empty site or making new
  keys. Restore from backup; see DEPLOY-AFRIHOST.md, "If the site stops itself".
- Send PHP/web-server logs to monitored storage and alert on repeated login
  failures, webhook rejection/failure, database-lock errors, error-rate spikes,
  changes to integration settings, and any request for private files.

## Capacity and privacy

- SQLite serializes writes. Load-test the exact hosting plan before major sales
  or gates; migrate transactional data to managed PostgreSQL/MySQL when peak
  concurrent orders/scans exceed the tested envelope.
- Offline scanners keep attendee data locally. Issue only managed, screen-
  locked devices; clear site data after the event and revoke staff access when
  a device is lost.
- Test provider sandbox webhooks, refunds, order idempotency, and backup
  restoration in staging before each production release.
- Additional successful charges for an already-settled order are held as an
  overpayment liability and a full refund is initiated. Yoco/sandbox refunds
  run automatically; PayFast refunds appear in Finance as `manual_pending` and
  must be sent in the provider dashboard before their reference is recorded.
  Reconcile this queue daily and reconcile provider history after upgrades.

## Controlled emergency tools

`deploy-check.php` and `set-password.php` return 404 by default. Enable either
only for a documented, short maintenance window in the private config, create
the corresponding private unlock file, use it over HTTPS, then delete the file
and disable the feature immediately. Treat use as a security event and rotate
the recovered account's sessions and relevant secrets.
