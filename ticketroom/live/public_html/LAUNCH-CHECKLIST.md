# TicketRoom launch checklist

What is ready, what only you can do, and the first marketing steps.

## Ready (tested)

- Buying, free and paid tickets, guest checkout, transfers, face-value
  resale, waitlist, cashless wristbands, vendors, box office, event teams,
  gate scanner with offline mode, test events, VerifyNow checks, wallet passes,
  reserved seating on a map of the venue (blocks placed around the stage,
  copied to every show at the same venue), extras sold with tickets (parking,
  merchandise, VIP upgrades), tickets on WhatsApp, and linked devices for
  the gates and top-up desks (rugged handhelds, phones, USB and Bluetooth
  barcode, NFC and RFID readers).
- Every automated test suite passes, on SQLite (Afrihost) and on MySQL
  (your own server). No overselling under load.
- Security: HTTPS only, strict security headers, rate limits, signed tickets,
  audit log, private data folder, no passwords or keys in the package.
- Search and sharing: every event page carries its own title, description,
  poster and Google event data (date, venue, price in rand, sold out or not),
  so links shared on WhatsApp, Facebook and X show the event, and events can
  appear in Google's event results. /sitemap.xml lists every event on sale.

## Before you open: only you can do these (blocking)

1. **Payments live.** Admin portal → Integrations → Payments: the live Yoco or
   PayFast keys. Then buy one real R10 ticket with your own card and refund
   it. Do not open until that round trip works.
2. **Email that lands in the inbox.** In your domain's DNS (Afrihost or
   Cloudflare), add the SPF, DKIM and DMARC records your mail provider gives
   you. Without them, ticket emails go to spam. Test with mail-tester.com
   (aim for 9/10 or better).
3. **Cron job** (DEPLOY-AFRIHOST.md, section 12): sends emails on time,
   expires held seats, makes the daily backup.
4. **Backups off the server.** Download one backup from Admin portal →
   Backups and keep it off the server. Do this weekly until the off-site
   copy is automatic (DEPLOY-SERVER.md, section 6).
5. **VerifyNow API key** (Integrations) before the first paid organiser
   payout.
6. **SMS provider** (Integrations), for sign-in codes and gate alerts.
7. **WhatsApp tickets** (optional, Integrations → WhatsApp tickets): a
   WhatsApp Business number on Meta's Cloud API, a permanent access token and
   an approved Utility template with four values (name, event, date, link).
   Use Practice mode first, then send yourself a test message.
8. **Apple and Google Wallet certificates**, if you want the wallet buttons
   on day one. The site works without them.
9. **Policies.** Read the Terms, Privacy Policy and refund rules once more.
   Admin portal → Site settings → Legal: fill in your POPIA Information
   Officer (the Privacy Policy and PAIA manual show it).
10. **Remove sample content.** Make sure no test or sample events are
    published (test events never show to the public, but check drafts too).

## Before your first event with handhelds

- Link each handheld under the event's Devices tab (one code per device, it
  works once for 15 minutes) and scan a test ticket on it.
- Register two wristbands on the desk device and tap them at a gate device.
  If a band is not recognised, set the reader's number format under Edit
  (hex or decimal, reverse byte order) so all devices read bands the same way.
- Keep the handhelds charged, on the venue Wi-Fi or mobile data; the gate
  keeps working offline with the ticket list it downloaded.

## Launch week: marketing

1. **Google Search Console**: add ticketroom.co.za, submit
   `https://ticketroom.co.za/sitemap.xml`. Check "Events" under Enhancements
   after the first events are published.
2. **Google Business Profile** for TicketRoom (South Africa).
3. **Share preview check**: paste an event link into WhatsApp and the
   Facebook Sharing Debugger (developers.facebook.com/tools/debug) to see the
   poster and title.
4. **First organisers**: list 3 to 5 real events before announcing, so the
   home page is not empty on launch day. Free community events are the
   quickest start.
5. **Social**: post the 14 campaign posts over the first two weeks
   (captions in the social media pack), pin "Get in" and the two
   "How it works" posts.
6. **Print**: the A5 flyer at venues and campuses, the pull-up banners at the
   first events you run the gate for.
7. **Watch**: Admin portal dashboard and /api/health daily for the first
   two weeks; answer every support request the same day.
