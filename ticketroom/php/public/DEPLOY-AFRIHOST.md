# Putting TicketRoom live on Afrihost

Do these in order. Nothing here needs a developer. Set aside about an hour,
most of it waiting for the certificate.

---

## Before you start, have these to hand

| What | Where it comes from |
| --- | --- |
| cPanel login | Afrihost Client Zone → **Hosting** → your package → **cPanel** |
| `ticketroom.zip` | The build you were given. Every version has this same name; `version.txt` inside it names the build. |
| The temporary admin password | Given to you with the zip. It is not written in any file. |
| A password for the `hello@ticketroom.co.za` mailbox | You create it in step 4. |

`ticketroom.co.za` must already point at Afrihost. Nothing below works while
it still resolves somewhere else.

---

## Already live? Updating to a new version

This package is build **{{BUILD}}**. Updating takes five minutes and keeps
every account, event, order and setting.

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
   `TicketRoom build {{BUILD}}`. An older build means step 2 or 4 did not
   happen: do them again.
7. Sign in to the admin portal. The Overview line says "Running build
   {{BUILD}}".
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
   https://ticketroom.co.za/version.txt: it should say `TicketRoom build {{BUILD}}`.

Permissions: `data` must be writable: `755` (or `775` if the host runs PHP as
a different user). Right-click → **Change Permissions**.

## 4. Create the mailbox

cPanel → **Email Accounts** → **Create** → `hello@ticketroom.co.za`. Give it a
real password and keep it.

You'll type that password into the admin portal in step 8 (Admin portal →
**Integrations** → Email). It is stored encrypted and never shown again.

(Prefer files? **File Manager** → `ticketroom-data/config.php` (the folder
next to `public_html`, not inside it) → **Edit**, and put the password
between the quotes on the `smtpPass` line. The admin portal wins if both are set.)

(`ticketroom-data` and its `config.php` appear the first time the site is
opened. If your host does not allow that folder, they are in `public_html/data`
instead; the deploy check in step 5 shows which. If it is not
there yet, open https://ticketroom.co.za once and look again.)

This matters: the site sends tickets as `hello@ticketroom.co.za`, and email
sent without the mailbox often lands in spam or is not delivered at all.

## 5. Check what arrived

In `public_html/data`, create an empty file called `unlock-check`
(**+ File**). Open **https://ticketroom.co.za/deploy-check.php**.

It reports the build, the folder, PHP, the data folder, whether the API and
the clean addresses work, whether the database is safe from download, how
email is sent, and what is left over from earlier uploads. Fix anything
marked **Fix**, top to bottom. Then delete `data/unlock-check`.

## 6. Turn on https

1. cPanel → **SSL/TLS Status**. `ticketroom.co.za` and `www.ticketroom.co.za`
   should show a certificate. If not, press **Run AutoSSL** and wait (up to
   an hour).
2. Once the padlock shows in the browser: cPanel → **Domains** → switch on
   **Force HTTPS Redirect**.

`www.ticketroom.co.za` already goes to `ticketroom.co.za` on its own.

## 7. Sign in and change the password

Go to **https://ticketroom.co.za/admin**. This sign-in is for TicketRoom
staff only: it has no "Create account" and no "Forgot password" (an admin
sends staff a new-password link from **Staff & roles**).

- Email `hello@ticketroom.co.za`
- Password: the temporary one you were given

You land in the **admin portal** (red bar at the top). A yellow bar reminds
you to change the password: **Admin portal → My password**.

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

## 8. Set up email and prove it works

Admin portal → **Integrations** → **Email**: choose "SMTP mailbox", check
the server (`mail.ticketroom.co.za`, port `465`), type the username
(`hello@ticketroom.co.za`) and the mailbox password, press **Save** and type
your own admin password when asked. Press **Send a test email** and type any
address: it is sent straight away and the page says what happened. If it
fails, **Check connection** says why. Admin portal → **Email templates**
lets you preview every email and send a test of any of them.

## 9. Switch on card payments

Free events work without this. For paid tickets, TicketRoom uses your own
Yoco or PayFast merchant account; the money goes to that account, and
TicketRoom pays organisers from it.

**Yoco (recommended: refunds happen with one click)**
1. Sign in at portal.yoco.com → **Sales** → **Payment gateway** → **API keys**.
   Copy the **test secret key** (starts with `sk_test_`).
2. Admin portal → **Integrations** → **Card payments**: provider **Yoco**,
   mode **Test**, paste the key, **Save** (it asks for your admin password).
   TicketRoom registers its notification address with Yoco for you.
3. **Check connection**. Then make a R10 test event and buy a ticket with
   Yoco's test card (4111 1111 1111 1111, any future date, any CVV).
4. When that works: change the mode to **Live**, paste the **live** key
   (`sk_live_`), **Save**, and **Check connection** again.

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

Keys are stored encrypted and never shown again; the page only says
whether each one is saved. Changing them needs your admin password and is
written to the audit log.

**How the money moves**
- A ticket is issued only when Yoco or PayFast confirms the payment to
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
- After the event: unused balances go back to the card (asked for from the
  account, or automatically two days later), approved by finance under
  **Refunds**. Vendor takings are settled to the organiser under **Payouts**.
- Limits can be changed in `ticketroom-data/config.php`:
  `'cashless' => ['minTopupCents' => 5000, 'maxTopupCents' => 300000, 'maxBalanceCents' => 500000, 'pinThresholdCents' => 20000]`,
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

## 10c. Promote (the R1500 organiser package)

Organisers buy **Promote** for one event from the event's **Promote** tab
in the organiser portal (also listed under **Promote** in their menu and
on the public **/sell** page). It costs R1 500 once off and runs until the
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
- **Settings** (optional, in `ticketroom-data/config.php`):
  `'promote' => ['priceCents' => 150000, 'smsCostPerSegmentCents' => 0]`.
  With an SMS cost set, organisers see an estimate before each SMS send;
  without it they are told no cost is set.

## 11. Maintenance mode

Admin portal → **Site settings** → **Maintenance mode**. While it is on,
the server answers every visitor with the maintenance page: nobody can
browse, book, sign up or sign in, except TicketRoom staff, who see the
site as normal with a yellow "Maintenance mode is on" bar. Payment
notifications from Yoco and PayFast keep arriving. **See what visitors see**
previews the page. Turn it off on the same card.

## Going-live checklist

- [ ] https://ticketroom.co.za/version.txt shows the build you were given
- [ ] The home page shows events (or "No events yet"), not a setup screen
- [ ] https://ticketroom.co.za/sell, /help and /legal/privacy open
- [ ] Deploy check is all green, and `data/unlock-check` is deleted again
- [ ] The padlock shows, and http:// goes to https://
- [ ] The temporary admin password has been changed
- [ ] A test ticket email arrived
- [ ] Card payments: a test purchase and a test refund worked, then switched to Live
- [ ] Integrations → Identity verification is **not** on Sandbox
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

## Optional: background jobs on a timer

Reminder emails and clean-up run after visitors' requests, which is enough for
most sites. For punctual reminders on a quiet site: cPanel → **Cron Jobs** →
every 5 minutes:

    php /home/YOURUSER/public_html/api/cron.php
