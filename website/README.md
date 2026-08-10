# TitoPay Marketing Website

Static marketing website package for `https://titopay.co.za/`.

## Contents

- Main pages: `index.html`, `personal.html`, `business.html`, `events.html`, `security.html`, `about.html`, `newsroom.html`, `waitlist.html`, `careers.html`, `faqs.html`, `contact.html`, `legal.html`
- Shared assets: `styles.css`, `script.js`, `assets/titopay-official-logo.png`
- Public form capture endpoint in `api/`
- Protected submissions dashboard in `admin/`
- Careers application capture files in `hr/`
- SEO files: `robots.txt`, `sitemap.xml`
- Browser icons: `assets/titopay-official-logo.png`, with legacy `favicon.png` files overwritten by the same official TitoPay wordmark

## Updates Included

- Added TitoPay-branded favicon files based on the official logo artwork.
- Stabilized the interface by removing motion-based hover lifts, entrance wobble, and viewport-scaling type.
- Hardened desktop and mobile navigation click behavior, including the Resources dropdown.
- Upgraded the homepage with stronger fintech positioning, product-suite information, trust proof points, and readiness messaging.
- Converted the logo asset into a real PNG file for cleaner hosting/CDN behaviour.
- Replaced public waitlist/contact mail-app handoff with on-site form capture and privacy consent.
- Replaced JSON submission storage with a PHP database backend and protected admin dashboard.
- Tightened mobile hero spacing and wallet preview height to reduce unnecessary first-screen scrolling.
- Updated canonical, Open Graph, JSON-LD, sitemap, and robots URLs to use `https://titopay.co.za`.
- Replaced Cloudflare email-protection wrappers with normal `mailto:` links so the zipped static copy works independently.
- Published the TitoPay Careers 2026 positions and added a role-aware career application form.
- Applicants apply only on the marketing Careers page.
- Join Waitlist is now a dedicated page at `waitlist.html` instead of an on-page homepage jump.
- Careers Apply buttons now jump to the application form, select the role, and keep the form visible below the fixed header.
- Careers includes a separate HR enquiry form for application and role questions.
- Careers PDF download was removed from the public site; applications now require CV and qualification document uploads.
- Career applications are written to the secure SQLite backend when hosted with PHP enabled.
- HR and CEO review applications, CVs, qualifications, waitlist entries, and contact requests through `/admin/`. Keep HR archives outside the public website root.
- Published the TitoPay Events service page at `/events` in its **Coming Soon** state, with the Events waitlist and the "Bring TitoPay to My Event" organiser enquiry.
- Added public feature flags (`api/config.php` → `features`, published by `api/features.php`) so the Events page can go live before any Events financial functionality does.
- Added a `Source` column and a `TitoPay Events` counter to the `/admin/` submissions view so Events requests are identifiable at a glance.

## TitoPay Events

`/events` is a public service page. TitoPay Events is **not live**: it takes no
payments, creates no event wallets, settles no vendors, and drives no NFC/RFID
hardware. The page explains the service to organisers, vendors and patrons, and
labels everything that is not production-ready as **Coming Soon** or **Planned**.

### Waitlist

TitoPay Events reuses the existing waitlist and ticket pipeline. There is no
second account system and no new table:

- The Events waitlist form posts `formType: waitlist` with `context: events-waitlist`.
- "Bring TitoPay to My Event" posts `formType: contact` with `context: events-organiser`.
- Both land in `public_submissions` and raise a normal TitoPay ticket, visible in `/admin/`.

### Feature flags

Defaults live in `api/config.php` under `features`, and any of them can be
overridden per-environment in `api/config.local.php`:

```php
'features' => [
    'events_public_page' => true,   // serve /events
    'events_waitlist' => true,      // accept Events waitlist and organiser enquiries
    'event_wallets' => false,
    'event_payments' => false,
    'event_rfid' => false,
    'event_vendor_settlements' => false,
],
```

`api/features.php` publishes only these keys. The browser reads them and can
only ever *retire* a "Coming Soon" label — the page ships in its Coming Soon
state, so a visitor who never reaches the endpoint still sees the truth. The
`events_waitlist` flag is also enforced server-side: with it off, an Events
submission is refused with HTTP 503 and the form on the page is disabled.

Turning `event_wallets`, `event_payments`, `event_rfid` or
`event_vendor_settlements` on only changes page labelling. The underlying
financial functionality is not built and must not be switched on until it is
tested and approved for production.

## Deployment

Upload the contents of this folder to the website public root. If the host supports Apache/LiteSpeed `.htaccess`, the included file redirects `www.titopay.co.za` to `titopay.co.za` and forces HTTPS.

Waitlist, contact, and career forms use the included PHP backend, with browser-storage fallback for static previews. Review submissions at `/admin/` using the private CEO or HR admin login. Uploaded CVs and qualification files are stored in protected private storage and downloaded through the admin dashboard after sign-in.

For Afrihost/cPanel hosting, upload the website files directly into `public_html`. PHP should be enabled for the domain. If PDO SQLite is available, the default configuration will create a protected SQLite database automatically. For a more standard cPanel production setup, create a MySQL database and user in cPanel, then update `api/config.local.php`:

```php
'database' => [
    'driver' => 'mysql',
    'mysql' => [
        'host' => 'localhost',
        'database' => 'cpaneluser_titopay',
        'username' => 'cpaneluser_titopay',
        'password' => 'your-database-password',
        'charset' => 'utf8mb4',
    ],
],
```
