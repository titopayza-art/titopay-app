# Running SeaGeek day to day

## How the reseller model works

Customers only ever deal with SeaGeek. Each product sends its traffic through your wholesale partners, which you manage in **Admin > Wholesale partners**:

| Product | Partners (priority order) | Connector |
|---|---|---|
| SMS | SMSMessenger, then Iwin / Zephyr | HTTP template |
| WhatsApp | 360dialog, then ChatReach | 360dialog connector / HTTP template |
| KYC / AML (Verify) | Teruza, then VerifyNow | HTTP template |
| Email | Amazon SES | SES connector (AWS Signature v4) |
| AI | Anthropic, then OpenAI | Official Anthropic PHP SDK / OpenAI REST |
| Voice | Zephyr, then Cloud Telecoms | HTTP template |

For each live request the gateway:

1. Picks the active partner with the lowest priority number.
2. Moves on to the next partner if one returns an error or times out.
3. Moves a partner that has failed 5 times in a row to the back of the queue until it succeeds again.
4. Refunds the customer automatically if every partner fails.

### Connecting an HTTP partner

You need the partner's API documentation and credentials. On the partner's page in Admin:

1. **Endpoint URL** and **method**, e.g. `POST https://api.partner.co.za/v1/sms`.
2. **API key / secret** (stored encrypted), plus **headers** using `{{secret}}`, e.g. `Authorization: Bearer {{secret}}`.
3. **Body template** with placeholders, e.g.
   ```json
   {"destination": "{{to}}", "message": "{{body}}", "sender": "{{from}}", "clientRef": "{{reference}}"}
   ```
   Available placeholders: `to, body, from, reference, subject, html, text, type, id_number, first_name, last_name, company_reg, account_number, branch_code`.
4. **Message ID path**: where the partner's response holds its message ID, e.g. `data.messageId`.
5. **Delivery reports**: copy the delivery report URL from the page into the partner's portal. Then set where its callback holds the ID and status, and which status values mean "delivered".
6. Tick **Active** and use **Send a test**.

### WhatsApp numbers

1. A customer adds a number under WhatsApp in their dashboard. This opens a high-priority ticket in your support desk.
2. Register the number in the 360dialog Partner Hub (or with ChatReach).
3. On the customer's page in Admin > Customers:
   - paste the number's channel API key,
   - choose the partner,
   - set the status to **active**.
4. Set the number's webhook in 360dialog to the URL shown next to it. Inbound messages then reach the customer's webhook and their Desk.

## What runs without anyone

| Event | What happens automatically |
|---|---|
| Sign-up | Account created, verification email sent, sandbox key issued on confirmation, welcome email |
| First payment clears | Live access switches on, live key issued, "live access is on" email |
| Top-up via PayFast | Signature, amount and PayFast server confirmation checked; credit added; receipt emailed |
| Plan renewal date | Invoice created; paid from credit if auto-pay is on and the balance covers it; otherwise emailed |
| Invoice due and overdue | Reminders on days 0, 3 and 6 after the due date (Admin > Settings) |
| 7 days overdue | Live API access paused (sandbox keeps working), customer emailed, logged |
| Payment after lock | Access restored and plan credit added straight away |
| Balance below alert level | Low-balance email, once per drop |
| 1st of the month | WhatsApp number fees charged from credit |
| Partner fails | Next partner used; customer refunded if all fail; partner marked unhealthy |
| AI usage | Plan and customer caps checked before every call; nothing is spent past the cap |
| Chat, WhatsApp, email, help centre form | Ticket created; AI agent answers from the help centre; handover to people when needed; agents emailed |
| Ticket misses its first-reply target | Tagged overdue, agents emailed |
| Customer webhook down | Retried with backoff for 24 hours |

## What still needs a person (the other ~10%)

These appear under **Needs a person** on the admin overview and as tickets in the support desk:

- **Business verification (KYB)** before live identity checks. This is a POPIA and FIC Act decision, so a person approves it.
- **SMS sender ID** approval, after the networks confirm it.
- **WhatsApp number** onboarding with Meta through the partner.
- **Mail domain** verification in SES.
- **EFT payments**: match the bank statement, then click **Mark EFT paid** on the customer's invoice.
- **Support handovers**: billing disputes, complaints and anything the AI can't answer.
- **Pricing**: when a partner changes its cost, update it in Plans & pricing.

## Pricing and margins

Default prices are in Admin > Plans & pricing. Each rate shows your selling price, the wholesale cost and the margin. The costs in the database are estimates: replace them with the numbers from your signed partner contracts before launch. AI prices follow the provider's USD list price × the USD/ZAR rate × (1 + markup); update the exchange rate monthly.

## Email delivery (SMTP)

Admin, Settings, Email delivery. Fill in the SMTP details from your host, Microsoft 365 or Google Workspace:

| Provider | Host | Port | Security |
|---|---|---|---|
| Afrihost and most cPanel hosts | mail.seageek.co.za | 465 | SSL/TLS |
| Microsoft 365 | smtp.office365.com | 587 | STARTTLS |
| Google Workspace | smtp.gmail.com | 587 | STARTTLS (use an app password) |
| Amazon SES (SMTP interface) | email-smtp.af-south-1.amazonaws.com | 587 | STARTTLS |

Save, then use *Send a test email*. From the server you can also run `php cli.php test-email you@seageek.co.za`.
Add SPF, DKIM and DMARC records for seageek.co.za at your DNS host so mail lands in inboxes, not spam.

## Staff and permissions

Admin, Staff and permissions. Roles: Owner (everything), Administrator (everything except staff), Developer
(partners, settings, jobs, customers), Customer support (desk, customers), Finance (money, customers),
Marketing (campaigns, contacts, QR codes, customers) or Custom. Invited staff get a link to set a password.
Switching someone off signs them out at once. There is always at least one owner.

## Marketing, QR codes and store SMS

- **Newsletters**: Admin, Marketing. Send to *All SeaGeek customers* (owners and billing contacts) or the
  *Website newsletter* list (people who subscribe in the site footer). Unsubscribes are honoured automatically.
- **QR codes**: customers pay R20 per code from credit (plan discounts apply). Dynamic codes go through
  `/q/{code}`, so they can be changed and counted. Admin, Marketing, QR codes lists every customer's codes.
- **Store SMS**: customers connect Shopify, WooCommerce, Wix or any platform with a private link. Each order
  SMS costs R0.50 (store_sms rate under Plans, packages and rates). Abandoned-cart reminders are sent by cron.
- **Campaigns** are sent in batches by cron and the worker; failed messages are refunded like any API send.
