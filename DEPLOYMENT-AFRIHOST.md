# TitoPay App PWA Deployment

Target domain: `https://app.titopay.co.za`

## Upload Structure

Upload the contents of this folder directly into the document root for `app.titopay.co.za`.

Required files (every one of these is requested by `index.html`,
`service-worker.js`, `manifest.webmanifest` or `app.js` at runtime):

```text
/
├── index.html
├── offline.html
├── app.js
├── styles.css
├── services-default.json
├── manifest.webmanifest
├── favicon.ico
├── DEPLOYMENT_BUILD_MARKER.txt
├── service-worker.js          <- upload LAST, see Upload Order
└── assets/
    ├── apple-touch-icon.png
    ├── favicon.png
    ├── icon-192.png
    ├── icon-512.png
    ├── jsQR.min.js
    ├── maskable-512.png
    ├── splash-1170x2532.png
    └── titopay-logo.jpg
```

Do not upload this folder inside another `/app` folder unless the domain is intentionally configured to serve from `/app`.

## Upload Order

`service-worker.js` must be the **last** file uploaded.

The worker precaches a fixed list of versioned URLs on install. If it is
uploaded before the assets it names, the install fires against a web root that
still holds the previous build, the precache fails or caches stale files, and
returning visitors are served a mixed build.

1. `assets/` (all files)
2. `services-default.json`, `manifest.webmanifest`, `favicon.ico`, `offline.html`
3. `styles.css`
4. `app.js`
5. `index.html`
6. `DEPLOYMENT_BUILD_MARKER.txt`
7. `service-worker.js` — last

Then hard refresh once so the new worker installs and the old cache is deleted.

## Production Configuration

`app.js` points the PWA to:

```text
APP_BASE_URL=https://app.titopay.co.za
API_BASE_URL=https://api.titopay.co.za
```

If the API domain changes, update `API_BASE` in `app.js` before uploading.

## Afrihost Notes

1. Enable HTTPS for `app.titopay.co.za`.
2. Upload all files and the `assets` folder to the web root, following Upload Order above.
3. Confirm `manifest.webmanifest` is served with `application/manifest+json` when possible.
4. Confirm `service-worker.js` is served from the same root as `index.html`.
5. Open `https://app.titopay.co.za/` and hard refresh once after deployment.
6. Test install from Chrome Android and Safari iPhone.

## Verification Checklist

- `https://app.titopay.co.za/` loads `index.html`.
- `https://app.titopay.co.za/manifest.webmanifest` loads.
- `https://app.titopay.co.za/service-worker.js` loads.
- `https://app.titopay.co.za/offline.html` loads.
- `https://app.titopay.co.za/services-default.json` loads.
- `https://app.titopay.co.za/DEPLOYMENT_BUILD_MARKER.txt` matches the build being deployed.
- `index.html` requests `styles.css` and `app.js` at the deployed version, with no
  reference to the previous version anywhere in the served HTML.
- Sign In and Create Account call `https://api.titopay.co.za`.
- Offline navigation displays the cached app shell or offline page.

`mobile-preview.html` and `splash-render.html` are development preview pages.
They are not part of the production package and nothing at runtime requests them.
