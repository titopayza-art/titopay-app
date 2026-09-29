# TitoPay — app store packaging kit

Everything needed to put the live PWA (https://app.titopay.co.za) into the
app stores. The app itself does not change: the Android package is a thin
wrapper that opens the PWA fullscreen, so every PWA deploy updates the "app"
instantly with no store review.

Contents:

    store/google-play/twa-manifest.json   Bubblewrap build config (ready to use)
    store/listing/feature-graphic-1024x500.png
    store/listing/store-listing-copy.md   Title, descriptions, data-safety answers
    store/listing/account-deletion-page.md  Copy for the required public deletion page
    pwa/.well-known/assetlinks.json       Domain proof — needs your key fingerprint

---

## Google Play — step by step

Prerequisites: Node 18+, Java 17+ (Bubblewrap offers to install its own JDK
and Android SDK on first run — say yes). Play Console organisation account
(D-U-N-S: done).

**1. Build the app package** (on your own machine, in a new empty folder):

    npm i -g @bubblewrap/cli
    # copy store/google-play/twa-manifest.json into the folder first
    bubblewrap build

    # First run: it creates the signing keystore at ./titopay-play.keystore
    # and asks you to choose keystore + key passwords. WRITE THEM DOWN and
    # BACK UP THE FILE like your .env — losing it loses the app identity.

Output: `app-release-bundle.aab` (upload this) and
`app-release-signed.apk` (useful later for Huawei).

**2. Fill in the domain proof.** Print your signing key's SHA-256:

    keytool -list -v -keystore ./titopay-play.keystore -alias titopay | grep SHA256

Copy the `AA:BB:CC:...` value into
`pwa/.well-known/assetlinks.json` (replacing REPLACE_WITH_YOUR_SHA256_FINGERPRINT),
then deploy the PWA so it serves at:

    https://app.titopay.co.za/.well-known/assetlinks.json

(Then verify that URL in a browser.) Note: if you later enable Play App
Signing and let Google hold the signing key, use the SHA-256 that the Play
Console shows under Setup -> App signing instead.

**3. Play Console** (play.google.com/console):
- Create the app: TitoPay, App (not game), Free, category Finance.
- Upload `app-release-bundle.aab` to an internal testing track first; install
  it on a real phone and check it opens fullscreen with no browser bar (that
  proves assetlinks.json is right).
- Store listing: copy from `store/listing/store-listing-copy.md`, the feature
  graphic from `store/listing/`, screenshots from the preview images already
  generated, the 512 icon from `pwa/assets/icon-512.png`.
- Policy forms: Privacy policy URL, Data safety (answers drafted in the
  listing copy file), Account deletion URL (publish
  `account-deletion-page.md` on titopay.co.za first), Financial features
  declaration (have your regulatory/partner documentation ready to attach).
- Content rating questionnaire, target audience 18+, then submit for review.
  Finance apps review slower than average — days to a few weeks.

## Huawei AppGallery (after Play)

- Register at developer.huawei.com (free; business verification uses the same
  D-U-N-S).
- Upload the `app-release-signed.apk` from the same Bubblewrap build. Test it
  on a Huawei device first: the TWA needs a browser that supports Custom Tabs
  — on Google-free Huawei phones it falls back to a custom tab, which works
  but shows more browser chrome. If that experience is not good enough,
  the next step is a small Capacitor wrapper instead (a separate task —
  say the word).
- Reuse the same listing assets and copy. Their finance category also asks
  for regulatory documentation.

## Apple App Store (deliberately last)

No wrapper shortcut exists: Apple rejects thin website wrappers (Guideline
4.2), and finance apps must be published by the licensed entity itself with
documentation (3.1.5). The path is a Capacitor app with native touches
(biometric unlock, push, native share), built and signed on a Mac with an
Apple Developer org account ($99/year). iPhone users install the PWA from
Safari in the meantime, so nothing is blocked. Treat this as its own project
when Play + AppGallery are live.

## The one rule that keeps this safe

The keystore file and its passwords are the app's identity. Back them up
off the server, never commit them, and never regenerate them casually — a
replacement key means Play treats the app as a different app.
