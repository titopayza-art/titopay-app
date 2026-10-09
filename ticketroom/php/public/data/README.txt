TICKETROOM DATA FOLDER
======================

Everything TicketRoom creates for itself lives here. The website never
serves these files, and uploading a new version of the site never changes
them.

  ticketroom.sqlite   The database: accounts, events, orders, tickets.
                      (-wal and -shm next to it are part of it.)
  keys.php            The keys that sign every ticket QR code and email link.
  config.php          YOUR settings: the hello@ mailbox password, and an
                      optional assistant key. Edit it here in File Manager.
  uploads/            Event posters and advertising images.

BACK THIS FOLDER UP (cPanel → Backup). Losing keys.php means no ticket
already issued can be scanned at the gate; losing the database loses every
account, event and ticket.

Two empty "unlock" files open the locked tools, one at a time:
  unlock-check   opens https://ticketroom.co.za/deploy-check.php
  unlock-reset   opens https://ticketroom.co.za/set-password.php
Delete them again when you are done (unlock-reset removes itself).
