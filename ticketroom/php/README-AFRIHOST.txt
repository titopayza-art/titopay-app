TICKETROOM — Afrihost edition (PHP)
===================================

SETUP CODE: {{SETUP_CODE}}

1. In cPanel → File Manager, open public_html and delete what is there from
   earlier uploads (old index.html, holding, ticketroom-app, ticketroom.zip …).
2. Upload ticketroom.zip into public_html, click Extract, then delete the zip.
3. Open https://ticketroom.co.za — the TicketRoom setup page appears.
   Enter the setup code above, your admin email and a password, and finish.
   You land in the back office, signed in. That's it: the site is live.

If the setup page lists something under "Needs attention", fix it in cPanel
(usually: Select PHP Version → choose PHP 8.1 or newer and tick pdo_sqlite),
then reload the page.

What works: the public website, accounts, organiser sign-up and portal, free
events with QR tickets, ticket transfers, gate scanning on phones with live
counts, email marketing, the back office, the assistant, legal pages, and all
emails. Paid tickets, cashless wristbands and vendor POS arrive with the
payment gateway.

Your data (database, uploaded images, keys) is kept in a "ticketroom-data"
folder next to public_html (or public_html/tr-data if the host does not allow
that). Back it up with cPanel → Backup. Losing it means losing every account,
event and ticket.

Optional cron job (cPanel → Cron Jobs, every 5 minutes) for punctual reminder
emails on quiet sites:
    php /home/YOURUSER/public_html/tr-app/cron.php

BIG MATCHES (up to 100,000 fans)
--------------------------------
Tested with a 100,000-ticket stadium event: 4,000 fans booking at the same
moment all got their tickets (about 400 bookings a second, no failures), and
150 scanner phones checked about 900 tickets a second, each ticket let in
exactly once. That was on a test server; a shared hosting plan is slower.

Before you put a 100,000-seat match on sale:
- Hosting: ask Afrihost for a VPS or their biggest hosting plan for match
  week. A small shared plan has much less computing power, so fans would
  wait longer when tickets go on sale.
- Email: hosting mailboxes only send a few hundred emails an hour. Sign up
  with an email relay (Amazon SES, Mailgun or Brevo). In
  ticketroom-data/config.php, under 'mail', set 'mode' => 'smtp' and fill in
  the relay's smtpHost, smtpPort, smtpUser and smtpPass.
  Tickets always show in the fan's account, even before the email arrives.
- Scanners: each scanner opens https://ticketroom.co.za/scan and picks the
  match while they have Wi-Fi or signal, before the gates open. The phone
  downloads the ticket list (it says "Offline ready: 100,000 tickets"). If
  the stadium's signal drops, scanning carries on and the scans are sent to
  the server when the signal returns.
- Tickets are by stand or ticket type. Seat numbers are not supported yet.
- Large sports events need the usual safety approvals (SASREA) from the
  municipality. TicketRoom does not handle those.
