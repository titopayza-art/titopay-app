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
#
# IT BUILDS THE REPOSITORY, resolved from this script's own location. It used
# to cd into a scratch copy of the app made for a deployment, which meant a
# clean-looking build could report success while pwa/app.min.js — the file
# index.html actually loads and the file that ships — was never rebuilt at all.
set -e
cd "$(dirname "$(readlink -f "$0")")/../pwa"

current=$(grep -o 'app\.min\.js?v=[0-9]*' index.html | head -1 | grep -o '[0-9]*')
next=$((current + 1))

# Pinned. `npx --yes terser` resolved whatever the registry served at the
# moment of the build, so two builds of identical source could produce
# different bundles — and a minifier is the one tool in the chain that rewrites
# every line of the customer app.
npx --yes terser@5.49.2 app.js --compress --mangle --output app.min.js
sed -i "s/app\.min\.js?v=${current}/app.min.js?v=${next}/g" index.html service-worker.js
sed -i "s/titopay-pwa-v${current}/titopay-pwa-v${next}/g" service-worker.js
# head-boot.js and the stylesheet move too. They were bumped by hand before, and
# verification/asset-version-consistency.js fails the build when any one of the
# four is left behind — so the build does all four rather than three.
sed -i "s/head-boot\.js?v=${current}/head-boot.js?v=${next}/g" index.html service-worker.js
sed -i "s/styles\.min\.css?v=${current}/styles.min.css?v=${next}/g" index.html service-worker.js head-boot.js

echo "app.min.js rebuilt: $(wc -c < app.min.js) bytes, v${current} -> v${next}"
for name in api render boot primaryWallet statementPdf; do
  grep -q "function ${name}(" app.min.js || { echo "  MISSING from bundle: ${name}"; exit 1; }
done
echo "  entry points intact"
