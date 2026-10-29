#!/usr/bin/env bash
# Serves a fresh copy of the live package, runs the smoke test and every suite
# in dev/tests/, then stops the server it started (by PID only).
#
#   TR_TEST_ADMIN_PASSWORD=... ticketroom/live/dev/run-all.sh [port] [dir]
#
# Defaults: port 8640, dir a new temporary folder. TR_STRICT is passed on to
# smoke.js (0 unless set). Exits non-zero if anything failed.
set -uo pipefail

PORT="${1:-8640}"
DIR="${2:-$(mktemp -d "${TMPDIR:-/tmp}/tr-live-XXXXXX")}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TR_TEST_ADMIN_PASSWORD:?set TR_TEST_ADMIN_PASSWORD (14+ characters) for the local owner account}"
export NODE_PATH="${NODE_PATH:-$(cd "$HERE/../.." && pwd)/node_modules}"

stop() { if [ -f "$DIR/php.pid" ]; then kill "$(cat "$DIR/php.pid")" 2>/dev/null || true; rm -f "$DIR/php.pid"; fi; }
trap stop EXIT INT TERM

TR_DETACH=1 "$HERE/serve.sh" "$PORT" "$DIR" || { echo "serve.sh failed" >&2; exit 1; }

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
