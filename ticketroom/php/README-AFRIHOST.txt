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
