# Audit findings triaged against the live package

The audit (FINDINGS.md, made on the older schema-18 code) checked against
`ticketroom/live/public_html` (build 2026-10-22-phases, schema 46). Paths below are
relative to `ticketroom/live/public_html/`. **Repro** means it was reproduced on a
local instance started with `dev/serve.sh` (date 2026-10-29). Nothing in
`live/public_html` was changed.

Verdicts: **STILL APPLIES**, **FIXED IN LIVE**, **NOT APPLICABLE**. "Partly" means
part of the finding was fixed and the rest still applies; the row says which part.

## Summary

| Verdict | Count |
| --- | --- |
| STILL APPLIES (fully or partly) | 66 |
| FIXED IN LIVE | 12 |
| NOT APPLICABLE | 0 |
| Total audit IDs | 78 (M1–M15, T1–T14, O1–O15, S1–S8, U1–U26), plus P1 (6 sub-items) and 2 new notes |

STILL APPLIES with severity HIGH or CRITICAL: **T1, T2, T3, O1, O2, O3, O4, M3** (M1, M2 and M4 are fixed in live).

## Money (M)

| ID | Sev | Verdict | Evidence (live) |
| --- | --- | --- | --- |
| M1 | CRITICAL | FIXED IN LIVE | `api/lib/payments.php:372` reuses the open `initiated`/`pending` payment instead of starting a second one; `payments.php:436-451` books a confirmation for an already-settled order as `payment_overpayment` and raises an automatic `system:overpayment` refund of that charge (`refund_complete` handles it at `:634-641`). |
| M2 | CRITICAL | FIXED IN LIVE | `api/lib/payments.php:816-834` `organiser_money()` subtracts `desk_cash`, `desk_card`, `door_cash`, `door_card` per event and subtracts negative event balances (`$eventDebt`) from `availableCents` instead of flooring per event. |
| M3 | HIGH | STILL APPLIES (partly) | Fixed: `api/lib/exchange.php:423` confirms a resale only if the listing is held by this order and the ticket is still the seller's. Still: `refund_create` (`payments.php:557-590`) does not close the ticket's listings (only `refund_complete` does, `:653`); `resale_list` (`exchange.php:286-296`) does not check for an open refund; event cancel (`api/routes/admin.php:350-376`) does not close listings, and `resale_payment_confirmed` does not check the event status. |
| M4 | HIGH | FIXED IN LIVE | `api/lib/payments.php:570` counts `failed` refunds as unresolved (`refund_in_progress`); retry reuses the same refund id as the Yoco idempotency key (`:607`); amounts capped at what is left on the order (`:579-580`). |
| M5 | MED | STILL APPLIES (partly) | `api/lib/payments.php:760` routes only `unfulfilled` resale refunds to `resale:sellers`; any other refund of a resale order (e.g. `event_cancelled`) still debits the organiser's event account. |
| M6 | MED | STILL APPLIES | `api/routes/admin.php:362` `catch (AppError $e) { /* nothing left to refund */ }` also swallows `refund_in_progress`; those orders are silently skipped and not reported. |
| M7 | MED | STILL APPLIES | `api/lib/domain.php:389-406` `fulfil_order` issues tickets without checking the event status; `payments.php:483-487` re-holds an expired order without checking it; event cancel (`admin.php:361`) only handles paid orders, `pending_payment` ones stay open. |
| M8 | MED | STILL APPLIES | `api/routes/finance.php:305` decide updates by id without `AND status = 'requested'` and without re-checking the balance; mark-paid `:329` has no status guard in the UPDATE. |
| M9 | MED | STILL APPLIES (partly) | Fixed for Yoco: `api/lib/payments.php:52-58` only uses `sk_live_` in live mode. Still: `payfast_host()` `:72-76` honours the `payments.payfastBase` override in live mode, so a sandbox host can serve live orders. |
| M10 | MED | STILL APPLIES | `api/lib/promote.php:262` makes a new `reference('RF')` on every retry, used as the Yoco idempotency key (`:274`); `api/routes/promote.php:148` completes manually only from `manual_pending`, not `failed`. |
| M11 | LOW | STILL APPLIES (partly) | Reject is guarded (`api/routes/finance.php:154`), but approve goes through `refund_process`, which sets `processing` without a status condition (`payments.php:603`), so a racing reject and approve can both act (balance re-credited and refund paid). |
| M12 | LOW | STILL APPLIES | Per-ticket discount share rounded per refund (`api/lib/payments.php:574-576`); bounded only by the order-total cap at `:579`. |
| M13 | LOW | STILL APPLIES (partly) | Fixed: an EFT resale payout now needs bank details at listing time (`api/lib/exchange.php:310`). Still: PayFast has no status pull for a lost ITN (`payment_sync` handles Yoco and Peach only, `payments.php:503-520`); the other sub-points were not changed. |
| M14 | MED | STILL APPLIES | Test orders are cleared only by the manual admin action (`api/routes/finance.php:768-773`, `payments.php:865`); nothing clears them or refuses test money when payments switch to live. |
| M15 | MED | STILL APPLIES | `api/lib/payments.php:782-806` `ledger_check()` checks journal balance and provider clearing only; no check for double-paid orders, over-refunds, negative organiser balances or un-netted desk money. |

## Tickets and gate (T)

| ID | Sev | Verdict | Evidence (live) |
| --- | --- | --- | --- |
| T1 | HIGH | STILL APPLIES | **Repro**: admin reissue moved ticket `E8VXQKD2YB` from qr_version 1 to 2 with the same code, and the typed old code scanned `admitted`. Transfer and reissue only bump `qr_version` (`api/lib/domain.php:591`, `api/routes/admin.php:550`); typed codes are parsed unsigned (`domain.php:509-510`) and the version check runs only for signed QR (`:638`). Offline: `assets/scan-offline.js:109-110` likewise. |
| T2 | HIGH | STILL APPLIES | `api/routes/staff.php:145-150` ships every ticket code in clear to any `can_scan` phone; `assets/scan-offline.js:107` accepts any `TR1.<code>.<v>.<22 chars>` without checking the signature. |
| T3 | HIGH | STILL APPLIES | A ticket stays `valid` until the refund completes; `start_transfer` (`api/lib/domain.php:555-566`), `resale_list` (`exchange.php:286-296`) and `admit` (`domain.php:603-660`) do not check for open refunds. |
| T4 | MED | STILL APPLIES | **Repro**: a signed-out guest checkout with the seeded customer's email was booked into that (non-guest) account and returned an `accessKey`; the stranger's order link showed the ticket with its QR. `guest_buyer` `api/lib/domain.php:451-462`, `api/routes/public.php:300`. The free-limit message says "you already have 1" (**repro**, `domain.php:345`). |
| T5 | MED | STILL APPLIES | Per-person free limit is per account/email (`api/lib/domain.php:338-346`); guest limits 120/h per IP and 15/h per email (`api/routes/public.php:281-282`); a held resale listing cannot be withdrawn (`exchange.php:331`). |
| T6 | MED | STILL APPLIES | `multi_day`, `season`, `day_pass` kinds exist (`api/lib/domain.php:125`) but `admit` marks any ticket `used` on first scan (`domain.php:654-659`); no per-day or re-entry logic for tickets. |
| T7 | MED | STILL APPLIES | `assets/core.js:33` `toLocalInput` uses the browser's zone; `assets/organiser.js:195` `toIso` parses `datetime-local` in the browser's zone, while display uses Africa/Johannesburg (`core.js:20`). |
| T8 | LOW-MED | STILL APPLIES | `assets/scan-offline.js:100-103` `forgetOthers` deletes every other event's `pack:` and `queue:` keys, unsynced scans included (called from `assets/scan.js:23`); sync goes through `admit`, which refuses scans more than 6 h after the end (`api/lib/domain.php:600,616-618`). |
| T9 | LOW-MED | STILL APPLIES | `api/lib/domain.php:427-447` expires 100 orders per run with a Yoco call per order, in the after-response worker every 60 s (`api/bootstrap.php:583`); `create_order` does not release lapsed holds. |
| T10 | LOW | STILL APPLIES | Offer held 30 min (`api/lib/exchange.php:34`) but `waitlist_take_primary` marks the entry `claimed` at checkout (`:248-249`), so the 10-minute order hold (`domain.php:143`) replaces it and a failed payment loses the place. |
| T11 | LOW | STILL APPLIES | `api/routes/organiser.php:985-997` reads `quantity_sold + quantity_held`, then updates `quantity_total` without a condition. |
| T12 | LOW | STILL APPLIES | `/api/staff/events` (`api/routes/staff.php:9`) and the `admit` answer do not carry `age_restriction`; the scanner shows none. |
| T13 | MED | STILL APPLIES | `tag_resolve` accepts the printed display code (`api/lib/cashless.php:129`) at tills (`:764`, PIN only above the threshold, `:771`) and at the gate (`domain.php:622`); `ORG_ALL` (viewer included) lists display codes (`api/routes/cashless.php:130-134`). |
| T14 | LOW | STILL APPLIES | **Repro** (smoke.js, KNOWN T14): after sign-out, `localStorage.tr_wallet_v1` still held the customer's ticket with its QR image. Written at `assets/account.js:24`, never removed on sign-out (`core.js:452,530,579`); the signed-out welcome page shows it when offline (`account.js:569-570`). Scanner IndexedDB is kept too. |

## Ops and security (O, S)

| ID | Sev | Verdict | Evidence (live) |
| --- | --- | --- | --- |
| O1 | HIGH | STILL APPLIES | `api/lib/messaging.php:31-36` claims by incrementing `attempts` only; rows stay `queued`, so a second worker can pick them up while the first sends (no lease). |
| O2 | HIGH | STILL APPLIES | No backup code anywhere in `api/` (no `VACUUM INTO`, no snapshot job in `jobs()`, `api/bootstrap.php:580-608`); no admin download. |
| O3 | HIGH | STILL APPLIES (partly) | Fixed: a new install is refused inside the web root (`api/bootstrap.php:30-41`). Still, **repro**: with `ticketroom-data/keys.php` moved away on the installed instance, `/api/health` answered 200 and `tr_keys()` (`bootstrap.php:71-84`) silently wrote new keys (hash b961f4bf… became e097d66b…), invalidating every QR and encrypted secret. |
| O4 | HIGH | STILL APPLIES | `api/lib/messaging.php:65-66`: five attempts, back to `queued` immediately, no `next_attempt_at`, no backoff; no retry-failed route (`api/routes/admin.php:820-825` is read-only). |
| O5 | MED | STILL APPLIES | No `display_errors`/`error_log` setting in the package; `.htaccess:69` blocks `*.log` but not a file named `error_log`. |
| O6 | MED | STILL APPLIES (partly) | Fixed: JSON (offline pack) is compressed by `.htaccess:122-124`. Still: every `limit()` is a write transaction (`api/lib/core.php:606-620`), including browse (`api/routes/public.php:12`), keyed on IP by default. |
| O7 | MED | STILL APPLIES | `api/cron.php:2-4` and `DEPLOY-AFRIHOST.md:467-470` call cron optional, use bare `php`, and the script echoes output (`cron.php:11`). |
| O8 | MED | STILL APPLIES | `/api/health` is `SELECT 1` plus version (`api/routes/auth.php:5-8`); no job freshness, outbox backlog or alert email. |
| O9 | MED | FIXED IN LIVE | `SECURITY-OPERATIONS.md:27,61-64` covers SPF, DKIM and DMARC. |
| O10 | MED | STILL APPLIES | `ticketroom/package.json` has no PHP/live test script; this harness (`live/dev/`) is not wired into CI. |
| O11 | LOW | STILL APPLIES | `api/bootstrap.php:705` loads `routes/*.php` by glob. |
| O12 | LOW | STILL APPLIES | `api/lib/core.php:191` sends HSTS with `includeSubDomains` from the API. |
| O13 | LOW | STILL APPLIES | `scripts/build-php.js` and `scripts/build-afrihost.js` still write `../ticketroom.zip`, the same name as `scripts/build-live.js` (repo tooling, not the package). |
| O14 | LOW | FIXED IN LIVE | The live package has no admin password: `api/config.php:15-24` (empty `passwordHash`) and the one-time `setup.php` ceremony. Literals remain only in the old `tests-ui/php-*.js` (old tree). |
| O15 | LOW | STILL APPLIES | Maintenance blocks `/api/staff/*` and `/api/pos/*` (`api/bootstrap.php:574`); `deploy-check.php` has no SQLite version, cron or backup checks; `assets/ticketroom-logo.png` is 392 KB; images cached a day without a version (`.htaccess:92-94`). |
| S1 | MED | FIXED IN LIVE | Nothing sets a temporary password any more: owner via `setup.php:51-55`, staff via a reset link (`api/routes/admin.php:477-478`); `temp_password:` is only read/cleared (`api/routes/auth.php:227,298,391`). |
| S2 | LOW-MED | STILL APPLIES | `api/routes/auth.php:107` locks the account for 15 min after 30 failures from anywhere (5 per IP, `:102-106`), so 6 IPs can lock any account. |
| S3 | LOW | STILL APPLIES | `api/lib/messaging.php:174-180`: STARTTLS only if advertised, then `AUTH LOGIN` regardless, so a stripped STARTTLS sends the mailbox password in clear. |
| S4 | LOW | STILL APPLIES | User-supplied names go into emails to third parties unchanged (e.g. `fromName` in `transferOffer`, `api/lib/domain.php:566`; `by`/`organiser` in `orgMemberInvite`, `api/routes/organiser.php:686`). |
| S5 | LOW | STILL APPLIES | **Repro**: register with an existing email returns `email_taken` (`api/routes/auth.php:59`); also `organiser.php:583`, `has_account` (`api/routes/exchange.php:123`), `friend_not_found` (`api/lib/exchange.php:595`), free-limit message (`domain.php:345`). |
| S6 | LOW | STILL APPLIES | An existing customer is added to an event team with no consent or notice (`api/routes/organiser.php:1110-1128`, invite only for new/guest emails); cash desk looks people up by unverified phone (`api/lib/cashdesk.php:120`). |
| S7 | LOW | STILL APPLIES | `store_upload` (`api/lib/domain.php:704-716`) has no quota or cleanup (only 30 uploads/h per user, `api/routes/organiser.php:709`). |
| S8 | LOW | STILL APPLIES (partly) | Fixed: `deploy-check.php:15` also needs `security.diagnosticsEnabled`. Still: when unlocked it shows the admin email (`deploy-check.php:77`) and paths; outbox bodies with links are kept 180 days (`api/bootstrap.php:599`). |

## UX and copy (U)

Fixed on the `live-ux` branch: every U item marked STILL APPLIES below, and N2. Each has a test in `tests/ux.js`, alongside a crawler over every portal page at 390 and 1366 px.

| ID | Verdict | Evidence (live) |
| --- | --- | --- |
| U1 | STILL APPLIES | `scroll-padding-top` is `auto` on the live pages (browser probe); `assets/tr.css` sets `scroll-margin-top` only for two blocks (`:250,498`). |
| U2 | FIXED IN LIVE | `assets/tr.css:97-98` `.grid-2/.grid-3` use `minmax(0, 1fr)`; smoke at 390 px shows no sideways scroll on organiser pages. |
| U3 | STILL APPLIES | **Repro** (smoke.js, KNOWN U3): "Forgot password?" in the /scan sign-in dialog measures 1.49:1. |
| U4 | STILL APPLIES | Free checkout still shows the Pay step (`assets/site.js:357-360`), a "Booking fee R0.00" line (`:537`), the promo hint, and "By paying you agree" (`:638`). Seen in the free-checkout screenshot. |
| U5 | STILL APPLIES | `.cat-label` uses `--amber-600` #DB8F1C (2.64:1 on white), `.tk-label` `--amber-500` #F2A93B (2.0:1) (`assets/tr.css:5,198,324`). |
| U6 | STILL APPLIES | Initials-only artists (`assets/site.js:285-287`); the "Details" card renders even when there is no description (`:396`). |
| U7 | STILL APPLIES | Organiser category dropdown options are raw slugs (`music,festival,…,nightlife,other`, browser probe of `#/events/new`). |
| U8 | STILL APPLIES | Fixed 52×52 Help button at the bottom right at 390 px covers ticket text and QR (see ticket-phone screenshot). |
| U9 | STILL APPLIES | `assets/tr.css:21` focus ring is `--amber-500` on amber primary buttons (1:1). |
| U10 | FIXED IN LIVE | Organiser settings email has a linked label (`#oe`); the customer settings page no longer shows an editable email field (browser probe). |
| U11 | STILL APPLIES | Customer portal tab strip at 390 px: scrollWidth 1622 vs 390, `overflow-x: auto`, no hint (browser probe). |
| U12 | FIXED IN LIVE | smoke.js: admin `#/integrations` at 390 px has no sideways scroll. |
| U13 | STILL APPLIES | `.preview-bar` is `position: sticky; top: 0` (`assets/tr.css:711`) like the header (not visually re-checked). |
| U14 | FIXED IN LIVE | Upcoming tickets first, then a "Past & inactive" table (`assets/account.js:98-106`). |
| U15 | STILL APPLIES (partly) | A clear (×) button exists, but a text search with no results gets the filters copy "No events match those filters" (`assets/site.js:230`). |
| U16 | FIXED IN LIVE | No hard-coded booking fee in the pages; fees come from settings (`api/routes/finance.php:610`). (Retail page still states "R3 of the service fee", `assets/retail.js:13`.) |
| U17 | STILL APPLIES | Two money formats (`money()` "R0"/"R150" vs `moneyExact()` "R0.00", `assets/core.js:21-27`); unpluralised counts such as `${p.recipients} people` (`assets/organiser.js:820`) and `${s.count} tickets` (`assets/scan.js:67`). |
| U18 | STILL APPLIES | `#/events/new` has a visible, unstyled native `input[type=file]` (browser probe). |
| U19 | STILL APPLIES (partly) | "loud and clear", "Faster bars, bigger spend", "Your event, sorted" are gone; "no surprises" (`assets/site.js:815`) and "in seconds" (`:810`) remain. |
| U20 | FIXED IN LIVE | Server greeting is "Hi, I'm the TicketRoom assistant" (`api/lib/site.php:32`); the "Hi!" text is only a fallback when no greeting is set (`assets/core.js:879`). |
| U21 | STILL APPLIES (partly) | No duplicate IDs found on the organiser dashboard; it still greets the organisation: "Hi, Harbour Lights Productions" (browser probe). |
| U22 | STILL APPLIES | En dash hours fallback "Weekdays · 9am–5pm" (`assets/core.js:780`); other wording points not changed. |
| U23 | STILL APPLIES | The free event page shows "EV-…" and "ORG-…" codes and the "non-refundable" refund-policy line (browser probe). |
| U24 | STILL APPLIES | Audit log prints `JSON.stringify(e.details)` (`assets/admin.js:745`); ledger shows raw account codes (`:587`). |
| U25 | STILL APPLIES | `.badge.good` 4.41:1 (`assets/tr.css:8,109`); lineup placeholder uses a real artist name (`assets/organiser.js:128`). |
| U26 | STILL APPLIES | /sell mentions cashless 7 times (browser probe); tile layout not changed. |

## P1: portals don't clash (owner request)

Portals in live: website (`/`), customer `/account`, organiser `/organisers`,
admin `/admin`, gate scanner and box office `/scan`, vendor till `/pos`, retail
partners `/retail`. One `tr_sid` session cookie serves all of them
(`api/lib/core.php:486,534-536`): one account per browser at a time.
Sign-in boxes accept: website customer+organiser, customer portal customer,
organiser portal organiser, admin staff, scanner and POS customer+organiser
(`api/lib/domain.php:14`). All checks below run in `dev/smoke.js`.

| Sub-item | Verdict | Evidence |
| --- | --- | --- |
| (a) each portal admits only its account types, with a clear message | STILL APPLIES (one gap) | Sign-in boxes refuse the wrong type with "This is a customer/organiser account. Sign in on …" and staff's generic "Access denied" (`api/routes/auth.php:117-122`); signed-in sessions on the wrong portal get "This portal isn't for this account" (`assets/core.js:444-454`), checked for every session × page. **Gap, repro**: a staff session on `/scan` throws `Cannot set properties of null (setting 'innerHTML')` and shows an empty page: `wrongAccountPage` renders into `#sidenav` (`assets/core.js:447`), which `scan.html` does not have (`assets/scan.js:173`). |
| (b) one tab's sign-in/sign-out vs other tabs | STILL APPLIES (LOW) | By design one session per browser: signing in on the organiser tab replaces the customer session everywhere; after a reload the customer tab shows the wrong-account page, and sign-out in one tab signs every tab out (both checked). **Repro**: a customer tab left open keeps showing the customer's tickets while its next call fails with 403 "This is for customer accounts" and a console error; it does not notice the switch. The customer's saved tickets with QR codes stay in `localStorage` after sign-out (T14). No organiser data appeared in customer pages. |
| (c) one person, several roles | FIXED IN LIVE | One email = one account (`api/routes/auth.php:57-61`, `api/routes/organiser.php:581-584`); organiser team members must be organiser accounts (`organiser.php:673`); event staff are customer (or organiser) accounts with a per-event role (`organiser.php:1101-1131`), never staff accounts (`:1110`). Smoke: the customer added as scanner sees only that event in `/scan`, `/account` still lists exactly their own tickets, the organiser API stays 403/404, and they remain one customer account. Consent for being added is S6. |
| (d) menus and links never send users into the wrong portal | FIXED IN LIVE | Header links per portal are limited by `ALLOWED` (`assets/core.js:475-479`); smoke checks customer, organiser and admin headers and side menus link to no portal they cannot use. |
| (e) one portal's API refuses other portals' sessions | FIXED IN LIVE | `/api/me/*` is customer-only (`api/bootstrap.php:707-709`), organiser routes check membership (`api/lib/domain.php:25-43`), admin routes check staff roles; smoke: 8 cross-portal calls all 403/404. |
| (f) portal styles don't bleed | STILL APPLIES | The scanner's dark `body.venue` theme leaks into its sign-in dialog: "Forgot password?" 1.49:1 (= U3). |

## New notes from this pass

| ID | Sev | Note |
| --- | --- | --- |
| N1 | LOW | The "Save ticket image" PNG has no TEST marker: `ticketPng()` gets no test flag (`assets/account.js:81`, `assets/core.js:1297`), while the in-page ticket shows "TEST TICKET · not valid for entry". The gate still refuses test tickets. |
| N2 | LOW | At 390×844 the ticket card (about 830 px) plus the sticky header and tab strip does not fit on one screen, and the Help button sits over the QR code (U8). |
