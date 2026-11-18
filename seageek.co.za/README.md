# SeaGeek platform

Website, API gateway, customer dashboard, admin back office, billing automation and SeaGeek Desk for **seageek.co.za**. PHP 8.1+, MySQL (or SQLite for testing), no build step.

## What's in the box

| Part | Where | What it does |
|---|---|---|
| Public website | `/`, `/pricing`, `/desk`, `/developers`, `/about`, `/contact` | Marketing pages with the animated seabed and sharks, live pricing from the database |
| API docs | `/docs`, `/docs/{product}`, `/docs/openapi.json` | Generated from `app/catalog.php`, with cURL, PHP, Node.js and Python samples |
| REST API | `/api/v1/...` | SMS, Mail, Auth (OTP), WhatsApp, Verify, Voice, AI, Desk, account and usage |
| Customer dashboard | `/dashboard` | Sandbox and live environments per product, API keys, usage, credit, payments, invoices, webhooks, team, Desk |
| Admin | `/admin` | Customers, wholesale partners and routing, plans and pricing, invoices, support desk, settings, jobs |
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
   - **Settings**: PayFast merchant details, bank details for EFT, VAT status.
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

PHP 8.1+ with `pdo_mysql` (or `pdo_sqlite`), `curl`, `sodium`, `mbstring`. Composer packages are already in `vendor/` (Anthropic PHP SDK and Guzzle), so shared hosts don't need Composer.

## Security notes

- `app/`, `storage/`, `vendor/`, `docker/` and `guides/` are blocked from the web (`.htaccess`, `docker/nginx.conf`).
- Partner credentials, PayFast secrets and AI keys are encrypted at rest with `app_key` from `app/config.php`. **Back up `app_key`**: without it, stored secrets can't be decrypted.
- API keys are stored as SHA-256 hashes and shown once. Passwords use PHP's `password_hash`.
- Every form has CSRF protection; sign-in, sign-up, chat, OTP and API calls are rate-limited.
