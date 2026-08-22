# Incident Response Procedure

TitoPay has already run a real incident end-to-end — detected, diagnosed,
fixed, structurally prevented, and permanently documented (20 August 2026,
below). What it had not done is write the procedure down so that a second
responder, an auditor, or a sponsor bank can see that the response was
process rather than heroics. This document is that procedure. It is scaled
to a small operator honestly: it names two people, not a fictional NOC.

## 1. Severity classification

Classify FIRST, before diagnosing. Severity decides who is woken and what is
said publicly, and it can be revised as facts arrive.

| Severity | Definition | Examples | Response clock |
|---|---|---|---|
| **SEV-1** | Money is wrong, moving wrongly, or customers cannot transact at all | ledger discrepancy alert; duplicate credit suspicion; API down; database lost; credential compromise | acknowledge ≤ 15 min, act immediately, all else stops |
| **SEV-2** | A core function is degraded but money is correct | webhook delivery stalled; settlement sweep failed; OTP emails not sending; one provider (Peach) down | acknowledge ≤ 1 h, fix same day |
| **SEV-3** | Annoying, contained, not money | one merchant's report wrong; a screen broken on one device class; backup ran late once | next business day |
| **SEV-4** | Cosmetic or informational | copy errors, non-blocking warnings | backlog |

**One rule overrides the table: anything touching wallet balances, the
ledger, or settlement totals is SEV-1 until PROVEN otherwise** — the
money-integrity sweep and the settlement reconciliation checks are the
proving tools, and "the numbers look fine" is not proof.

## 2. Roles

| Role | Holder | Duty |
|---|---|---|
| Incident Lead | Operator (primary) | owns the incident, decides actions, keeps the timeline |
| Second Responder | Named deputy — **appointing this person is itself a due-diligence precondition** | can independently: read the runbooks, restart the API, run the restore procedure, and reach every credential via the shared vault |
| Communications | Incident Lead (delegable) | customer/merchant/partner notices per §5 |

Both responders hold: access to the operator password manager, the server,
`/etc/titopay-backup.env` custody knowledge, this repository, and the
alerting channel. An incident only one living person can respond to is a
governance finding, not a staffing detail.

## 3. Response sequence

1. **Acknowledge** the alert in the operations channel ("ack, looking").
   Unacknowledged CRITICALs escalate to phone at 15 minutes.
2. **Classify** severity (§1). Write the first timeline line: time, alert,
   classification.
3. **Stabilise before diagnosing.** The platform provides levers that stop
   harm without destroying evidence, in escalating order: pause a webhook
   subscription; suspend a partner (kills all their keys); disable a
   terminal; lock a profile; put the platform's provider integrations into
   their documented off states. Prefer the narrowest lever that stops the
   bleeding.
4. **Diagnose from the platform's own instruments** — `/v1/health`
   (configWarnings, worker heartbeats, build number), the admin console
   diagnostics endpoint, `settlement_batches.discrepancy`, the
   money-integrity exception queue, `webhook_deliveries.attempt_log`,
   `audit_logs`. The 20 Aug incident taught that the answer is usually
   already being reported by something.
5. **Fix forward or roll back.** Rollback = redeploy the previous build's
   zip (every build is additive by policy; build notes state per build that
   tables are inert). Database restore per `ops/backup/BACKUP-AND-RESTORE.md`
   is the last resort and is rehearsed, not improvised.
6. **Verify** the way the platform always verifies: run the relevant smoke
   (vendor journey, settlement close), check `/v1/health`, confirm the
   integrity sweep is clean.
7. **Communicate** (§5), **then** write the post-incident review (§6).

## 4. Credential compromise (special case, always SEV-1)

Any suspicion that a secret left custody — server breach, leaked env file,
departed contractor: rotate in this order, which the platform supports
without downtime for (a)–(c): (a) partner API keys (revoke + reissue, 24 h
grace exists but SKIP grace on compromise), (b) webhook subscription secrets
(built-in dual-signature 24 h overlap), (c) terminal secrets (re-register
terminals), (d) JWT secrets + `EMAIL_ENCRYPTION_KEY`/`INTEGRATION_ENCRYPTION_KEY`
— **follow the pinned-key procedure in the build-79–81 notes exactly; this
specific rotation caused the 20 Aug outage when done casually**, (e)
database password, (f) `BACKUP_ENCRYPTION_KEY` (new key forward; old key
retained sealed until its backups age out). Then: audit `audit_logs` and
`api_partner_usage` for the exposure window, and notify affected parties
per §5 and, where personal data is implicated, the Information Regulator
per POPIA section 22 within the required timeframe.

## 5. Communication templates

Honesty discipline: state what is known, what is not, and the next update
time. Never speculate about cause in public; never say "sophisticated
attack"; never let the next-update time pass silently.

- **Merchants (SEV-1 availability):** "TitoPay payments are currently
  unavailable. Your funds and history are safe. We are working on it now;
  next update by HH:MM. Do not re-run payments that showed an error — check
  Sales history first."
- **Partners (webhook impact):** "Webhook deliveries are delayed since
  HH:MM. No events are lost — deliveries retry automatically and can be
  replayed. Reconcile via GET /v1/pos/payment-intents/{id} meanwhile."
- **Customers (money-shaped SEV-1, after stabilisation):** plain-language
  statement of impact, what TitoPay did, and per-account correction detail
  where balances were touched.
- **Sponsor bank / key partners (once such relationships exist):** SEV-1
  notification within 4 hours with facts + next-update cadence; written
  post-incident review within 5 business days.

## 6. Post-incident review (blameless, written, filed)

Within 5 business days, one page in `docs/assurance/incidents/`:
timeline · impact (who, how much, how long) · root cause (a mechanism, not
a person) · what stopped it · what structurally prevents recurrence · the
prevention's proof (a test, a guard, a refusal at boot). The build notes
show the house style — see build 81's "NEVER AGAIN, MADE STRUCTURAL".

## 7. Worked example — the 20 August 2026 incident, restated in this format

- **Timeline:** routine JWT refresh-secret rotation → every stored email
  credential silently undecryptable → SMTP sends failing
  (`Missing credentials for "PLAIN"`) → admin OTP emails not delivered →
  operator locked out of console. Detected by the operator; diagnosed the
  same day.
- **Severity:** SEV-1 (operator lockout = no admin control plane).
- **Root cause:** encryption keys for stored credentials derived from a
  rotatable JWT secret, in five copy-pasted sites; rotation was designed as
  safe and was not.
- **Fix:** pin `EMAIL_ENCRYPTION_KEY` to the pre-rotation value (recovery),
  then centralise all key derivation in one module with pinned keys ahead
  of any JWT fallback (builds 79–81).
- **Structural prevention:** a grep-shaped test now FAILS THE BUILD if any
  file derives a key from a JWT secret again; the preflight names the
  coupling; the deploy script prints the health proof.
- **What this document adds:** the same event under this procedure would
  have paged a second responder at minute 15 and produced this review as a
  matter of course rather than as build-note archaeology.
