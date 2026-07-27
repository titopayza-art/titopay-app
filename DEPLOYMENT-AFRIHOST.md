# TitoPay App PWA Deployment

Target domain: `https://app.titopay.co.za`

## Upload Structure

Upload the contents of this folder directly into the document root for `app.titopay.co.za`.

Required files:

```text
/
├── index.html
├── mobile-preview.html
├── offline.html
├── app.js
├── styles.css
├── manifest.webmanifest
├── service-worker.js
├── DEPLOYMENT-AFRIHOST.md
└── assets/
    ├── apple-touch-icon.png
    ├── icon-192.png
    ├── icon-512.png
    ├── maskable-512.png
    ├── splash-1170x2532.png
    └── titopay-logo.jpg
```

Do not upload this folder inside another `/app` folder unless the domain is intentionally configured to serve from `/app`.

## Production Configuration

`app.js` points the PWA to:

```text
APP_BASE_URL=https://app.titopay.co.za
API_BASE_URL=https://api.titopay.co.za
```

If the API domain changes, update `API_BASE` in `app.js` before uploading.

## Afrihost Notes

1. Enable HTTPS for `app.titopay.co.za`.
2. Upload all files and the `assets` folder to the web root.
3. Confirm `manifest.webmanifest` is served with `application/manifest+json` when possible.
4. Confirm `service-worker.js` is served from the same root as `index.html`.
5. Open `https://app.titopay.co.za/` and hard refresh once after deployment.
6. Test install from Chrome Android and Safari iPhone.

## Verification Checklist

- `https://app.titopay.co.za/` loads `index.html`.
- `https://app.titopay.co.za/manifest.webmanifest` loads.
- `https://app.titopay.co.za/service-worker.js` loads.
- `https://app.titopay.co.za/offline.html` loads.
- `https://app.titopay.co.za/mobile-preview.html` loads.
- Sign In and Create Account call `https://api.titopay.co.za`.
- Offline navigation displays the cached app shell or offline page.
