#!/bin/bash
# Bring the sandbox PostgreSQL back up on 55432.
#
# The cluster is /var/lib/pgdata-titopay. Two decoys exist and both look
# plausible: an empty pgdata/ here, and an older cluster at
# /var/lib/postgresql/titopay carrying a database from an earlier day. Starting
# that one answers queries perfectly well and silently gives wrong answers.
chmod o+x /tmp/claude-0 /tmp/claude-0/-home-user-titopay-app \
  /tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a 2>/dev/null
su postgres -c '/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/pgdata-titopay -l /var/lib/pgdata-titopay/pg.log -o "-p 55432" -w start'
