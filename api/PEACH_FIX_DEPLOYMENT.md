# Deploying the Peach Checkout fix to Afrihost

This package is a **full replacement** for the API at `api.titopay.co.za`. It is the previous
package plus the Peach Checkout V2 authentication fix — nothing else changed. The archive is flat:
`package.json`, `src/`, `deploy/` and the docs are at the ZIP root.

Only six files differ from your current deployment:

```
src/services/peach-checkout-auth-service.js   (new)
src/services/peach-payments-service.js
src/routes/admin.routes.js
src/routes/integrations.routes.js
test/peach-payments-v2.test.js
PEACH_CHECKOUT_403_FIX.md                     (new, documentation)
```

No database migration. No schema change. No environment variable is required.

---

## Step 0 — Find your install path (do this first)

The bundled docs disagree: `AFRIHOST_API_REPLACEMENT.md` says `/var/www/titopay/api`, while
`deploy/ecosystem.config.cjs` says `/opt/titopay-api`. Confirm which one is live before touching
anything.

In **cPanel → Terminal** (or over SSH):

```bash
pm2 list
pm2 info titopay-api | grep -E "cwd|script|exec"
```

The `cwd` it prints is your real install path. Use that everywhere below as `$API_DIR`.

```bash
export API_DIR="$(pm2 info titopay-api | awk '/cwd/{print $4}')"
echo "$API_DIR"
```

If `pm2` is not installed, you are on a cPanel **Setup Node.js App** deployment instead — see the
cPanel-only variant at the bottom.

---

## Step 1 — Back up the current deployment (Mac terminal)

Do this before uploading anything. This is your instant rollback.

```bash
ssh youruser@api.titopay.co.za
cd "$API_DIR/.."
tar -czf ~/titopay-api-backup-$(date +%Y%m%d-%H%M%S).tar.gz "$(basename "$API_DIR")"
ls -lh ~/titopay-api-backup-*.tar.gz
```

Also keep your existing `api_3.zip` on your Mac. Between the tarball and that ZIP you can restore
the exact current state at any time.

---

## Step 2 — Upload

**Option A — Mac terminal (scp), recommended**

```bash
cd ~/Downloads
shasum -a 256 api-peach-checkout-fix.zip          # note the hash
scp api-peach-checkout-fix.zip youruser@api.titopay.co.za:/tmp/api-peach-fix.zip
```

**Option B — cPanel File Manager**

1. cPanel → **File Manager** → navigate to your `$API_DIR`.
2. **Upload** → select `api-peach-checkout-fix.zip`.
3. Do **not** extract yet — finish Step 3 first.

---

## Step 3 — Extract over the existing install

The archive is flat, so extract it **inside** the API directory, never in its parent. A nested
`$API_DIR/api/` directory means it went in one level too deep.

```bash
cd "$API_DIR"
unzip -o /tmp/api-peach-fix.zip
test -f "$API_DIR/package.json" && echo "layout OK"
test -d "$API_DIR/api" && echo "WRONG — nested copy, remove $API_DIR/api and redo"
```

Confirm the new file landed:

```bash
ls -l "$API_DIR/src/services/peach-checkout-auth-service.js"
```

In cPanel File Manager: right-click the ZIP → **Extract** → target must be `$API_DIR` itself →
confirm overwrite.

---

## Step 4 — Install dependencies

Dependencies are unchanged from your current build, so this is normally a no-op. Run it anyway so a
partially-extracted `node_modules` cannot bite you.

```bash
cd "$API_DIR"
npm install --omit=dev
```

---

## Step 5 — Restart

```bash
pm2 restart titopay-api --update-env
pm2 restart titopay-email-worker --update-env
pm2 list
```

---

## Step 6 — Verify (Mac terminal)

```bash
curl -sS https://api.titopay.co.za/v1/health
```

Expected: `{"status":"ok","database":"ok",...}`

Then in the Admin Portal:

**Integrations → Peach Payments → Environment: Sandbox → Save Configuration → Test Connection**

Make sure all three fields are filled before testing:

| Field | Where to get it |
| :-- | :-- |
| Client ID | Peach **sandbox** Dashboard → API keys |
| Client Secret | Peach **sandbox** Dashboard → API keys |
| **Merchant ID** | Peach **sandbox** Dashboard → API keys |

Merchant ID was not required before this fix and may be blank. Test Connection will tell you if it
is missing rather than failing obscurely.

**Expected result:** `CONNECTED`.

Watch the server log while you click Test Connection:

```bash
pm2 logs titopay-api --lines 50 | grep peach-checkout-auth
```

You should see one line with `httpStatus: 200`. It contains no secrets by design — only the
environment, endpoint, status, duration, and the last four characters of the Client ID and
Merchant ID.

---

## If Test Connection does not say CONNECTED

The message now tells you which problem you have:

| Message | Meaning | What to do |
| :-- | :-- | :-- |
| `Authentication rejected by Peach Payments…` | Peach refused the credentials | Re-copy all three values from the **sandbox** Dashboard. Sandbox and live credentials are not interchangeable. |
| `Peach Payments Checkout configuration is incomplete: merchantId` | A field is blank | Fill it in and save again. |
| `Peach Payments is unavailable` | Peach returned 5xx | Peach-side outage; retry later. |
| `Peach Payments could not be reached` / `timed out` | Network egress blocked | Confirm the server can reach `sandbox-dashboard.peachpayments.com` on 443. |

Egress check from the server:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://sandbox-dashboard.peachpayments.com/api/oauth/token \
  -H 'content-type: application/json' \
  --data '{"clientId":"x","clientSecret":"x","merchantId":"x"}'
```

`400` is the healthy answer here — it proves the server reached Peach and Peach rejected the dummy
credentials. `000`, a hang, or a timeout means the network is blocked, not the fix.

---

## Rollback

```bash
pm2 stop titopay-api titopay-email-worker
cd "$API_DIR/.."
rm -rf "$API_DIR"
tar -xzf ~/titopay-api-backup-<timestamp>.tar.gz
pm2 restart titopay-api titopay-email-worker --update-env
curl -sS https://api.titopay.co.za/v1/health
```

Nothing in this change writes to the database schema, so a rollback needs no data repair. The
Peach configuration row stays readable by the old code.

---

## cPanel "Setup Node.js App" variant

If there is no PM2 and the app runs under cPanel's Node.js manager:

1. cPanel → **Setup Node.js App** → note the **Application root**; that is your `$API_DIR`.
2. **Stop** the application.
3. File Manager → upload and extract the ZIP into the application root (Step 3).
4. Back in Setup Node.js App, click **Run NPM Install**.
5. **Start** the application.
6. Run the Step 6 verification.
