# Pre-deployment audit of the three cPanel archives

Before `api.zip`, `app.zip` and `admin.zip` overwrite the live servers, four
independent auditors were pointed at them with one brief: **assume the archive
is broken and prove it.** Every finding was then handed to a separate agent
whose job was to refute it, so that only claims which survive an honest attempt
at demolition reach this page.

**Verdict: no blockers in any of the three packages.** Every finding was minor,
every one of them pre-existing rather than introduced by this work, and all
seven that were worth acting on have been fixed. What follows is what was
checked, what was found, and what was done about it.

---

## What the auditors could not break

These are the checks that passed, listed because a clean result is only
meaningful if you know what was actually attempted.

**The API package.** Every `.js` file parses. Exactly one file present in the
pristine tree is absent from the archive — `dump-routes.js`, a local debug
script that hardcodes sandbox secrets and has never appeared in any shipped
archive. No `.env`, no `node_modules`, no `.git`, no backups, no logs, no path
traversal. `package.json` is valid and every `require()` resolves to a declared
dependency. The Event Tag service exports what the routes call, and both
`/tags/link` and `/tickets` are defined.

**The PWA package.** `app.min.js` was reproduced from `app.js` byte-for-byte
with `terser --compress --mangle` — the shipped bundle really is built from the
shipped source. `index.html` and `service-worker.js` agree on every cache-bust
version, so the stale-service-worker failure is absent. All 15 `APP_SHELL`
entries resolve to real files, so `cache.addAll()` cannot reject. `styles.min.css`
was parsed with a comment- and string-aware tokenizer and compared rule by rule
against `styles.css`: 1755 rules and 6042 declarations in each, zero missing
selectors, zero property mismatches.

**The Admin package.** All 52 pages reference one build stamp, `admin-console-v75`,
and `admin.js`'s internal fallback matches — the drift that once served v73
pages against v63 modules is genuinely fixed, and the lazy modules now derive
their stamp from their own script tag so the two cannot diverge again. All 110
local asset references across all 52 pages resolve. All 42 `data-page` values map
1:1 onto both the descriptor and loader tables, so no page can hit the
"not configured" throw. Every one of the 49 sidebar routes has a shipped page.

**Secrets, across all three.** No `.env`. No private keys, AWS keys, Google keys,
GitHub tokens, Stripe live keys or JWTs. No source maps. No build-machine paths.
No test fixtures or test credentials. **No shipped page permits a localhost
origin in `connect-src`** — the sandbox test copy does, and it did not ship.

---

## What was found, and fixed

### The PWA's offline page had never once been served

The most substantive finding. The service worker's fallback read:

```js
return caches.match(event.request) || caches.match("./index.html") || caches.match("./offline.html");
```

Every one of those is a Promise and every Promise is truthy, so the chain always
returned the first one regardless of what it resolved to. On a cache miss the
handler resolved to `undefined`, `respondWith()` received a non-Response, and
the request failed as a network error rather than falling back. `offline.html`
has been precached since the day it shipped and was unreachable by construction —
line 44 was its only reference outside the precache list.

Fixed by awaiting each match in turn, with an explicit `Response.error()` so the
failure path is deliberate. Demonstrated against a mock Cache: the old chain
returns `undefined` for an uncached route, the new one returns `index.html`, and
with `index.html` also missing it finally returns `offline.html`.

Two related gaps came with it. `offline.html` linked `./styles.css`, which is not
precached — so the one page that only ever renders with no network was the one
page guaranteed to render unstyled; it now links the file the service worker
holds. And `manifest.webmanifest` pinned its icons at `?v=83` while everything
else used `?v=165`; because a query string is part of the Cache API key, every
manifest icon fetch missed the precache. Realigned.

Because precached copies changed, the cache name moved with them: **v295 → v296**.

### Three CSP inconsistencies in the Admin console

- `email-centre/index.html` was the only page of 52 permitting `'unsafe-inline'`
  in `style-src`, on a console that emits **zero** inline styles anywhere —
  confirmed by grepping every HTML file and all three JS bundles. Removed.
- `email-centre/otp/index.html` loaded `admin.js` while naming no `script-src`.
  It worked through the `default-src` fallback, but a policy should say what it
  means. Added `script-src 'self'`.
- `support/index.html` and `chatbot-escalations/index.html` each listed
  `wss://api.titopay.co.za` twice in one directive. Harmless — browsers
  de-duplicate — but it reads as a mistake. Removed.

All four affected pages were then driven in a real browser with the tightened
policy: all render, **zero CSP violations, zero console errors**.

### A megabyte of frontend source was publicly downloadable

`app.zip` ships `app.js` (1,009,457 bytes, 1,173 comment lines of internal
engineering narrative) and `styles.css` (269,896 bytes) alongside the `.min`
versions the browser actually loads. Nothing references either — `index.html`
names only `styles.min.css` and `app.min.js`, and neither appears in the service
worker's precache list. They land in a public document root all the same, and
`https://app.titopay.co.za/app.js` returned **200** while this was being written.
The same root served `CPANEL-DEPLOYMENT.md`, which names internal route paths.

**Nothing was deleted from the package.** The sources stay on the server, where
they are useful to whoever is debugging a live problem; Apache simply stops
handing them to the internet. Four rules were added to the PWA's `.htaccess`:
`app.js`, `styles.css`, `*.md` and `.ht*`. `DEPLOYMENT_BUILD_MARKER.txt` stays
reachable — it is what a deploy is verified against.

The admin root already blocked its `.md` files this way and
`https://admin.titopay.co.za/AFRIHOST_DEPLOYMENT.md` returns **403** in
production today, so `Require all denied` demonstrably works there; the two
operational `.txt` files that describe the upload procedure were added to that
same proven block.

The PWA root got a different mechanism on purpose. `Require` belongs to Apache's
**AuthConfig** override class, and that document root has never used a directive
from it — if `AllowOverride` there does not include AuthConfig, Apache answers
**every** request with 500 rather than hiding one file. `RewriteRule ... [F]`
belongs to **FileInfo**, which the existing Cache-Control rules prove is
permitted (`service-worker.js` comes back `no-store, max-age=0`, and only that
`.htaccess` sets it). Same 403, no way to take the app down.

Both were then run through a real Apache 2.4, serving the **extracted archives**,
not the working tree:

| | app.zip, `AllowOverride FileInfo` | admin.zip, `AllowOverride All` |
|---|---|---|
| pages and assets | 15/15 → **200**, every Cache-Control rule intact | 50/50 pages + all assets → **200** |
| `admin-version.txt` | — | **200** (verification step preserved) |
| `DEPLOYMENT_BUILD_MARKER.txt` | **200** (verification step preserved) | **403** |
| sources / docs / dotfiles | `app.js`, `styles.css`, `.md`, `.htaccess` → **403** | `.md`, `UPLOAD-INSTRUCTIONS.txt`, `.htaccess` → **403** |

And the counter-test, because the reasoning above is only worth anything if the
danger was real: the same package with the `Require all denied` form, under the
same FileInfo override, returned **500 for the entire site** — index.html,
app.min.js, styles.min.css, everything.

### Deployment markers described an older package

The PWA build marker said v291 while the bundle was v295. Its cPanel note
described the v274 Peach release — wrong version, wrong verification steps. The
admin changelog stopped at v74 while shipping v75. And the API note opened with
"No database migration", which is no longer true. All corrected.

---

## Deferred, with a recommendation

`admin-version.txt` is a 437-line, 27 KB internal changelog served at the admin
web root **without authentication**, deliberately exempted from the `.htaccess`
rule that blocks documentation, because the upload instructions make fetching it
a post-deploy verification step.

It names internal permission slugs (`event_tags`), internal settings keys
(`admin_role_permission_overrides`), unimplemented API endpoints, and the full
feature history of the platform. None of that is a credential, but collectively
it is reconnaissance material available to anyone who guesses the URL.

This was **not** changed, because fixing it alters an operator workflow and that
is not a call to make unilaterally mid-deploy. The recommended remedy keeps the
verification step exactly as it is:

1. Reduce `admin-version.txt` to the three lines a deploy check actually reads —
   product, build stamp, date.
2. Move the changelog body to `CHANGELOG.md`, which `.htaccess` already denies.

---

## Verifying what you upload

```
api    eba56da36b3e01f9cec98cc8dd8be8dcd17ea9bc8c04dd26172a453bd999f5c0
app    97221d59b4806eb57c0ce3f61903fa92da0a1d36e1e1616d25dc9027080d4839
admin  26cadf6bb827850177f39d47589b745f5a67bc577c7557c97966b0d1b0aa226b
```

These are the archives with every fix on this page applied. Also recorded in
`ARCHIVE-CHECKSUMS.txt`. `api.zip` has not changed since it was first sent —
the same `eba56da3…` — so if you already hold it, it is the right one. `app.zip`
and `admin.zip` were rebuilt for the `.htaccess` work above: an app checksum of
`d261dda5…` or an admin checksum of `686b0121…` or `19324eba…` predates it.

File counts, against the archives they replace: api 189 → 189, app 26 → 26,
admin 116 → 116. **Nothing removed from any of them.**

### If a deny rule ever misbehaves

Both rules live entirely in `.htaccess`. Delete the three `RewriteRule` lines
from the PWA's, or the one `<FilesMatch>` block naming the `.txt` files from the
admin's, and the previous behaviour is back immediately — no re-upload of
anything else, no cache to clear.

## Beyond the static audit

The API archive was **extracted and booted**, not merely inspected: health
returned 200 and all six new endpoints correctly refused unauthenticated calls
with 401.

The "no manual migration" claim was **proven on an empty database**. A fresh
database received only the base schema production already has; the Event Tag
tables were confirmed absent; one ordinary ticketing request created all three
tables and both columns with `cashless_tags_enabled` defaulting to false, and
returned 200. Three further requests changed nothing — no duplication, no
errors, and still zero balance-like columns anywhere.
