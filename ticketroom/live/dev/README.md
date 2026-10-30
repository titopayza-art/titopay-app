# Local test harness for the live package

`ticketroom/live/public_html/` is the package that runs on ticketroom.co.za
(Afrihost, PHP 8 + SQLite). This folder runs a fresh copy of it locally, makes
the first owner, seeds test data and smoke-tests it in Chromium. Nothing here
changes `live/public_html`.

| File | What it does |
| --- | --- |
| `router.php` | Router for `php -S` that mirrors `public_html/.htaccess` and `api/.htaccess`: clean addresses to `.html` pages, `/api/*` and `/media/*` to `api/index.php`, 301s for moved addresses, `/x.html`, `/index` and stray trailing slashes, 403 for `data/`, `tr-app/`, `tr-data/`, `maintenance.on`, hidden files, `.md/.sql/.sqlite/.zip/...` and `START-HERE.txt`, `404.html` for anything else, maintenance mode through `index.php`, and the same response headers (CSP etc.). It sets `HTTPS=on` (TLS is assumed to end in front of PHP), so `setup.php` and the `enforceHttps` redirect behave as on the host. |
| `serve.sh <port> <dir>` | Builds a fresh copy with `scripts/build-live.js` into `<dir>/public_html`, creates `<dir>/ticketroom-data` next to it (where `tr_data_dir()` looks), serves it, runs the first-owner ceremony and seeds. |
| `seed.js` | Test data through the site's own APIs (see below). Writes `<dir>/seed.json`. |
| `smoke.js <dir> [port]` | The Playwright smoke test. |
| `lib.js` | API client (cookie jar + CSRF token) and outbox/SQLite readers shared by the two scripts. |
| `TRIAGE.md` | The audit findings checked against the live code. |
| `run-all.sh [port] [dir]` | Serves a fresh instance, runs `smoke.js` and every suite in `tests/`, stops the server it started. Also `npm run test:live` in `ticketroom/`. |
| `tests/money.js` | Money regression tests (refunds, resale, payouts, test money, reconciliation); scenarios are built in the PHP CLI with `tests/money-lib.php`. Uses a Yoco mock on port 8790 (`TR_MONEY_MOCK_PORT`); `TR_ONLY=M10` runs one item. |
| `tests/ops.js <dir> [port]` | Operations and security regressions (O* and S* in TRIAGE.md): email lease and retries, backups, keys and data folder, cron, health, rate limits, uploads, emails. Uses SMTP stand-ins on 127.0.0.1:8800-8802 (and 8804 as a closed port); `TR_OPS_MOCK_PORTS=a,b,c,d` moves them. |
| `run-all.sh <port> <dir>` | Serves a fresh instance, runs `smoke.js` (TR_STRICT=0 by default) and every suite in `tests/`, then stops the server it started. |
| `tests/tickets.js <dir> [port]` | Regression tests for the ticket, checkout and gate fixes (T1-T14, P1 (a) and (b)). `TR_ONLY=T6` runs the tests whose name starts with that. |
| `tests/ux.js <dir> [port]` | UX and copy: a crawler over every portal page (public site, /account, /organisers, /admin, /scan gate and box office, /pos, /retail partner and counter, signed-out sign-in boxes) at 390x844 and 1366x900 that fails on console or request errors, sideways scroll, text contrast under 4.5:1, em dashes or exclamation marks, raw codes or JSON, empty cards, repeated ids, lower-case badges, phone tap targets under 40 px, strips with no "more" cue, wrong plurals and (in portals) money without cents; then one test per U item and N2. It sets up its own vendor and till, door staff, retail partner and draft event. `TR_ONLY=U4` runs one item; `TR_UX_SHOTS=<folder>` saves each portal's main page; the full crawl report goes to `<dir>/ux-crawl.txt`. |
| `tests/verifynow.js <dir> [port]` | VerifyNow electronic organiser checks (KYC/KYB): Integrations card, POPIA consent, background checks with pass / review / fail, admin review, payouts gated by the bank check, webhook signatures, idempotent retries, 429, no credits, nothing secret in logs. Starts `mock-verifynow.js` on 8805 (`TR_VN_MOCK_PORT`) and points the instance at it through `config.php` (`verifynow.baseUrl`, test-only). |
| `tests/testevent.js <dir> [port]` | Admin > Test event (TE1-TE9): create (staff only, audited), never listed publicly, signed-in and guest booking with TEST EVENT on pages, emails, My tickets and the saved image, transfer and waitlist, the gate (event team and the admin at `/scan?test=<id>`) admitting with TEST EVENT, practice scans / practice tickets / reset scans, KPIs and admin lists unchanged, complete delete that cannot touch a real event, and the 7-day auto delete. `TR_JOURNEY_DIR=<dir>` also saves numbered 390x844 screenshots of the journey. |
| `mock-verifynow.js <port> <key>` | Local stand-in for the VerifyNow API with its documented sandbox behaviour (inputs ending 90 / 91, 2-second repeat 429, scenario header, signed bank webhooks, job polling, idempotency, credits). Tests only. |

## Run it

```sh
export TR_TEST_ADMIN_PASSWORD='...'          # 14+ characters, never committed
# Serve in the foreground (Ctrl-C stops it):
ticketroom/live/dev/serve.sh 8640 /tmp/tr-live
# ...or return once seeded and leave it running:
TR_DETACH=1 ticketroom/live/dev/serve.sh 8640 /tmp/tr-live
kill "$(cat /tmp/tr-live/php.pid)"           # stop it (only the PID serve.sh started)

# Smoke test (Playwright from ticketroom/node_modules; set NODE_PATH if it is elsewhere)
node ticketroom/live/dev/smoke.js /tmp/tr-live 8640
TR_QUICK=1  node ticketroom/live/dev/smoke.js /tmp/tr-live   # one width, two pages per portal
TR_STRICT=1 node ticketroom/live/dev/smoke.js /tmp/tr-live   # known live issues fail the run too
```

Open <http://localhost:8640>. Use `localhost`, not `127.0.0.1`: the site's
same-origin check compares the browser's Origin with `baseUrl`, and the
session cookie is `Secure` (browsers allow that on `localhost` only).
Chromium defaults to `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
(override with `TR_CHROME`).

## What serve.sh sets up

1. `<dir>/ticketroom-data/config.php`: `baseUrl` and mail mode `log`, so email
   is recorded in the `message_outbox` table and never sent.
2. The first-owner ceremony exactly as `setup.php` requires: a random 48-character
   `ticketroom-data/bootstrap-secret`, then a POST of the form with an `https`
   Origin that matches `baseUrl` (which is `https://localhost:<port>` for that one
   request and `http://localhost:<port>` afterwards). Owner:
   `hello@ticketroom.co.za`, password from `TR_TEST_ADMIN_PASSWORD`.
   `setup.php` deletes the secret on success; serve.sh checks it did.
3. `seed.js`, through the same calls the pages make:
   - the admin signs in with password + the emailed staff code (read from the outbox)
     and switches payments to the TicketRoom sandbox
     (`POST /api/admin/integrations/payments/sandbox`, the Integrations button);
   - an organiser signs up (`/api/organiser/signup`) and a customer signs up
     (`/api/auth/register`); both confirm the link from their outbox email;
   - the admin approves the organisation; the organiser saves "About you" (a valid
     generated SA ID number), signs the organiser terms and uploads an ID document;
     the admin approves the document;
   - two events with generated posters (no real artists): a free one starting in
     about 3 hours (inside the gate's 12-hour admission window, so `/scan` admits)
     and a paid one (R150) in 3 weeks; both submitted and published.
   Accounts (random passwords for organiser and customer) go to `<dir>/seed.json`.

## What smoke.js checks

- Public pages (home, both event pages, ticket page, sell, help, terms, contact),
  each portal's sign-in through its own sign-in box (admin with the emailed code),
  and each portal's main pages, all at 390 px and 1366 px. A page fails on a
  console error, an unexpected failed request or HTTP error, or sideways scrolling.
- A paid checkout as the signed-in customer through the sandbox payment page
  (order `paid`, ticket marked TEST), and a free checkout as a guest.
- The organiser scans the free ticket at `/scan` by typed code (ADMIT, then
  ALREADY SCANNED; ticket `used` in the database).
- Portal separation (P1 in TRIAGE.md): which sign-in boxes refuse which accounts,
  every session on every portal page, two tabs in one browser, one person with a
  customer and a scanner role, header links, cross-portal API calls, and the
  scanner's dark theme in its sign-in dialog.

Problems that are in the live code and recorded in `TRIAGE.md` are printed as
`KNOWN` with their triage ID and do not fail the run (unless `TR_STRICT=1`).
Screenshots of failures go to `<dir>/smoke-shots/`.
