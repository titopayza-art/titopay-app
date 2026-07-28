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
│   └── admin.js
├── dashboard/
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
- Navigation routes are root routes:
  - `/dashboard/`
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

## Blank Screen Checklist

If the deployed page is blank:

1. Confirm `admin.titopay.co.za/index.html` exists.
2. Confirm `admin.titopay.co.za/assets/admin.js` returns JavaScript, not a 404 page.
3. Confirm `admin.titopay.co.za/assets/admin.css` returns CSS, not a 404 page.
4. Confirm the files were uploaded to the domain root, not nested under `/admin`.
5. Confirm `.htaccess` was uploaded. Some FTP clients hide dotfiles.
6. Confirm the browser console has no blocked `admin.js` request.
7. Confirm the hostname is exactly `admin.titopay.co.za`; `www.admin.titopay.co.za` redirects to the canonical host.
