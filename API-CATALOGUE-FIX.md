# Service catalogue fix

Changes to apply to the live `GET /v1/services` catalogue.

**Why this cannot be fixed in the app.** `services-default.json` shipped in the
deployment package is only a fallback, used when `/v1/services` fails. The live
catalogue overrides it on every successful load, so these values have to change
server-side. Editing the file in the deployment zip has no effect in production.

Nothing here changes the catalogue's shape. Every row already has these fields:

```
service_code, service_name, service_icon, action, description,
fee, commission, status, personal_visible, business_visible,
sort_order, feature_badge
```

---

## 1. Hide Stockvel until it has a backend — highest priority

The app renders a complete savings-group interface (create, members,
contributions, withdrawals, statement) against `/v1/stockvels`, and there is no
service behind that path. Every screen renders empty or errors. A savings
product that appears to work and has no ledger is the largest risk currently
live.

| service_code | field | from | to |
|---|---|---|---|
| `stockvel` | `personal_visible` | `true` | `false` |

Leave `status` as `active` — the row stays, it is simply not shown. Flip
`personal_visible` back to `true` on the day the ledger endpoints in
`API-REQUIREMENTS.md` §P1-1 are live.

---

## 2. Business account is showing personal-only services

Both of these appear on business accounts in production. Neither should.

| service_code | field | from | to | why |
|---|---|---|---|---|
| `bill-split` | `business_visible` | `true` | `false` | Splitting a bill between friends is a personal action. It has no merchant meaning and clutters the business grid. |
| `withdraw` | `business_visible` | `true` | `false` | Duplicates Payouts. Both move wallet money to a bank account, they are separate service codes, and showing both gives a merchant no way to choose. Business settles through `payouts`. |

---

## 3. Business account is missing two services it should have

Requested for business and currently absent from the live catalogue.

| service_code | field | from | to |
|---|---|---|---|
| `send-gift` | `business_visible` | `false` | `true` |
| `tickets` | `business_visible` | `false` | `true` |

`tickets` is the browse-and-buy screen. It is distinct from `ticketing`, which
is the organiser dashboard for running your own events. A business needs both:
one to buy, one to sell.

---

## 4. Airtime is published three times

The catalogue publishes `airtime`, `data` and `airtime-data` as separate
services. The app collapses all three into one "Airtime & Data" tile everywhere,
because three tiles with the same icon for overlapping products reads as a bug.

If the combined product is the real one, publish only it:

| service_code | field | from | to |
|---|---|---|---|
| `airtime` | `personal_visible` / `business_visible` | `true` / `true` | `false` / `false` |
| `data` | `personal_visible` / `business_visible` | `true` / `true` | `false` / `false` |

Leave `airtime-data` visible. If instead the three are genuinely distinct
products with different provider behaviour, tell us and we will stop collapsing
them — but then they need distinct icons and names.

---

## 5. Copy correction

| service_code | field | from | to |
|---|---|---|---|
| `payment-request` | `description` | `Request money from a customer, friend or family member.` | `Request money by username, cellphone number or email.` |

A personal account is not dealing with customers. The app now says "user" on
personal and "customer" on business throughout; this string is the last place
the old wording survives, and it is served from the API.

---

## 6. Nine services are advertised and do not exist

These are `status: coming_soon` and invisible to both account types, so they are
not currently user-facing — but they sit in the catalogue as commitments:

`shop-marketplace`, `rewards`, `business-rewards`, `virtual-doctor`, `travel`,
`donate`, `cross-border`, `get-cash`, `cash-back`

Either attach a real date or remove the rows. No app change is needed either
way; this is catalogue hygiene.

---

## Applying it

The client reads these fields directly, so any representation works — the
change is nine field values across seven rows.

**As a JSON patch to the catalogue source:**

```json
[
  { "service_code": "stockvel",        "personal_visible": false },
  { "service_code": "bill-split",      "business_visible": false },
  { "service_code": "withdraw",        "business_visible": false },
  { "service_code": "send-gift",       "business_visible": true  },
  { "service_code": "tickets",         "business_visible": true  },
  { "service_code": "airtime",         "personal_visible": false, "business_visible": false },
  { "service_code": "data",            "personal_visible": false, "business_visible": false },
  { "service_code": "payment-request", "description": "Request money by username, cellphone number or email." }
]
```

**As SQL — indicative only, adjust to your actual table and column names:**

```sql
UPDATE services SET personal_visible = false WHERE service_code = 'stockvel';
UPDATE services SET business_visible = false WHERE service_code IN ('bill-split', 'withdraw');
UPDATE services SET business_visible = true  WHERE service_code IN ('send-gift', 'tickets');
UPDATE services SET personal_visible = false, business_visible = false
  WHERE service_code IN ('airtime', 'data');
UPDATE services
  SET description = 'Request money by username, cellphone number or email.'
  WHERE service_code = 'payment-request';
```

## Verifying it worked

No app deployment is required — the catalogue is fetched on load. After the
change, sign in and check:

- **Personal:** no Stokvel tile. One "Airtime & Data" tile, not three.
- **Business:** no Bill Split, no Withdraw. Send Gift and Tickets both present,
  alongside Ticketing.
- **Both:** Payment Request no longer says "customer" on a personal account.

If a tile does not change, the client is falling back to the bundled
`services-default.json`, which means `/v1/services` returned an error — check
that endpoint before assuming the catalogue edit failed.
