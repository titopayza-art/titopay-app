# TitoPay Admin Afrihost Deployment

Upload the contents of this `admin` folder to the document root for:

`admin.titopay.co.za`

Do not upload the folder as `/admin` inside the domain root. The files below must be directly inside the domain root.

## Required Server Structure

```text
admin.titopay.co.za/
├── .htaccess
├── index.html
├── assets/
│   ├── admin.css
│   ├── admin.js
│   └── admin-analytics.js
├── dashboard/
│   └── index.html
├── analytics/
│   └── index.html
├── users/
│   └── index.html
├── merchants/
│   └── index.html
├── transactions/
│   └── index.html
├── wallets/
│   └── index.html
├── support/
│   └── index.html
├── compliance/
│   └── index.html
├── revenue/
│   └── index.html
├── security/
│   └── index.html
├── audit/
│   └── index.html
└── settings/
    └── index.html
```

## Path Rules

- Root login page loads assets with relative paths:
  - `assets/admin.css`
  - `assets/admin.js`
- Section pages load assets with relative parent paths:
  - `../assets/admin.css`
  - `../assets/admin.js`
- `assets/admin-analytics.js` is imported by `assets/admin.js` at runtime, the
  first time an operator opens Analytics. It is fetched from the same `assets/`
  folder, so it must be uploaded alongside `admin.js`. Nothing else requests it,
  and no other page changes if it is missing — only Analytics reports that it
  could not load.
- Navigation routes are root routes:
  - `/dashboard/`
  - `/analytics/`
  - `/users/`
  - `/merchants/`
  - `/transactions/`
  - `/wallets/`
  - `/support/`
  - `/compliance/`
  - `/revenue/`
  - `/security/`
  - `/audit/`
  - `/settings/`

## Required API

The production portal calls:

`https://api.titopay.co.za/v1`

Make sure CORS on `api.titopay.co.za` allows:

`https://admin.titopay.co.za`

## Live Admin API Endpoints

- Admin login / send OTP: `POST https://api.titopay.co.za/v1/admin/login`
- Verify OTP: `POST https://api.titopay.co.za/v1/admin/login/verify`
- Resend OTP: `POST https://api.titopay.co.za/v1/admin/login/resend-otp`
- Reset password request: `POST https://api.titopay.co.za/v1/auth/password-reset`
- Reset password confirm: `POST https://api.titopay.co.za/v1/auth/password-reset`
- Refresh session: `POST https://api.titopay.co.za/v1/auth/refresh`
- Get admin profile: `GET https://api.titopay.co.za/v1/admin/me`
- Dashboard overview: `GET https://api.titopay.co.za/v1/admin/dashboard/overview`

## Analytics Endpoints

Analytics reads the admin endpoints that were already live. It adds no required
endpoint and changes no payload:

`/admin/dashboard/overview`, `/admin/users`, `/admin/merchants`,
`/admin/wallets`, `/admin/transactions`, `/admin/revenue`,
`/admin/compliance/queue`, `/admin/support/tickets`,
`/admin/support/conversations`, `/admin/security`, `/admin/module-health`,
and, per section, `/admin/audit`, `/admin/marketing/reviews`,
`/admin/qr-assets`, `/admin/chat-monitor/overview`, `/admin/maintenance`,
`/admin/integrations/webhooks`, `/admin/email/dashboard`.

`GET /admin/analytics/overview` is optional. The module asks for it, uses it
when it answers, and works normally when it does not exist.

## Blank Screen Checklist

If the deployed page is blank:

1. Confirm `admin.titopay.co.za/index.html` exists.
2. Confirm `admin.titopay.co.za/assets/admin.js` returns JavaScript, not a 404 page.
3. Confirm `admin.titopay.co.za/assets/admin.css` returns CSS, not a 404 page.
4. Confirm the files were uploaded to the domain root, not nested under `/admin`.
5. Confirm `.htaccess` was uploaded. Some FTP clients hide dotfiles.
6. Confirm the browser console has no blocked `admin.js` request.
7. Confirm the hostname is exactly `admin.titopay.co.za`; `www.admin.titopay.co.za` redirects to the canonical host.
