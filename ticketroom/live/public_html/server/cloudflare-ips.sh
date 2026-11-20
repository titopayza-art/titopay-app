#!/usr/bin/env bash
# Prints nginx settings that restore the visitor's real IP from Cloudflare's
# CF-Connecting-IP header, trusting it only from Cloudflare's own addresses.
# Rate limits, fail2ban and the app's sign-in limits then see real visitors.
set -euo pipefail
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
[ -n "$v4" ] && [ -n "$v6" ]
echo "# Cloudflare ranges, $(date -u +%F). Refreshed weekly by cron."
for ip in $v4 $v6; do echo "set_real_ip_from $ip;"; done
echo "real_ip_header CF-Connecting-IP;"
