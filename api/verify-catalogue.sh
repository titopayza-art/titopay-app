#!/usr/bin/env bash
# Verifies the service catalogue corrections landed (APPLY.md stage 1).
#
# Checks the LIVE catalogue over HTTP, so it needs no database access and
# proves what the app will actually receive — not what the table says.
#
#   ./verify-catalogue.sh
#   API=https://staging-api.titopay.co.za ./verify-catalogue.sh
#
# Exits 0 when all eight rows are correct, 1 otherwise.

set -uo pipefail
API="${API:-https://api.titopay.co.za}"

body=$(curl -sS --max-time 25 "$API/v1/services?audience=all" 2>/dev/null) || {
  echo "Could not reach $API/v1/services"; exit 1; }

echo "TitoPay catalogue check — $API"
echo

printf '%s' "$body" | python3 -c '
import json,sys
try:
    items=json.load(sys.stdin).get("items",[])
except Exception:
    print("  Response was not JSON — is the endpoint up?"); sys.exit(1)
by={i.get("service_code"):i for i in items}
want=[("stockvel","personal_visible",False,"Stokvel hidden until it has a ledger"),
      ("bill-split","business_visible",False,"Bill Split off business"),
      ("withdraw","business_visible",False,"Withdraw off business (use Payouts)"),
      ("send-gift","business_visible",True,"Send Gift on business"),
      ("tickets","business_visible",True,"Tickets on business"),
      ("airtime","personal_visible",False,"Airtime hidden (airtime-data only)"),
      ("data","personal_visible",False,"Data hidden (airtime-data only)")]
G,R,Z="\033[32m","\033[31m","\033[0m"
bad=0
for code,field,exp,label in want:
    row=by.get(code)
    if row is None:
        print(f"  {R}FAIL{Z}  {label:44} row missing"); bad+=1; continue
    got=row.get(field)
    if got==exp: print(f"  {G}PASS{Z}  {label:44} {field}={got}")
    else:        print(f"  {R}FAIL{Z}  {label:44} {field}={got}, want {exp}"); bad+=1
d=(by.get("payment-request") or {}).get("description","")
label="payment-request copy"
if "customer" in d.lower():
    print(f"  {R}FAIL{Z}  {label:44} still says customer"); bad+=1
else:
    print(f"  {G}PASS{Z}  {label:44}")
print()
if bad:
    print(f"{R}{bad} of 8 still wrong.{Z} Run: psql \"$DATABASE_URL\" -f catalogue/catalogue-fix.sql")
    if (by.get("stockvel") or {}).get("personal_visible"):
        print("Stokvel is live to personal users with no ledger behind it.")
    sys.exit(1)
print(f"{G}All 8 correct.{Z}")
'
rc=$?
if [ "$rc" -ne 0 ]; then
  echo
  echo "If a value looks right in the database but wrong here, the app is being"
  echo "served this response — check /v1/services rather than the table."
fi
exit $rc
