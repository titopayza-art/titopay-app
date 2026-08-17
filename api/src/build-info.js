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

const API_BUILD = 54;

// Most recent first. Keep this short; it is a deployment aid, not a changelog.
const BUILD_NOTES = {
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
