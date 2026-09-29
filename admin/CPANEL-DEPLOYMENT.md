# TitoPay Admin Portal — Afrihost cPanel deployment

Static site. No Node.js, no build step, no database. Upload, extract, hard-refresh.

**Build:** `admin-console-v75`
**Target:** `admin.titopay.co.za`

---

## What is in this archive

The archive is **flat** — `index.html`, `assets/`, `integrations/` and the rest are at the ZIP
root. Extract it *inside* the admin document root, not in its parent.

## Step 1 — Back up the current site

cPanel → **File Manager** → navigate to the admin document root (usually
`public_html/admin` or the document root of the `admin.titopay.co.za` subdomain).

Select all → **Compress** → `admin-backup-YYYY-MM-DD.zip` → move it somewhere outside the document
root. That is your rollback.

## Step 2 — Upload

cPanel → **File Manager** → open the admin document root → **Upload** → select `admin.zip`.

## Step 3 — Extract

Right-click `admin.zip` → **Extract** → the target must be the admin document root **itself**.

Then confirm:

- `index.html` sits directly in the document root — **not** inside a nested `admin/` folder.
- `assets/admin.js` exists.
- `integrations/peach-payments/index.html` exists.

If you see `admin/admin/index.html`, it went one level too deep: delete the inner folder and
extract again.

Delete the uploaded `admin.zip` afterwards so it is not web-served.

## Step 4 — Keep `.htaccess`

The archive contains `.htaccess`, which carries the security headers, the Content-Security-Policy
and the 403/404 error pages. cPanel's File Manager hides dotfiles by default — turn on
**Settings → Show Hidden Files (dotfiles)** and confirm `.htaccess` is present after extracting.

## Step 5 — Hard-refresh

Assets are requested at `?v=admin-console-v75`, so the browser fetches them fresh.
Open the console and press **Ctrl+F5** (Windows) or **Cmd+Shift+R** (Mac) once anyway —
without it a browser holding the previous page HTML may keep the old JavaScript.

## Step 6 — Verify

Sign in, then go to **Integrations → Peach Payments**. You should see:

```
Peach Payments
  Collection / Top-up   ● Connected
  Payout / Withdrawal   ● Not Configured

Collection / Top-up            [Save Configuration] [Test Connection]
Payout / Withdrawal            [Save Configuration] [Test Connection]
```

Press **Test Connection** under Collection — it must still say Connected.

---

## Rollback

Delete the contents of the document root, upload the backup ZIP from Step 1, extract it, and
hard-refresh. Nothing in this release stores state in the browser or the database, so a rollback
needs no other action.

## Notes

- No API base URL to configure: the console targets `https://api.titopay.co.za` automatically and
  falls back to `http://127.0.0.1:8110` only on localhost.
- No environment variables. Static hosting only.
- If the Peach page shows one section instead of two, the API package has not been deployed yet —
  deploy `api.zip` and reload.
