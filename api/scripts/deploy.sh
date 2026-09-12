#!/bin/bash
# ONE COMMAND, THE RIGHT DIRECTORY, EVERY STEP, EVERY TIME.
#
#     bash scripts/deploy.sh              # deploys ~/api.zip
#     bash scripts/deploy.sh /path/to/api.zip
#
# Written after 20 August 2026, when every deploy was hand-typed and the day's
# failures were mostly the hands: builds extracted into /root instead of the
# app directory, database scripts run from shells that could not see the
# configuration, the email worker left running six-day-old code because only
# the API was restarted, and a health check curled into the two-second restart
# window and read as an outage.
#
# This script closes each of those: it asks pm2 itself where the app lives and
# refuses to guess, deploys there no matter where it was invoked from,
# restarts BOTH processes, waits out the restart window, and ends by printing
# the health line whose build number is the proof.
#
# The whole body is a function so that overwriting this very file mid-run
# (the zip contains it) cannot corrupt the execution.

deploy_main() {
  set -euo pipefail

  local zip="${1:-$HOME/api.zip}"
  if [ ! -f "$zip" ]; then
    echo "No zip found at $zip"
    echo "Usage: bash scripts/deploy.sh [/path/to/api.zip]"
    return 1
  fi

  # The app directory according to the process manager, not according to
  # whichever shell this is. pm2 knows where it runs the API from.
  local appdir
  appdir=$(pm2 jlist 2>/dev/null | node -e "
    const l = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const p = l.find((x) => x.name === 'titopay-api');
    if (!p) process.exit(1);
    const s = p.pm2_env.pm_exec_path || '';
    console.log(s.includes('/src/server.js') ? s.replace(/\/src\/server\.js$/, '') : p.pm2_env.pm_cwd);
  ") || { echo "pm2 does not know an app called titopay-api. Is pm2 running?"; return 1; }

  echo "App directory (from pm2): $appdir"
  cd "$appdir"

  if [ ! -f .env ]; then
    echo "WARNING: no .env in $appdir - the API will boot with warnings. Continuing."
  fi

  # Optional integrity check. If a checksum sidecar sits next to the zip
  # (api.zip.sha256), the archive must match it before we extract — so a
  # truncated or tampered upload is caught, not unzipped over a running API.
  # No sidecar means no check: existing deploys are unaffected.
  if [ -f "${zip}.sha256" ]; then
    echo "== verifying integrity (${zip}.sha256) =="
    expected=$(awk '{print $1}' "${zip}.sha256")
    actual=$(sha256sum "$zip" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
      echo "ABORT: $zip does not match its checksum. Not extracting."
      echo "  expected $expected"
      echo "  actual   $actual"
      return 1
    fi
    echo "integrity OK"
  fi

  echo "== extracting $zip =="
  unzip -o -q "$zip"

  echo "== dependencies =="
  npm i --omit=dev

  echo "== database migrations =="
  npm run db:apply-migrations

  echo "== preflight (advisory since build 74: problems cannot cause a 502) =="
  node preflight.js || echo "Preflight reported problems above. The API will still start; fix them when calm."

  echo "== restarting ALL TitoPay processes =="
  # Restart every pm2 app, not just api + email-worker. The ecosystem also runs
  # titopay-chat (live chat sockets) and may run a standalone webhook worker;
  # restarting only two left those on the PREVIOUS build after every deploy -
  # the exact "worker stuck on old code" failure the build stamps exist to catch.
  # Named restarts first (so a missing name is a clear error), then a sweep for
  # anything else pm2 is running.
  pm2 restart titopay-api --update-env
  pm2 restart titopay-email-worker --update-env
  pm2 restart titopay-chat --update-env 2>/dev/null || echo "  (no titopay-chat app registered; skipping)"
  pm2 restart all --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null

  echo "== waiting out the restart window =="
  sleep 6

  echo "== the proof =="
  curl -sS https://api.titopay.co.za/v1/health || echo "(health request failed - wait five seconds and curl it again)"
  echo
  echo "Check the build number above matches the release you just extracted."
}

deploy_main "$@"
