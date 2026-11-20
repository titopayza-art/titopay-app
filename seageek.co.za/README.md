# SeaGeek platform

Website, API gateway, customer dashboard, admin back office, billing automation and SeaGeek Desk for **seageek.co.za**. PHP 8.1+, MySQL (or SQLite for testing), no build step.

## What's in the box

| Part | Where | What it does |
|---|---|---|
| Public website | `/`, `/pricing`, `/desk`, `/developers`, `/about`, `/contact` | Marketing pages with the animated seabed and sharks, live pricing from the database |
| API docs | `/docs`, `/docs/quickstart`, `/docs/{product}`, `/docs/openapi.json` | Guides (quickstart, authentication, sandbox and live, errors, limits, idempotency, webhooks, billing, changelog) and a page per product with cURL, PHP, Node.js and Python samples, search and an on-this-page index |
| REST API | `/api/v1/...` | SMS, Mail, Auth (OTP), WhatsApp, Verify, Voice, AI, Desk, QR codes, account and usage |
| Customer dashboard | `/dashboard` | Services and one order for many products, API keys, usage, credit, invoices, statements, quotes, webhooks, team, Desk |
| No-code tools | `/dashboard/stores`, `/dashboard/campaigns`, `/dashboard/contacts`, `/dashboard/qr` | Store SMS for Shopify, WooCommerce, Wix and any platform (R0.50 an SMS), bulk SMS and email campaigns with templates, contact lists with CSV import, QR codes (R20 each) |
| Admin | `/admin` | Customers, money (invoices, bank imports, quotes), marketing (newsletters, contacts, QR codes), wholesale partners, pricing, staff and permissions, settings, jobs |
| Desk | `/dashboard/desk`, `/admin/desk`, `/help`, `/h/{company}` | Zendesk-style help desk: omnichannel tickets, AI agent with human handover, help centre, macros, SLAs, ratings |
| Chat widget | `assets/js/chat-widget.js` | On every page; customers can embed it on their own sites |
| Automation | `php cli.php cron` (every minute) or `php cli.php worker` | Renewals, invoices, reminders, locking and unlocking, low-balance alerts, queued sends, webhooks, email |

## Quick start (shared hosting, e.g. Afrihost cPanel)

1. Create a MySQL database and user in cPanel.
2. Upload the **contents** of this folder to `public_html/`.
3. Open your domain. The installer checks the server, asks for the database details and creates your admin account.
4. Add a cron job in cPanel to run every minute:
   `php /home/YOURUSER/public_html/cli.php cron >/dev/null 2>&1`
5. Sign in at `/admin`, then:
   - **Wholesale partners**: add credentials for each partner and switch them on.
   - **Settings**: PayFast merchant details, bank details for EFT, VAT status, and **Email delivery** (SMTP host, port, user, password; then *Send a test email*).
   - **Staff and permissions**: add developers, support, finance and marketing people with only the access they need.
   - **Settings > Support chatbot**: choose Anthropic or OpenAI (keys go on the partner rows).

Full steps, including a VPS or Docker setup, are in [`guides/DEPLOY.md`](guides/DEPLOY.md).

## Guides

- [`guides/DEPLOY.md`](guides/DEPLOY.md): shared hosting, VPS (nginx + PHP-FPM), Docker
- [`guides/SCALING.md`](guides/SCALING.md): moving servers, backups, growing from one server to many
- [`guides/OPERATIONS.md`](guides/OPERATIONS.md): connecting wholesale partners, what runs automatically, what still needs a person

## Local development

```bash
composer install
php -S 127.0.0.1:8000 index.php      # open http://127.0.0.1:8000 and choose SQLite in the installer
php cli.php cron                     # run the scheduled jobs once
```

## Requirements

PHP 8.1+ with `pdo_mysql` (or `pdo_sqlite`), `curl`, `sodium`, `mbstring`, and `gd` for PNG QR codes (SVG works without it). Composer packages are already in `vendor/` (Anthropic PHP SDK, Guzzle, PHPMailer, php-qrcode), so shared hosts don't need Composer.

## Security notes

- `app/`, `storage/`, `vendor/`, `docker/` and `guides/` are blocked from the web (`.htaccess`, `docker/nginx.conf`).
- Partner credentials, PayFast secrets and AI keys are encrypted at rest with `app_key` from `app/config.php`. **Back up `app_key`**: without it, stored secrets can't be decrypted.
- API keys are stored as SHA-256 hashes and shown once. Passwords use PHP's `password_hash`.
- Every form has CSRF protection; sign-in, sign-up, chat, OTP and API calls are rate-limited.
- Staff see only the admin areas their role allows; switched-off staff are signed out at once.
- Store webhooks are checked with the platform's HMAC signature (Shopify, WooCommerce) or your store secret.
- **Bot and attack blocking.** Requests for WordPress, `.env`, database dumps and similar paths, and known attack tools (sqlmap, nikto, wpscan and others), are refused before any page runs. Wrong passwords, wrong API keys, forged forms and bot form posts count against the IP address; 20 in an hour blocks it for an hour. Admin, Security lists blocked addresses and lets you block or unblock by hand.
- **Form traps.** Every form carries a hidden field and a signed time stamp. Bots that fill the field or post in under two seconds are turned away. Cloudflare Turnstile can be added to public forms by saving its keys under Admin, Security.
- **Two-step sign-in.** Anyone can turn on authenticator-app codes under "Two-step sign-in". Staff must have it to open the admin console (switch under Admin, Security). An owner can reset it from Staff if someone loses their phone.

## Xero accounting

1. At developer.xero.com create a **Web app** with redirect URI `https://www.seageek.co.za/admin/xero/callback`.
2. In Admin, Xero accounting, paste the Client ID and Client secret, check the sales (200) and bank (090) account codes and the tax rate, then press **Connect to Xero**.
3. From then on the scheduled jobs (`php cli.php cron`) copy every invoice, its customer (matched on the 6-digit customer number) and every card, EFT or PayFast payment to Xero, and void invoices voided here. Failures are retried up to five times and shown in the log with Xero's reason.
