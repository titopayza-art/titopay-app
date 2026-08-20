# Deploying this release to Afrihost cPanel

Four archives. The three front-end ones are static files — upload, extract,
overwrite. The API is the only one that needs SSH, and the only one with a step
you must not skip.

| Archive | Extract into | Needs SSH |
|---|---|---|
| `app.zip` | the customer PWA folder (`public_html` or the app subdomain root) | no |
| `admin.zip` | the Admin Portal folder | no |
| `hr.zip` | the HR portal folder | no |
| `api.zip` | the API application folder | **yes** |

Order does not matter, except that `api.zip` and its migration should go first
if you want the HR portal's new screens to have a server that understands them.

---

## 1. The three static packages

In cPanel → File Manager:

1. Upload the zip into the folder it belongs in.
2. **Extract**, choosing *overwrite* when asked.
3. Delete the zip afterwards so it is not served.

Nothing else. No build step, no restart.

### One thing to check on `app.zip`

The customer app is served from `app.min.js`, not `app.js`. Both are in the
archive and both must land. If you extract selectively and take only `app.js`,
customers get the previous build and nothing appears to have changed.

`index.html`, `service-worker.js` and the service worker's cache name all carry
the same version number, and that agreement is what makes a returning customer
pick up the new code instead of the copy their browser cached. Read the number
out of `pwa/index.html` for the release you are shipping rather than trusting a
number written here, which goes stale on every build. If you ever hand-edit one
of those three, change all three.

**And close the app afterwards.** Uploading a new bundle updates the service
worker and its cache, but neither replaces JavaScript ALREADY RUNNING in an open
page. An installed PWA that is never fully closed keeps executing the copy it
loaded, indefinitely. This has already cost one round of "the fix is deployed
and the phone still shows the old behaviour": force-close the app and reopen it
before deciding a deploy did not work.

---

## 2. The API, over SSH

Log in with the cPanel SSH credentials:

```bash
ssh USER@titopay.co.za -p 22
```

Find the API folder — it is the one containing `package.json` and `src/server.js`:

```bash
ls ~/api/package.json ~/titopay-api/package.json 2>/dev/null
cd ~/api            # or wherever the line above found it
```

### Back up what is there now

Two minutes that save an evening. `.env` is excluded from the archive and must
survive; this copies it out of harm's way as well.

```bash
cd ~
tar -czf api-backup-$(date +%F-%H%M).tar.gz --exclude=node_modules api
cp api/.env ~/api-env-backup-$(date +%F-%H%M)
ls -la api-backup-*.tar.gz | tail -1
```

### Upload and extract

Upload `api.zip` through cPanel File Manager into the home directory, then:

```bash
cd ~/api
unzip -o ~/api.zip
rm ~/api.zip
```

`-o` overwrites without prompting. The archive contains no `.env` and no
`node_modules`, so neither your configuration nor your installed packages are
touched.

### Install any new dependencies

```bash
npm install --omit=dev
```

Safe to run when nothing changed — it exits quickly.

### Apply the database migrations

**This is the step that matters.** Skipping it is what made the Marketing pages
answer "Unable to complete the request" a few weeks ago: the code was fine and
the tables it wanted were not there.

```bash
npm run db:apply-migrations
```

It prints each migration as it applies, records what it did, and is safe to run
twice — already-applied migrations are skipped. It never runs a `.down.sql`.

Expect to see `20260810_hr_claim_employee_link` and
`20260810_hr_learning_resource_link` in this release.

### Check the release will start, before you restart it

```bash
cd ~/api && node preflight.js
```

**This is the step that keeps a bad release from becoming an outage.**

A release can add a newly *required* environment variable. When it does, the new
code refuses to start without it, which is correct, and from behind nginx a
process that refuses to start is indistinguishable from a server that is down:
you get 502. That is exactly what happened on 20 August 2026, when build 71 made
`IDENTITY_PEPPER` required and nothing on the server said so until the restart.

The preflight reads the configuration this server actually has, loads it the same
way the API does, and tells you whether the extracted build will start. It reports
every problem at once rather than dying on the first, names each variable, and
never prints a secret's value.

Add `--database` to also prove Postgres is reachable and report how many
migrations are recorded:

```bash
node preflight.js --database
```

`Safe to restart.` means go ahead.

**If it fails, DO NOT RESTART.** The API still running is serving from memory and
is completely unaffected by the files you extracted; it keeps working until it is
restarted. Fix what the preflight names, run it again, and restart only once it
passes. Stopping here costs nothing. Restarting into a failed preflight costs an
outage.

`api/.env.example` lists every variable the API reads, which are required, and
which have defaults. It holds names only, never values.

### If the preflight reports everything missing on a working server

Read that as "this shell cannot see the configuration", not "the API has none".
On cPanel (Passenger), pm2 and systemd setups the running API gets its
variables injected by the process manager, and an SSH shell does not inherit
them — so the preflight and `db:apply-migrations`, run by hand, can see nothing
on the very machine where the API is serving fine. (A database URL missing from
the shell is also where a confusing `password authentication failed for user
"root"` comes from: the Postgres client falls back to your OS username.)

Two consequences:

- **To check the running API**, ask it, not the shell:
  `curl -s https://api.titopay.co.za/v1/health` — its `configWarnings` field
  counts the problems the live process actually started with.
- **To make shell scripts work**, create `~/api/.env` carrying the same values
  the process manager injects (`api/.env.example` lists every name), or prefix
  the one you need: `POSTGRES_URL="<value>" npm run db:apply-migrations`.

Where you add a NEW variable such as `IDENTITY_PEPPER`, add it where the
running API reads from — the process manager's environment screen — and mirror
it into `~/api/.env` so the scripts agree with the service.

### Restart the API

Which command depends on how Afrihost runs it.

**If it runs under Passenger** (the usual cPanel Node.js setup) — cPanel →
*Setup Node.js App* → **Restart**, or from the shell:

```bash
mkdir -p ~/api/tmp && touch ~/api/tmp/restart.txt
```

**If it runs under pm2:**

```bash
pm2 restart titopay-api && pm2 logs titopay-api --lines 40
```

**If it runs as a plain process:**

```bash
pkill -f "node src/server.js"; sleep 3
cd ~/api && nohup node src/server.js > ~/api.log 2>&1 &
```

### Confirm it came back

```bash
curl -s https://api.titopay.co.za/v1/health | head -c 400; echo
```

You want `"status":"ok"`. Also look at the `emailWorker` field in that response:

- `ready` — the email worker is running.
- `stalled` or `not_migrated` — **queued email will not be delivered.** Nothing
  is lost, it sits in the queue, but nobody receives anything until the worker
  runs. See below.

### Running more than one API process (optional, and how to do it safely)

The API runs as a single process unless you say otherwise, which is one CPU
core for every customer request, payment and webhook — and one crash away from a
full outage.

Set `API_WORKERS` in `.env` to fork that many HTTP workers:

```
API_WORKERS=4
```

A worker that dies is replaced automatically, and the connection pool is
**divided** between workers rather than multiplied by them, so four workers stay
inside the database's connection budget instead of exhausting it.

**One thing you must not skip.** Live chat keeps its open sockets in one
process's memory, so clustered workers refuse chat connections — structurally,
not by configuration. If you set `API_WORKERS` and do nothing else, **live chat
stops connecting.** Run one additional instance with `API_WORKERS` unset, on its
own port, and point nginx at it:

```nginx
location /v1/chat/socket { proxy_pass http://127.0.0.1:8101; }
location /v1/            { proxy_pass http://127.0.0.1:8100; }
```

Worker 1 prints a reminder of this at every boot. If you are not ready to run
the second instance, leave `API_WORKERS` unset — the single-process behaviour is
unchanged and nothing here applies.

### The email worker

It is a separate process from the API. If `/health` says it is not ready:

```bash
cd ~/api
pm2 start src/email-worker.js --name titopay-email-worker   # if you use pm2
# or, without pm2:
nohup node src/email-worker.js > ~/email-worker.log 2>&1 &
```

---

## 3. After deploying

### Turn on HR staff email — only when you want it

It ships **off** and sends nothing until two separate switches agree.

Add to the API's `.env`:

```
HR_EMAIL_ENABLED=true
```

then restart the API, and turn it on in the HR portal: **Announcements → Email
to staff → Manage → Turn staff email on**. Only the CEO, a Super Admin or the
HR Director sees that panel.

Before switching it on, the panel tells you how many people the next
announcement would reach. Read that number first.

### Chase overdue mandatory training (optional)

A daily cron, if you want it. cPanel → *Cron Jobs*:

```bash
cd ~/api && /usr/bin/node scripts/hr-training-reminders.js >> ~/hr-reminders.log 2>&1
```

It sends nothing while staff email is off.

### Check for leftover test data (reads only, deletes nothing)

```bash
cd ~/api && npm run hr:hygiene
```

It lists records that look like test entries across seventeen HR modules and
says why it suspects each one. Delete the confirmed ones through the HR portal,
which records who removed them.

---

## 4. If something looks wrong

**Roll the API back:**

```bash
cd ~
mv api api-bad-$(date +%F-%H%M)
tar -xzf api-backup-YYYY-MM-DD-HHMM.tar.gz
cd api && npm install --omit=dev
# then restart by whichever method above applies
```

The migrations in this release are additive — they add columns and indexes and
never drop anything — so an older API runs against the migrated database
without complaint. You do not need to reverse them to roll back.

**A front-end package** rolls back the same way any static upload does: extract
the previous zip over it.

**Read the actual error.** The API now says what is wrong on a 5xx instead of
"Unable to complete the request. Please try again." If a screen still shows that
generic sentence, the cause was genuinely unknown to the server, and the log
line carries the `requestId` shown in the response:

```bash
grep "REQUEST_ID_FROM_THE_RESPONSE" ~/api.log
# under pm2:
pm2 logs titopay-api --lines 200 | grep "REQUEST_ID"
```

---

## What is in this release

- HR: data isolation between employees; payroll saves zero and blank amounts;
  one authoritative expense-claim status with no self-approval; records must
  name a real employee; the staff directory no longer hands out salaries and
  bank details; clock-in identifies the person from their session; the audit log
  names who acted.
- HR portal: delete controls for candidates and announcements; "Open resource"
  no longer points at a placeholder; the mobile menu no longer scrolls the page
  behind it; a Staff email panel.
- HR email: work communications through the existing Email Centre, off by
  default, replying to `hr@titopay.co.za` without changing where customer email
  replies go.
- Customer app: "Open Profile" on the ticketing verification notice now closes
  its sheet so the profile is visible.
- Admin: the missing `favicon.ico` that every page was fetching as a 404.
- A 5xx now tells you what went wrong instead of "please try again".
