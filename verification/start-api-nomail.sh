#!/bin/bash
# A second API on 8176 with HR_EMAIL_ENABLED deliberately NOT set — a stand-in
# for a staging box that was never configured to mail staff.
cd /tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad || exit 1
pid=$(fuser -n tcp 8176 2>/dev/null | tr -d ' '); [ -n "$pid" ] && kill $pid 2>/dev/null
sleep 2
cd api
( set -a; . ../local.env; set +a; export API_PORT=8176 CHAT_SOCKET_ENABLED=false; unset HR_EMAIL_ENABLED; nohup node src/server.js > ../api-nomail.log 2>&1 & )
for _ in $(seq 1 40); do
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8176/v1/health)" = "200" ] && break
  sleep 1
done
echo "nomail health $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8176/v1/health)"
