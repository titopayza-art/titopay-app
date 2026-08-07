# TitoPay PWA — Afrihost cPanel deployment

Static site. No Node.js, no build step. **Target:** `app.titopay.co.za`

**Build:** `peach-card-topup-v274`

## Steps

1. **Back up.** File Manager → the PWA document root → select all → **Compress** →
   `pwa-backup-YYYY-MM-DD.zip` → move it outside the document root.
2. **Upload** `app.zip` into the PWA document root.
3. **Extract** into that root. The archive is flat: `index.html`, `app.min.js`, `assets/` are at the
   ZIP root. Confirm `index.html` is directly in the root, not inside a nested `app/` folder.
   Delete the uploaded ZIP afterwards.
4. **Keep `.htaccess`.** Turn on File Manager → Settings → **Show Hidden Files (dotfiles)** and
   confirm it survived the extract.
5. **Hard-refresh** (Ctrl+F5 / Cmd+Shift+R). Assets moved from `?v=273` to `?v=274` and the service
   worker cache name changed, so returning users pick the new bundle up on their next visit.

## Verify

Sign in → **Top Up** → enter an amount → Preview → Confirm. You should be sent to the Peach
Payments hosted page. After paying you land back in TitoPay with **"Wallet topped up"**, and the
top-up appears in Activity.

If Confirm still says "Transaction not confirmed", the browser is on the old bundle (hard-refresh)
or the API package has not been deployed.

## Rollback

Delete the document root contents, upload and extract the backup from step 1, hard-refresh.
