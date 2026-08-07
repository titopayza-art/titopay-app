# TitoPay API — Afrihost cPanel deployment

Node.js application. **Target:** `api.titopay.co.za`

**No database migration. No new environment variable is required.**

---

## Step 0 — Find your install path first

The bundled docs disagree (`AFRIHOST_API_REPLACEMENT.md` says `/var/www/titopay/api`,
`deploy/ecosystem.config.cjs` says `/opt/titopay-api`), so confirm which is live before touching
anything.

**If you have cPanel → Terminal or SSH:**

```bash
pm2 info titopay-api | grep cwd
export API_DIR="$(pm2 info titopay-api | awk '/cwd/{print $4}')"
echo "$API_DIR"
```

**If there is no PM2**, you are on cPanel's **Setup Node.js App**: open it and note the
**Application root** — that is your install path. Follow the cPanel-only route at the bottom.

## Step 1 — Back up

```bash
cd "$API_DIR/.." && tar -czf ~/titopay-api-backup-$(date +%Y%m%d-%H%M%S).tar.gz "$(basename "$API_DIR")"
```

Or in File Manager: select the API folder → **Compress** → move the archive outside the document
root. Keep your previous `api.zip` too.

## Step 2 — Upload

File Manager → open the API directory → **Upload** → `api.zip`.
(Or `scp api.zip user@api.titopay.co.za:/tmp/api.zip` from a Mac terminal.)

## Step 3 — Extract inside the API directory

The archive is **flat**: `package.json`, `src/`, `deploy/` are at the ZIP root.

Right-click `api.zip` → **Extract** → target must be the API directory itself.

```bash
cd "$API_DIR" && unzip -o /tmp/api.zip
test -f "$API_DIR/package.json" && echo "layout OK"
test -d "$API_DIR/api" && echo "WRONG — nested copy, delete $API_DIR/api and redo"
ls -l "$API_DIR/src/services/peach-payout-service.js"   # should exist
```

Delete the uploaded ZIP afterwards.

## Step 4 — Install dependencies

Dependencies are unchanged, so this is normally a no-op — run it anyway.

```bash
cd "$API_DIR" && npm install --omit=dev
```

In **Setup Node.js App**, click **Run NPM Install** instead.

## Step 5 — Restart

```bash
pm2 restart titopay-api --update-env
pm2 restart titopay-email-worker --update-env
```

In **Setup Node.js App**: **Stop**, then **Start**.

## Step 6 — Verify

```bash
curl -sS https://api.titopay.co.za/v1/health
```

Expect `{"status":"ok","database":"ok",...}`.

Then in the Admin Portal → **Integrations → Peach Payments**:

1. **Collection / Top-up** → Test Connection → must still be **Connected**.
2. **Payout / Withdrawal** → shows **Not Configured** until you enter payout credentials.

Watch the log while testing:

```bash
pm2 logs titopay-api --lines 40 | grep -E "peach-checkout-auth|peach-payout-auth"
```

Neither line ever contains a secret — only environment, endpoint, status, duration and last-4
identifiers.

---

## Configuring Payout (when you have the credentials)

Payout credentials are **separate** from Checkout. Create them in the Peach Dashboard under
**Payouts → Settings → Create API credentials** (switch to the sandbox Dashboard for sandbox keys).

Then Admin → Integrations → Peach Payments → **Payout / Withdrawal**:

| Field | Sandbox value |
| :-- | :-- |
| Environment | `sandbox` |
| Base URL | `https://sandbox-payouts.peachpayments.com/api` |
| Client ID | from Payouts → Settings |
| Client Secret | from Payouts → Settings |
| Merchant ID | from Payouts → Settings |

Live values are `production` and `https://payouts.peachpayments.com/api`.

Save, then **Test Connection**. The test authenticates with the payout credentials and reads your
payout balance — it moves no money.

Saving Payout never touches Collection, and saving Collection never touches Payout: they are
separate encrypted rows.

## Withdrawals stay closed

Connecting the payout provider does **not** open withdrawals. TitoPay's withdrawal lifecycle
(debit → submit → provider confirmation → complete) is a separate build step, so customers see:

> "Withdrawals are not open yet. The payout provider is connected, but TitoPay withdrawal
> processing is still being enabled. No wallet debit was made."

`PEACH_PAYOUT_PROCESSING_ENABLED` exists in the code but must stay unset until that lifecycle is
built and tested. Do not set it to `true` yet — nothing would submit the payout.

## Rollback

```bash
pm2 stop titopay-api titopay-email-worker
cd "$API_DIR/.." && rm -rf "$API_DIR"
tar -xzf ~/titopay-api-backup-<timestamp>.tar.gz
pm2 restart titopay-api titopay-email-worker --update-env
curl -sS https://api.titopay.co.za/v1/health
```

No schema change means a rollback needs no data repair. The payout settings row is simply ignored
by the older build.

## Optional environment variables

None are required. Available if you prefer process configuration over the Admin form:

```dotenv
APP_BASE_URL=https://app.titopay.co.za
PEACH_TOPUP_MIN_AMOUNT=5
PEACH_TOPUP_MAX_AMOUNT=50000
PEACH_PAYOUTS_BASE_URL=https://sandbox-payouts.peachpayments.com/api
PEACH_PAYOUTS_CLIENT_ID=...
PEACH_PAYOUTS_CLIENT_SECRET=...
PEACH_PAYOUTS_MERCHANT_ID=...
```
