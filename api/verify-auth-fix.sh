#!/usr/bin/env bash
# Verifies the auth-failure fix described in INCIDENT-admin-500.md.
#
# Run it before the fix to reproduce the fault, and after to confirm it is gone.
# Read-only: it sends no credentials, creates nothing, and cannot lock an
# account. Every request is either an anonymous GET or a POST with an obviously
# invalid token.
#
#   ./verify-auth-fix.sh                          # against production
#   API=https://staging-api.titopay.co.za ./verify-auth-fix.sh
#
# Exits 0 when everything passes, 1 otherwise — so CI can gate on it.

set -uo pipefail
API="${API:-https://api.titopay.co.za}"
pass=0; fail=0

check() { # check <want> <label> <curl args...>
  local want="$1" label="$2"; shift 2
  local got; got=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000)
  if [ "$got" = "$want" ]; then
    printf '  \033[32mPASS\033[0m  %-44s %s\n' "$label" "$got"; pass=$((pass+1))
  else
    printf '  \033[31mFAIL\033[0m  %-44s got %s, want %s\n' "$label" "$got" "$want"; fail=$((fail+1))
  fi
}

echo "TitoPay auth-failure check — $API"
echo
echo "Baseline (these already pass; they prove the API is up)"
check 200 "GET /health"                     "$API/health"
check 401 "admin endpoint, no token"        "$API/v1/admin/dashboard/overview"

echo
echo "The bug: an invalid token must be 401, never 500"
check 401 "admin endpoint, garbage token"   "$API/v1/admin/dashboard/overview" \
      -H "Authorization: Bearer garbage"
check 401 "admin endpoint, fake JWT shape"  "$API/v1/admin/dashboard/overview" \
      -H "Authorization: Bearer aaa.bbb.ccc"
check 401 "admin endpoint, expired JWT"     "$API/v1/admin/dashboard/overview" \
      -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxNTc3ODM2ODAwfQ.aW52YWxpZHNpZ25hdHVyZQ"
check 401 "app endpoint, garbage token"     "$API/v1/wallets" \
      -H "Authorization: Bearer garbage"

echo
echo "The compounding bug: a bad refresh token must be 401, never 500"
check 401 "POST /v1/auth/refresh, junk token" -X POST "$API/v1/auth/refresh" \
      -H 'Content-Type: application/json' -d '{"refreshToken":"not-a-real-token","scope":"admin"}'
check 401 "POST /v1/auth/refresh, empty body" -X POST "$API/v1/auth/refresh" \
      -H 'Content-Type: application/json' -d '{}'

echo
echo "Unrelated, also live: an endpoint named public requires a token"
check 200 "GET /v1/maintenance/public, no token" "$API/v1/maintenance/public"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mAll %d checks passed.\033[0m The console can refresh and recover on its own.\n' "$pass"
  exit 0
fi
printf '\033[31m%d of %d checks failed.\033[0m See INCIDENT-admin-500.md.\n' "$fail" "$((pass+fail))"
echo "A 500 where 401 is wanted is the admin crash loop: the console only"
echo "refreshes on 401, so a 500 leaves it retrying a dead token forever."
exit 1
