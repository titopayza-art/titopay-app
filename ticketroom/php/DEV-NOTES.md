# TicketRoom PHP edition — developer notes

The PHP edition re-implements the Node API (`src/routes/*.js`) for shared hosting (Afrihost). The browser code in `public/assets/*.js` is shared and must keep working unchanged, so **JSON shapes, field names, status codes and error codes must match the Node routes exactly**.

Scope: everything for free events (accounts, organisers, events, free tickets, transfers, scanning, marketing email, admin, site settings, assistant). **Not** in this edition (return `throw not_available();`, or an empty list where a page only lists things): payments, refunds of paid orders, payouts, settlements, ledger, reconciliation, webhooks, cashless wallets/top-ups, tags/wristbands, vendors, POS, terminals, SMS.

## Layout
- `app/bootstrap.php` front controller (`tr_handle`), page routing, maintenance, background jobs.
- `app/lib/core.php` errors, time, db, router, validation (`R::*`, `check()`), crypto, sessions/CSRF, `limit()`, `audit()`.
- `app/lib/domain.php` access helpers, consent, orders, tickets, admission, uploads.
- `app/lib/messaging.php` `outbox_enqueue`, delivery, `tpl($name, $args)`, `email_catalog()`, `email_html()`, reminders.
- `app/lib/site.php` settings (`settings_all`, `setting`, `setting_set`, `hours_status`), assistant/KB.
- `app/routes/*.php` route files; every file in this folder is loaded for each API request.
- `app/schema.sql` SQLite schema — same table/column names as PostgreSQL.

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

## Running locally
```
node scripts/build-php.js --setup-code TESTCODE1234
cp -r var/php-build/public_html /tmp/x/public_html
php -S 127.0.0.1:PORT -t /tmp/x/public_html php/dev-router.php
curl -c jar -X POST http://127.0.0.1:PORT/ --data-urlencode setupCode=TESTCODE1234 --data-urlencode fullName=Admin \
  --data-urlencode email=admin@test.local --data-urlencode password=admin-pass-123 --data-urlencode password2=admin-pass-123 \
  --data-urlencode baseUrl=http://127.0.0.1:PORT
```
Then edit `/tmp/x/ticketroom-data/config.php`: set `'mail' => ['mode' => 'log', ...]`, add `'dev' => true, 'rateLimitDisabled' => true, 'cookieSecure' => false`. API calls need the session cookie and the `x-csrf-token` header from `GET /api/auth/me`, and `content-type: application/json`.
