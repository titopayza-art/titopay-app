# SeaGeek integration guide

What must be connected, in what order, before SeaGeek can serve real customers. Each item lists where it is set, what it unlocks, and how to confirm it works. Operating routines (cron, backups, daily checks) are in `guides/OPERATIONS.md`.

Status key: **Built** means the code is in place and tested against a stand-in or sandbox. **Needs account** means an outside party must issue credentials before it can run live.

## 1. Server and database

| Item | Where | Notes |
|---|---|---|
| PHP 8.3 with PDO, curl, mbstring, openssl, json | Host | Checked by the installer |
| MySQL 8 or MariaDB 10.6+ (or SQLite for small installs) | Installer | Schema runs automatically (migrations up to 8) |
| `app_key` | `app/config.php` | Encrypts all secrets at rest. **Back it up.** Without it, stored partner keys cannot be decrypted |
| `app_url` | Installer | Must be the public HTTPS address, used in links and webhooks |
| Cron, every minute | Host | `php cli.php cron`. Drives billing, reminders, queued sends, webhooks, email, retention |

Confirm: the `/health` route returns OK, and `storage/logs/cron.log` gets a line each minute.

## 2. Outbound email (SMTP or Amazon SES)

| Item | Where | Status |
|---|---|---|
| Sending domain verified (SPF, DKIM, DMARC) | Amazon SES or host DNS | Needs account |
| SES production access (out of sandbox) | AWS | Needs account |
| `smtp_host`, `smtp_port`, `smtp_username`, `smtp_password`, `smtp_encryption` | Admin > Settings | Built |
| `mail_from_address`, `mail_from_name`, `support_email` | Admin > Settings | Built |

Confirm: send a verification email to a real inbox, and check it does not land in spam. Use the one-click unsubscribe header on campaign email (already implemented, RFC 8058).

## 3. Payments (PayFast)

| Item | Where | Status |
|---|---|---|
| Merchant ID, merchant key, passphrase | Admin > Settings (`payfast_*`, encrypted) | Needs account |
| `payfast_mode` set to `live` | Admin > Settings | Set after tests |
| Notify URL: `https://YOUR-DOMAIN/webhooks/payfast` | PayFast dashboard | Built |
| Return and cancel URLs | Built into the invoice pay page | Built |

Confirm: pay R10 with a real card in live mode, check the wallet credits once (not twice), then refund. Sandbox mode is the default until this is done.

EFT: add the bank details under Settings (`bank_*`). EFT payments are matched by the customer number reference, either by bank import or manually in Admin > Money.

## 4. AI (Anthropic and OpenAI)

| Item | Where | Status |
|---|---|---|
| Anthropic API key | Admin > Partners (encrypted) | Needs account |
| OpenAI API key | Admin > Partners (encrypted) | Needs account (optional fallback) |
| Model choice, markup, monthly cap | Admin > Settings and each org's AI page | Built |
| `ai_data_allowed` per company | Dashboard > Privacy | Built (off by default for new companies) |

Confirm: open Admin > Partners, run "Test SeaGeek AI". Today this has only been tested against a stand-in server, so this live test is the first real proof. Check the reply, the usage charge in rand, and that the monthly cap stops calls.

## 5. Wholesale messaging partners (SMS, voice, OTP)

Add each partner under **Admin > Partners** with its credentials, set its priority, then switch it on. Each channel has a primary and a backup partner, so traffic fails over automatically.

| Channel | Partners named in the deck | Status |
|---|---|---|
| SMS | SMSMessenger, Iwin (Zephyr) | Needs account |
| Voice and voice OTP | Partner to be signed (beta) | Needs account |
| Email (transactional) | Amazon SES | Needs account (see section 2) |
| Identity checks | VerifyNow and others, one per check | Needs account |

Inbound delivery receipts: `POST /webhooks/partner/{id}/{token}`. The token is generated per partner. Give the partner the exact URL shown on its Admin > Partners page.

Confirm: send a live SMS to your own phone, check the delivery receipt updates the status, and check the rand charge matches the price list.

## 6. WhatsApp Business

| Item | Where | Status |
|---|---|---|
| Meta Business account and WhatsApp Business number | Meta | Needs account |
| Meta business verification (for the verified tick) | Meta | Needs account |
| Provider credentials (360dialog or direct Cloud API, per partner row) | Admin > Partners | Needs account |
| Webhook: `POST /webhooks/whatsapp/{id}/{token}` | Meta or partner dashboard | Built |
| Message templates approved by Meta | Dashboard > WhatsApp templates | Needs Meta approval (1 to several days per template) |

Confirm: approve one utility template, send it to your own number, reply to it, and check the reply shows in the Desk inbox.

## 7. Identity verification (Verify)

| Check | Partner | Status |
|---|---|---|
| SA ID number | Partner row | Needs account |
| Photo match, PEP, sanctions, CIPC, bank account | Partner rows | Needs account |

Verify is sold only after the partner contract and a legal review of POPIA obligations. Keep it switched off until then.

## 8. Accounting (Xero)

| Item | Where | Status |
|---|---|---|
| Xero app client ID and secret | Admin > Settings (`xero_*`, encrypted) | Needs account |
| OAuth connection | Admin > System (Xero callback) | Built |
| Bank account for payments | Settings `xero_bank_account` | Built |

Confirm: create one invoice, check it appears in Xero after the next cron run, and that a payment marks it paid in both places.

## 9. Store plug-ins (Shopify, WooCommerce, others)

| Item | Where | Status |
|---|---|---|
| Store connection | Dashboard > Stores | Built |
| Webhook: each store posts to its own signed URL | Shown on the store page | Built, tested with signed test payloads (18 checks) |
| Sandbox order test | Dashboard > Stores > Send a test order | Built |

Confirm: connect a real test store, place a test order, and check the SMS is queued and sent.

## 10. Support chatbot and Desk

| Item | Where | Status |
|---|---|---|
| AI provider for the chatbot | Settings > Support chatbot | Built (needs AI key, section 4) |
| Desk inbound email | Webhook: `POST /webhooks/inbound-email/{slug}/{token}` | Built, needs the mail provider to forward to it |
| Turnstile (bot protection on forms) | `turnstile_site_key`, `turnstile_secret` | Needs Cloudflare account (optional) |

## 11. Monitoring and operations

| Item | Where | Status |
|---|---|---|
| Ops alerts email and phone | Settings `ops_email`, `ops_phone`, `ops_digest` | Built |
| Uptime check on `/health` | External monitor (e.g. UptimeRobot) | Recommended, not built in |
| Backups (daily database and `app_key`) | Host | Set up before launch |

## 12. Go-live checklist

1. Sections 1 and 2 done, with a real verification email delivered.
2. One real SMS, one real WhatsApp template, and one real email sent and received.
3. One real PayFast payment in live mode, then refunded.
4. Anthropic key added and "Test SeaGeek AI" passing with a real reply.
5. Xero invoice flow confirmed (if you use Xero from day one).
6. Backups tested: restore the database to a scratch copy and log in.
7. Lawyer review of the data protection page, and Verify kept off until then.
8. Build prices and the "live within a week" promise confirmed by you.

## Known gaps

- MySQL/MariaDB install path currently returns an error on a fresh database (under investigation). SQLite is fully tested. Use SQLite for the first launch, or treat MySQL as unverified until the suite passes.
- The AI, WhatsApp, PayFast, SMS partner, and Xero paths have only been tested against stand-in or sandbox servers. Each one needs the live test above.
- No load test has been run, so no capacity figure should be quoted.
