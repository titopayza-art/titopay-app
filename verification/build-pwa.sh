#!/bin/bash
# Rebuild app.min.js from app.js and bump the cache-busting version.
#
# index.html loads app.min.js, NOT app.js. Editing the source alone changes
# nothing a customer sees — the shipped bundle is the built artefact, and this
# is the step that carries an edit into it.
#
# Terser is run without name mangling at the top level, because the markup and
# the tests reach functions by name (data-action handlers, render, boot).
# The version has to move in three places or a stale service worker keeps
# serving the previous bundle; api/test/pwa-structure.test.js checks all three.
set -e
cd /tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/app

current=$(grep -o 'app\.min\.js?v=[0-9]*' index.html | head -1 | grep -o '[0-9]*')
next=$((current + 1))

# Pinned. `npx --yes terser` resolved whatever the registry served at the
# moment of the build, so two builds of identical source could produce
# different bundles — and a minifier is the one tool in the chain that rewrites
# every line of the customer app.
npx --yes terser@5.49.2 app.js --compress --mangle --output app.min.js
sed -i "s/app\.min\.js?v=${current}/app.min.js?v=${next}/g" index.html service-worker.js
sed -i "s/titopay-pwa-v${current}/titopay-pwa-v${next}/g" service-worker.js

echo "app.min.js rebuilt: $(wc -c < app.min.js) bytes, v${current} -> v${next}"
for name in api render boot primaryWallet statementPdf; do
  grep -q "function ${name}(" app.min.js || { echo "  MISSING from bundle: ${name}"; exit 1; }
done
echo "  entry points intact"
