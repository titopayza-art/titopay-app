# Deploying SeaGeek

Three ways to run it. Start with shared hosting; move to a VPS or Docker when traffic grows (see `SCALING.md`). The code is the same in every case.

## Option A: shared hosting (Afrihost, cPanel, most SA hosts)

1. **Database.** cPanel > MySQL Databases: create a database (e.g. `user_seageek`) and a user with all privileges on it.
2. **Upload.** Upload the zip with File Manager, extract it, and move the contents of `seageek.co.za/` into `public_html/` (so `public_html/index.php` exists).
3. **PHP version.** cPanel > Select PHP Version: choose 8.2 or 8.3 and tick `pdo_mysql`, `curl`, `sodium`, `mbstring`.
4. **SSL.** cPanel > SSL/TLS Status: run AutoSSL for `seageek.co.za` and `www.seageek.co.za`.
5. **Install.** Open `https://www.seageek.co.za`. The installer:
   - checks the server,
   - asks for the database host (`localhost`), name, user and password,
   - creates the tables, prices, plans, partner rows and help centre articles,
   - creates your admin account.
6. **Cron.** cPanel > Cron Jobs, "Once per minute":
   ```
   php /home/YOURUSER/public_html/cli.php cron >/dev/null 2>&1
   ```
   If your host won't run PHP from cron, use an external cron service to call the URL shown in Admin > Jobs & logs (`/cron/<token>`) every minute.
7. **Email.** Shared hosts can send with PHP `mail()`, but deliverability is poor. Set up the **Amazon SES** partner (Admin > Wholesale partners) and all platform email goes through it. Add SPF and DKIM for `seageek.co.za` in SES first.
8. **Payments.** Admin > Settings > PayFast: enter your merchant ID, key and passphrase, switch the mode to Live, and set the notify URL shown there in your PayFast dashboard.

## Option B: VPS (Ubuntu with nginx and PHP-FPM)

```bash
sudo apt install nginx mysql-server php8.3-fpm php8.3-mysql php8.3-curl php8.3-mbstring unzip
sudo mkdir -p /var/www/seageek && sudo unzip seageek.co.za.zip -d /tmp && sudo cp -r /tmp/seageek.co.za/. /var/www/seageek/
sudo chown -R www-data:www-data /var/www/seageek/storage /var/www/seageek/app
sudo cp /var/www/seageek/docker/nginx.conf /etc/nginx/sites-available/seageek && sudo ln -s /etc/nginx/sites-available/seageek /etc/nginx/sites-enabled/
sudo certbot --nginx -d seageek.co.za -d www.seageek.co.za
sudo systemctl reload nginx
```

Create the MySQL database, open the site to run the installer, then start the worker instead of cron:

```bash
sudo cp /var/www/seageek/docker/seageek-worker.service /etc/systemd/system/
sudo systemctl enable --now seageek-worker
```

The worker sends queued messages, webhooks and email continuously and runs the scheduled jobs every minute.

## Option C: Docker

```bash
cd seageek.co.za/docker
cp .env.example .env        # fill in SG_APP_KEY, SG_CRON_TOKEN, SG_DB_PASS, MYSQL_ROOT_PASSWORD
docker compose up -d --build
docker compose exec web php cli.php migrate
docker compose exec web php cli.php create-admin you@seageek.co.za "Your Name"
```

With `SG_*` environment variables set there is no installer and no `app/config.php`, which is what you want for containers.

## After installing: the 10-minute checklist

- [ ] Admin > Wholesale partners: credentials for each partner, priorities set, **Active** ticked. Use **Send a test**.
- [ ] Give each HTTP partner its delivery report URL (shown on its page).
- [ ] For WhatsApp: in the 360dialog Partner Hub, set each number's webhook to the URL shown on the customer's page in Admin.
- [ ] Admin > Settings: PayFast (Live), bank details, VAT, support hours.
- [ ] Admin > Settings > Support chatbot: provider and model; API key on the Anthropic or OpenAI partner row.
- [ ] Admin > Plans & pricing: confirm every **cost** against your partner contracts; the margin column turns red under 20%.
- [ ] Admin > Jobs & logs: jobs show a recent run time.
- [ ] Register a test customer, top up R100 with PayFast, send a live SMS to yourself.
