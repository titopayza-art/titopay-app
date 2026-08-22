"use strict";

// WHICH BUILD IS ACTUALLY RUNNING ON THE SERVER?
//
// Four separate debugging sessions have now started with a feature that was
// present in the code, proven by tests and a live harness, and absent on the
// customer's phone: the TitoKids co-parent screen, the "Not found" ticketing
// panel, the admin console's ticketing metrics reading R0.00, and the
// wristband Link button. In every case the answer was the same, and in every
// case it took an investigation to establish it, because the deployed API
// state was invisible from outside.
//
// The PWA solved this for itself: index.html carries app.min.js?v=NNN, so the
// running bundle can be read in one request. This is the same idea for the
// API. GET /health reports the build, so "is the server current?" becomes one
// curl instead of an afternoon.
//
// BUMP API_BUILD whenever api.zip is rebuilt for deployment, and add a line to
// the notes below. The number is deliberately a plain integer: it only has to
// answer "newer or older than the build that contains the fix".

const API_BUILD = 105;

// Most recent first. Keep this short; it is a deployment aid, not a changelog.
const BUILD_NOTES = {
  105: "CONNECTION-POOL SELF-HEAL. Production sign-in and /v1/health began "
      + "timing out with 'timeout exceeded when trying to connect' - the DB "
      + "connection pool was exhausted and only a Postgres restart cleared it, "
      + "for a few hours at a time. A code audit found no forgot-to-release leak "
      + "(all 86 pool.connect() sites release; single pool; measuredQuery uses "
      + "try/finally), so the cause is a connection held idle-in-transaction "
      + "until a manual restart. src/db/pool.js now sets "
      + "idle_in_transaction_session_timeout=60s on every connection, so Postgres "
      + "reclaims any connection left open-and-idle inside a transaction - the "
      + "pool can no longer be starved to the point where every query fails. Only "
      + "affects a connection doing NOTHING inside an open transaction; an active "
      + "query, migration or report is never interrupted. Operators can apply the "
      + "same setting live with ALTER SYSTEM, no deploy required. No API "
      + "behaviour change.",
  104: "READINESS SWEEP - REMAINDER CLOSED. The low-severity items deferred from "
      + "build 103 are now fixed, so the audit backlog is empty. Email Centre "
      + "analytics (today counts, per-day trend, the daily/weekly/monthly rollup) "
      + "bucket in South African time instead of UTC; the HR attendance-date "
      + "default and the learning-overdue check use the SA calendar day; and the "
      + "customer Saved-Beneficiaries strip (Saved/Favourites/Verified) now reads "
      + "server-side SQL counts over the whole set instead of counting the "
      + "100-row display page (PWA v474). Reporting/analytics only; no money path, "
      + "ledger or existing endpoint behaviour changed. Full suite green.",
  103: "PRODUCTION-READINESS SWEEP. A six-lane adversarial audit (money/ledger, "
      + "concurrency, crash/500, security, timezone, infra) and its fixes. "
      + "MONEY-LOSS: reverseTransaction was service-code-blind and would re-credit "
      + "a wallet for a completed BANK WITHDRAWAL whose money already left to the "
      + "customer's bank (double-pay); it now refuses externally-settled codes "
      + "(payouts, top-ups, tickets), which reverse only through their own flows. "
      + "REGULATORY: the monthly send-cap re-check + per-user lock ran only when an "
      + "idempotency key was supplied, so two concurrent key-less sends could "
      + "exceed the cap; the lock + re-check are now unconditional. SECURITY: "
      + "webhook delivery no longer follows redirects (a merchant could 3xx to an "
      + "internal address past the private-range guard). CORRECTNESS: statement "
      + "totals now count only completed money; the statement PDF uses authoritative "
      + "whole-period totals when its row list is capped; banking intent transitions "
      + "and stokvel withdrawal approvals are decide-once; a fee-mechanism conflict "
      + "is asserted. TIMEZONE: business-sales, waitlist, rewards badge, chat-monitor "
      + "counts, and several reports now compute over the full set / in SA time. "
      + "HARDENING: boot deployment-inspection wrapped; a floating compliance review "
      + "caught. GUARDRAILS: new test/guardrails.test.js + an api-tests CI job fail "
      + "the build if any of these classes regress. deploy.sh restarts ALL pm2 apps "
      + "(chat was left on old code); .env.example declares TITOPAY_ENV + pool/worker "
      + "vars. Additive/behaviour-preserving except the reverse guard (a refusal) "
      + "and the SA-time report windows. Full suite green.",
  102: "AUDIT: TOTALS THAT OVER-CLAIMED THEIR DATA. A sweep for the same class "
      + "of bug as the build-101 \"Today\" card - a figure presented as complete "
      + "but summed over a capped LIMIT list, or a window rolled in UTC instead "
      + "of SA time - fixed the confirmed money/HIGH ones. (1) MONEY-CRITICAL: "
      + "TitoKids child spend caps (day/week/month) were enforced with a bare "
      + "UTC date_trunc, so between 00:00-02:00 SAST the day window pointed at "
      + "yesterday and a child could spend up to 2x the daily cap in one SA day; "
      + "spentInWindows now anchors each window in Africa/Johannesburg like the "
      + "main limit engine. (2) Business Sales report + ledger totals "
      + "(salesSummary/salesLedger) were summed over the most-recent 2000/500 "
      + "credits (oldest days silently dropping); now SQL SUM/COUNT/GROUP BY "
      + "over the full window, with per-day and per-hour both bucketed in SA "
      + "time. (3) New GET /v1/transactions/statement returns whole-period "
      + "money-in/out totals and record count (window aggregates) plus the "
      + "period's rows, so the Statements screen summary, PDF and CSV stop "
      + "totalling only the last 100 transactions. (4) Enterprise bulk "
      + "distribution \"Funds locked\" now reads a per-organisation SQL SUM "
      + "instead of summing the capped 300-batch page. All additive/read-only "
      + "except the TitoKids window (a correctness fix to an existing block); "
      + "no ledger or existing endpoint behaviour changed. Full suite green.",
  101: "ACCURATE \"TODAY\" CARD. The dashboard summary card labelled \"Today\" "
      + "was summing the 100 most-recent transactions across ALL time (the "
      + "list endpoint is ORDER BY created_at DESC LIMIT 100, no date filter), "
      + "so its Records/In/Out never matched the actual day. New read-only "
      + "endpoint GET /v1/transactions/today-summary returns a SQL aggregate "
      + "over COMPLETED transactions dated to the current calendar day in "
      + "South African time, bounded on BOTH ends [start-of-today, "
      + "start-of-tomorrow) so a future-scheduled row cannot inflate it, split "
      + "by direction and UNCAPPED. The PWA reads it for the card and keeps a "
      + "client-side same-day fallback for offline. Additive and read-only: no "
      + "table, ledger or existing endpoint changed; full suite green.",
  100: "TWO CONTROL FIXES, NO NEW SURFACE. (1) The settlement fee "
      + "(pricing rule pos_settlement) is skimmed from every merchant "
      + "payout, so re-pricing it now requires a SECOND admin through the "
      + "existing dual-authorisation service - the same control that guards "
      + "large reversals and limit changes. A new 'pricing_change' action "
      + "type carries it; the action_type CHECK is widened idempotently and "
      + "non-fatally at boot; config flag settlementFeeChanges defaults on. "
      + "Every OTHER pricing rule keeps its existing single-super-admin path "
      + "unchanged - only pos_settlement is gated. (2) Sign-in and "
      + "password-change one-time codes now jump ahead of bulk mail in the "
      + "email worker: claimJobs orders email_otp/password_change_otp first, "
      + "so an auth code can no longer wait behind a marketing blast (the A3 "
      + "OTP-priority gap; retry/dead-letter caps and worker-stall alerting "
      + "were already in place). Additive and behaviour-preserving; full "
      + "suite green.",
  99: "SETTLEMENT, RECONCILIATION + MERCHANT PAYOUT. Per-merchant settlement "
      + "batches over tiling POS trading windows (UNIQUE window = idempotent "
      + "closeout), derived from transactions and verified three ways before "
      + "anything is called settled: double-entry wallet_ledger legs per "
      + "item, the pos_payment_intents stream cross-checked both directions, "
      + "and header totals recomputed by SUM(). Clean batches pay out - into "
      + "a configured settlement wallet, or recorded as realtime_wallet when "
      + "the operating wallet already holds the money; a discrepancy parks "
      + "the batch and raises a money-integrity alert; a payout the wallet "
      + "cannot cover fails loudly and is retried from the console. Optional "
      + "settlement fee prices rule pos_settlement (FREE until an operator "
      + "sets it) and books to the revenue wallet + revenue_ledger. Paid "
      + "batches emit settlement.completed through the existing webhook "
      + "rails, exactly once. Schedules manual/daily/weekly/monthly roll at "
      + "SA midnight via an inline sweep worker (SETTLEMENT_WORKER_INLINE=0 "
      + "to disable); /v1/health reports settlementWorker. Merchant API "
      + "/v1/settlements (+config, +close); admin /admin/settlements under "
      + "the transactions permission. Tables settlement_batches/_items/"
      + "_events are additive and inert until used.",
  98: "PARTNER SANDBOX + CREDENTIALS. POS vendors self-serve the whole "
      + "integration: register at /v1/partners (sandbox key issued instantly, "
      + "production keys only after admin approval), manage keys "
      + "(create/rotate with 24h grace/revoke, hashes stored - never the "
      + "key), and read their own usage and delivery stats. A sandbox "
      + "deployment (same api.zip, TITOPAY_ENV=sandbox, own database) "
      + "exposes /v1/sandbox: provision real merchants/terminals/funded "
      + "customers and drive every payment outcome (scan, complete, "
      + "insufficient funds, expire, cancel, refund, reverse) through the "
      + "REAL POS engine, plus a webhook event generator; production "
      + "refuses /v1/sandbox outright. Admin console APIs approve/suspend "
      + "partners under the integrations permission. Static developer "
      + "portal in developers/ (developers.titopay.co.za), OpenAPI in "
      + "docs/openapi-titopay.yaml, SDK starters (Node/Java/PHP/Kotlin) in "
      + "docs/sdk-starters/. Tables api_partners/_keys/_usage/_resources "
      + "are additive and inert in production until used.",
  97: "OUTBOUND WEBHOOKS. Merchants and POS partners subscribe HTTPS "
      + "endpoints (max 10, public HTTPS only) and receive signed real-time "
      + "payment events fanned out from the transactional pos_payment_events "
      + "stream: payment.created/scanned/completed/failed/cancelled/expired "
      + "and refund.created/completed (settlement.completed reserved). "
      + "HMAC-SHA256 signatures with timestamped canonical requests and a "
      + "24-hour dual-signature secret rotation; retries at 1m/5m/15m/1h/6h "
      + "then dead-letter with API replay; 410 unsubscribes; ten consecutive "
      + "dead deliveries auto-pause. Delivery runs in-process by default or "
      + "as a standalone src/webhook-worker.js; /v1/health reports "
      + "webhookWorker. Docs + OpenAPI in docs/webhooks/.",
  96: "INLINE EMAIL WORDMARK. The header logo now travels inside the message "
      + "as an inline CID attachment, so webmail that blocks remote images "
      + "(the Afrihost default among others) still renders it - dark mode and "
      + "light mode alike. SMTP, Postmark and SendGrid carry it inline; "
      + "providers without inline support automatically fall back to the "
      + "hosted /brand/email-logo.png, which remains for already-queued mail.",
  95: "EMAIL LOGO FALLBACK. Mail clients that block remote images now show "
      + "'TitoPay' in white bold on the navy header band instead of a broken-"
      + "image glyph - the wordmark img carries styled alt text. The image "
      + "itself is unchanged and confirmed serving in production.",
  94: "DARK-SAFE EMAIL FOOTER. The footer follows the build-93 header onto a "
      + "fixed navy band: light text, white company name and light-blue links "
      + "with explicit inline colours, so dark-mode mail clients cannot render "
      + "the support, legal and unsubscribe links as dark blue on a darkened "
      + "background. The test suite pins the navy footer alongside the header.",
  93: "DARK-SAFE EMAIL HEADER. Every branded email now carries the white-and-"
      + "blue wordmark on a fixed navy band. Dark-mode mail clients (Gmail "
      + "above all) recolour light backgrounds but never image pixels, so the "
      + "old navy logo on a white header went invisible on phones in dark "
      + "mode. The wordmark ships inside the API at /brand/email-logo.png "
      + "(bundled like the favicon), so the fix deploys atomically with this "
      + "build and never depends on the website's asset folder.",
  92: "DUAL AUTHORISATION + LEDGER UNIQUENESS. Reversals at/above a "
      + "configured amount (default R1,000) and every limit-framework change "
      + "are captured as requests that a SECOND, different admin approves "
      + "and executes (admin_dual_auth_requests; self-approval refused in "
      + "code and by DB CHECK; decide-once claim). New endpoints under "
      + "/admin/dual-auth. A partial unique index on wallet_ledger "
      + "(transaction_id, wallet_id, entry_type, reference) makes duplicate "
      + "postings structurally impossible; attempted at boot and NEVER "
      + "fatal - blocked history logs loudly and raises an integrity alert. "
      + "Stokvel server errors say 'Stokvel group'; the app states TitoPay "
      + "holds no group pot (PWA v464, console v96).",
  91: "REWARDS AD IMAGES. reward_publications gains image_url (metadata-only "
      + "ALTER, event-poster contract: data-URL JPG/PNG/WebP <= 700KB or an "
      + "http(s) URL). The PWA (v460) shows a big Rewards ad banner beside "
      + "Search on the Services screen and a swipeable poster carousel on the "
      + "Rewards screen; the admin console (v92) uploads and previews the "
      + "image. No behaviour change for publications without an image.",
  90: "REWARDS. New customer Rewards screen (PWA v459) served by GET "
      + "/me/rewards: admin-published promotions, discounts, coupon codes, "
      + "adverts and notices. Marketing drafts a publication in the console "
      + "(v91); a CEO/COO/Senior Marketing seat approves it live; any "
      + "marketing admin can withdraw one instantly. Audience targeting "
      + "(personal/business/both), optional live window, per-user seen "
      + "tracking feeds the tile's unseen badge, coupon copy counts feed "
      + "engagement. Nothing here moves money. The dormant 'rewards' service "
      + "tile switches on via a guarded one-shot fixup.",
  89: "ACCOUNT CLOSURE REQUESTS (Google Play deletion requirement). A customer "
      + "asks to close their profile from the Security Centre (PWA v458); the "
      + "request lands in the Admin Console's Support desk under a new Account "
      + "Closures tab (support permission, console v90). Approval is refused "
      + "while the wallet holds money; once settled it sets users.status = "
      + "'closed' and revokes every session - sign-in stops immediately, no "
      + "row is deleted (FICA retention), and an admin can reopen by setting "
      + "the status back to active. Decline requires a note the customer sees; "
      + "the customer can cancel while pending. One open request per customer, "
      + "enforced by a partial unique index. Table account_closure_requests is "
      + "runtime-ensured AND in schema.sql - no migration needed.",
  88: "BUG AUDIT BATCH A2 - money correctness. Reversing a held payment now "
      + "closes the pending-credit hold inside the same transaction (the expiry "
      + "sweep could previously refund the sender a SECOND time from suspense); "
      + "the reversal claws back the transaction's ACTUAL collected revenue, "
      + "not just the payer fee; send and withdrawal limits are re-checked "
      + "under a per-user advisory lock inside the money transaction (two "
      + "concurrent R150k sends could both pass a R200k monthly cap); a "
      + "dynamic Make-a-Sale QR admits exactly one payer via an atomic claim "
      + "(two simultaneous scanners could both settle one sale); a TitoKids "
      + "money request is decided exactly once (double-approve funded the "
      + "child twice); a ticket admits exactly one gate scan; the user's "
      + "spending wallet can never resolve to a TitoKids custody wallet "
      + "(kind <> 'system' on every oldest-wallet pick); monthly limits roll "
      + "at South African midnight instead of 02:00; a zero-priced fee-only "
      + "service refuses cleanly. No migration.",
  87: "BUG AUDIT BATCH A1 - the lockout/critical set from the 21 Aug six-"
      + "dimension correctness sweep. API: users.login_mfa_enabled added to "
      + "schema.sql and the runtime self-heal (fresh installs no longer 500 on "
      + "the Login Code endpoints); sign-in email-OTP challenges force past the "
      + "global Enable Email OTP switch (unticking it can no longer lock every "
      + "MFA customer and OTP-mode admin out); a sign-in code whose email never "
      + "queued now fails loudly and revokes the challenge instead of claiming "
      + "'code sent'; verify-otp re-checks account status before issuing a "
      + "session; npm run db:migrate now actually runs migrations (it aliased "
      + "schema init, which could also clobber operator pricing). Ships with "
      + "PWA v457: SMS-OTP password reset fixed (the app demanded an accountId "
      + "the hardened reset response deliberately no longer returns - every "
      + "reset failed with a valid code in hand); sign-in OTP input accepts "
      + "6-8 digits + resend button; parseAmount reads SA decimal commas "
      + "('1,50' is R1.50, never R150 or NaN); isoDate returns the local "
      + "calendar date (Today reports, statement periods and invoice terms "
      + "were a day off); profile photo submit uses the pre-capture FormData. "
      + "No migration.",
  86: "LOGIN-CODE VERIFY BRIDGE. Build 85's customer login MFA minted an Email "
      + "OTP challenge, but the app's OTP form posts every sign-in code to "
      + "/v1/auth/verify-otp, which only searched the classic login purposes - "
      + "so the emailed code answered 'OTP challenge not found' and an opted-in "
      + "customer could not finish signing in. verify-otp now bridges exactly "
      + "one extra purpose, email_otp:login, through the email-OTP verifier "
      + "(tokens only for a login event; wallet-unlock and verification codes "
      + "remain unredeemable here). API-only, no migration, no PWA change.",
  85: "OPT-IN CUSTOMER LOGIN MFA. A customer can switch on an email one-time "
      + "code at sign-in (GET/PUT /v1/auth/me/login-mfa). Off by default, so "
      + "existing sign-in is unchanged; enabling is refused unless the account "
      + "has an email to receive the code, so no one can lock themselves out. "
      + "Reuses the existing email-OTP sign-in path (same one admin uses); the "
      + "PWA already handles the otp_required response. Migration "
      + "20260821_login_mfa adds users.login_mfa_enabled (metadata-only, "
      + "idempotent). Additive and default-off: no change to any current login.",
  84: "SECURITY ASSESSMENT FIXES. (1) Fee bearer + recipient fee are no longer "
      + "trusted from the client: POST /v1/transactions strips merchantReceivesFee "
      + "and recipientFee from the request body, so a sender can neither dodge the "
      + "send fee nor divert a payment into revenue; the internal callers "
      + "(qr-service etc.) set them server-side and are unaffected. (2) Admin MFA "
      + "is now secure by default - admin sign-in requires email OTP unless an "
      + "operator explicitly sets ADMIN_OTP_REQUIRED=false as documented "
      + "break-glass; the DB-unavailable fallback now fails closed. Route-layer "
      + "and config-default only: no boot-time gating, no new required env var, no "
      + "502 surface. To enforce on an existing deployment, set the admin "
      + "authentication mode to password_email_otp in the Admin Portal.",
  83: "SIX-DIMENSION SECURITY AUDIT (auth/session, credential recovery, "
      + "authorization/IDOR, money movement, injection, rate-limit/crypto). No "
      + "critical and no exploitable IDOR were found - authorization is "
      + "uniformly scoped to the authenticated user. Fixed: the email-link "
      + "password reset skipped the strength policy the OTP door enforces (a "
      + "business account could set a 4-char password) - now enforced; the "
      + "password-reset request was an account-existence + internal-UUID oracle "
      + "- unknown and known identifiers now return an identical shape and the "
      + "UUID is never returned; event ticket_code was minted with Math.random "
      + "(state-recoverable, forgeable admission) - now crypto.randomInt; the "
      + "shared rate-limit store failed OPEN on a counter-write error (unlimited "
      + "attempts during a partial DB hiccup) - now degrades to in-memory "
      + "counting; the withdrawal fee was debited from the customer but never "
      + "credited to revenue - now booked at settlement success, idempotently, "
      + "so a failed+reversed withdrawal collects nothing; and the refresh path "
      + "did not enforce the session expires_at - now it does. Lower-severity "
      + "items (admin-gated SSRF on provider test probes, an authenticated "
      + "webhook-log spoof, client-supplied fee-bearer flags, refresh-token "
      + "reuse detection) are documented for follow-up. 8 new tests.",
  82: "A RESET THAT ACCEPTS THE OLD PASSWORD IS THEATRE. Both reset flows "
      + "(the OTP flow, which also serves the logged-in change, and the email "
      + "link flow) and therefore the change flow accepted the OLD password or "
      + "PIN as the new one, so the single thing a reset exists to do - make a "
      + "leaked credential stop working - silently did not happen. Found by "
      + "the operator on 20 August 2026. Every credential-setting flow now "
      + "refuses a new password matching the current one, with the reason in "
      + "the message, and refuses it BEFORE consuming the OTP or reset link - "
      + "the same code or link works again with a genuinely new password, and "
      + "the refusal does not count as a failed attempt. The check runs only "
      + "AFTER the OTP or token is proven, so the flow cannot be used as a "
      + "password oracle by anyone who has not already demonstrated control "
      + "of the account. One copy of the rule, in lib/passwords.",
  81: "NEVER AGAIN, MADE STRUCTURAL. The sha256(refreshSecret) key derivation "
      + "that broke every stored credential on 20 August was COPY-PASTED into "
      + "five files, and build 80 fixing one of them split the brain: the "
      + "admin save path encrypted under one key while the worker read path "
      + "decrypted with another. The derivation now lives in "
      + "lib/integration-secret-key ALONE - pinned keys before the rotatable "
      + "JWT fallback - and every site (notification, peach-config, POS, "
      + "integrations.routes, admin.routes, email-centre) routes through it, "
      + "with POS keeping its explicit terminal key first and the Email "
      + "Centre its historical EMAIL-first order, so nothing already "
      + "encrypted changes hands. A grep-shaped test bans any file from "
      + "deriving a key from a JWT secret again. Also scripts/deploy.sh: one "
      + "command that asks pm2 where the app lives, deploys there, migrates, "
      + "preflights, restarts BOTH processes and prints the health proof - "
      + "because the day's other failures were builds extracted into /root, "
      + "a worker left on six-day-old code, and a health check curled into "
      + "the restart window. DEPLOY.md leads with it.",
  80: "THE SECOND VAULT. Build 79 pinned EMAIL_ENCRYPTION_KEY, and email "
      + "stayed dead anyway: the SMTP password actually lives in the admin "
      + "Integrations store (platform_settings), encrypted by "
      + "notification-service under a key derived DIRECTLY from the JWT "
      + "refresh secret with no override, and its decrypt failures were "
      + "swallowed by a bare catch - so the wrong-key mismatch surfaced three "
      + "layers away as `Missing credentials for \"PLAIN\"` with no clue "
      + "attached. integrationEncryptionKey now honours "
      + "INTEGRATION_ENCRYPTION_KEY, then EMAIL_ENCRYPTION_KEY (the key "
      + "operators are told to pin), before the legacy JWT fallback - so the "
      + "one pinned key reopens BOTH vaults - and an undecryptable stored "
      + "secret is logged with the field name and a hint instead of failing "
      + "silently. Deploying this build on a server whose EMAIL_ENCRYPTION_KEY "
      + "is already pinned to the pre-rotation value restores email with no "
      + "other action.",
  79: "THE ROTATION THAT BROKE EMAIL, NAMED BEFORE IT CAN HAPPEN AGAIN. Stored "
      + "email credentials (the SMTP password saved in the Email Centre) are "
      + "encrypted under EMAIL_ENCRYPTION_KEY, falling back to a key derived "
      + "from JWT_REFRESH_SECRET when it is absent. On 20 August a routine JWT "
      + "rotation therefore silently broke every stored email credential: every "
      + "send failed with `Missing credentials for \"PLAIN\"`, the admin OTP "
      + "email never arrived, and the operator was locked out of the console. "
      + "Recovery: set EMAIL_ENCRYPTION_KEY to the OLD refresh secret and "
      + "everything decrypts again. Prevention, in this build: .env.example "
      + "declares the key and says exactly what happens without it; the "
      + "preflight reports the coupling as a problem with the zero-risk pin "
      + "command as the remedy; and the rotation advice no longer says "
      + "`nothing is lost`, because that was disproven in production. No "
      + "runtime behaviour changed.",
  78: "DEFENCE IN DEPTH ON CHILD WALLETS, one path deep. Reviewing every "
      + "place that credits a wallet looked up by number found one more: "
      + "enterprise distribution's batch release. It is safe today only "
      + "because child wallets are unnumbered; it now refuses kind 'system' "
      + "explicitly, in both the batch validation lookup and the release "
      + "credit query, so a child wallet number behaves exactly like an "
      + "unknown number - the item fails cleanly and the money releases back "
      + "to the business wallet. No behaviour change for any real recipient.",
  77: "A PARENT MAY HAVE MORE THAN ONE TITOKIDS CHILD. Every child is a kind "
      + "'system' wallet under the parent, and idx_wallets_user_kind enforced "
      + "one wallet per user per kind across ALL kinds, so the second child was "
      + "a duplicate-key 500 every time. The index is rebuilt PARTIAL under a "
      + "new name (idx_wallets_user_kind_ex_system); uniqueness is unchanged "
      + "for personal, business and merchant wallets, and the merchant wallet "
      + "upsert names the predicate so ON CONFLICT still matches. Fixing it "
      + "exposed two leaks, both closed: the wallet-number backfills (schema "
      + "DO block and ensureWalletNumbersForAllWallets) numbered child wallets "
      + "that are unnumbered BY DESIGN, and a numbered child wallet resolved "
      + "as a transfer recipient - money into a child's pocket around the "
      + "TitoKids flow, its notifications and its limits. Both backfills now "
      + "skip user-owned system wallets, recipient resolution refuses kind "
      + "'system' outright, the migration strips numbers already assigned, and "
      + "the customer wallet list no longer shows child wallets. Requires "
      + "db:apply-migrations (20260820_titokids_sibling_wallets); the ensure "
      + "function self-heals if the migration lags. First-ever TitoKids test "
      + "file: 14 tests through the real service against the real database.",
  76: "REFINEMENTS FROM THE ADVERSARIAL REVIEW OF BUILD 75, tooling text and "
      + "detection only, no API behaviour change. The preflight's bare-shell "
      + "explanation now triggers only when NO name declared in .env.example is "
      + "set (a shell holding NODE_ENV or the SMTP block is partly configured, "
      + "not bare), says that /v1/health's configWarnings describes the process "
      + "still running the OLD build until restart, and that a failed health "
      + "request is itself the running API reporting a broken configuration. "
      + "apply-migrations honours libpq's PG* variables instead of refusing "
      + "them, and its refusal names DATABASE_URL as the equal alternative.",
  75: "A BARE SHELL IS NOT THE PROCESS MANAGER. Minutes after build 74 fixed "
      + "the 502, the preflight run over SSH reported every variable missing on "
      + "the machine where the API was serving fine, and db:apply-migrations "
      + "failed with `password authentication failed for user \"root\"`. Both "
      + "tools were reading a login shell that does not inherit the variables "
      + "cPanel/pm2/systemd inject into the running process, and neither said "
      + "so. Now they do: the preflight detects a shell with no TitoPay "
      + "configuration and no .env and explains where the configuration "
      + "probably lives, pointing at /v1/health's configWarnings for the "
      + "running process's real state; apply-migrations refuses up front when "
      + "no database URL is visible, in those words, instead of letting the "
      + "Postgres client fall back to the OS username. DEPLOY.md carries the "
      + "same explanation. No API behaviour changed.",
  74: "A CONFIGURATION PROBLEM CAN NO LONGER BE A 502. src/config/env.js does "
      + "not throw any more, for anything. A missing IDENTITY_PEPPER, a short or "
      + "absent JWT secret, a missing database string, a non-numeric port: each "
      + "is now a startup WARNING, printed at boot, counted on GET /health as "
      + "configWarnings and listed by `node preflight.js`. The API starts and "
      + "says what is wrong instead of dying where nobody can read the reason. "
      + "An absent signing key becomes a strong random one for that process "
      + "rather than an empty string, and an absent pepper is derived by HMAC "
      + "from the access secret, which still lives outside the database, so a "
      + "stolen dump is still useless on its own. Security floors are unchanged "
      + "in what they call wrong; only in what they do about it.",
  73: "A DEPLOY CAN NO LONGER DISCOVER A NEW REQUIRED VARIABLE BY GOING DOWN. "
      + "Build 71 made IDENTITY_PEPPER required; the new code correctly refused "
      + "to start without it, and from behind nginx a process that refuses to "
      + "start is a 502. The guard was right and stays; what was missing was any "
      + "way to learn the requirement before restarting into it. Three things "
      + "close that: api/preflight.js reads the server's real configuration and "
      + "says whether this build will start, reporting every problem at once and "
      + "never printing a secret's value; api/.env.example declares every "
      + "variable the API reads and which are required, names only; and DEPLOY.md "
      + "runs the preflight BEFORE the restart, where a failure costs nothing "
      + "because the running API is untouched by extracted files. "
      + "test/deployment-preflight.test.js fails the build if a startup-blocking "
      + "variable is ever added without being declared and checked.",
  72: "STOKVEL MONEY INTEGRITY. A group's recorded savings and each member's "
      + "own total were summed over the register DISPLAY query, which is capped "
      + "at the 500 most recent rows, so a group that crossed 500 contributions "
      + "watched its balance fall. Both totals now come from SUM() in SQL. The "
      + "audit line written AFTER a transfer commits is no longer allowed to "
      + "throw: a failure there reported a payment that had already succeeded as "
      + "failed, and the customer's next move is to pay again. Guessing an "
      + "invite code now costs: POST /v1/stokvels/join and the invitation accept "
      + "path share a five-per-fifteen-minutes limiter in their own bucket, so "
      + "mistyped codes cannot eat a customer's login attempts.",
  71: "SECURITY REMEDIATION FROM THE 19 AUGUST 2026 AUDIT. Identity numbers are "
      + "now keyed. They were digested with a constant in-source prefix, which "
      + "is a domain separator and not a pepper, so a dumped users table gave up "
      + "every customer's ID number: the valid SA ID space is about 1.46 billion "
      + "numbers and one GPU walks it in under a second. Hashing moved to "
      + "lib/identity-hash and is HMAC-SHA-256 under IDENTITY_PEPPER, which is "
      + "REQUIRED IN PRODUCTION - the API refuses to start without it. New "
      + "additive columns users.id_number_hmac, compliance_screening_list."
      + "id_number_hmac and kyc_verifications.document_hmac hold it; the legacy "
      + "digest is still written alongside so that screening entries created "
      + "before the change keep matching, and screening compares keyed with "
      + "keyed and legacy with legacy. Set IDENTITY_HASH_LEGACY_DUAL_WRITE=false "
      + "only after the screening list has been re-ingested. TOP-UPS: creation "
      + "now refuses any currency but ZAR (an omitted field still means ZAR), "
      + "and settlement refuses a missing amount instead of treating it as a "
      + "match and compares the currency it already read; both reuse the "
      + "existing processing/requiresReview path. JWT: access and refresh "
      + "secrets must be at least 32 bytes or the API will not start. BOOK: a "
      + "venue photo may be uploaded but no longer linked to an external host.",
  70: "TWO DEFECTS THAT BROKE CUSTOMER VERIFICATION END TO END. Both were found "
      + "by driving the shipped app against a real database, not by reading. "
      + "FIRST: the FICA submit button never submitted. onSubmit calls "
      + "setBusy(form, true), which disables every control, and submitFica then "
      + "rebuilt its FormData from the now-disabled form - the HTML spec omits "
      + "disabled controls, so every field came back empty and it threw "
      + "'Choose a document to upload.' on a form that plainly had one. No FICA "
      + "submission had ever reached the server from that button. It now "
      + "receives the FormData captured before the fields are disabled. "
      + "SECOND: approving a review never verified the customer. The compliance "
      + "decision endpoint updated kyc_reviews and stopped, while the only write "
      + "to users.fica_status anywhere set it to 'submitted'. Nothing ever set "
      + "'approved'. approvedFicaDetails() requires BOTH, so an officer could "
      + "approve a customer and that customer stayed unverified permanently: no "
      + "verified identity on statements and every check gated on "
      + "users.fica_status = 'approved' shut for good. A FICA approval or "
      + "rejection now reaches the customer record in the same request, audit "
      + "logged with the subject user id. Requires app.zip v441.",
  69: "The Book business console stops being blank. A business can now add a "
      + "photo, add what it offers, set its opening hours for the week, edit "
      + "its details and publish - and it sees today's real bookings with "
      + "confirm and decline, where the screen previously showed a fixed 'no "
      + "bookings yet' even when somebody had booked. Publishing is refused "
      + "until there is something to book and at least one open day, because a "
      + "live page with neither offers a customer an empty screen. The link the "
      + "business shares now RESOLVES: /book/<slug> opens the place, its photo, "
      + "its open times and its list, and a person with no account books it "
      + "there. The .htaccess SPA fallback already served that path; the app "
      + "simply never read it, so the link landed on a sign-in screen. Adds "
      + "cover_image_url and gallery to book_venues. Requires "
      + "db:apply-migrations and app.zip v440 together.",
  68: "Personal users can find and book a business. Discovery, a venue page, a "
      + "day-and-time picker and a confirmation with a readable reference, all "
      + "in the app. The Book tile appears for a customer ONLY once at least "
      + "one venue is published and bookable, and then it appears by itself - "
      + "an empty discovery screen is worse than no tile. Includes a one-shot "
      + "fixup so installs that already created the book service_config row "
      + "learn it is for customers too: that table seeds ON CONFLICT DO "
      + "NOTHING, so an existing row never learns anything from DEFAULT_SERVICES. "
      + "Requires db:apply-migrations and app.zip v438 together.",
  67: "Book is LIVE and no longer coming_soon, because the link finally resolves. "
      + "A person with no TitoPay account can open a business's link, see the "
      + "place and its open times, and book - proven by ten tests that send no "
      + "Authorization header at all. The public endpoints are declared BEFORE "
      + "router.use(requireAuth), or a crawler and a customer would both get 401. "
      + "A booking-appropriate rate limiter was added: the first version reused "
      + "publicContactLimiter at five per fifteen minutes, which SA mobile "
      + "carriers would exhaust with strangers on the same NAT. Requires "
      + "db:apply-migrations and app.zip v436 together.",
  66: "The booking engine, not yet wired to any route. Services, resources, "
      + "opening hours, computed availability and concurrency-safe booking exist "
      + "as services and are covered by 18 tests, but no endpoint calls them, so "
      + "this build behaves exactly like 65 for every user. Book is still "
      + "coming_soon: visible with a soon badge, cannot be bought. Deploying is "
      + "safe and changes nothing anyone can see.",
  65: "No dead ends. Book's tile is coming_soon, so no business can pay R250 for "
      + "a booking page that customers cannot reach yet, and the business screen "
      + "no longer shows a link that resolves to a bare 404. The cause was "
      + "building in architecture layers rather than along the customer journey: "
      + "the screen rendered a URL because the venue row had a slug column, not "
      + "because anything served that address. Everything else is unchanged and "
      + "the R250 path still works; it is gated, not removed.",
  64: "TitoPay Book is REACHABLE. /v1/book is mounted (above lookupRoutes, which "
      + "puts requireAuth on the bare prefix and turns anything after it into a "
      + "401), the Book tile appears for business accounts under Run your "
      + "business, and a business can pay the once-off R250, create its booking "
      + "page and get a clean shareable link. Bookings themselves are not built "
      + "yet: the day view is an empty state, honestly labelled. Requires "
      + "db:apply-migrations and app.zip v434 together.",
  63: "TitoPay Book: the foundation only. Eight new book_* tables, the category "
      + "vocabulary, and the once-off R250 business activation. NOTHING IS "
      + "REACHABLE: no router is mounted, so no endpoint changes and no screen "
      + "changes. Safe to deploy ahead of the feature, and doing so gets the "
      + "migration applied early. The migration is purely additive and touches "
      + "no existing table. The only edit to an existing file outside Book is a "
      + "new entry in the pricing schedule (book_business_activation, R250) so "
      + "the price is operator-controlled rather than hardcoded. Book owns no "
      + "balance and no ledger; the activation moves money through "
      + "applyWalletMovement and records it in transactions, wallet_ledger and "
      + "revenue_ledger like every other rand.",
  62: "Tests only; no behaviour changes from 61. The commercial profile routes "
      + "had no test above the service layer, so a router that referenced the "
      + "wrong function, read the wrong path parameter or was never mounted "
      + "would have passed the whole suite and failed as a screen that will not "
      + "load. test/business-commercial-profile-http.test.js now drives both "
      + "routes over real HTTP with a real session.",
  61: "A business can tell TitoPay what it does and where its money comes from. "
      + "Two self-declared fields on business_profiles, an industry list written "
      + "for the businesses that actually use TitoPay rather than a corporate "
      + "onboarding list, and sources of funds ordered so the first one is the "
      + "primary. NOT VERIFICATION and not behind the Support approval queue "
      + "that a business NAME change goes through: a name is identity, this is "
      + "the business describing itself, and an approval queue would add Support "
      + "load for answers only the business can give. kyb_status is never "
      + "touched and a test asserts it. The columns are added by the migration "
      + "AND by ensureBusinessSchema, because that function creates the table "
      + "on demand for deployments that have not migrated and would otherwise "
      + "build it without them.",
  60: "New customers are finally ASKED to verify their email. The whole flow "
      + "existed and was deliberately dormant: a note in register() explained "
      + "that the landing page did not exist, so a \"Verify your email\" message "
      + "would point every new customer at a 404, and a welcome email with a "
      + "dead link is worse than no email. That was true when it was written. "
      + "pwa/verify-email/ has shipped since, so registration now sends the "
      + "link, non-fatally, exactly like the welcome email beside it. Four "
      + "things were also wrong or missing: links lived for a DAY rather than "
      + "thirty minutes; five of the seven audit events had no writer, so a "
      + "replayed or expired link left no trace; nothing checked that "
      + "APP_ORIGIN was HTTPS before putting a bearer token in a query string; "
      + "and the email did not say that TitoPay never asks for a password, PIN "
      + "or card details, which is the one sentence a phishing lookalike cannot "
      + "copy safely. VERIFYING AN EMAIL STILL GRANTS NOTHING: not identity, "
      + "not FICA, not a limit, and a test now fails if anybody wires a "
      + "financial decision to it. No authentication rule, session rule, "
      + "payment, wallet, QR or provider behaviour changed.",
  59: "A database row is no longer an approval. Gate 6 asked the database "
      + "whether a capability was approved and the database answered, so anybody "
      + "who could write to banking_capability_approvals could approve a bank "
      + "rail: a psql prompt, a restored backup, a migration run by mistake. The "
      + "table already had approved_by and approval_reference columns and "
      + "NOTHING CHECKED THEM, so an approval with both left NULL passed exactly "
      + "like one a compliance officer had signed. An approval now needs "
      + "attribution, an external reference that is not a UUID and not the word "
      + "\"approved\", and an HMAC signature keyed by a secret held in the "
      + "SERVER environment and never in the database, so full database write "
      + "access still cannot mint one. Production additionally needs a second, "
      + "DIFFERENT approver, enforced by the contract and by a CHECK constraint. "
      + "The remaining boundary is named rather than hidden: one holder of the "
      + "shared key can produce both signatures, so the two-person rule is "
      + "enforced in the data and not in the ceremony, and there is a test "
      + "asserting exactly that. Twenty mutations, twenty caught. No provider "
      + "added, no capability enabled, no ledger, transaction status, Peach "
      + "service, payment route, payout route or POS constraint touched.",
  58: "The last architectural weakness closed: a stored configuration must now "
      + "declare which environment it is for. TitoPay resolves credentials "
      + "STORED-CONFIG-FIRST, so a platform_settings row beats the environment "
      + "variable, and every environment check written so far reads the "
      + "VARIABLE. A sandbox configuration restored into a production database "
      + "would have passed all of them, used sandbox credentials, and reported "
      + "nothing wrong. A sixth gate now reads the environment a provider's "
      + "stored config declares for itself and refuses unless it EQUALS the one "
      + "running. Nothing is inferred: not from a URL, a hostname, a key "
      + "prefix, a credential name or a provider name, because a guess that "
      + "happens to be right teaches everyone that guessing works. Missing, "
      + "unknown, ambiguous, unreadable and undeclared all refuse. Mutation "
      + "testing also found dead code in the new gate, a typeof guard on a "
      + "module export that always exists, and it is gone. Ten mutations, ten "
      + "caught. The approval gate's known limitation, that database write "
      + "access can create an approval row, is now documented with a five-point "
      + "TODO rather than left implicit. No provider added, no capability "
      + "enabled, no route, schema, migration or ledger touched.",
  57: "Safety audit of the banking foundation. Two real findings, both from "
      + "MUTATION TESTING rather than from reading the code. First: the "
      + "environment rule was two statements about which pairs were WRONG, with "
      + "everything unlisted falling through to permitted, which is fail-open in "
      + "shape even while it was correct in content. It is now an allow list, so "
      + "a value added later is closed until somebody opens it. Second: the gate "
      + "tests were partly vacuous. They asserted `unavailable` against an "
      + "adapter that implements nothing, so `unavailable` was already true and "
      + "deleting the flag gate from the code broke no test. Three test-only "
      + "stub adapters now isolate each gate, and a control test proves five "
      + "open gates really do open a capability, so the refusals mean something. "
      + "Seven mutations, seven caught. Also: the code has always required FIVE "
      + "booleans while the comments said four, and the eleven states had no "
      + "written meanings. Both corrected. No provider added, no capability "
      + "enabled, no route, schema or migration changed.",
  56: "The banking capability gets a seam, and NOTHING is activated by it. "
      + "src/providers has named `banking` since it was written and deliberately "
      + "left it unregistered; there is now an adapter interface behind it with "
      + "nine operations, all of which refuse with CAPABILITY_NOT_SUPPORTED, and "
      + "a shipped `none` default that implements nothing. A capability opens "
      + "only when FOUR gates agree: the adapter implements it, its config "
      + "resolves, a server-read flag says so, the banking environment agrees "
      + "with TITOPAY_ENV, and an approval row names it. No bank is added, and "
      + "no bank name appears anywhere in the layer. Four new tables hold the "
      + "bank-side lifecycle beside the transaction rather than inside it; none "
      + "holds a balance and none has a foreign key into any ledger. "
      + "transactions.status, the wallet, the ledger, the top-up and withdrawal "
      + "routes and every existing provider are untouched. A deployment that "
      + "has not configured banking gains no new warning and behaves exactly as "
      + "build 55 did.",
  55: "URGENT FIX FOR BUILD 54, WHICH COULD REFUSE TO START. 54 treated a "
      + "variable that had never been set as a reason to stop, so deploying it "
      + "to a server that did not yet have TITOPAY_ENV and the three modes took "
      + "the API down. The check was right; the rollout was the outage. "
      + "Undeclared now WARNS on every boot, reports itself on /health and "
      + "SERVES. Only a CONTRADICTION refuses: a production API on a database "
      + "stamped sandbox, or an integration in the other environment, both of "
      + "which are only reachable once the variables are deliberately set. A "
      + "database that cannot be reached warns instead of refusing, and Peach "
      + "with no mode set keeps its historic production default with a warning "
      + "rather than failing every top-up. This build starts on an empty "
      + "environment, exactly as build 53 did.",
  54: "The API refuses to start on an unsafe environment. PEACH_PAYMENTS_MODE, "
      + "DOCFOX_MODE and OTT_MODE each read `process.env.X || \"production\"`, so "
      + "an unset variable, a typo or a stripped env file put TitoPay LIVE in "
      + "silence. That default is gone: all three, plus a new TITOPAY_ENV, must "
      + "be exactly sandbox or production or the process exits 78 before "
      + "serving anything. The database is stamped with its own identity in "
      + "platform_settings, so a production API opening the sandbox database, "
      + "or the reverse, is refused even if the databases are renamed. No "
      + "financial table gained a column and no data was touched. NODE_ENV is "
      + "deliberately NOT overloaded: setting it to \"sandbox\" would disable "
      + "the customer registration geo-lock and widen CORS.",
  53: "npm run db:init-production stands up a clean production database. "
      + "Sandbox is not a separate database on TitoPay, it is one env var per "
      + "integration, and no table records which mode created a row, so going "
      + "live leaves every test balance in place as a claim on real money. This "
      + "sets up a NEW database instead: schema, pricing, catalogue, templates, "
      + "the revenue wallet that nothing else creates, and one admin, then "
      + "verifies and reports. It holds no DROP, DELETE or TRUNCATE, refuses "
      + "outright if it finds customer data, has no override flag, and writes "
      + "nothing without --apply. See GOING-LIVE.md.",
  52: "An Email Statement now arrives AS a statement. The fee bought an email "
      + "whose body held the ledger as pipe-separated monospace lines that "
      + "wrapped into an unreadable block on a phone, so the document somebody "
      + "paid for could not be used as one. It is now an attached A4 PDF with "
      + "the account holder, the FICA-verified identity where there is one, the "
      + "totals and the ledger as a real table, and the email is a clean "
      + "summary. Also: every copy fixup in seedDefaultTemplates wrote to an "
      + "email_templates.body column that has never existed, so each one threw "
      + "into a silent catch and no copy correction shipped this way has ever "
      + "reached a live database. They now write html_body and text_body.",
  51: "The person who was PAID is now told. Every receipt TitoPay has ever sent "
      + "went to the payer; the receiver got nothing, so a Payment A4 poster, a "
      + "Tip A4 poster, a till, an event selling tickets and money sent to a "
      + "username all landed in silence. One notifier, called from "
      + "createTransaction and from the ticket sale, writes an in-app notice "
      + "always and an email when the customer has transaction receipts on. It "
      + "states the NET that reached the wallet, so it agrees with the balance. "
      + "In-app and email only, no SMS. A gift keeps its own richer notice and "
      + "a held credit keeps notifyHold, so nothing is announced twice.",
  50: "A person pays a FLAT R1.50 to pay by QR, on any size of sale, with no "
      + "percentage and nothing to cap. The percentage sits on the business "
      + "side, which now pays R1.50 + 1.5% of the sale out of what it is "
      + "credited, uncapped. Build 49 charged the customer R1.50 + 1% capped at "
      + "R10; that percentage moves to the business. A sale too small to carry "
      + "its own fee is now refused before anything moves rather than settling "
      + "with the business credited nothing.",
  49: "QR payments are priced on both sides. The customer pays R1.50 + 1% of "
      + "the sale, capped at R10, on top of the amount; the business pays 1.5% "
      + "of the sale, out of what it is credited. It was a flat R0.50 from the "
      + "customer and nothing from the business: a merchant_qr_payment rule has "
      + "sat in the schedule since it was written, at 1.7%, read by no code at "
      + "all, so every business has been credited in full on every payment "
      + "TitoPay has settled. The R0.50 floor that code applied on top of the "
      + "schedule is gone too, so what an admin sets is now what customers are "
      + "charged. A one-shot fixup moves the live rules and skips any rule an "
      + "admin has already changed.",
  48: "GET /v1/qr/:id/status, the one question a till needs to ask. Make a Sale "
      + "was hunting the MERCHANT'S transaction list for the payment, and there "
      + "has never been such a row: a payment writes one transactions row owned "
      + "by the PAYER and the merchant is credited through wallet_ledger, so the "
      + "till searched for something that could not be there and every completed "
      + "sale expired on Waiting for payment. Owner-only, read-only, and it also "
      + "reports what the merchant RECEIVED, which is the full amount: the QR fee "
      + "is the customer's, and the slip was subtracting it from the takings.",
  47: "QR codes are far easier to scan. The image encoded 219 characters the "
      + "server never reads (the account id, amount, currency, reference, label "
      + "and metadata), giving a 61x61 code; it now encodes the id and code type "
      + "only, 66 characters, 37x37, so each module is about 65% wider at the "
      + "same printed size. The quiet zone was also one module against the four "
      + "the QR standard requires, which is a known cause of failed reads. Codes "
      + "already printed still scan: the id is the only field anything reads.",
  46: "An event's web address reads like one. A free name was always used as it "
      + "is; a COLLISION used to append six characters of a sha1 digest, so a "
      + "second event called TitoPay Launch became /events/titopay-launch-3d4c29. "
      + "It is now the next free number, /events/titopay-launch-2. New addresses "
      + "only: every event already published keeps the exact slug it has, so no "
      + "link already shared changes. A long name is also no longer cut leaving a "
      + "dangling hyphen.",
  45: "SECURITY. The price on a QR code came from the REQUEST BODY, with the "
      + "merchant's own amount only a fallback, so a payer could settle a R200 "
      + "Make a Sale for R1 and the code was then marked paid. The amount is now "
      + "read from TitoPay's row and a disagreement is refused outright. The "
      + "printed payload also carried the owner's internal account UUID on every "
      + "poster; nothing read it, and it is gone. Codes already printed are "
      + "unaffected: only the id has ever been trusted from a scan.",
  44: "A shared event link is the real one again. The Share button used to copy "
      + "the API's own /preview path, so organisers sent their audience a URL that "
      + "reads like a developer path; crawlers are now redirected to the preview "
      + "by the app's .htaccess instead, and people get the app. The preview also "
      + "serves the poster as real image bytes at a new public route, because "
      + "posters are data: URLs and no crawler could ever fetch one, so every "
      + "shared event has previewed with no image. The description is cut at a "
      + "word boundary instead of mid-word, with no raw line breaks.",
  43: "Four things about a QR payment. GET /v1/qr/:id/details finally exists, so "
      + "the review screen can name the owner instead of always reading Owner not "
      + "confirmed. A payment whose recipient wallet cannot be resolved is refused "
      + "before anything moves, where it used to debit the payer, credit nobody and "
      + "report completed. Paying your own QR is refused. A missing revenue wallet "
      + "now says something a customer can act on rather than the blanket 5xx, and "
      + "the admin console reports it as a fault instead of passing on zero rows.",
  42: "A business can record its company registration number before the owner "
      + "has verified their own identity. CAPTURING the entity is not VERIFYING "
      + "it, and refusing the first until the second was done left a business "
      + "owner on a screen that offered an ID number and nothing else. Nothing "
      + "about verification moved: a business still cannot be submitted, and no "
      + "limit still moves, until a person is verified behind it.",
  41: "An organiser can replace the poster on an event that is already selling. "
      + "Everything else on an approved event still goes through admin review; "
      + "the poster is the shop window and a wrong one is a broken event the "
      + "organiser must be able to fix themselves. One column, audited, and "
      + "refused on a cancelled or finished event.",
  40: "Event Tickets actually appears for business accounts on upload. Build 39 "
      + "corrected the default, but the seed inserts with ON CONFLICT DO NOTHING "
      + "so it never reached a database that already had the row. The correction "
      + "is now pushed out the same way the service renames are, once, recorded, "
      + "so an admin who later hides the tile keeps that decision.",
  39: "Event Tickets is offered to business accounts as well as personal ones. "
      + "Buying a ticket was never personal-only: the whole path already worked "
      + "for a business wallet, the tile was simply hidden. Selling tickets is "
      + "unchanged and stays business only. Seeds only a database that has "
      + "never seen the row; an existing one needs the column set directly.",
  38: "The schema can apply on an older PostgreSQL again. CREATE TRIGGER ... "
      + "EXECUTE FUNCTION needs PostgreSQL 11, and schema.sql runs as ONE "
      + "statement, so on an older server that syntax error rolled the whole "
      + "file back and created nothing. Every table declared after it had been "
      + "missing in production for months. EXECUTE PROCEDURE is the older "
      + "spelling, identical for triggers, accepted by every release.",
  37: "Schema repair that never rewrites pricing (scripts/repair-schema.js); the "
      + "diagnosis stops counting foreign keys across every schema and stops "
      + "pointing at db/init.js. No response shape changed.",
  36: "App only: the landing screen stops fighting the browser for a gesture " +
      "it was always going to lose. iOS Safari reserves a strip down each side " +
      "for its own back navigation and `touch-action` does not govern it, so a " +
      "swipe starting there became a page transition AND stepped Personal to " +
      "Business at the same time — the app sliding sideways with a pale gap " +
      "where the rest of it should be. It now declines gestures that begin in " +
      "that strip. No API change; the build moves so the pair stays legible.",
  35: "The diagnosis stops needing a shell. GET /admin/diagnostics/console " +
      "returns exactly what `npm run db:diagnose` prints, from one shared " +
      "service, so the console and the script can never disagree: the tables " +
      "each page needs, the queries the failing panels actually run with the " +
      "real Postgres error, the save statements behind the buttons that say " +
      "nothing useful, the shape of platform_settings on THIS database, and " +
      "which provider supplies which capability. Read-only; the save probes " +
      "run inside transactions that are always rolled back. Database Health " +
      "also stops checking a stale fifteen-table list against a schema past " +
      "a hundred and fifty, and /health's build number is finally read.",
  34: "Limits & Verification is operated from the console. The numbers were " +
      "already editable; the SENTENCES around them were hard-coded, which is " +
      "the wrong way round, because wording is what a compliance review " +
      "actually asks to change. Both now live in platform_settings. And a " +
      "real hole closes: the limit store had NO validation, and the engine " +
      "reads a non-finite value as \"no limit\", so a typed \"25,000\" removed a " +
      "limit and reported success. Types and ranges are refused; incoherence " +
      "is warned about rather than blocked. Editable wording cannot claim a " +
      "regulator set the amount, and the two caveat sentences cannot be " +
      "emptied.",
  33: "Terminology, not arithmetic. The first level is \"Limited Access\" " +
      "rather than \"Unverified\": no approved TitoPay compliance requirement " +
      "says a customer may transact without the due diligence that applies to " +
      "them, and a label announcing otherwise reads as a claim that one does. " +
      "The top level no longer calls itself FICA verification, which is a " +
      "documentary review and not a generic verification status, and never " +
      "implies enhanced due diligence was performed. The product ACCESS LEVEL " +
      "is now its own named concept in the status payload, separate from the " +
      "compliance axes it is derived from. The disclaimer denies statutory " +
      "status of any kind rather than only FICA. No limit changed.",
  32: "The monthly figure is a TRANSACTION VOLUME limit and nothing else. " +
      "Build 31 scaled the per-payment, daily, withdrawal and wallet-balance " +
      "rails alongside it, which quietly said a wallet that may MOVE R200 000 " +
      "over a month may also HOLD it, and may move it in one payment. Those " +
      "four rails are back on their own values and their own reasoning: " +
      "unverified R25 000 a month, basic verified R200 000 a month, fully " +
      "verified no fixed monthly limit, with per payment, per day, cash out " +
      "and stored value set independently of all three.",
  31: "The ladder is three levels and the whole ladder moved: unverified " +
      "R25 000 a month, identity verified R200 000 a month, fully verified " +
      "no standing limit on any rail. Set deliberately ABOVE the identity " +
      "assurance the platform currently holds, so the trade-off is written " +
      "into the config rather than discovered later. Risk is still applied " +
      "last, so an elevated or high risk account is narrowed on every level " +
      "including the top one.",
  30: "Providers become replaceable and a business stops being a person. Core " +
      "asks for a CAPABILITY (processPayment, processPayout, verifyIdentity) " +
      "and never for a company; which supplier answers is one environment " +
      "variable per capability. A business now has its own entity, its own " +
      "registration number where its type has one, and its own KYB status, so " +
      "one verified person can hold several businesses without re-verifying " +
      "themselves once. The top verification level gains a R200 000 monthly " +
      "ceiling in place of no standing limit at all.",
  29: "A cancelled event is answered instead of hidden: its public page used to " +
      "404 the moment it was cancelled, killing every share, email link and " +
      "poster QR pointing at it, and My Tickets never carried the event status " +
      "so a cancelled ticket looked live. Customers can also remove a ticket " +
      "from My Tickets, which hides it and never deletes it, so the row, its " +
      "scan history and the organiser's counts are untouched and it can be " +
      "brought back.",
  28: "The schema can rebuild an empty database again: two ticketing tables " +
      "referenced transactions 200 lines before it was created, and because " +
      "the file runs as one statement that rolled the WHOLE schema back and " +
      "left nothing behind. Adds `npm run db:diagnose`, which reports the real " +
      "reason a console page is failing instead of the sanitised message the " +
      "operator sees.",
  27: "The same commit-then-500 audit bug fixed for security content in build " +
      "26 was still live on PUT /admin/roles/:role, which wrote a role name " +
      "into a UUID column: changing what a role may do saved the change and " +
      "then reported failure, logging nothing. Fixed at the call site AND in " +
      "writeAuditLog, so any identifier that is not a UUID now travels in the " +
      "metadata rather than costing the whole audit record.",
  26: "Saving security content no longer answers 500 after saving it: the audit " +
      "write put the settings key in a UUID column, so the copy changed while " +
      "the admin was shown an error and the log recorded nothing. The console " +
      "and the API now offer the SAME icon list, so re-saving cannot downgrade " +
      "a stored icon, and the admin read reports whether anything is stored and " +
      "who wrote it.",
  25: "The customer security copy is admin-editable: the Stay safe with TitoPay " +
      "card, its warning, the acknowledge button and the safety tips now live in " +
      "platform_settings and are edited from the console with a live preview. " +
      "Reading is public and never throws; the app keeps the same defaults so " +
      "the warning still renders with no network at all.",
  24: "Refund policy ENFORCED, not just stored: refunds_allowed, the cut-off " +
      "and the conditions had never been read by anything, and the app sent " +
      "every tier as refundable regardless. Buyers now see the terms before " +
      "paying and organisers approve refunds themselves. Plus waitlists on " +
      "sold-out events, promoter links that attribute sales, multi-day events, " +
      "duplicate-an-event, and server-rendered Open Graph link previews.",
  23: "Event discovery: search and category filtering answered in SQL over the " +
      "whole approved catalogue instead of in the browser over one batch, with " +
      "category counts built from the full catalogue so a filter can always be " +
      "undone. One shared category vocabulary for the organiser's form and the " +
      "buyer's chips. Browsing still needs no account.",
  22: "Ticket discount codes: organisers create a code with an expiry and " +
      "either a percentage or an amount off, optionally capped by total uses, " +
      "uses per person and ticket type. Buyers enter it at checkout. The " +
      "discount comes off the subtotal so the organiser funds it, and TitoPay " +
      "charges commission on what was paid, never on the money given away. " +
      "Schema is additive; orders written before this are untouched.",
  21: "Sign out now revokes the session the server already proved, instead of " +
      "matching a refresh token hash from the request body and reporting " +
      "success whether or not anything was revoked. A refresh token is still " +
      "honoured when sent, scoped to the caller's own account, so it can no " +
      "longer sign a stranger out. Other devices are unaffected.",
  20: "Two holes a live probe opened, closed. The API enforced no password " +
      "rule at all and accepted the password 'a'; it now applies a policy at " +
      "registration and reset, and NEVER at sign-in, so no existing customer " +
      "is locked out. Account lockout is checked before the password is " +
      "verified, so a correct guess against a locked account no longer looks " +
      "different from a wrong one.",
  19: "Fewer database round trips on the money path: the limit engine now " +
      "returns the 24 hour debit count with the rest of its usage picture, " +
      "and transaction monitoring reads it from there instead of asking the " +
      "ledger the same two questions again. No rule, limit or number changed.",
  18: "Basic Verified limits set to the assurance TitoPay actually has: " +
      "R25 000 a month, R10 000 a payment, with the rest of the rung moved " +
      "to stay coherent. Raise them in the console the day an identity " +
      "verification provider is wired in.",
  17: "Held money now lives in a suspense wallet so every leg balances; both " +
      "sender and recipient are told about a hold (in-app only, never a " +
      "claim-by-link message); hold window 7 days; earned capacity counts " +
      "distinct real counterparties, so it cannot be farmed by self-payment.",
  16: "Limit engine: verification x product x earned standing x risk, risk last. " +
      "Refusals quote remaining capacity, never the law. Money beyond a recipient's " +
      "capacity is held for them to claim, released on verification, returned in " +
      "full (fee included) if unclaimed. Limit config versioned and reversible.",
  15: "Money Integrity Engine: ledger-vs-balance sweeps, duplicate/orphan/" +
      "unbalanced detection, transaction status history by trigger, provider " +
      "reconciliation with exception queues, compliance case management, " +
      "dashboards, regulatory report evidence, security signals into risk.",
  14: "Identity verification goes international: SA ID, passport or other " +
      "approved document with issuing country, hash-only storage, verification " +
      "history, and nine customer-safe verification states on the wallet badge.",
  13: "Compliance finalized: risk axis separate from KYC (normal/elevated/high " +
      "risk/EDD), sanctions screening list, transaction monitoring, ongoing CDD, " +
      "daily/withdrawal/balance limits, pre-limit upgrade nudges, RMCP disclaimers.",
  12: "Progressive KYC/FICA: four tiers with configurable limits, instant SA ID " +
      "basic verification, automatic EDD flags, and Limits and Verification in the app.",
  11: "Receiving is open unless the account is blocked; every sent transfer " +
      "records and reports who was paid, name and contact included.",
  10: "FICA is now the R200 000 monthly receiving limit, not a wall: unverified " +
      "accounts receive and request freely under the line, one rule on all rails.",
  9: "/health now reports the email worker's own build, so an unrestarted worker is visible.",
  8: "Emails render full-width and readable on phones: viewport-aware wrapper.",
  7: "Stokvel treasurer contributions live; gift notices; PDF tickets in email; " +
     "email overhaul (copyright, legal links, unsubscribe, no dead verify link); " +
     "support list cleanup; response compression; hot-path indexes.",
  6: "Payment requests live: Request funds and Bill Split store real requests, " +
     "notify the payer, and settle on the wallet_transfer rails when paid.",
  5: "Cleared notifications stay cleared on every device: server-side clear marker.",
  4: "Campaigns scoped to one event, paid on submission, released only on admin approval.",
  3: "Campaign Tools: R1500 email pack per event, R0.60 per SMS sent.",
  2: "Ticket phases and pre-sales enforced; registration events; organiser social links.",
  1: "Ticketing analytics on the console's path; Service Builder API storage; " +
     "raw emails can never render blank; TitoKids invite rewritten; build number added."
};

module.exports = {
  API_BUILD,
  BUILD_NOTES,
  buildInfo() {
    // appVersion is the literal "1.0" and has been since the first deploy, so
    // it reports the same thing for every build and answers nothing. `build`
    // is the field that moves and the one to read.
    //
    // LEAVE IT ALONE. It was changed to carry the build, and that was a change
    // to a live response shape made because someone ASKED WHAT THE FIELD MEANT,
    // which is not a request to change it. Anything outside this repository
    // may be reading it -- an uptime check, a monitor, a script on the host --
    // and none of that is visible from here. Changing it needs a decision, not
    // an inference.
    return { build: API_BUILD, appVersion: "1.0" };
  }
};
