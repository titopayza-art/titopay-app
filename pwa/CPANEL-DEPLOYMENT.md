# TitoPay PWA — Afrihost cPanel deployment

Static site. No Node.js, no build step. **Target:** `app.titopay.co.za`

**Build:** `event-tags-and-full-screen-services-v295`

## Deploy order

This package pairs with the API package of the same date. **Deploy `api.zip` first.**
The PWA calls three routes that only exist in that package —
`GET /v1/ticketing/tickets`, `GET /v1/ticketing/tags` and `POST /v1/ticketing/tags/link`.
Without them the Event Tag area simply does not appear and My Tickets keeps
showing the error it shows today; nothing else is affected, but there is no
reason to ship in the wrong order.

## Steps

1. **Back up.** File Manager → the PWA document root → select all → **Compress** →
   `pwa-backup-YYYY-MM-DD.zip` → move it outside the document root.
2. **Upload** `app.zip` into the PWA document root.
3. **Extract** into that root. The archive is flat: `index.html`, `app.min.js`, `assets/` are at the
   ZIP root. Confirm `index.html` is directly in the root, not inside a nested `app/` folder.
   Delete the uploaded ZIP afterwards.
4. **Keep `.htaccess`.** Turn on File Manager → Settings → **Show Hidden Files (dotfiles)** and
   confirm it survived the extract.
5. **Hard-refresh** (Ctrl+F5 / Cmd+Shift+R). Assets moved from `?v=291` to `?v=295` and the service
   worker cache name changed to `titopay-pwa-v295-calmer-service-forms`, so returning users pick the
   new bundle up on their next visit without being told to do anything.

## What changed

**Every service screen is full-screen on a phone.** Eighteen of them — Stokvel, My Tickets,
Events, Receive, QR Pay, Airtime, Airtime & Data, Data, Electricity, Voucher, Pay Bills,
Payment Request, Bill Split, Send Gift, Statements, Refund, Learn and Tip. The heading stays
put while content scrolls under it, and the primary action sits at the bottom under the thumb.
Tablets and desktops are unchanged: still a centred dialog.

**Top Up, Send Money, Withdraw and Payout share one screen.** Recipient at the top, the amount
as the largest thing on the screen with the available balance under it, a keypad instead of the
OS keyboard, one button that names what it will do. Spending more than the balance is called out
before the button is pressed. The form underneath is unchanged — the same fee preview, the same
review screen, the same confirmation.

**Event Tags.** An attendee with a ticket for a cashless event sees a Link Event Tag card in My
Tickets, holds their wristband against the phone, confirms, and it is active. On a phone without
Web NFC — every iPhone — the same screen accepts the code printed on the tag instead.

## Verify

1. Sign in → **Top Up** → tap `5` `0` `0` on the keypad. The screen should read **R 500**, the
   button should read **Top up R 500.00**, and the available balance should be underneath. Press it
   and you should reach the review screen with the fee shown before anything is charged.
2. Open **Stokvel** from Services. It should fill the screen edge to edge with no page visible
   behind it and no stray close button in the corner.
3. If you hold a ticket for an event with cashless switched on, open **Event Tickets → My Tickets**.
   A **Link Event Tag** card should appear above your ticket.

## If something looks wrong

**Old layout persists.** The browser is on the cached bundle. Hard-refresh; on iOS, close every
tab of the site and reopen.

**My Tickets says "Tickets could not be loaded".** The API package has not been deployed. That
screen calls `GET /v1/ticketing/tickets`, which is new in the paired API package. (This screen
has been broken since it shipped, for exactly this reason — the route never existed.)

**Event Tag area does not appear.** Expected unless the event has cashless Event Tags switched
on by its organiser and you hold a valid ticket for it. Nothing appears for ordinary events.

## Rollback

Delete the document root contents, upload and extract the backup from step 1, hard-refresh.
Rolling the PWA back does not require rolling the API back — the new API routes are additive and
the old bundle simply does not call them.
