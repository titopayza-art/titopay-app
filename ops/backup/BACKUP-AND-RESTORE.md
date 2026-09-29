# Backup & Restore — Runbook and Evidence Standard

The database is the company. Wallet balances, the ledger, FICA records,
settlement statements — all of it lives in one PostgreSQL database, and until
this runbook existed there was no documented way to get it back. A backup
that has never been restored is a hope, not a control, so this runbook
defines both the schedule **and the rehearsal that turns the schedule into
evidence** a bank can read.

## Objectives (state these numbers, don't imply them)

| Objective | Target | How it is met |
|---|---|---|
| RPO (max data loss) | 24 hours | daily encrypted `pg_dump` at 02:15 SAST via cron |
| RTO (max time to serve again) | 4 hours | rehearsed restore procedure below; the rehearsal log records the actual time |
| Retention | 35 days | rotation inside `backup.sh`, local and off-site |
| Off-site copy | every run | `BACKUP_REMOTE` (rclone to object storage in a second facility) |
| Restore rehearsal | quarterly, minimum | evidence file per rehearsal in `docs/assurance/` |

An RPO of 24h is honest for the current stage. When merchant volume makes a
day of loss unacceptable, add WAL archiving (`archive_command` to the same
off-site remote) on top of this scheme — the daily dump remains the
foundation either way.

## The three rules

1. **Encrypted always.** Dumps hold identity data and balances. `backup.sh`
   pipes `pg_dump` straight through `openssl` (AES-256-CBC, PBKDF2, 200k
   iterations); plaintext never touches disk.
2. **Off the machine.** A backup on the server it protects shares every fate
   with it. `BACKUP_REMOTE` is not optional in production.
3. **The key is not beside the lock.** `BACKUP_ENCRYPTION_KEY` lives in the
   operator's password manager AND one sealed offline copy — never in the
   repository, never only on the server. Losing the key loses every backup;
   treat its custody like the JWT secrets.

## Daily backup (automated)

```
# /etc/titopay-backup.env   (chmod 600, root-owned)
POSTGRES_URL=postgres://...
BACKUP_ENCRYPTION_KEY=<long random passphrase>
BACKUP_DIR=/var/backups/titopay
BACKUP_REMOTE=b2:titopay-backups        # any rclone remote

# crontab
15 2 * * * . /etc/titopay-backup.env && /home/titopay/ops/backup/backup.sh
```

Every run self-verifies (`pg_restore --list` over the decrypted stream) and
appends one line to `backup.log`. **The watchdog checks the age of the
newest backup** (see `ops/watchdog/`); a missed night pages the operator —
silence is not success.

## Restore (rehearsal and disaster are the same procedure)

```
. /etc/titopay-backup.env
createdb -h <host> titopay_restore          # fresh, empty target
ops/backup/restore.sh /var/backups/titopay/titopay-<stamp>.dump.enc \
    "postgres://.../titopay_restore"
```

`restore.sh` refuses a non-empty target unless `FORCE_RESTORE=1`, so the
rehearsal can never clobber production by typo.

### Verification block (record ALL of it in the evidence file)

```sql
-- 1. Structural: table count matches the source
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';

-- 2. Volume: row counts on the money tables match the source at dump time
SELECT (SELECT COUNT(*) FROM users)          AS users,
       (SELECT COUNT(*) FROM wallets)        AS wallets,
       (SELECT COUNT(*) FROM transactions)   AS transactions,
       (SELECT COUNT(*) FROM wallet_ledger)  AS ledger_rows,
       (SELECT COUNT(*) FROM settlement_batches) AS settlements;

-- 3. Value: total customer float matches the source to the cent
SELECT SUM(available_balance) AS total_available,
       SUM(reserved_balance)  AS total_reserved FROM wallets;

-- 4. Recency: the newest ledger entry is inside the RPO window
SELECT MAX(created_at) FROM wallet_ledger;
```

Then the proof that matters to a bank: **boot the API against the restored
database** and read `/v1/health` — build number, no unexpected
configWarnings. A restore that psql likes but the application cannot serve
from is not a restore.

### Disaster sequencing (server lost entirely)

1. Provision server (or use standby), install Node + PostgreSQL, create
   empty database. 2. Pull newest `.dump.enc` + `.sha256` from
   `BACKUP_REMOTE`. 3. `restore.sh` as above. 4. Deploy the current
   `api.zip`, point `POSTGRES_URL` at the restored database, restore the
   environment file from the operator password manager. 5. `node
   preflight.js`, start, verify `/v1/health`. 6. Rotate any secret whose
   custody the incident put in doubt, per `docs/assurance/INCIDENT-RESPONSE.md`.

## Evidence

Each rehearsal produces `docs/assurance/RESTORE-REHEARSAL-<date>.md`
containing the timed transcript of the whole procedure and the verification
block's output. The first such rehearsal (22 Aug 2026) is in that directory
now; it is the file to show a due-diligence reviewer, and its existence — not
this runbook — is what closes the DR finding.
