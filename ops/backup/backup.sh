#!/usr/bin/env bash
# TitoPay database backup - encrypted, verified, rotated.
#
# What one run produces, in $BACKUP_DIR:
#   titopay-YYYYMMDD-HHMMSS.dump.enc   the backup (pg_dump custom format,
#                                      AES-256-CBC via openssl, PBKDF2)
#   titopay-YYYYMMDD-HHMMSS.sha256     checksum of the ENCRYPTED file, so
#                                      transport corruption is detectable
#                                      without the key
#   backup.log                         appended one line per run, pass or fail
#
# Required environment (put these in /etc/titopay-backup.env, chmod 600,
# and source it from the cron entry - NEVER inline the key in crontab):
#   POSTGRES_URL            the same connection string the API uses
#   BACKUP_ENCRYPTION_KEY   long random passphrase; losing it loses every
#                           backup, so store it in TWO places neither of
#                           which is this server (e.g. the operator password
#                           manager AND a sealed envelope)
# Optional:
#   BACKUP_DIR              default /var/backups/titopay
#   BACKUP_KEEP_DAYS        default 35 (POPIA: backups are personal data;
#                           rotation is a compliance duty, not housekeeping)
#   BACKUP_REMOTE           an rclone remote:path (e.g. b2:titopay-backups).
#                           When set, the encrypted file + checksum are
#                           copied OFF this machine - a backup that lives
#                           only on the server it protects is not a backup.
#
# Cron (02:15 daily, SA time):
#   15 2 * * * . /etc/titopay-backup.env && /path/to/ops/backup/backup.sh
#
# The dump is taken with pg_dump, which never blocks the running API.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/titopay}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/titopay-$STAMP.dump.enc"
LOG="$BACKUP_DIR/backup.log"

fail() {
  echo "$(date -Is) FAIL $1" >> "$LOG" 2>/dev/null || true
  echo "backup FAILED: $1" >&2
  exit 1
}

[ -n "${POSTGRES_URL:-}" ] || fail "POSTGRES_URL is not set"
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || fail "BACKUP_ENCRYPTION_KEY is not set"
mkdir -p "$BACKUP_DIR" || fail "cannot create $BACKUP_DIR"

# Dump straight through openssl so the plaintext never touches disk.
if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges \
      --dbname="$POSTGRES_URL" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass env:BACKUP_ENCRYPTION_KEY -out "$OUT"; then
  rm -f "$OUT"
  fail "pg_dump or encryption failed"
fi

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
# An empty or tiny file is a failed backup that exited zero somewhere.
[ "$SIZE" -gt 100000 ] || { rm -f "$OUT"; fail "dump implausibly small ($SIZE bytes)"; }

sha256sum "$OUT" > "$OUT.sha256" 2>/dev/null || shasum -a 256 "$OUT" > "$OUT.sha256"

# Verify the encrypted artifact is decryptable and is a valid archive,
# WITHOUT restoring it: pg_restore --list reads the whole table of contents.
# pg_restore cannot --list a custom-format archive from a pipe, so decrypt
# to a transient owner-only temp file and remove it immediately.
VERIFY_TMP="$(umask 077 && mktemp "$BACKUP_DIR/.verify-XXXXXX")"
trap 'rm -f "$VERIFY_TMP"' EXIT
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -pass env:BACKUP_ENCRYPTION_KEY -in "$OUT" -out "$VERIFY_TMP" \
    || ! pg_restore --list "$VERIFY_TMP" > /dev/null; then
  fail "verification failed - the file written is not a restorable backup"
fi
rm -f "$VERIFY_TMP"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_REMOTE" && rclone copy "$OUT.sha256" "$BACKUP_REMOTE" \
    || fail "off-site copy to $BACKUP_REMOTE failed (local backup kept)"
fi

# Rotate, locally and (if configured) remotely.
find "$BACKUP_DIR" -name "titopay-*.dump.enc*" -mtime "+$KEEP_DAYS" -delete || true
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone delete --min-age "${KEEP_DAYS}d" "$BACKUP_REMOTE" || true
fi

echo "$(date -Is) OK $OUT ($SIZE bytes)$( [ -n "${BACKUP_REMOTE:-}" ] && echo " offsite=$BACKUP_REMOTE")" >> "$LOG"
echo "backup OK: $OUT"
