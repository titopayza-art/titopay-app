#!/usr/bin/env bash
# Serve a fresh local copy of the live package (ticketroom/live/public_html).
#
#   TR_TEST_ADMIN_PASSWORD=... ticketroom/live/dev/serve.sh <port> <dir>
#
# 1. builds a fresh copy with scripts/build-live.js into <dir>/public_html
# 2. creates <dir>/ticketroom-data (outside the served folder, as on the host)
#    with a local config.php: baseUrl http://localhost:<port>, mail "log"
#    (emails are recorded in the message_outbox table, never sent)
# 3. starts `php -S localhost:<port>` with dev/router.php (PID in <dir>/php.pid,
#    log in <dir>/php.log)
# 4. completes the first-owner ceremony: writes ticketroom-data/bootstrap-secret
#    and POSTs /setup.php (owner hello@ticketroom.co.za, password from
#    TR_TEST_ADMIN_PASSWORD)
# 5. seeds test data with dev/seed.js (organiser, customer, events, sandbox
#    payments); the accounts are written to <dir>/seed.json
#
# The server keeps running in the foreground; Ctrl-C stops it. With
# TR_DETACH=1 the script returns once seeding is done and leaves the server
# running: stop it with `kill $(cat <dir>/php.pid)`.
# TR_NO_SEED=1 skips step 5.
set -euo pipefail

PORT="${1:?usage: serve.sh <port> <dir>}"
DIR="${2:?usage: serve.sh <port> <dir>}"
: "${TR_TEST_ADMIN_PASSWORD:?set TR_TEST_ADMIN_PASSWORD (14+ characters) for the local owner account}"
if [ "${#TR_TEST_ADMIN_PASSWORD}" -lt 14 ]; then echo "TR_TEST_ADMIN_PASSWORD must be at least 14 characters" >&2; exit 1; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TR="$(cd "$HERE/../.." && pwd)"          # ticketroom/
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
BASE="http://localhost:$PORT"

if [ -f "$DIR/php.pid" ] && kill -0 "$(cat "$DIR/php.pid")" 2>/dev/null; then
  echo "A server from an earlier run is still running (PID $(cat "$DIR/php.pid")). Stop it first." >&2; exit 1
fi

# 1. Fresh build
node "$TR/scripts/build-live.js" >/dev/null
rm -rf "$DIR/public_html" "$DIR/ticketroom-data"
cp -a "$TR/var/live-build/public_html" "$DIR/public_html"
echo "Built $(cat "$DIR/public_html/version.txt") into $DIR/public_html"

# 2. Data folder (next to public_html: tr_data_dir() looks for ../ticketroom-data)
DATA="$DIR/ticketroom-data"
mkdir -p "$DATA"
chmod 750 "$DATA"
# TR_DB=mysql: a fresh MariaDB/MySQL database tr_<port> on this machine
# (its own user tr_<port>, local only) instead of SQLite.
DB_BLOCK=""
if [ "${TR_DB:-sqlite}" = "mysql" ]; then
  DBNAME="tr_$PORT"
  DBPASS="local-test-$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  mariadb -uroot -e "DROP DATABASE IF EXISTS $DBNAME; CREATE DATABASE $DBNAME CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
    CREATE USER IF NOT EXISTS '$DBNAME'@'localhost'; ALTER USER '$DBNAME'@'localhost' IDENTIFIED BY '$DBPASS';
    GRANT ALL ON \`$DBNAME\`.* TO '$DBNAME'@'localhost'; GRANT PROCESS ON *.* TO '$DBNAME'@'localhost';"
  DB_BLOCK="'database' => ['driver' => 'mysql', 'socket' => '/run/mysqld/mysqld.sock', 'name' => '$DBNAME', 'user' => '$DBNAME', 'pass' => '$DBPASS'],"
  echo "Using MySQL database $DBNAME"
fi
write_config() { # $1 = baseUrl
  cat > "$DATA/config.php" <<PHP
<?php
// Local test settings written by ticketroom/live/dev/serve.sh.
return [
    'baseUrl' => '$1',
    'mail' => ['mode' => 'log', 'smtpPass' => ''],
    'anthropicApiKey' => '',
    $DB_BLOCK
];
PHP
  chmod 600 "$DATA/config.php"
}
# setup.php insists on an https base URL and an https Origin for its POST.
write_config "https://localhost:$PORT"

# 3. Serve
php -S "localhost:$PORT" -t "$DIR/public_html" "$HERE/router.php" >"$DIR/php.log" 2>&1 &
PID=$!
echo "$PID" > "$DIR/php.pid"
stop() { kill "$PID" 2>/dev/null || true; rm -f "$DIR/php.pid"; }
trap 'stop' INT TERM
for _ in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/version.txt" && break
  sleep 0.2
done

# 4. First-owner ceremony
SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
printf '%s\n' "$SECRET" > "$DATA/bootstrap-secret"
chmod 600 "$DATA/bootstrap-secret"
CODE="$(curl -s -o "$DIR/setup.out.html" -w '%{http_code}' "$BASE/setup.php" \
  -H "Origin: https://localhost:$PORT" \
  --data-urlencode "secret=$SECRET" \
  --data-urlencode "name=TicketRoom Admin" \
  --data-urlencode "email=hello@ticketroom.co.za" \
  --data-urlencode "password=$TR_TEST_ADMIN_PASSWORD" \
  --data-urlencode "confirm=$TR_TEST_ADMIN_PASSWORD")"
if [ "$CODE" != "200" ] || ! grep -q 'Owner account created' "$DIR/setup.out.html"; then
  echo "First-owner setup failed (HTTP $CODE):" >&2; sed -e 's/<[^>]*>//g' "$DIR/setup.out.html" | grep -v '^\s*$' | head -20 >&2; stop; exit 1
fi
rm -f "$DIR/setup.out.html"
[ ! -f "$DATA/bootstrap-secret" ] || { echo "bootstrap-secret was not removed by setup.php" >&2; stop; exit 1; }
echo "Owner hello@ticketroom.co.za created by /setup.php"
# The browser talks to http://localhost:<port>; the API's same-origin check compares against baseUrl.
write_config "$BASE"

# 5. Seed
if [ "${TR_NO_SEED:-}" != "1" ]; then
  TR_BASE="$BASE" TR_DATA="$DATA" node "$HERE/seed.js" > "$DIR/seed.json" || { echo "Seeding failed" >&2; stop; exit 1; }
  echo "Seeded test data: $DIR/seed.json"
fi

echo "Serving $BASE (PID $PID, log $DIR/php.log)"
if [ "${TR_DETACH:-}" = "1" ]; then
  trap - INT TERM
  echo "Stop with: kill $PID"
  exit 0
fi
wait "$PID"
