#!/bin/bash
# Rebuild hrserve/ from hr/.
#
# hrserve is the SAME HR portal, served on 8030, with one difference: it talks
# to the sandbox API on 127.0.0.1:8110 instead of api.titopay.co.za. The shipped
# files are correct for production and cannot reach anything from a local
# browser, so every module would fail in a test for a reason that has nothing to
# do with the code being tested.
#
# Same reasoning as sync-adminserve.sh: this patch used to be applied by hand,
# and a plain copy silently reverted it. One command, and it cannot be forgotten.
set -e
cd /tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad

rm -rf hrserve
cp -r hr hrserve

# Production serves the API behind an /api prefix; the sandbox does not.
sed -i "s|https://api.titopay.co.za/api/v1/hr|http://127.0.0.1:8110/v1/hr|g" hrserve/hr-session.js
sed -i "s|https://api.titopay.co.za/api/v1|http://127.0.0.1:8110/v1|g" hrserve/index.html
sed -i "s|https://api.titopay.co.za|http://127.0.0.1:8110|g" hrserve/index.html

echo "hrserve rebuilt:"
echo "  hr-session.js base: $(grep -o 'HR_API_BASE = \"[^\"]*\"' hrserve/hr-session.js)"
echo "  remaining production origins in index.html: $(grep -c 'api\.titopay\.co\.za' hrserve/index.html || true)"
