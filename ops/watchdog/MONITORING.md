# Monitoring & Alerting — Runbook

Build 99 already *knows* when it is unhealthy — `/v1/health` reports the
build, configuration warnings, integrity alerts and a heartbeat for each of
the three workers (email, webhook delivery, settlement sweep). What it could
not do was tell anyone. This runbook adds the push layer, in two parts that
cover each other's blind spot:

1. **The watchdog** (`ops/watchdog/watchdog.js`) — runs on a machine that is
   NOT the production server, polls health every minute, and pushes alerts.
2. **An external uptime probe** (free tier of UptimeRobot / Better Stack /
   Pingdom — any of them) — watches `https://api.titopay.co.za/v1/health`
   from the public internet and covers the case where the watchdog host
   itself dies. Two independent watchers, no shared fate.

## What the watchdog raises

| Check | Severity | Meaning |
|---|---|---|
| API unreachable / non-200 | CRITICAL | customers cannot transact |
| Any worker heartbeat `stalled` | CRITICAL | that queue is not draining (webhooks not delivering, settlements not sweeping, OTP emails not sending) |
| Newest backup older than 26 h | CRITICAL | last night's backup did not run — silence is not success |
| `configWarnings` present | WARN | the running process is telling you its configuration is degraded |
| Webhook dead-letter queue non-empty | WARN | partner deliveries exhausted retries and await replay |
| Settlement batches in discrepancy/failed | WARN | money is parked pending an operator decision |
| Worker `never_ran` | WARN | fresh deployment whose worker has not ticked yet |

Alert hygiene is built in: a standing failure pages **once**, re-pages every
60 minutes while it persists, and sends **one recovery notice** when it
clears — verified live on 22 Aug 2026 (down → single CRITICAL → suppressed →
recovery INFO, transcript in the assurance evidence).

## Setup (15 minutes)

```
# On the watchdog host (any small VM, or the operator's always-on machine):
# /etc/titopay-watchdog.env   (chmod 600)
WATCHDOG_API_URL=https://api.titopay.co.za
WATCHDOG_WEBHOOK_URL=<Slack/Discord/Teams incoming-webhook URL>
# When the watchdog host also mirrors backups (rclone pull), age-check them:
# WATCHDOG_BACKUP_DIR=/var/backups/titopay-mirror

# crontab — MAILTO is the fallback channel when no webhook is configured:
MAILTO=hello@titopay.co.za
* * * * * . /etc/titopay-watchdog.env && node /opt/titopay/ops/watchdog/watchdog.js
```

Then register the external probe: monitor
`https://api.titopay.co.za/v1/health`, keyword `"build"`, 1–5 minute
interval, alert contact the same channel. Do the same for the sandbox API
and the two web front-ends (app/admin) with plain HTTP 200 checks.

## Who gets paged, and what they do

Alerts land in the operations channel and (via MAILTO) the operator inbox.
Every CRITICAL follows `docs/assurance/INCIDENT-RESPONSE.md`: acknowledge,
classify severity, act, record. A page that nobody acknowledges within 15
minutes escalates to phone — which requires the second trained responder
that document establishes.

## What this deliberately is not (yet)

Not metrics/dashboards (Prometheus/Grafana), not log aggregation, not
tracing. Those become worthwhile at the 10,000-merchant stage
(due-diligence Section 8); at the current stage the failure modes that
matter are binary — down, stalled, missed backup, parked money — and this
layer catches all of them with two moving parts an auditor can read in one
sitting.
