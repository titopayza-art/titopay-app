# Apple Wallet & Google Wallet passes — setup

The "Add to Apple Wallet" / "Add to Google Wallet" buttons on tickets are fully
built and switch on the moment the signing credentials below are configured.
Until then the endpoints answer an honest 404 and the app shows "This ticket
does not have an … Wallet pass yet. The QR code above is still valid for
entry."

A wallet pass is a **cryptographically signed object**. Apple and Google only
accept passes signed with credentials issued to *your* accounts — no code can
work around that, which is why these are configuration, not features to build.

---

## Apple Wallet

What you need: an **Apple Developer Program** membership (US$99/year,
https://developer.apple.com/programs/).

1. **Create a Pass Type ID**
   developer.apple.com → Account → Certificates, Identifiers & Profiles →
   Identifiers → “+” → **Pass Type IDs** → e.g. `pass.za.co.titopay.ticket`.
2. **Create the pass certificate**
   Select the new Pass Type ID → Create Certificate → upload a CSR (Keychain
   Access → Certificate Assistant → Request a Certificate) → download the
   `.cer` → open it in Keychain → export certificate **with private key** as
   `titopay-pass.p12` (choose a password).
3. **Download Apple’s WWDR intermediate certificate** (G4):
   https://www.apple.com/certificateauthority/ → “Worldwide Developer Relations
   – G4” → convert to PEM: `openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem`
4. **Find your Team ID**: Account → Membership details (10 characters).
5. **Set the environment variables** on the API server:

   ```
   APPLE_WALLET_CERT_P12_BASE64=$(base64 -w0 titopay-pass.p12)
   APPLE_WALLET_CERT_PASSWORD=<the p12 password>
   APPLE_WALLET_PASS_TYPE_ID=pass.za.co.titopay.ticket
   APPLE_WALLET_TEAM_ID=<your 10-char team id>
   APPLE_WALLET_WWDR_PEM_BASE64=$(base64 -w0 wwdr.pem)
   ```

6. Restart the API. “Add to Apple Wallet” now serves a signed `.pkpass` and
   iPhones raise the native save sheet. The pass barcode carries the SAME
   payload as the in-app ticket QR, so the door scanner accepts either.

## Google Wallet

What you need: a **Google Wallet API issuer account**
(https://pay.google.com/business/console → Google Wallet API).

1. Sign up as an issuer and note the numeric **Issuer ID**.
2. In Google Cloud Console create a **service account**, grant it the Wallet
   API, and create a **JSON key**; also add the service account under the
   Wallet console’s “Users”.
3. Create one **Event ticket class** with id `titopay-event-ticket` (the code
   references `<ISSUER_ID>.titopay-event-ticket`).
4. Set the environment variables:

   ```
   GOOGLE_WALLET_ISSUER_ID=<numeric issuer id>
   GOOGLE_WALLET_SA_EMAIL=<service account email>
   GOOGLE_WALLET_SA_KEY_BASE64=$(base64 -w0 <(jq -r .private_key key.json))
   ```

5. Restart the API. “Add to Google Wallet” now returns a signed
   Save-to-Google-Wallet link.

---

## Deployment note

This feature adds one npm dependency (`node-forge`). After extracting a new
`api.zip`, run `npm install` in the API directory once so it is present.

## Verifying

`api/test/wallet-passes.test.js` proves the pipeline end to end with a
self-signed certificate (ZIP structure, manifest hashes, PKCS#7 signature,
Google JWT). With the real credentials configured, open any ticket in the app
and tap the wallet button — the pass appears in Wallet with the event name,
venue, date and the scannable entry QR.
