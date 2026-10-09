# Putting TicketRoom live on Afrihost

Do these in order. Nothing here needs a developer. Set aside about an hour,
most of it waiting for the certificate.

---

## Before you start, have these to hand

| What | Where it comes from |
| --- | --- |
| cPanel login | Afrihost Client Zone → **Hosting** → your package → **cPanel** |
| `ticketroom.zip` | The build you were given. `version.txt` inside it names the build. |
| The temporary admin password | Given to you with the zip. It is not written in any file. |
| A password for the `hello@ticketroom.co.za` mailbox | You create it in step 4. |

`ticketroom.co.za` must already point at Afrihost. Nothing below works while
it still resolves somewhere else.

---

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
4. **Delete `ticketroom.zip` from the server.**

Permissions: `data` must be writable: `755` (or `775` if the host runs PHP as
a different user). Right-click → **Change Permissions**.

## 4. Create the mailbox

cPanel → **Email Accounts** → **Create** → `hello@ticketroom.co.za`. Give it a
real password and keep it.

Then **File Manager** → `public_html/data/config.php` → **Edit**, and put that
password between the quotes on the `smtpPass` line. Save.

(`data/config.php` appears the first time the site is opened. If it is not
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

Go to **https://ticketroom.co.za/signin**.

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

Staff land in the admin portal when they sign in, organisers in the
organiser portal, everyone else in the customer portal. The Menu button
lists the other portals a person may open, by these names. The admin portal
is never linked anywhere on the site: staff open it by typing
ticketroom.co.za/admin, and to anyone else that address shows "Page not found".

## 8. Prove that email works

Admin portal → **Email templates** → send yourself a test, or create a free test
event and book a ticket for yourself. The ticket email should arrive within
a minute or two. If it does not, run the deploy check again: the Email
section says what is wrong.

---

## Going-live checklist

- [ ] https://ticketroom.co.za/version.txt shows the build you were given
- [ ] The home page shows events (or "No events yet"), not a setup screen
- [ ] https://ticketroom.co.za/sell, /help and /legal/privacy open
- [ ] Deploy check is all green, and `data/unlock-check` is deleted again
- [ ] The padlock shows, and http:// goes to https://
- [ ] The temporary admin password has been changed
- [ ] A test ticket email arrived
- [ ] cPanel → **Backup** includes `public_html/data` (keep a copy off the server)

## Big matches (up to 100,000 fans)

Tested with a 100,000-ticket stadium event: 4,000 fans booking at the same
moment all got tickets (about 400 bookings a second), and 150 scanner phones
checked about 900 tickets a second, each ticket let in exactly once. That was
on a test server; a shared hosting plan is slower.

- **Hosting:** for match week, ask Afrihost for a VPS or their biggest plan.
- **Email:** hosting mailboxes send a few hundred emails an hour. Use an email
  relay (Amazon SES, Mailgun or Brevo) in `data/config.php`. Tickets always
  show in the fan's account, even before the email arrives.
- **Scanners:** each scanner opens https://ticketroom.co.za/scan and picks the
  match on Wi-Fi before the gates open, until it says "Offline ready". If the
  stadium's signal drops, scanning carries on and syncs when it returns.
- Tickets are by stand or ticket type; seat numbers are not supported yet.
- Large sports events need the usual safety approvals (SASREA).

## Optional: background jobs on a timer

Reminder emails and clean-up run after visitors' requests, which is enough for
most sites. For punctual reminders on a quiet site: cPanel → **Cron Jobs** →
every 5 minutes:

    php /home/YOURUSER/public_html/api/cron.php
