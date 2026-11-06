#!/usr/bin/env bash
# Runs every live-package test on a fresh local instance:
#   1. serve.sh builds, sets up and seeds a new copy (detached)
#   2. smoke.js (known live issues reported, not failed, unless TR_STRICT=1)
#   3. every suite in tests/*.js, in name order
#   4. stops the server it started (by its PID) and exits non-zero if
#      anything failed
#
#   TR_TEST_ADMIN_PASSWORD=... ticketroom/live/dev/run-all.sh [port] [dir]
#   (or: cd ticketroom && npm run test:live)
#
# Playwright comes from ticketroom/node_modules (set NODE_PATH if elsewhere).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8640}"
DIR="${2:-$(mktemp -d "${TMPDIR:-/tmp}/tr-live-XXXXXX")}"
: "${TR_TEST_ADMIN_PASSWORD:?set TR_TEST_ADMIN_PASSWORD (14+ characters) for the local owner account}"
export NODE_PATH="${NODE_PATH:-$(cd "$HERE/../.." && pwd)/node_modules}"

TR_DETACH=1 "$HERE/serve.sh" "$PORT" "$DIR" || { echo "serve.sh failed" >&2; exit 1; }
PID="$(cat "$DIR/php.pid")"
stop() { kill "$PID" 2>/dev/null || true; rm -f "$DIR/php.pid"; }
trap stop EXIT INT TERM

failed=()
echo "== smoke.js"
TR_STRICT="${TR_STRICT:-0}" node "$HERE/smoke.js" "$DIR" "$PORT" || failed+=("smoke.js")
for t in "$HERE"/tests/*.js; do
  [ -e "$t" ] || continue
  # Every suite signs in from the same address; start each one with empty
  # rate-limit counters so one suite's sign-ins do not throttle the next.
  php "$HERE/dbq.php" "$DIR/ticketroom-data" "DELETE FROM rate_limits" >/dev/null || true
  echo "== tests/$(basename "$t")"
  node "$t" "$DIR" "$PORT" || failed+=("tests/$(basename "$t")")
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "All live suites passed."
