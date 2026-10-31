#!/usr/bin/env bash
# Nightly backup, encrypted, kept on this server and copied off it.
#   - the database: a consistent mysqldump (no locks, the site keeps running)
#   - ticketroom-data: settings, signing keys and uploads
# Both are packed and encrypted with AES-256 (gpg) using the passphrase in
# /root/.ticketroom-backup. Without the passphrase a backup cannot be read,
# so keep a copy of it somewhere safe off this server.
#
# /root/.ticketroom-backup (chmod 600):
#   BACKUP_PASSPHRASE='a long random phrase'
#   RCLONE_REMOTE='b2:ticketroom-backups'   # optional: any rclone remote (S3, B2, Google Drive...)
set -euo pipefail
SITE=/var/www/ticketroom
OUT=/var/backups/ticketroom
KEEP=14
. /root/.ticketroom-db
[ -f /root/.ticketroom-backup ] || { echo "No /root/.ticketroom-backup: set BACKUP_PASSPHRASE first." >&2; exit 1; }
. /root/.ticketroom-backup
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || { echo "BACKUP_PASSPHRASE must be at least 20 characters." >&2; exit 1; }
mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mysqldump --single-transaction --quick --routines --triggers --hex-blob --no-tablespaces ticketroom | gzip -6 > "$WORK/database.sql.gz"
tar -C "$SITE" -czf "$WORK/ticketroom-data.tar.gz" --exclude='ticketroom-data/backups' ticketroom-data
tar -C "$WORK" -cf - database.sql.gz ticketroom-data.tar.gz \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 -o "$OUT/ticketroom-$STAMP.tar.gpg" 3<<<"$BACKUP_PASSPHRASE"
chmod 600 "$OUT/ticketroom-$STAMP.tar.gpg"
ls -1t "$OUT"/ticketroom-*.tar.gpg | tail -n +$((KEEP + 1)) | xargs -r rm -f
if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$OUT/ticketroom-$STAMP.tar.gpg" "$RCLONE_REMOTE" && echo "$(date -u +%FT%TZ) copied off-site"
else
  echo "$(date -u +%FT%TZ) WARNING: backup kept on this server only. Set RCLONE_REMOTE." >&2
fi
echo "$(date -u +%FT%TZ) backup ticketroom-$STAMP.tar.gpg done"
# Restore: gpg -d ticketroom-STAMP.tar.gpg | tar -x ; gunzip < database.sql.gz | mysql ticketroom
