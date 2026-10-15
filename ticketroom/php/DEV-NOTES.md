# TicketRoom PHP edition — developer notes

The PHP edition re-implements the Node API (`src/routes/*.js`) for shared hosting (Afrihost). The browser code in `public/assets/*.js` is shared and must keep working unchanged, so **JSON shapes, field names, status codes and error codes must match the Node routes exactly**.

Scope: accounts, organisers, events, free and paid tickets, transfers, scanning, marketing email and SMS, the Promote package, card payments (Yoco, PayFast, the practice sandbox), webhooks, refunds, payouts, the ledger and reconciliation, cashless (wristbands and tags, event wallets topped up by card, vendors, POS tills, spending PINs, wallet and sale refunds, vendor settlement), organiser verification (FICA), gate passes, admin, site settings, assistant. **Not** in this edition (return `throw not_available();`, or an empty list where a page only lists things): linked TitoPay wallets (`/api/me/payment-methods`).

## Layout
The package mirrors what sits in `public_html` (see `scripts/build-php.js`):
- Pages are plain `.html` files at the root (built from `public/*.html`), served by the web server with clean addresses from `php/public/.htaccess`. `php/public/index.php` is a front door that does the same mapping for hosts that send every request to PHP.
- `api/index.php` answers every `/api/` request and `/media/{id}` images; `api/bootstrap.php` loads config, finds the data folder, installs the database and first admin on the first request (no setup screen), runs upgrades and background jobs.
- `api/config.php` holds defaults (the admin's temporary password only as a hash, filled in at build time). The site's own settings are in `data/config.php`, created on first run and never touched by uploads; `data/keys.php` holds the signing keys.
- `api/lib/core.php` errors, time, db, router, validation (`R::*`, `check()`), crypto, sessions/CSRF, `limit()`, `audit()`.
- `api/lib/domain.php` access helpers, consent, orders, tickets, admission, uploads.
- `api/lib/messaging.php` `outbox_enqueue`, delivery, `tpl($name, $args)`, `email_catalog()`, `email_html()`, reminders.
- `api/lib/site.php` settings (`settings_all`, `setting`, `setting_set`, `hours_status`), assistant/KB.
- `api/lib/payments.php` providers (`pay_ready()`, `payment_start`, `payment_apply`), refunds, the ledger (`ledger_post`, `test:` accounts for test mode), organiser money.
- `api/lib/cashless.php` wristbands (`tag_*`), event wallets (`wallet_*`, never-negative `wallet_debit`), top-ups (payments with `purpose = 'topup'`), the till (`pos_charge`, idempotent by terminal + request key), wallet and sale refunds, vendor settlement, upgrade 14. Routes in `api/routes/cashless.php`. Ledger accounts: `wallet:<user>:<event>`, `vendor:<vendor>:event:<event>`, `revenue:cashless_commission`. Cashless is on when `cashless_ready()` (card payments ready and `cashless.enabled` not false) and the event has `cashless_enabled`.
- `api/routes/*.php` route files; every file in this folder is loaded for each API request.
- `api/schema.sql` SQLite schema, same table/column names as PostgreSQL.
- `deploy-check.php` and `set-password.php` open only while `data/unlock-check` / `data/unlock-reset` exist.

## Conventions
- Register: `route('GET', '/api/x/:id', function (array $a) { ... return [...]; });` Return an array (→ 200 JSON) or `json_out($data, 201)` / `raw_out($text, $type)`.
- Auth: `$u = require_auth();` / `require_role('admin')` / `has_role($u, 'admin', 'support')`. User array keys: `id, email, fullName, phone, emailVerified, platformRoles (list), primaryRole`.
- Request body: `body()` (decoded JSON array). Query: `qs('name')`.
- Validation: `$b = check(body(), ['name' => R::str(['min'=>2,'max'=>80]), 'n' => R::int(['min'=>0]), 'when' => R::date(['optional'=>true]), 'ok' => R::bool(), 'kind' => R::oneOf([...]), 'id' => R::uuid(), 'list' => R::arr(R::uuid(), ['max'=>20]), 'obj' => R::obj([...])])`. Optional fields that are absent are **omitted** from `$b` (use `$b['x'] ?? null`), unless a `fallback` is given. `R::bool()` defaults to false; pass `['optional'=>true,'fallback'=>null]` to tell "absent" from false. Errors → 422 `validation_failed` with `details`, like Node.
- Errors: `throw bad()` 400, `invalid([...])` 422, `forbidden()` 403, `not_found()` 404, `conflict($msg, $code)` 409, `new AppError($status, $code, $msg)`.
- DB: `rows($sql, $params)`, `row()`, `val()`, `q()`, `affected()`, `insert($table, $assoc)`, `tx(fn)` (BEGIN IMMEDIATE; nests safely). Positional `?` params only. `placeholders($list)` for `IN (...)`.
- IDs `uuid()`. Timestamps: ISO strings — `now_iso()`, `iso_in($seconds)` (negative for the past), `to_unix($iso)`. Compare in SQL as strings (`e.starts_at > ?` with `now_iso()`), never `now()`/`interval`.
- Booleans are stored 0/1. `rows()` converts columns named in `BOOL_COLS` (core.php) to true/false and JSON-decodes `JSON_COLS`. If you alias a boolean to another name, add it to `BOOL_COLS` or cast in PHP. Counts come back as ints.
- PostgreSQL → SQLite: `count(*) FILTER (WHERE x)` → `SUM(CASE WHEN x THEN 1 ELSE 0 END)` (or `SUM(x)` for a boolean expression; wrap in `COALESCE(…,0)`); `ILIKE` → `lower(col) LIKE lower(?)`; `= ANY($1)` → `IN (placeholders)`; `json_agg` → build arrays in PHP; `date_trunc` → compute bounds in PHP; `GREATEST` → `MAX(a,b)`; `RETURNING` works in SQLite 3.35+ but prefer `insert()` then `row()`.
- Audit: `audit('event.created', ['entityType'=>'event','entityId'=>$id,'organiserId'=>$orgId,'details'=>[...]])` (actor defaults to the signed-in user).
- Email: `outbox_enqueue(['to'=>$email,'userId'=>$id] + tpl('eventPublished', [...]))`; marketing: `'kind'=>'marketing','campaignId'=>…`. Delivery happens after the response.
- Settings: `settings_all()['support']['email']`, `setting_set($u, $key, $value)`.
- Uploads: `store_upload($ownerId, $orgId, raw_body())` returns an id; images are served at `/media/{id}`.
- Signed links: `sign_link(['u'=>$userId,'o'=>$orgId,'c'=>'email'], $ttl)`; `base_url()`.

## Organiser verification (FICA / KYC)
`lib/verification.php` (rules, storage, identity check, retention), `routes/verification.php` (API). Tables: `organiser_verification`, `verification_documents`, `event_risk` (schema.sql tail; upgrade 12 runs that tail, so it never touches other tables).
- **Rules** (`kyc_org_items`, `kyc_event_items`): computed from the kind of organiser (individual / company / npo), whether they sell paid tickets (`plans_paid` or any paid ticket type) and event risk (`kyc_event_risk`). Each item has a `reason` and `needFor` (`free_events`, `paid_events`, `payouts`). Individuals: ID (passport if foreign), terms, email; paid adds proof of address + bank letter (payouts only). Companies: CIPC certificate + registration number, representative's ID, authorisation letter if not a director; paid adds business address + bank letter. NPOs: certificate, constitution, representative's ID, resolution; paid adds bank letter. Phone is shown as "not verified" and blocks nothing (there is no phone verification yet).
- **Event items**: liquor licence (alcohol), permit (2 000+ people or a public space), insurance and safety plan (2 000+), artist authorisation (someone else's show), venue agreement (required if high risk, recommended for paid). High risk = 5 000+ people, festival, R1m+ of tickets, or a new organiser with R100k+ on sale; staff override per organiser or event. High risk adds five more documents.
- **Enforcement**: `kyc_require_for_event($ev, 'submitted')` on organiser submit, `'approved'` on admin publish; `kyc_require_for_payout()` on payout request, approve and mark-paid (409 `verification_required` / `bank_not_verified`, with `details.missing`). Changing bank details retires the bank letter.
- **Storage**: `data/private/<40 hex>`, AES-256-GCM with the data key (`kyc_seal`), magic bytes checked (PDF/JPG/PNG), max 10 MB or `post_max_size`. Upload: `POST /api/organiser/:orgId/verification/documents?requirement=…[&eventId=…]` with the raw file (core.php `csrf_check` and bootstrap's `$isUpload` know the path via `KYC_UPLOAD_RE`). Download only through `GET /api/verification/documents/:id/file` (owners, or staff with admin/support/finance), audited as `verification.document_viewed`.
- **Identity check** (`kyc_provider`): integration group `kyc` (`cfg('kyc.provider')`): manual, sandbox (`KYC_SANDBOX_RULE`), http (like the SMS http provider; `kyc.allowPrivateHosts` in data/config.php for tests only). SA ID numbers are validated locally by `sa_id_check()` (Luhn, date, 18+, citizenship digit).
- **Retention**: setting `verification` (`retentionYears` ≥ 5, `discardRejectedDays`), job `verification-retention`.
- Tests: `tests-ui/php-verification.js`; other suites use `tests-ui/kyc-helper.js` (`verifyOrganiser`) to get past the rules through the API.
- **How others do it** (from their public organiser help pages, worth rechecking): Quicket and Howler let anyone list free events and ask for ID, proof of address and a bank confirmation before paying out; Computicket and Ticketmaster onboard promoters through a sales contract with company papers. Ours: one checklist, only what the rules need for what you sell, a reason on every item, status as soon as you upload, free events never asked for bank details.

## Promote (R1500 event promotion package)
`lib/promote.php` (money, campaign rules, analytics), `routes/promote.php` (API). Tables `event_promotions`, `promotion_payments`; columns `campaigns.promotion_id`, `tracking_links.campaign_id` (upgrade 15, `tr_promote_tables()`, each only if missing; 13 is never used).
- **Purchase**: `POST /api/organiser/:orgId/events/:eventId/promotion/checkout {method: card|balance}` (owner/manager/marketing; balance: owner only, plus `kyc_require_for_payout`). Event must be published (verification approved) or pending (submitted), not over, not already promoted. Card payments are `promotion_payments` rows (not `payments`, so no clash with cashless `purpose = 'topup'`): `payment_apply`, `payment_sync`, `sandbox_payment` and the PayFast form fall back to them; `promo_payment_apply` activates the promotion. A payment that arrives for an event already promoted or over is returned at once (sandbox, Yoco) or flagged for a PayFast dashboard refund.
- **Ledger**: card `provider:<p>` DR / `revenue:promotions` CR (`test:` prefix in test mode); balance `organiser:<org>:deductions` DR / `revenue:promotions` CR, in one transaction with the balance check (`organiser_money()` counts deductions like payouts). Refunds reverse these (`promotion_refund`). `ledger_check()` includes live promotion payments in provider clearing; reconciliation matches them too.
- **Campaigns**: `promo_for_campaign()` = audience is exactly one event with an active promotion. Then: no daily cap (`ORG_DAILY_CAMPAIGN_LIMIT` counts only `promotion_id IS NULL`), `PROMO_HOURLY_LIMIT` (6) sends per organiser per hour, SMS allowed when `sms_ready()`, a tracking link `C…` per send (`{{event_link}}` in the body, or appended). Without Promote: unchanged (email, 10 a day, SMS refused with `sms_not_available`).
- **Analytics** (`promo_analytics`): sends from the outbox, clicks and orders/tickets/revenue via the campaign links (live orders only; test orders counted apart), no opens (not tracked), 30-day daily series.
- **Admin**: `GET /api/admin/promotions` (+ revenue live/test from the ledger), `POST /api/admin/promotions/:id/social`, `/refund` (finance; event cancelled or cancellation requested), `/refund/complete` (PayFast manual). Emails: `promotionConfirmed`, `promotionRefunded`, `socialRequested`, `socialPostLive`. Job `end-promotions`.
- Tests: `tests-ui/php-promote.js` (`TR_MOCK_PORT5` for its SMS stand-in).

## Running locally
```
TR_ADMIN_PASSWORD='Admin-pass-#2026' node scripts/build-php.js
cp -r var/php-build/public_html /tmp/x/public_html
php -S 127.0.0.1:PORT -t /tmp/x/public_html php/dev-router.php
# sign in as hello@ticketroom.co.za with that password
```
