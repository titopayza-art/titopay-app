TICKETROOM: public_html/data
============================

This folder is only for the two "unlock" files that open the locked tools.
Make one when you need it (File Manager, + File), and it locks itself again
after 30 minutes:

  unlock-check   opens https://ticketroom.co.za/deploy-check.php
  unlock-reset   opens https://ticketroom.co.za/set-password.php
                 (type a secret word of your own, 8+ characters, inside it;
                 the page asks for that word)

The database, the ticket signing keys, uploaded posters and your settings
(config.php) live in "ticketroom-data", the folder NEXT TO public_html,
where the web cannot reach them. Back that folder up (cPanel → Backup).
If your host does not allow that folder, they are kept here instead, and
this folder's .htaccess stops anyone downloading them.
