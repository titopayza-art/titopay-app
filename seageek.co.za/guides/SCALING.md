# Scaling and moving servers

SeaGeek is built so the web servers hold no state of their own:

- **Sessions** are stored in the database, not on disk, so any server can answer any request.
- **Configuration** can come from `SG_*` environment variables instead of `app/config.php`.
- **Slow work** (large SMS batches, scheduled sends, email, webhooks) goes into database queues and is sent by `cli.php worker` or `cli.php cron`, not inside web requests.
- **Partner failover** happens per request, so one partner outage doesn't take you down.
- **The database schema** is versioned (`app/schema.php`); `php cli.php migrate` brings any database up to date.

## Growth path

| Stage | Roughly | Setup |
|---|---|---|
| 1. Launch | Up to ~50 customers, ~200k messages a month | Shared hosting, MySQL on the same host, cron every minute |
| 2. Growing | ~50 to 500 customers, a few million messages a month | One VPS (2 to 4 vCPU), MySQL on the VPS or managed, `worker` under systemd instead of cron |
| 3. Scale-out | 500+ customers, bursty traffic | Load balancer, 2+ web servers (Docker image), managed MySQL with a read replica, 1 to 2 worker servers |
| 4. Regional | Multiple countries | Same image per region, shared or replicated database, partners configured per region |

Signs it's time for the next stage:

- Admin > Jobs & logs shows queued messages building up.
- Pages take more than a second to load.
- The host throttles CPU.

## Moving to a new server

Downtime is the length of the copy, usually a few minutes.

1. **Put the old site in read-only mode.** Pause the cron job or stop the worker so nothing is sent during the copy.
2. **Export the data.** Either:
   - Same database engine: `mysqldump --single-transaction seageek > seageek.sql` (or cPanel > phpMyAdmin > Export), or
   - Engine-neutral JSON: `php cli.php backup seageek-backup.json`.
3. **Copy `app/config.php`**, or at least its `app_key`. Every stored partner secret and API provider key is encrypted with it. Lose it and you have to re-enter those secrets.
4. **Set up the new server** with Option A, B or C from `DEPLOY.md`. Don't run the installer: put the old `app/config.php` in place and change the database details, or set the `SG_*` environment variables.
5. **Import:** `mysql seageek < seageek.sql`, or `php cli.php migrate && php cli.php restore seageek-backup.json`.
6. **Run `php cli.php migrate`** in case the new code has newer migrations.
7. **Point DNS** (`seageek.co.za`, `www`) at the new server. Lower the TTL to 300 seconds a day before.
8. **Start cron or the worker** on the new server only. Never run workers on both servers.
9. **Check:** `https://www.seageek.co.za/health` returns `"status": "ok"`, then send a test from Admin > Wholesale partners.

PayFast, partner delivery reports and 360dialog webhooks use your domain, so they follow the DNS change with no reconfiguration.

## Backups

- **Nightly database backup.** Most hosts do this. Add your own as well:
  `0 2 * * * php /path/cli.php backup /path/backups/seageek-$(date +\%a).json`
  This keeps 7 rolling days.
- **Copy backups off the server** (another host, S3, Google Drive).
- **Keep `app_key`** in your password manager.

## Running several web servers

- Build the image from `docker/Dockerfile`. Run any number of `web` containers behind a load balancer with the same `SG_*` variables.
- Run `worker` on **one** machine. Adding a second worker is safe for webhooks and email but can double-send queued SMS. Split work by service first, or add row locking, before running two.
- `storage/` only holds logs and the SQLite file used for testing. Ship logs to your log service in production.
- Put Cloudflare or another CDN in front for `/assets/*`.

## Database notes

- InnoDB and utf8mb4 everywhere. Money is DECIMAL(16,4).
- The busiest tables are `messages` (usage log) and `ledger`. Both are indexed by organisation and time.
- Past ~50 million `messages` rows, archive rows older than 13 months to cold storage. Keep 12 months to answer billing queries.
