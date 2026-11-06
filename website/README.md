# TitoPay website launch

Prepared 3 November 2026; launch-readiness pass 6 November 2026. This package updates the existing PHP/Apache marketing website for the app at https://app.titopay.co.za. It does not replace or change the wallet app.

## Design revision

The launch site uses the approved TitoPay blue palette, supplied campaign photography, transparent Personal and Business app screens, rotating service labels and a Peach Payments footer. The installation guide includes the supplied PWA explanation and separate phone instructions. The live domain must be updated from this release before these changes reach customers.

## Launch-readiness pass (6 November 2026)

This release builds on the 3 November package. Upload it the same way (steps below).

**Page weight.** The homepage dropped from about 10.1 MB to 0.7 MB (mobile) and every other page from about 1.1 MB to 0.3 MB.
- Hero photo resized from 3374px to 1600px; phones get a separate 900px version.
- App screens are served as WebP (about 85 KB each), with resized PNG fallbacks.
- The payments photo is now a JPEG (3.5 MB down to 137 KB). The new file is `titopay-real-payments.jpg`.
- The Peach Payments footer logo was 778 KB on every page and is now 26 KB. The header logo went from 145 KB to 58 KB.
- Logo URLs and `campaign.css` carry new `?v=` values, so returning visitors get the new files.
- Images that nothing referenced, plus the unused `approved-launch.css`, `launch.css` and `launch-motion.js`, are left out of the package. Uploading it does not delete them from the server, which is harmless.

**Security and hosting**
- `api/private/` holds the database, CVs and ID documents. It is now blocked by a rule in the root `.htaccess` and by its own `api/private/.htaccess`. Before this, an uploaded document could be fetched from the web if someone knew its file name.
- All files are 644 and folders 755. Several images in the previous package were 600, so Apache may not have been able to read them.
- Added gzip compression and browser caching for CSS, JS and images. HTML is always revalidated.
- `/fees.html` and `/more-about-titopay.html` now redirect to their clean URLs like the other pages.

**SEO and sharing**
- New 1200×630 share image (`assets/titopay-share-card.jpg`) with og:image dimensions, site name and `en_ZA` locale on every public page.
- `more-about-titopay` used to point its canonical tag at the homepage. It now points to itself and is in the sitemap. The sitemap dates were refreshed.
- The 404 page uses root-relative paths, so its logo and styles also load on nested missing URLs such as `/a/b`.

**Launch email**
- Each launch email now sends a `List-Unsubscribe` header that points to the existing opt-out page, with a mailto fallback. Gmail, Outlook and Apple Mail show this as their own Unsubscribe button. Gmail and Yahoo expect the header on bulk mail. The email body is unchanged, so there is still no visible unsubscribe link, as the owner requested.
- **Decision for the owner:** POPIA section 69 expects every direct-marketing email to include a way to opt out. The header covers this in most mail apps. A small visible link in the footer is the safer choice and can be restored in `api/launch-email.html`.

**Still needs checking on the live host** (not possible from a local build): Apache rewrites and headers, MySQL, real email delivery with SPF/DKIM/DMARC for titopay.co.za, and installation on a physical iPhone and Android phone.

## Included

- A redesigned, responsive launch homepage using the supplied personal/business image and existing TitoPay branding and photography.
- Direct app links and Create your wallet calls to action across public pages.
- Prominent R0 signup, R0 monthly wallet access and R0 TitoPay-to-TitoPay transfer messaging, with other-service fee qualification.
- iPhone Safari and Android Chrome home-screen instructions on the homepage and at /install.
- Updated help answers, support assistant, page metadata and sitemap.
- Retired public waitlist forms. Old /waitlist links redirect to the app on Apache; the fallback HTML is also a launch page.
- Events remain a planned product, with contact enquiries instead of a waitlist.
- CEO-only launch announcement controls at /admin/launch.php, linked from the existing dashboard.

## Upload to the existing host

1. Back up the live website and its database using your usual hosting backup tool.
2. Extract titopay-launch-website.zip into the same document root that currently serves titopay.co.za. Upload hidden .htaccess files too. This is the original PHP/Apache structure, not a Node project.
3. Preserve the live api/config.local.php and everything already stored under api/private/, including the database and uploads. The package deliberately contains no local configuration credentials or live database files. Do not delete the existing document root before uploading.
4. Keep the existing PHP, PDO and database configuration. The campaign adds a launch_recipients table automatically using the existing database connection; the database user needs CREATE TABLE permission for the first run.
5. Clear any host/CDN HTML cache. Confirm /, /personal, /business, /install, /contact, /admin/ and /admin/launch.php on the real host. Confirm /waitlist redirects to the app.
6. Check the app links on an actual iPhone and Android device. The app's public PWA manifest was checked and declares standalone display, but physical-device installation and wallet onboarding were not exercised.

## Email existing waitlisters

1. Sign in to /admin/ using your existing CEO administrator account, then open Launch announcement. Support and HR accounts cannot send campaigns.
2. Click Import / refresh waitlisters. This reads all general wallet waitlist records from the existing public_submissions database table, not just the 500 records displayed on the dashboard. It deduplicates addresses after trimming and lowercasing. Contacts, applicants, invalid addresses and event-only registrations are excluded.
3. Add any existing opt-outs through Suppress an address. Historical records have no dedicated marketing-consent or unsubscribe column, so the tool cannot infer preferences stored outside this database.
4. Review the fixed launch email. Send a test to your own inbox. Confirm delivery, sender identity and links. The test must be accepted within the last hour before batches can be sent.
5. Confirm the audience and send the next batch of up to 20. Continue in batches while reviewing delivery logs and your host's sending limits. Each recipient receives an individual message; no addresses are exposed to other recipients.
6. Accepted, failed and processing recipients are not automatically resent. Refreshing or importing again preserves send history and suppressions. Accepted means the server mail function accepted the message, not that it reached the inbox. Failed or interrupted processing records require mail-log review before any manual retry.
7. The launch email is a branded HTML email with a plain-text alternative. Its visible unsubscribe section was removed at the owner's request. Existing suppression records remain enforced by the sender.

Mail uses the website's existing PHP mail() integration and configured mail_from address. This package does not provision SMTP or an email service. Configure and verify sender-domain authentication and real inbox delivery with your host before sending. No real waitlister or test emails were sent during development.

The campaign is intentionally one fixed app-launch announcement, not an ongoing newsletter platform. Delivery statuses and opt-outs are stored in launch_recipients and should be included in database backups. Preserve this table during later website updates.

## Verification

Passed: 449 local resource/link checks, page H1 checks, sitemap XML parsing, all 13 PHP files parsed, JavaScript syntax, desktop/mobile rendering, mobile navigation, FAQ expansion, and no horizontal overflow at a 390px viewport.

Isolated PHP 8.3 tests passed for imports, case-insensitive deduplication, batch limits, repeat protection, exclusions, suppressed recipients, interrupted sends, durable opt-out, invalid tokens, unauthenticated/unauthorised access, and CSRF rejection. Mail was mocked; the test database was disposable. PHP execution used SQLite; live Apache rewriting, MySQL operation and real email delivery still require host verification.

The public app URL and standalone installation manifest were fetched successfully. Installation wording follows Apple/WebKit and Chrome guidance:
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid

This is a marketing and website update. It is not a security certification or an audit of wallet services, regulatory status, or the existing legal policies. No bank licensing, deposit protection or unsupported certification claims were added.

## Rollback

Restore the backed-up website files if needed. Preserve the campaign database table so delivery history and unsubscribe preferences are not lost.
