TICKETROOM — Powered by TitoPay — Afrihost package
====================================================

DO NOT extract this zip inside public_html.

1. In cPanel File Manager, DELETE public_html/ticketroom and public_html/ticketroom.zip
   (they expose source code publicly).
2. Upload ticketroom.zip to your HOME folder (the one that contains public_html) and Extract there.
   - public_html/       -> a "Launching soon" page + protective .htaccess (works immediately)
   - ticketroom-app/    -> the TicketRoom application (private, outside the website folder)
3. Open AFRIHOST-SETUP.html (in this package) and follow steps 2-9 to start the app
   with cPanel "Setup Node.js App" + PostgreSQL.
