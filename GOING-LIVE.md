# Going live

How TitoPay moves from sandbox to production without a test balance becoming a
claim on real money.

Read this once before you start. It takes about twenty minutes.

---

## What "sandbox" actually is

There is **no separate sandbox database**. Sandbox is one environment variable
per integration, choosing which URL and API keys the server talks to:

| Variable | Controls |
|---|---|
| `TITOPAY_ENV` | which deployment this is |
| `PEACH_PAYMENTS_MODE` | card top-ups, withdrawals, payouts |
| `DOCFOX_MODE` | KYC document verification |
| `OTT_MODE` | vouchers and value-added services |

All four are **required** and must be exactly `sandbox` or `production`. Until
build 54 the three integration modes defaulted to `production` when unset, so
going live could happen by omission: an unset variable, a typo or a stripped
environment file put the platform live in silence. That default is gone. A
missing, empty or misspelled value now stops the process with exit code 78
before it accepts a single request.

No table records which mode created a row. `transactions` and `wallets` have no
environment column. So flipping the keys changes nothing about existing data:
every test balance stays exactly where it is.

## Why that matters

A wallet balance is a number in the ledger. Today it is harmless, because it
was created by sandbox top-ups that moved no real money. The moment the keys
are live, that number becomes a **claim on real money**, because withdrawals
are wired to real payouts to real bank accounts.

A test account holding R5000 could request a withdrawal and TitoPay would
attempt to send R5000 of real money to a real bank account, funded from a float
that never received it. `revenue_ledger` has the mirror problem: it is full of
fees that were never earned, and they would appear in the first real revenue
report.

## The approach: start production on a clean database

Stand up a **new** database for production and keep the existing one as the
test environment. Nothing is deleted, so nothing can go wrong irreversibly, and
"is it clean?" is a row count rather than a hope.

The alternative, purging the current database, also works, but it is strictly
worse here: its safety depends on the delete script being right, you can never
prove nothing was missed, and the current database carries known unexplained
drift (`payment-integrity.js` reports 391 drifting wallet balances and 783
orphaned ledger rows, the oldest from 12 August). Starting fresh means the
first discrepancy you ever see is a real one.

---

## The sequence

### 1. Create an empty database

```sql
CREATE DATABASE titopay_production;
```

Nothing else. No schema, no seed.

### 2. Look before you write

```bash
cd api
POSTGRES_URL=postgres://user:pass@host:5432/titopay_production \
  npm run db:init-production
```

This writes nothing. It prints which database it is pointed at and what it
would do. **Read the database name back to yourself** before going on.

If it is pointed at a database holding customer data it refuses outright, lists
what it found, and exits non-zero. There is no override flag, deliberately.

### 3. Set it up

```bash
POSTGRES_URL=postgres://user:pass@host:5432/titopay_production \
ADMIN_FULL_NAME="Your Name" \
ADMIN_USERNAME=ceo \
ADMIN_EMAIL=ceo@titopay.co.za \
ADMIN_ROLE=super_admin \
ADMIN_PASSWORD='<at least 14 chars, upper, lower, number, symbol>' \
  npm run db:init-production -- --apply
```

It applies the schema, the approved pricing schedule, the service catalogue,
the email templates, the revenue wallet, the suspense wallet and one admin
account, then verifies and prints what exists. It exits non-zero if any
invariant fails.

Leave `ADMIN_PASSWORD` out to skip the admin step and use `npm run admin:create`
separately.

Re-running is safe while the database is still unused: the refusal is on
customer data, and the platform rows are what the script itself creates. Once
real activity exists it refuses permanently, which is the intended direction.
This is a setup step, not a repair tool.

### 4. Point the API at it, and declare the environment

**The API refuses to start unless all four of these are set explicitly.** They
have no defaults. `PEACH_PAYMENTS_MODE`, `DOCFOX_MODE` and `OTT_MODE` used to
default to `production` when unset, which meant going live could happen by
omission; that default is gone and an unset or misspelled value now stops the
process with exit code 78 before it serves anything.

Production:

```
TITOPAY_ENV=production
PEACH_PAYMENTS_MODE=production
DOCFOX_MODE=production
OTT_MODE=production
POSTGRES_URL=postgres://user:pass@host:5432/titopay_production
```

Test server:

```
TITOPAY_ENV=sandbox
PEACH_PAYMENTS_MODE=sandbox
DOCFOX_MODE=sandbox
OTT_MODE=sandbox
POSTGRES_URL=postgres://user:pass@host:5432/<your test database>
```

`TITOPAY_ENV` is separate from `NODE_ENV` on purpose. `NODE_ENV` keeps its
ordinary `development`/`production` meaning, because two existing behaviours
key off it: setting it to `sandbox` would turn the customer registration
geo-lock OFF by default and widen CORS. Leave `NODE_ENV` alone.

**The database is stamped with its own identity** on first boot, in
`platform_settings`. After that, a production API opening the sandbox database,
or the reverse, is refused even if the databases have been renamed or restored
elsewhere. Nothing is added to any financial table.

### 5. Swap the live keys

Peach production API key, secret, client id, entity id, merchant id, webhook
secret. Point the Peach webhook at the production callback URL.

### 6. Prove it before you tell anyone

- `curl https://api.titopay.co.za/health` and check the build number
- Sign in to the admin console with the account you just created
- Register one real account and top up the smallest amount the provider allows
- Make one QR payment and check three things: the payer's slip says the amount
  plus R1.50, the business is credited the amount less R1.50 + 1.5%, and the
  business receives a notification
- Request one Email Statement and open the PDF on a phone
- Withdraw the top-up back out and confirm it lands

Only then hand the app to anyone else.

---

## Do not forget

**Reprint the A4 posters.** A poster's QR encodes a code id belonging to an
account. Accounts on the old database do not exist on the new one, so every
sheet printed during testing resolves to nothing. Generate and print them again
from the production accounts.

**Set the pricing deliberately.** Whatever sits in `pricing_rules` when the
first real payment lands is what you actually charged. Refunding a fee is
harder than setting it. Current published rates:

| | |
|---|---|
| Customer, QR payment | flat R1.50, charged on top |
| Business, QR payment | R1.50 + 1.5%, out of the credit |

**Never run `npm run db:migrate` against production.** It is `db/init.js`, which
calls `syncApprovedPricingSchedule()` and overwrites all 90 pricing rules,
including any an operator has tuned. Use `npm run db:repair-schema` for schema
work on a live database.

**Keep the old database.** It is your test environment. Every change should be
proven against it before it reaches production.
