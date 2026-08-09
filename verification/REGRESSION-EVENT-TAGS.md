# Event Tags — verification log

Every run below was against a real Postgres 16, the real API, the real POS HMAC
signing stack, and Chromium. Nothing was mocked except the two payment
providers, which have always been stood in for locally.

## New coverage

| Suite | Result |
|---|---|
| `api/test/event-tag-structure.test.js` — static invariants | 14/14 |
| `verification/event-tag-e2e.js` — full journey + refusal matrix | 82/82 |
| `verification/event-tag-consoles.spec.js` — organiser + admin consoles | 29/29 |
| `verification/pwa-event-tags.spec.js` — the attendee's screen | 24/24 |

## API suite

324/326. The two failures are pre-existing and unrelated (Email Statement R0.10
pricing; `hr-session.test.js`), and fail identically on the shipped archive.

## Regression — before and after

| Suite | Before | After |
|---|---|---|
| PWA crawl | 20/20 | 20/20 |
| PWA journeys (84 journeys, 69 forms exercised) | 96/96 | 96/96 |
| PWA wallet lock | 10/10 | 10/10 |
| PWA chat options | 31/31 | 31/31 |
| PWA support escalation | 17/17 | 17/17 |
| PWA rating and alerts | 17/17 | 17/17 |
| Admin crawl | 53/53 | 53/53 |
| Admin landing | 39/39 | 39/39 |
| Admin monitoring | 23/23 | 23/23 |
| Admin modules (Analytics + Service Builder) | 28/28 | 28/28 |
| Top-up e2e | 32/32 | 32/32 |
| Top-up fee revenue | 20/20 | 20/20 |
| Top-up ledger integrity | 26/26 | 26/26 |
| Statement integrity | 20/20 | 20/20 |
| Withdrawals | 61/61 | 61/61 |
| Provider routing | 51/51 | 51/51 |
| Flash e2e | 48/48 | 48/48 |
| Top-up race (13-way) | pass | pass — credited exactly once |

## A note on running these

The API rate-limits 120 requests per minute **per client IP**, and several of
these harnesses spend most of that on their own. Run back to back they starve
each other, and the symptom is a first-step failure — "customer created FAIL",
"admin signed in FAIL" — that looks like a product break and is not.

`serial.sh` runs one at a time with a 75-second gap, which is what the results
above were produced with. The three Event Tag harnesses have rate-limit backoff
built in and can be run any time.

`split-e2e.js` scores 34/34 alone and 31/34 when it follows `withdrawal-e2e.js`.
That is a long-standing ordering dependency between those two harnesses — split
configures the payout capability withdrawal consumes — not a product fault, and
not something this change touched.
