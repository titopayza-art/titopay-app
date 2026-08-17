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

Set all four, on both servers, to exactly `sandbox` or `production`.

**The three integration modes still default to `production` when unset.** That
fail-open is real and it has not been removed: an unset variable, a typo or a
stripped environment file still leaves the platform pointed at live providers.
Going live can still happen by omission. What changed in build 55 is that the
API now **tells you** rather than letting it pass in silence.

Build 54 tried to make it impossible instead of visible, by refusing to start
when a variable was missing. Deploying that to a server that did not yet have
the variables **took the API down**, so it was withdrawn. Build 55 warns on
every boot, reports itself on `/health`, and serves.

The API refuses to start for one class of problem only: a **contradiction**,
where something has been declared and something else disagrees with it. Those
are listed at the end of step 4. None of them can occur until you have
deliberately set the variables, so configuring can never cause an outage.

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

Set all four. The API will start without them, but it will warn on every boot
and report itself as undeclared, and the integration modes will quietly fall
back to `production`.

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

#### Check it took

```bash
curl -s https://api.titopay.co.za/v1/health
```

`"environment":"production"` and `"environmentWarnings":0` means the deployment
is fully declared. `"undeclared"`, or a warning count above zero, means
something is still missing; the startup log names it.

#### The only three things that stop the API

1. A production API opening a database **stamped** as sandbox, or the reverse.
2. An integration mode in a different environment from `TITOPAY_ENV`.
3. `NODE_ENV` set to `sandbox` or `production` and contradicting `TITOPAY_ENV`.

Each requires the variables to have been set deliberately, so none can fell a
server that was working a minute ago. Everything else warns and serves,
including a missing variable, a typo, a database that cannot be reached at
boot, and absent Peach credentials.

If the API ever does refuse, it prints what contradicts what and exits 78
without accepting a connection. Correct the contradiction, or unset
`TITOPAY_ENV` to start unverified.

### 5. Swap the live keys

Peach production API key, secret, client id, entity id, merchant id, webhook
secret. Point the Peach webhook at the production callback URL.

### 6. Prove it before you tell anyone

- `curl https://api.titopay.co.za/v1/health` and check the build number, and
  that it reports `"environment":"production"` with zero warnings
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
