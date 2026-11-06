# Putting TicketRoom live on Afrihost

Do these in order. Nothing here needs a developer. Set aside about an hour,
most of it waiting for the certificate.

---

## Before you start, have these to hand

| What | Where it comes from |
| --- | --- |
| cPanel login | Afrihost Client Zone → **Hosting** → your package → **cPanel** |
| `ticketroom.zip` | The build you were given. Every version has this same name; `version.txt` inside it names the build. |
| A 32+ character bootstrap secret | You generate it yourself for the one-time owner setup. |
| A password for the `hello@ticketroom.co.za` mailbox | You create it in step 4. |

`ticketroom.co.za` must already point at Afrihost. Nothing below works while
it still resolves somewhere else.

---

## Already live? Updating to a new version

This package is build **2026-10-22-phases**. Updating takes five minutes and keeps
every account, event, order and setting.

Before you start:

- Admin portal → **Backups** → **Back up now**, then **Download** that copy
  to your computer. (The site also makes its own copy just before it
  upgrades the database, but a copy off the server is the one that counts.)
- Admin portal → **Site settings** → turn **Maintenance mode** on. Gate
  scanners, the top-up desk and the tills keep working, so it is safe even
  on an event day. Turn it off again after step 7.

Then:

1. cPanel → **File Manager** → `public_html`. **Settings** (top right) →
   tick **Show Hidden Files (dotfiles)**.
2. **Delete the old `ticketroom.zip` from `public_html`** if it is still
   there. Every version is called `ticketroom.zip`, and cPanel will not
   upload a file over one with the same name (unless you tick **Overwrite
   existing files**): you would end up extracting the old version again. Do not delete `data`, `ticketroom-data`
   or `tr-data`: that is your data.
3. **Upload** the new `ticketroom.zip` into `public_html`. Wait for the bar to reach 100%.
4. Right-click `ticketroom.zip` → **Extract** → into `/public_html` → **Extract
   File(s)**. Existing files are replaced.
5. Delete `ticketroom.zip`.
6. Open **https://ticketroom.co.za/version.txt**. It must say
   `TicketRoom build 2026-10-22-phases`. An older build means step 2 or 4 did not
   happen: do them again.
7. Sign in to the admin portal. The Overview line says "Running build
   2026-10-22-phases".
8. On your phone, close the TicketRoom tab or app and open it again. If you
   added TicketRoom to your home screen before, remove that icon and add it
   again from Safari (Share → **Add to Home Screen**) or Chrome
   (⋮ → **Add to Home screen**).

The database upgrades itself the first time the new version is opened.
Existing accounts are sorted into customers, organisers and staff by what
they already do. From this version, staff sign in at
**ticketroom.co.za/admin** only (the website's sign-in is for customers and
organisers).
Accounts made before email confirmation was required are asked to confirm
their email once, the next time they sign in; the link is sent for them.

If the update went wrong, put the backup you made back: see
**Restoring a backup** below. From this version the cron job is required:
if you have not set it up yet, do step 12 now.

## 1. Set the PHP version

cPanel → **Select PHP Version** (some accounts call it **MultiPHP Manager**).

Choose **PHP 8.1 or newer** (8.2 or 8.3 is best). Under **Extensions**, make
sure these are ticked:

- `pdo_sqlite`: the database. Without it nothing starts.
- `openssl`: email through the mailbox, and ticket signing.
- `mbstring`: names and text.
- `curl`: only for the website assistant's AI answers (optional).

## 2. Clear out the old upload

cPanel → **File Manager** → `public_html`.

1. **Settings** (top right) → tick **Show Hidden Files (dotfiles)**. Do this
   first: `.htaccess` controls the addresses, and an upload that skips it
   leaves pages showing "Not found".
2. Delete what earlier uploads left: `tr-app`, `ticketroom-app`, `holding`,
   any old `index.html` and any `.zip` files.
3. Leave `tr-data` alone if it exists, and the `ticketroom-data` folder next
   to `public_html`: they may hold the data of an earlier install, which the
   new package keeps using.

## 3. Upload the site

1. Upload `ticketroom.zip` into `public_html`.
2. Right-click it → **Extract**, into `public_html` itself.
3. You should now see `index.html`, `api`, `assets`, `data` and `legal`
   directly in `public_html`, not inside another folder. If they went into a
   folder, move its contents up one level.
4. **Delete `ticketroom.zip` from the server.** Then open
   https://ticketroom.co.za/version.txt: it should say `TicketRoom build 2026-10-22-phases`.

Create `ticketroom-data` next to `public_html`, not inside it, and give the
PHP user access (`750` is preferred; `770` only when required by the host).
New installs refuse to store database or keys under the web root.

## 4. Create the mailbox

cPanel → **Email Accounts** → **Create** → `hello@ticketroom.co.za`. Give it a
real password and keep it.

You'll type that password into the admin portal in step 8 (Admin portal →
**Integrations** → Email). It is stored encrypted and never shown again.

(Prefer files? **File Manager** → `ticketroom-data/config.php` (the folder
next to `public_html`, not inside it) → **Edit**, and put the password
between the quotes on the `smtpPass` line. The admin portal wins if both are set.)

(`ticketroom-data` and its `config.php` appear at first setup. If the host does
not permit that directory next to `public_html`, use a hosting plan that does;
this build will not create new private data under the web root.)

This matters: the site sends tickets as `hello@ticketroom.co.za`, and email
sent without the mailbox often lands in spam or is not delivered at all.

## 5. Check what arrived

Diagnostics are disabled by default. During a short approved maintenance
window, set `security.diagnosticsEnabled` to `true` in the private config,
create `ticketroom-data/unlock-check`, then open
**https://ticketroom.co.za/deploy-check.php**.

It reports the build, the folder, PHP, the data folder, whether the API and
the clean addresses work, whether database/key/config/upload paths are safe
from download, how email is sent, and what is left over from earlier uploads.
An existing install with data inside `public_html` is now marked **Fix** even
if `.htaccess` currently blocks direct requests. Follow the no-delete
migration procedure in `SECURITY-OPERATIONS.md`; do not delete or rename the
old data until the new copy has been verified. Then delete
`ticketroom-data/unlock-check` and set `security.diagnosticsEnabled` back to
`false`.

## 6. Turn on https

1. cPanel → **SSL/TLS Status**. `ticketroom.co.za` and `www.ticketroom.co.za`
   should show a certificate. If not, press **Run AutoSSL** and wait (up to
   an hour).
2. Once the padlock shows in the browser: cPanel → **Domains** → switch on
   **Force HTTPS Redirect**.

`www.ticketroom.co.za` already goes to `ticketroom.co.za` on its own.

## 7. Create the first owner over HTTPS

After the certificate is active, create `ticketroom-data/bootstrap-secret`
with a random 32+ character value. Within 15 minutes open
**https://ticketroom.co.za/setup.php**, enter that value, choose the owner
email/name and a 14+ character password. The bootstrap secret is removed when
the account is created. Then sign in at **https://ticketroom.co.za/admin**.
This sign-in is for TicketRoom staff only; create separate accounts for every
staff member. Staff sign-in requires a one-time code sent to the verified
staff email address; protect that mailbox with independent MFA. Admin pages,
staff login, OTP verification, and `/api/admin/*` remain available while
maintenance is on. Customer accounts cannot sign in during maintenance.

TicketRoom has three portals, each with its own coloured bar so they are
never confused:

| Portal | Address | Bar | Who uses it |
| --- | --- | --- | --- |
| Admin portal | /admin | red | TicketRoom staff: approve organisers and events, site settings, support |
| Organiser portal | /organisers | blue | Organisers: their events, tickets, sales, gate staff |
| Customer portal | /account | green | Ticket buyers: their tickets, orders, transfers |

One account, one portal: every account is a customer, an organiser or
TicketRoom staff, and signs in only on its own portal. Customers sign up on
the website, organisers with **Start selling**, and staff accounts are made
only under **Staff & roles**, on a work email (a customer's or organiser's
email can never become staff). The Menu button
lists the other portals a person may open, by these names. The admin portal
is never linked anywhere on the site: staff open it by typing
ticketroom.co.za/admin, and to anyone else that address shows "Page not found".

Retail applications and sales start **off** and the public Retail page shows a
Coming soon notice. An admin can activate or pause the programme under
**Admin portal → Site settings → Retail partner programme**. Pausing is blocked
while retailer cashier shifts remain open or reserved retailer sales need to
be resolved. Application review and partner payout reconciliation remain
available to staff while the programme is paused.

## 8. Set up email and prove it works

Admin portal → **Integrations** → **Email**: choose "SMTP mailbox", check
the server (`mail.ticketroom.co.za`, port `465`), type the username
(`hello@ticketroom.co.za`) and the mailbox password, press **Save** and type
your own admin password when asked. Press **Send a test email** and type any
address: it is sent straight away and the page says what happened. If it
fails, **Check connection** says why. Admin portal → **Email templates**
lets you preview every email and send a test of any of them.

If you use port 587 (or 25), the mail server must offer a secure
connection (STARTTLS): TicketRoom never sends the mailbox password without
one, and says so on the Messages page. Port 465 is always secure.

### Email authentication (SPF, DKIM and DMARC)

Without these, Gmail and Outlook send many tickets to spam. In cPanel →
**Email Deliverability**, press **Repair** (or **Install the suggested
record**) next to SPF and DKIM for `ticketroom.co.za`, until both show a
green tick. Then add a DMARC record in cPanel → **Zone Editor** → **Add
Record** → TXT, name `_dmarc`, value `v=DMARC1; p=none; rua=mailto:hello@ticketroom.co.za`.
If you use an email relay (Amazon SES, Mailgun, Brevo), add the records it
gives you instead. SECURITY-OPERATIONS.md has the details.

## 9. Switch on card payments

Free events work without this. For paid tickets, TicketRoom uses your own
Yoco, PayFast, or Peach Payments merchant account; the money goes to that
account, and TicketRoom pays organisers from it.

**Yoco (recommended: refunds happen with one click)**
1. Sign in at portal.yoco.com → **Sales** → **Payment gateway**. You will see
   **Test keys** and **Live keys** (a public key `pk_…` and a secret key `sk_…` each).
2. Admin portal → **Integrations** → **Card payments**: provider **Yoco**,
   mode **Test**. Paste the test public and secret keys in the **TEST** boxes
   and, when you have them, the live keys in the **LIVE** boxes, then **Save**
   (it asks for your admin password). A key pasted in the wrong box is refused.
   TicketRoom registers a separate notification address with Yoco for test
   and for live, and keeps both.
3. **Check connection**: it reports Test and Live separately. Then make a R10
   test event and buy a ticket with Yoco's test card (4111 1111 1111 1111,
   expiry 01/30, CVC 123).
4. When that works: change **Mode** to **Live** and **Save**. Only the live
   keys are used from then on, so a test payment can never count as real money.

**Just want to try it first?** Press **Use the test account** on the Card
payments card: PayFast's shared test account in test mode, no sign-up, no
real money. Buy a ticket to see the whole flow, then put in your own keys.

**PayFast (cards, instant EFT, SnapScan, Zapper)**
1. PayFast dashboard → **Settings** → **Developer settings**: note the
   merchant ID and merchant key, and set a **passphrase**.
2. Admin portal → **Integrations** → **Card payments**: provider **PayFast**,
   mode **Test** for the sandbox or **Live**, enter the three values, **Save**.
3. PayFast refunds are made in the PayFast dashboard; then record the
   reference in Admin portal → **Refunds** ("Mark paid manually").

**Peach Payments (hosted checkout)**
1. In Peach's sandbox Dashboard, create or select a Checkout profile and
   copy its profile ID and API key. Keep sandbox credentials separate from
   production credentials.
2. Admin portal → **Integrations** → **Card payments**: choose **Peach
   Payments**, set **Mode** to **Test**, enter the sandbox profile ID, API
   key, and a strong webhook secret, then save.
3. In the sandbox Checkout profile, configure the payment notification URL
   shown in Integrations and add the custom header
   `X-TicketRoom-Peach-Secret` with the same webhook secret. Check connection,
   then complete a paid sandbox order and confirm the payment/order/ticket
   in Admin. Test credentials create TEST orders and cannot count as sales.
4. Before launch, configure the production Peach Dashboard with its own
   profile, API key, and custom webhook header/secret. Select **Live** only
   after the sandbox order passes. Never paste sandbox credentials into
   production fields or vice versa.

**Peach Payments Payouts (optional, separate from checkout)**
1. Peach Payouts uses different credentials and endpoints from Checkout.
   Enter the sandbox client ID, client secret, and merchant ID under
   **Integrations** → **Payouts**, select **Peach** and **Sandbox**, and check
   the connection.
2. Set the displayed Payout status webhook URL in Peach's Payouts Dashboard
   and request its signing secret from Peach support; enter that secret in
   the sandbox webhook field. Use an approved test payout to verify the flow.
   Sandbox results never mark a real organiser payout as paid or change the
   production ledger.
3. Use separate production Payouts credentials and webhook signing secret.
   Live payouts require finance approval, sufficient Peach float, valid
   beneficiary details, and deliberate confirmation. Transfers cannot be
   recalled. Peach may require source-of-funds review or IPv4 allowlisting.
   Unsupported/invalid bank details remain on the manual EFT process.

Keys are stored encrypted and never shown again; the page only says
whether each one is saved. Changing them needs your admin password and is
written to the audit log.

**How the money moves**
- A ticket is issued only when the selected payment provider confirms the payment to
  TicketRoom directly (a signed notification). Coming back to the website
  proves nothing on its own.
- Every payment, refund and payout is written to the **Ledger**, which must
  always balance. **Reconciliation** compares TicketRoom with the
  provider's report (export it as CSV from the provider's portal).
- **Refunds**: customer care or an organiser asks; finance approves (a
  second person, unless only one person has the finance role). Yoco
  refunds go straight back to the card.
- **Payouts**: an organiser's money becomes available a few days after
  their event (3 by default). They ask from their portal; finance approves,
  makes the EFT from TicketRoom's bank, and records the bank reference.
  The organiser is emailed at each step.

**Cashless events (wristbands)** switch on by themselves once card
payments work (the sandbox too, for practice). Nothing else to set up.
- The organiser ticks **Cashless event** on the event, then registers the
  wristbands' chip numbers (Vendors & POS → Wristbands). The download is
  the only copy of each band's printed code and activation code.
- Attendees link a band in their account (or at the registration desk in
  the gate scanner), top up by card, and tap to pay. Purchases of R200 or
  more need their spending PIN. A lost band is blocked from the account in
  one tap; the balance stays on the account for the next band.
- The organiser adds vendors, invites their staff by email and registers
  a till for each phone (ticketroom.co.za/pos). TicketRoom's commission is
  the percentage set per vendor; top-ups and refunds carry no fee.
- **Top-up desk**: guests can also top up in person with cash or on the
  event's own card machine (gate scanner → Top-up desk, the organiser's
  Vendors & POS tab, or Admin → Wristbands & wallets). Each desk has a
  cash-up (print or CSV). Desk money is already in the organiser's hands, so
  it comes off what TicketRoom pays them for that event.
- **Cash-outs**: after the event (or while the organiser has the venue's
  cash-out desk open) guests cash out from their wallet: back to the card
  for money topped up online, by EFT (finance approves under **Refunds**;
  two people for large amounts), or as cash at the cash-out desk with a
  code. Everyone with money left gets one email with a link; money topped up
  online by card goes back to the card automatically after 14 days.
  Vendor takings are settled to the organiser under **Payouts**.
- Limits can be changed in `ticketroom-data/config.php`:
  `'cashless' => ['minTopupCents' => 5000, 'maxTopupCents' => 300000, 'maxBalanceCents' => 500000, 'pinThresholdCents' => 20000,`
  `'deskDailyCapCents' => 2000000, 'cashoutFeeCents' => 0, 'dualApprovalCents' => 200000, 'autoRefundAfterDays' => 14]`,
  or `'cashless' => ['enabled' => false]` to switch it off for the whole site.

---

## 10. SMS (optional)

Admin portal → **Integrations** → **SMS**. Choose **BulkSMS** or
**Clickatell** and paste its keys, or **My own provider (any web API)**:

1. From your SMS provider's API documentation, copy the web address for
   sending one SMS (it must start with `https://`) and the Authorization
   header value (for example `Bearer …`).
2. Fill in the field names the provider expects for the number and the
   message (often `to` and `message`), the sender field if any, and the
   number format (+27…, 27… or 0…).
3. **Save**, then **Send a test SMS** to your own phone.

The address and header are stored encrypted, like every key.

## 10b. Organiser verification (FICA)

Organisers verify themselves under **Verification** in the organiser
portal: one checklist, only what applies to them (an ID and signed terms
for everyone; company or NPO papers where relevant; a bank confirmation
letter and proof of address only before payouts; permits only for events
that need them). Staff check the uploads in Admin portal → **Verification**.

- **Documents are private.** They are stored encrypted in
  `ticketroom-data/private` (never inside `public_html`) and can only be
  opened by the organisation's owners and TicketRoom staff. Every view is
  logged and shown to the organiser. Include `ticketroom-data` in backups.
- **Upload size.** Documents can be up to 10 MB. If the host's PHP allows
  less (`post_max_size`, often 8 MB), uploads are capped at that. To allow
  the full 10 MB: cPanel → **MultiPHP INI Editor** → choose the domain →
  set `post_max_size` to `12M` → **Apply**.
- **Identity checks.** Admin portal → **Integrations** → **Identity
  verification**: *TicketRoom staff* (the default, works now), the
  *Sandbox* (simulated, for testing only: never leave it on when live), or
  *My own provider* (an `https://` address on the public internet and an
  Authorization header; both stored encrypted). **Try a check** tests it.
- **Keeping documents.** Admin portal → **Verification** → *Keeping
  documents*: records are kept 5 years after an organiser's account closes
  (FICA's minimum; you can choose up to 10), then deleted automatically.
  Replaced or rejected copies go after 90 days by default.

## 10c. Promote (the R1,600 organiser package)

Organisers buy **Promote** for one event from the event's **Promote** tab
in the organiser portal (also listed under **Promote** in their menu and
on the public **/sell** page). The standard price is R1 600 once off and runs until the
event ends: unlimited email campaigns to opted-in buyers (at most 6 sends
an hour), SMS campaigns once SMS is set up (step 10), a post on
TicketRoom's socials, and results per campaign.

- **Payment.** By card through whatever is set up in step 9 (the sandbox
  and test mode mark it **TEST**; it never counts as revenue), or by the
  owner straight from the organiser's available balance (same verification
  rules as a payout).
- **Your work.** Admin portal → **Promotions** → *Social queue*: open a
  request (caption, dates, links, pictures to download), mark it
  *Scheduled*, then *Posted* with the post's link. The organiser is
  emailed when it is live.
- **Refunds.** If a promoted event is cancelled, finance presses
  **Refund** on the promotion: card payments go back through the provider
  (PayFast ones are refunded in the PayFast dashboard, then recorded with
  **Record refund**); balance payments go back to the balance.
- **Rates.** Admin portal → **Site settings** → **Pricing and fees** controls ticket
  commission, service fee, Promote, advertising's daily starting rate, and the cashless
  default commission for new vendors. Admin → **Wristbands & wallets** sets each vendor's
  negotiated commission. Existing tickets, purchases, vendor agreements and settlement
  entries keep their recorded rates; changes apply only to new orders or future vendor sales.
  Advertising dates and final quotes are confirmed manually.
  With an SMS cost set in `ticketroom-data/config.php`, organisers see an estimate before
  each SMS send; without it they are told no cost is set.

## 11. Maintenance mode

Admin portal → **Site settings** → **Maintenance mode**. While it is on,
the server answers every visitor with the maintenance page: nobody can
browse, book, sign up or sign in, except TicketRoom staff, who see the
site as normal with a yellow "Maintenance mode is on" bar. Payment
notifications from Yoco and PayFast keep arriving. Gate staff keep going:
the scanner (`/scan`), the top-up desk and the vendor tills (`/pos`) still
work, and gate staff can still sign in there. **See what visitors see**
previews the page. Turn it off on the same card.

## 12. Cron job (required)

Email, reminders, expiring holds, the daily backup and the alert email run
from a cron job. Without it they only run when someone happens to visit the
site, and on a quiet night nothing goes out.

1. cPanel → **Cron Jobs**. Under **Cron Email**, leave your own address:
   the job prints nothing when all is well, so you only hear about problems.
2. **Add New Cron Job** → Common Settings: **Once Per Five Minutes**
   (`*/5 * * * *`).
3. Command (put your cPanel username in place of `YOURUSER`; cPanel shows
   it top right, and the folder in File Manager's address bar):

       /usr/local/bin/php /home/YOURUSER/public_html/api/cron.php >/dev/null 2>&1

   Use the full path to PHP. A bare `php` can run an older PHP than the
   website uses, and the job then fails. If `/usr/local/bin/php` is not
   there, cPanel → **Select PHP Version** names the right one (often
   `/opt/alt/php83/usr/bin/php`).
4. Ten minutes later, Admin portal → **Backups** says "Cron job: last ran …".
   `/api/health` shows the same under `jobs.cron`.

If the job reports an error, it is printed to the cron email (and kept in
`ticketroom-data/php-errors.log`).

## 13. Backups

The site makes its own copy of the database every day (the newest 14 are
kept), and another just before every database upgrade (the newest 5). They
are in `ticketroom-data/backups`, outside the website, and only admins can
see them: Admin portal → **Backups**. **Back up now** makes one on the
spot. Every download is written to the audit log.

A copy on the same server does not help if the server is lost. Once a week,
download the newest copy to a safe place (a company drive), and keep a
cPanel → **Backup** → **Download a Home Directory Backup** now and then,
which includes `ticketroom-data` (the keys, uploads and settings as well as
the database).

### Restoring a backup

Restoring replaces everything on the site with the copy: orders and
accounts made since it was taken are lost. Do it only when you must.

1. Admin portal → **Site settings** → **Maintenance mode** on.
2. Admin portal → **Backups** → **Back up now** (so the current state is
   kept too).
3. cPanel → **File Manager** → `ticketroom-data`. Rename `ticketroom.sqlite`
   to `ticketroom.sqlite.old`. Delete `ticketroom.sqlite-wal` and
   `ticketroom.sqlite-shm` if they are there.
4. Copy the backup you want (from `ticketroom-data/backups`, or upload one
   you downloaded) into `ticketroom-data` and rename it to
   `ticketroom.sqlite`. Set its permission to 600.
5. Open https://ticketroom.co.za/api/health: it must say `"ok":true`. Sign
   in to the admin portal and check recent orders, then turn maintenance off.

Keep `keys.php` with the database: tickets and links made with one set of
keys only work with that set.

## If the site stops itself

If `ticketroom-data` or its `keys.php` goes missing on a site that is
already set up (a half-finished restore, a renamed folder, wrong
permissions), TicketRoom stops and shows visitors a short notice instead of
starting a new, empty site. It never makes new keys on an installed site:
new keys would make every ticket already sold unreadable at the gate. The
reason is in the cron email and in `ticketroom-data/php-errors.log`.

Put the folder or `keys.php` back from your backup (or fix the folder's
permission to 750 or 755), and the site carries on by itself. Only if the
site was deliberately moved to another data folder, delete
`public_html/data/.data-home`.

## Monitoring

https://ticketroom.co.za/api/health answers `"ok":true` while the site and its
database work, and `"healthy":true` when, in addition, the background jobs
ran on time, email is not backing up and there is a recent backup. Point an
uptime monitor (UptimeRobot or similar, free) at it with the keyword
`"healthy":true`. The owner also gets one email ("TicketRoom needs a
look") when email or the jobs get stuck, at most every 6 hours.
Admin portal → **Messages** shows each message, when it will be tried next,
and **Retry failed** puts failed ones back in the queue.

## Going-live checklist

- [ ] https://ticketroom.co.za/version.txt shows the build you were given
- [ ] `/api/health` and `/api/config` report the same configured payment provider
- [ ] The home page shows events (or "No events yet"), not a setup screen
- [ ] https://ticketroom.co.za/sell, /help and /legal/privacy open
- [ ] If diagnostics were enabled, the check is green, its private unlock file is deleted and diagnostics are off
- [ ] The padlock shows, and http:// goes to https://
- [ ] The owner was created through one-time HTTPS setup; no factory password exists
- [ ] A test ticket email arrived
- [ ] Free-only launch: provider is set to **Not set up (free events only)**; `cardPaymentsEnabled` and `paymentsTest` are false
- [ ] Free-only launch: a staging free event completed checkout and its ticket email was received
- [ ] If no staging environment exists, schedule the production free-ticket smoke test as the public opening; maintenance blocks visitor checkout by design
- [ ] Maintenance is turned off only after staff OTP, backups, and free-only provider configuration are verified
- [ ] Card payments: a test purchase and a test refund worked, then switched to Live
- [ ] Integrations → Identity verification is **not** on Sandbox
- [ ] The cron job runs (step 12): Admin portal → **Backups** shows when it last ran
- [ ] Admin portal → **Backups** has a copy, and you downloaded one to a safe place
- [ ] SPF and DKIM show a green tick in cPanel → **Email Deliverability**
- [ ] cPanel → **Backup** includes `ticketroom-data` (keep a copy off the server)

## Big matches (up to 100,000 fans)

Tested with a 100,000-ticket stadium event: 4,000 fans booking at the same
moment all got tickets (about 400 bookings a second), and 150 scanner phones
checked about 900 tickets a second, each ticket let in exactly once. That was
on a test server; a shared hosting plan is slower.

- **Hosting:** for match week, ask Afrihost for a VPS or their biggest plan.
- **Email:** hosting mailboxes send a few hundred emails an hour. Use an email
  relay (Amazon SES, Mailgun or Brevo) in `ticketroom-data/config.php`. Tickets always
  show in the fan's account, even before the email arrives.
- **Scanners:** each scanner opens https://ticketroom.co.za/scan and picks the
  match on Wi-Fi before the gates open, until it says "Offline ready". If the
  stadium's signal drops, scanning carries on and syncs when it returns.
- Tickets are by stand or ticket type; seat numbers are not supported yet.
- Large sports events need the usual safety approvals (SASREA).

## Optional: Apple Wallet and Google Wallet

Every ticket already has "Save ticket image" and "Add to calendar". The
**Add to Apple Wallet** and **Add to Google Wallet** buttons appear by
themselves (iPhone users see Apple, Android users see Google) once these
accounts are set up. Until then they stay hidden, so nothing looks broken.

**Apple Wallet** (needs the Apple Developer Program, US$99 a year, in the
name of TicketRoom (Pty) Ltd):

1. developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →
   **+** → Pass Type IDs → `pass.za.co.ticketroom`.
2. Open that Pass Type ID → **Create Certificate**, upload a certificate
   request, and download the `.cer` file. Note your **Team ID** (top right).
3. Download Apple's "Worldwide Developer Relations - G4" certificate from
   apple.com/certificateauthority.
4. Convert all three to PEM files (any developer can do this in a minute) and
   upload them to `ticketroom-data`: `apple-pass-cert.pem`,
   `apple-pass-key.pem`, `apple-wwdr.pem`.

**Google Wallet** (free):

1. pay.google.com/business/console → **Google Wallet API** → note the
   **Issuer ID**.
2. console.cloud.google.com → new project → enable the **Google Wallet API**
   → create a **service account** → **Keys** → add a JSON key.
3. Back in the Wallet console, add that service account's email as a user.
4. Upload the JSON key to `ticketroom-data` as `google-wallet.json`.
5. Ask Google for publishing access (in the console) so every customer can
   save passes, not only test users.

Then add this to `ticketroom-data/config.php`, inside the `return [ … ];`:

    'wallet' => [
        'apple' => ['passTypeId' => 'pass.za.co.ticketroom', 'teamId' => 'YOUR-TEAM-ID',
                    'certFile' => 'apple-pass-cert.pem', 'keyFile' => 'apple-pass-key.pem',
                    'keyPassword' => '', 'wwdrFile' => 'apple-wwdr.pem'],
        'google' => ['issuerId' => 'YOUR-ISSUER-ID', 'serviceAccountFile' => 'google-wallet.json'],
    ],

Either one can be added on its own. A wallet pass carries the same signed QR
code as the ticket, so it is checked at the gate exactly the same way, and it
stops working if the ticket is transferred.

## Background jobs

The cron job in step 12 is required. The jobs also run after visitors'
requests, but that is only a fallback.
