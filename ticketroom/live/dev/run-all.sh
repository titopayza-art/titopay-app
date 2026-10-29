#!/usr/bin/env bash
# Runs every check against one fresh local instance of the live package:
# serves it with serve.sh, runs smoke.js and every suite in tests/, then stops
# the server it started (by PID).
#
#   TR_TEST_ADMIN_PASSWORD=... ticketroom/live/dev/run-all.sh <port> <dir>
#
# smoke.js runs with TR_STRICT=0 unless TR_STRICT is set. Exit code 1 if any
# suite failed.
set -uo pipefail

PORT="${1:?usage: run-all.sh <port> <dir>}"
DIR="${2:?usage: run-all.sh <port> <dir>}"
: "${TR_TEST_ADMIN_PASSWORD:?set TR_TEST_ADMIN_PASSWORD (14+ characters) for the local owner account}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_PATH="${NODE_PATH:-$(cd "$HERE/../.." && pwd)/node_modules}"

TR_DETACH=1 "$HERE/serve.sh" "$PORT" "$DIR" || exit 1
DIR="$(cd "$DIR" && pwd)"
PID="$(cat "$DIR/php.pid")"
trap 'kill "$PID" 2>/dev/null; rm -f "$DIR/php.pid"' EXIT

failed=()
echo "== smoke.js"
TR_STRICT="${TR_STRICT:-0}" node "$HERE/smoke.js" "$DIR" "$PORT" || failed+=("smoke.js")
for suite in "$HERE"/tests/*.js; do
  [ -e "$suite" ] || continue
  echo "== tests/$(basename "$suite")"
  node "$suite" "$DIR" "$PORT" || failed+=("tests/$(basename "$suite")")
done

if [ "${#failed[@]}" -gt 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "All suites passed."
