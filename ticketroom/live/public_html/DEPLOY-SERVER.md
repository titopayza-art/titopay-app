# TicketRoom on your own server

For when TicketRoom outgrows shared hosting: your own server (a VPS), MySQL
instead of SQLite, and Cloudflare in front. Everything here is in the
`server/` folder of this package. The web server never serves that folder.

The Afrihost guide (DEPLOY-AFRIHOST.md) still works as before; SQLite stays
the default until a `database` block is set (step 4).

## 1. The server

| | Start | Large on-sales |
|---|---|---|
| Provider | Any with South African or nearby data centres (Afrihost VPS, Hetzner, AWS Cape Town, Azure SA North) | Same |
| Size | 4 CPU, 8 GB memory, 80 GB SSD | 8 CPU, 16 GB, or a separate database server |
| System | Ubuntu 24.04 LTS | Same |

## 2. Before you start

1. Create the server with your **SSH key** (not a password).
2. In Cloudflare: add `ticketroom.co.za`, point the `@` and `www` records at
   the server's IP, **proxied** (orange cloud). SSL/TLS mode: **Full (strict)**.
3. Upload `ticketroom.zip` and unzip it into `/var/www/ticketroom/public_html`:

       sudo mkdir -p /var/www/ticketroom/public_html
       sudo unzip ticketroom.zip -d /var/www/ticketroom/public_html

## 3. Run the setup

    sudo bash /var/www/ticketroom/public_html/server/setup-ubuntu.sh ticketroom.co.za hello@ticketroom.co.za
    sudo chown -R ticketroom:ticketroom /var/www/ticketroom

It installs and locks down:

- **nginx** with HTTPS (Let's Encrypt, renewed automatically), the same
  rules and security headers as the .htaccess files, request limits per
  visitor, and Cloudflare's real visitor IP.
- **PHP 8.3 (FPM)** as its own Linux user, with shell functions switched off,
  file access limited to the site, errors logged and never shown, OPcache on.
- **MariaDB**, reachable only from the server itself, with its own database
  and a user that can reach nothing else. The password is random and stored
  only in `/root/.ticketroom-db` and the private settings file.
- **Firewall**: only SSH, HTTP and HTTPS are open. **SSH**: keys only.
- **fail2ban**: blocks addresses that keep failing SSH logins or hitting limits.
- **Automatic security updates**, with a reboot at 03:30 when one needs it.
- **Cron**: the site's jobs every 5 minutes, and the nightly encrypted backup.

## 4. The settings file

The setup writes `/var/www/ticketroom/ticketroom-data/config.php` (outside the
website, readable by the site's user only) with the database connection:

    'database' => ['driver' => 'mysql', 'socket' => '/run/mysqld/mysqld.sock',
                   'name' => 'ticketroom', 'user' => 'ticketroom', 'pass' => '...'],

For a separate database server use `'host' => '10.0.0.5', 'port' => 3306`
instead of `socket`, on a private network only.

## 5. First owner

1. Create a bootstrap secret, as for Afrihost:

       sudo -u ticketroom sh -c 'head -c 48 /dev/urandom | base64 > /var/www/ticketroom/ticketroom-data/bootstrap-secret'
       sudo cat /var/www/ticketroom/ticketroom-data/bootstrap-secret

2. Open `https://ticketroom.co.za/setup.php`, paste the secret, create the
   owner account with a long password. The tables are created on MySQL then.
3. Admin portal → **Integrations**: payments, email, SMS, VerifyNow, wallets.

## 6. Backups

Two layers:

- **In the app**: Admin portal → Backups. Each is a MySQL dump (`.sql.gz`) in
  ticketroom-data/backups, made daily by the cron job and on "Back up now".
- **Off the server, encrypted, nightly** (`/opt/ticketroom/backup-offsite.sh`):
  the database and ticketroom-data, encrypted with AES-256. Set it up once:

      sudo apt install rclone && sudo rclone config     # e.g. a Backblaze B2 or S3 bucket
      sudo install -m 600 /dev/null /root/.ticketroom-backup
      sudo nano /root/.ticketroom-backup
          BACKUP_PASSPHRASE='a long random phrase you also keep off this server'
          RCLONE_REMOTE='b2:ticketroom-backups'

  Test it: `sudo /opt/ticketroom/backup-offsite.sh`. Restore a copy on a spare
  server every few months to know it works.

## 7. Cloudflare settings

- SSL/TLS: Full (strict). Always Use HTTPS: on. Minimum TLS: 1.2.
- Security → WAF: the managed rules on. A rate-limiting rule for
  `/api/auth/*`: 20 requests a minute per IP.
- Security → Bots: Bot Fight Mode on.
- Caching: leave HTML uncached (the site sends no-cache); images, CSS and JS
  are cached at the edge.
- For big on-sales: Cloudflare **Waiting Room** (Business plan and up) on
  `/events/*` keeps a rush in line before it reaches the server.

## 8. Moving from Afrihost (SQLite) to the server (MySQL)

With no live data yet, start the server fresh (steps 1 to 5). Once there is
live data, ask for the copy tool, which moves every table from the SQLite file
into MySQL with the site in maintenance mode.

## 9. What one server handles (measured)

Load test (dev/loadtest.js) on 4 CPUs, 16 GB, nginx + PHP-FPM + MariaDB 10.11,
with the load generator running on the same machine (a real server does better):

| Test | Result |
|---|---|
| Browsing (event list + event page), 200 visitors at once | about 770 requests a second, 99% answered within 0.4 s, no errors |
| Booking rush, 50 buyers at once | about 78 bookings a second, 95% within 0.7 s, no errors |
| Booking rush, 200 buyers at once | about 59 bookings a second, slower replies (95% within 3 s), no errors |
| 1,000 buyers for 300 tickets | exactly 300 tickets issued, 0 oversold |

What that means:

- 78 bookings a second is about **280,000 tickets an hour** from one server.
  A 50,000 seat stadium sells out in roughly 11 minutes.
- Bookings take turns on one write lock, as on SQLite, so seats, scans and
  wallet balances can never be double-spent. More web servers do not raise
  the booking rate; a faster database server and Cloudflare's Waiting Room
  for the biggest on-sales do.
- Browsing (most traffic) scales with more PHP servers behind a load
  balancer, sharing one database and the ticketroom-data folder.

## 10. Updating

Unzip the new package over `public_html` (ticketroom-data stays untouched),
then `sudo systemctl reload php8.3-fpm`.
