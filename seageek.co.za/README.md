# seageek.co.za

Corporate website for **SeaGeek Technologies (Pty) Ltd**: *Intelligence. Connected.*

A static site (HTML, CSS and vanilla JS) with no build step and no dependencies. Upload it to any web host.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Home: hero, 10 products, platform, industries, pricing, trust, roadmap, early access |
| `developers.html` | API preview: quickstart, auth, environments, idempotency, webhooks, errors, endpoints, SDKs |
| `about.html` | Vision, mission, values, how we're building, partners & investors |
| `contact.html` | Enquiry form and contact channels (`?plan=business` pre-selects a plan) |
| `privacy.html` | POPIA privacy notice, PAIA, acceptable use (**draft, needs legal review**) |
| `404.html` | "Lost at sea" error page |

## Deploy

1. Upload the **contents** of this folder to your web root (`public_html/` on Afrihost or cPanel hosts).
2. `.htaccess` handles the 404 page, forces HTTPS on `www.seageek.co.za`, and sets security and caching headers (Apache).
   On Netlify, Vercel or Cloudflare Pages, upload the folder as-is. Those hosts ignore `.htaccess`.
3. Make sure an SSL certificate is active before the HTTPS redirect goes live.

## Before going live

- [ ] Set up the mailboxes used on the site: `hello@`, `sales@`, `partners@`, `privacy@seageek.co.za`.
- [ ] Forms currently open the visitor's email app (`mailto:`). To collect submissions directly, point the forms at a form service or your own endpoint (see `assets/js/main.js`, the `form[data-mailto]` handler).
- [ ] Have the privacy notice reviewed by a POPIA practitioner, then remove the "Draft" notices.
- [ ] Confirm final pricing (the current figures come from the business plan and are marked "indicative").
- [ ] Update the footer once the company is registered (add the registration number and remove "registration pending").
- [ ] Trademark clearance for "SeaGeek".
- [ ] Partner names (home page, "Partner network") are plain text with a no-endorsement note. Once agreements are signed, confirm each partner is happy to be named, and get permission before adding any partner logos.

The site deliberately leaves out the business plan's financial projections and fundraising figures. They're confidential and belong in the investor pack, not on a public website.

## Editing

- Colours, fonts and spacing are defined as tokens at the top of `assets/css/style.css`.
- The animated seabed is `assets/js/ocean.js`. Any `<canvas data-ocean data-horizon="0.5">` renders one. It pauses when off-screen and falls back to a still frame for visitors who prefer reduced motion.
- Header and footer markup is repeated in each page, so edit them in every file.
