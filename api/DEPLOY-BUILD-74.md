# api.zip build 74 — deploy notes

**This build cannot give you a 502 from a configuration problem.** That is what
it exists to fix.

---

## What happened on 20 August

Build 71 made `IDENTITY_PEPPER` a required variable. Your server did not have
it. The new code refused to start, correctly by its own logic, and a Node
process that exits has nothing listening on its port — so nginx returned **502
Bad Gateway**.

Nothing crashed. Nothing was corrupt. No data was lost. The API was *complaining*
in the loudest possible way and the least useful one, because the thing that
would have shown you the complaint was the thing that had died.

## What build 74 changes

`src/config/env.js` **no longer throws for anything.** Not a missing pepper, not
a short signing key, not a missing database string, not a mistyped port number.
Every one of them is now a startup **warning**. The API comes up, prints what is
wrong, and keeps serving every request that does not depend on the misconfigured
thing.

Verified by extracting this exact archive and loading its configuration with a
**completely empty environment** — no variables at all:

```
STARTED. build=74, warnings=7
exit=0
```

And with the precise configuration that took you down on 20 August:

```
[config] 1 configuration warning(s). The API is starting anyway.
[config]   - IDENTITY_PEPPER is not set. Identity numbers are being keyed with a
             value DERIVED from JWT_ACCESS_SECRET instead...
[config] Run `node preflight.js` for the same list with remedies.

{"status":"ok","database":"ok","configWarnings":1,"build":74, ...}
```

Same server, same `.env`, same everything. Build 71 gave you 502. Build 74 serves.

## Deploy it

```bash
cd ~/api
unzip -o ~/api.zip
rm ~/api.zip
npm install --omit=dev
npm run db:apply-migrations
node preflight.js            # optional now, but read it
# restart via cPanel → Setup Node.js App → Restart
```

**You do not need to set anything first.** Build 74 will start on your current
`.env` exactly as it is. The preflight is now advice, not a gate.

## Confirm it came back

```bash
curl -s https://api.titopay.co.za/v1/health
```

Look for `"build":74`. The new `configWarnings` field is a count of
configuration problems the API started **despite**. Zero means the configuration
is complete. Non-zero means it is up and serving, and something is worth fixing.
It is a number, never the warnings themselves — a public health response must
not hint at which key is weak.

## Then, at your leisure, fix the warning

Not urgent. Nothing is broken while it stands.

```bash
node -e 'console.log("IDENTITY_PEPPER=" + require("crypto").randomBytes(48).toString("base64url"))' >> .env
```

Then restart again. `node preflight.js` should print `Configuration is complete.`

**Generate it once and keep it forever.** Identity numbers are keyed with it, so
if it changes later, ID numbers verified under the old value stop matching.

## What the fallbacks actually do

Since these now stand in for missing configuration, it matters what they are.

| Missing | What happens | Is it safe? |
|---|---|---|
| `IDENTITY_PEPPER` | Derived by HMAC-SHA-256 from `JWT_ACCESS_SECRET` | **Yes.** Still a real secret held outside the database, so a stolen database dump still does not give up ID numbers. The downside is that identity hashes are tied to a key you ought to be able to rotate, which is why it warns. |
| `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET` | A strong random key is generated for that process | **Survivable.** Everyone is signed out on each restart until you set it. That is far better than signing with an empty string, which anybody could forge. |
| `POSTGRES_URL` | Empty | The API starts and `/health` reports `"database":"error"`, so you can see the real reason instead of a blank 502. Requests needing data fail until you set it. |
| A non-numeric port or TTL | Falls back to the documented default | Yes. |

The security floors are unchanged in **what they consider wrong**. They changed
only in **what they do about it**.

## Why this cannot come back

`api/test/deployment-preflight.test.js` — 22 tests, part of the normal suite:

- `src/config/env.js` contains **no throw at all**. Add one and the build fails.
- The configuration loads with **nothing set**, with no pepper in production,
  with secrets far too short, with no database string, and with a non-numeric
  port and TTL. Each is a separate test running in a child process with the
  environment stripped bare.
- A missing signing key becomes a strong random one, never an empty string, and
  the access and refresh keys are never the same.
- The derived pepper **follows the access secret** and is never a constant —
  proved by deriving under two different secrets and asserting they differ. A
  constant is exactly the vulnerability the August audit found.
- Every variable the API needs is declared in `api/.env.example` and checked by
  `preflight.js`, and `DEPLOY.md` runs the preflight **before** the restart.

Full suite: **1126 passing.**

## Also in this build

Build 73 added `api/.env.example`, which had never existed — it declares every
variable the API reads, which are required and which have defaults, names only
and never values. That absence is why nothing on your server said
`IDENTITY_PEPPER` had become necessary.

Build 72 carries the stokvel fixes: group and member totals summed in SQL rather
than over the capped 500-row display page, the post-commit audit write no longer
able to report a succeeded payment as failed, a stable idempotency key on
contributions, and a rate limiter on invite-code guessing.
