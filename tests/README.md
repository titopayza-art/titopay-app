# TitoPay browser tests

Every suite drives the real app in Chromium against a **mocked TitoPay API**.
No request reaches production, and no suite may submit a transaction unless it
is on the `EXPECTS_SUBMISSION` allowlist in `run-all.js` — those exist to assert
the request body that results, against a mock.

## Running

```bash
npm install
npx playwright install chromium
npm run serve &          # serves the repo root on :8899
npm test                 # runs every suite, exits non-zero on any failure
```

Environment overrides:

| variable | purpose |
|---|---|
| `BASE_URL` | where the app is served (default `http://127.0.0.1:8899`) |
| `CHROMIUM_PATH` | explicit browser binary, for sandboxes that pin one |
| `SHOT_DIR` | where screenshots are written (default `tests/artifacts`) |

## What each suite covers

| suite | covers |
|---|---|
| `continuity-test.js` | every service tile opens, renders and reaches review |
| `v169-regression.js` | core wallet flows end to end |
| `vas-phase2.js` | airtime, data, electricity, voucher, bills; asserts submitted metadata |
| `stockvel-test.js` | savings group create, contribute, statement |
| `four-features.js` | Top Up, Withdraw, Send Gift, Tickets |
| `learn-test.js` | Learn library, search, categories, accordion |
| `doc-test.js` | invoice/quote/proforma totals, VAT, dates; asserts payload keys unchanged |
| `stmt-split-test.js` | statements arithmetic, bill split cent-exact division |
| `round4-test.js` | chat draft survival, lookup failure, ticketing, QR labels |
| `header-test.js` | fixed app bar across 6 device classes and 5 routes |
| `swipe-test.js` | landing segmented control: swipe, keyboard, tap |
| `modal-stack.js` | modal z-order and scroll restoration |
| `wording-sweep.js` | scans all rendered copy for account-type wording errors |
| `fill.js` | landing composition density at 10 viewports |
| `ff-a11y.js` | touch targets, labels, clipping across viewports |

`check-version.js` runs before the browser suites and fails the build if the
version in `index.html`, `service-worker.js`, `app.js` and the build marker
disagree. A mismatch ships a build that serves stale cached assets.

## Adding a suite

Print a single JSON object to stdout. The runner treats these keys as failures:
`errors` / `pageErrors` (non-empty), `failures` (non-empty), `txPosts`
(non-zero, unless allowlisted), `overflowX` (true, or an object with any true
value). Then add it to `SUITES` in `run-all.js`.
