#!/usr/bin/env bash
# TitoPay database restore - into a NAMED TARGET DATABASE, never blindly
# over production.
#
#   ops/backup/restore.sh <backup-file.dump.enc> <target-postgres-url>
#
# Rules this script enforces:
#   - the checksum file next to the backup must verify, when present
#   - the target database must be EMPTY (no tables) unless FORCE_RESTORE=1
#     is set, so a typo cannot overwrite the live database
#   - the decrypted stream goes straight into pg_restore; plaintext never
#     touches disk
#
# For the quarterly rehearsal (see BACKUP-AND-RESTORE.md) the target is a
# scratch database; for a real disaster it is the newly provisioned empty
# production database. Either way the procedure is IDENTICAL - that is the
# point of rehearsing it.
#
# Requires: BACKUP_ENCRYPTION_KEY in the environment.
set -euo pipefail

FILE="${1:-}"
TARGET_URL="${2:-}"
[ -n "$FILE" ] && [ -n "$TARGET_URL" ] || { echo "usage: restore.sh <backup.dump.enc> <target-postgres-url>" >&2; exit 2; }
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 2; }
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || { echo "BACKUP_ENCRYPTION_KEY is not set" >&2; exit 2; }

if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && { sha256sum -c "$(basename "$FILE").sha256" 2>/dev/null \
    || shasum -a 256 -c "$(basename "$FILE").sha256"; }) \
    || { echo "checksum verification FAILED - do not restore this file" >&2; exit 1; }
  echo "checksum verified"
else
  echo "warning: no .sha256 beside the backup; continuing without transport verification" >&2
fi

TABLE_COUNT=$(psql "$TARGET_URL" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "$TABLE_COUNT" != "0" ] && [ "${FORCE_RESTORE:-0}" != "1" ]; then
  echo "target database is not empty ($TABLE_COUNT tables). Refusing." >&2
  echo "Restore into a fresh database, or set FORCE_RESTORE=1 if you are" >&2
  echo "certain this target should be overwritten." >&2
  exit 1
fi

echo "restoring $FILE -> target ..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BACKUP_ENCRYPTION_KEY -in "$FILE" \
  | pg_restore --no-owner --no-privileges --dbname="$TARGET_URL" ${FORCE_RESTORE:+--clean --if-exists}

echo "restore complete. Now run the verification block from BACKUP-AND-RESTORE.md:"
echo "  - table count matches expectation"
echo "  - wallet_ledger double-entry invariant holds"
echo "  - the API boots against the restored database and /v1/health answers"
