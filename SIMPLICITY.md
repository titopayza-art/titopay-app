# Simplicity rules for TitoPay

TitoPay grew fast, and every feature added on its own was justified. Together
they started to make the app hard to hold in your head: the same feature behind
two doors, one sheet doing seven jobs, tiles with nothing behind them. These are
the rules that keep that from coming back. They are short on purpose.

## 1. One door per feature

A feature has exactly one home. If it is a tile, it is not also a Profile row.
If it is a Profile row, it is not also a tile.

The exception that proves the rule: **Bulk Distribution** shows in Profile only
while its tile is hidden, so an approved business sees it once and an
unapproved one still has somewhere to check its status.

This is enforced by `api/test/app-navigation-simplicity.test.js`, which fails if
a `profileFeature(...)` action is also a tile action.

Closing a door is only safe when the feature stays findable. Anything that lives
behind a single door belongs in `appSearchEntries()`.

## 2. Three taps from home

Any core action is reachable within three taps of the home screen.

    tap 1   a tile, or Profile
    tap 2   the feature
    tap 3   the thing you came to do

Send money, top up, withdraw, scan to pay and buy airtime are two taps. Ticketing,
Sales, TitoKids and Stokvel are three: tile → door → action. Nothing a person
does regularly should need a fourth.

When a new feature does not fit in three taps, it does not get a fourth — it
either fits an existing door or it replaces something.

## 3. A sheet does one job

A modal that does seven things cannot be simple, and it cannot be scrolled
without frustration. When a screen grows past what fits on a phone without
hunting, it becomes a hub of short doors — see Business Ticketing, which is now
My Events / Sales / Vendors & Door / Event Tags over one shared fetch.

Load the data once at the hub; each door renders from it. A save re-renders its
own door, never the whole dashboard, so nobody gets thrown back to the top.

## 4. No empty tiles

A tile with nothing behind it teaches people to ignore tiles.

Hide a tile until it has something to show — Bulk Distribution until the business
is approved, Event Scanners until an event is approved. Two conditions on any
such rule:

- **Fail open.** Hide only from data you actually have. An account you have not
  looked at yet still sees the tile.
- **Cost nothing.** Decide it from data already fetched for another reason,
  never an extra request on boot.

## 5. The Services screen is grouped, never a wall

Nineteen tiles in a flat grid is a list you have to read. The same tiles under
headings are a page you can scan, and nothing moves further away — every service
stays exactly one tap from that screen.

    Send & pay        send, QR pay, request, split, gift
    Money in & out    top up, receive, withdraw, payouts, tip, refund
    Buy               airtime, data, electricity, vouchers, bills, tickets
    Plan & save       stokvel, TitoKids, learn
    Run your business invoices, quotes, sales, ticketing, bulk distribution
    More              everything the map does not name

`More` is the catch-all and owns no members. A service added to the catalogue
that nobody mapped lands there rather than disappearing — grouping must never be
able to lose a feature.

## 6. The app asks in its own voice

No `window.prompt`, no `window.confirm`. On a phone those arrive as a grey box
carrying the site's address, which reads as "the app broke" rather than "the app
asked".

Use `askForValue()` for a value and `askToConfirm()` for a decision. Both layer
over the sheet the person is working in and leave it exactly as it was —
deliberately not built on `openModal`, which would close it. Destructive
confirmations pass `tone: "danger"`.

## 7. One name per concept

Three things called "chat" and three called "staff" is a naming problem that
reads as a complexity problem.

    TitoPay Chat      people talking to people
    TitoPay Assistant the bot
    Support           tickets to Customer Care
    Staff             the business staff register
    Event Scanners    the people who scan tickets at a door

If a new feature needs one of these words, it probably belongs inside that
feature rather than beside it.

## 8. Money rules that outrank simplicity

Simplicity never buys its way out of these:

- Balances, progress and spend windows are read from the ledger, never a
  parallel tally.
- A business cannot receive money without FICA. Free events need no FICA; paid
  tickets always do.
- Ticketing and TitoKids communicate by in-app alert and email. Never SMS.
