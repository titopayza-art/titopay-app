# Restore Rehearsal — 22 August 2026 (first on record)

This is the evidence file the due-diligence review said did not exist: a
timed, verified, end-to-end rehearsal of the backup and restore procedure in
`ops/backup/BACKUP-AND-RESTORE.md`, ending with the TitoPay API serving from
the restored database. Every number below is transcribed from the actual
run, not projected.

**Environment note (stated for honesty):** this rehearsal ran against the
integration database (build 99 schema, 199 tables, ~2,900 users, 4,959
ledger rows). Production timings will scale with data volume; the
*procedure* — the thing being rehearsed — is identical, and the next
rehearsal is due against production-scale data within the quarter.

## 1. Backup

| | |
|---|---|
| Started | 2026-08-22 10:08:44 UTC |
| Command | `ops/backup/backup.sh` (pg_dump custom format → AES-256-CBC/PBKDF2, plaintext never on disk) |
| Duration | **2.05 s** |
| Artifact | `titopay-20260822-100844.dump.enc` — 16,405,104 bytes |
| SHA-256 | `e0c491e8f949e5b824acc891c334e6d99eb456ebd5386d4912a98201577ca952` |
| Self-verification | decrypted stream listed by `pg_restore --list` (1,313 TOC entries) — PASS |
| Log line | `2026-08-22T10:08:46+00:00 OK … (16405104 bytes)` appended to `backup.log` |

A deliberately broken first draft of the verification step (piping a
custom-format archive into `pg_restore --list`, which it cannot read from a
pipe) **failed loudly and refused to report success** — recorded here
because a backup script whose failure path has been seen working is worth
more than one that has only ever succeeded.

## 2. Restore

| | |
|---|---|
| Target | freshly created empty database `titopay_restore` |
| Checksum gate | `.sha256` verified: **OK** before any decryption |
| Empty-target gate | confirmed 0 tables (the script refuses a non-empty target without `FORCE_RESTORE=1`) |
| Command | `ops/backup/restore.sh <file> <target-url>` |
| Duration | **5.09 s** |

## 3. Verification block (source vs restored, same queries)

| Check | Source `titopay` | Restored `titopay_restore` | Match |
|---|---|---|---|
| Tables in schema `public` | 199 | 199 | ✔ |
| `users` rows | 2,917 | 2,917 | ✔ |
| `wallets` rows | 2,385 | 2,385 | ✔ |
| `transactions` rows | 2,630 | 2,630 | ✔ |
| `wallet_ledger` rows | 4,959 | 4,959 | ✔ |
| `settlement_batches` rows | 113 | 113 | ✔ |
| Σ `available_balance` | R 61,114,700.52 | R 61,114,700.52 | ✔ to the cent |
| Σ `reserved_balance` | R 0.00 | R 0.00 | ✔ |
| Newest ledger entry | 2026-08-22 09:31:10.712 UTC | 2026-08-22 09:31:10.712 UTC | ✔ |

## 4. Application-level proof

The API (build 99) was started against the restored database on a separate
port and answered:

```
GET /v1/health →
  build 99 | status ok | configWarnings 0 | webhookWorker ready
```

A restore that psql accepts but the application cannot serve from is not a
restore; this one serves.

## 5. Timings vs objectives

| Objective | Target | This rehearsal |
|---|---|---|
| RTO (technical restore path) | 4 h | backup-to-serving in **under 30 s** at this data volume; the 4 h budget is for server provisioning and DNS in a true disaster |
| RPO | 24 h | newest ledger entry was 37 minutes old at dump time |

## 6. Follow-ups this rehearsal created

1. Production must adopt the cron + `BACKUP_REMOTE` off-site configuration
   from the runbook — this rehearsal proves the mechanism, not the schedule.
2. Next rehearsal: within 90 days (by **20 November 2026**), from the
   off-site copy, on a machine that is not the production server.
3. The watchdog (`ops/watchdog/`) alerts when the newest backup is older
   than 26 hours — silence is not success.
