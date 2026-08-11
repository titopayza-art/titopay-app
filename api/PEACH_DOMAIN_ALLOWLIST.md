# Peach Checkout — "Merchant domain is not allowlisted"

## 1. Exact merchant domain TitoPay sends to Peach

```
Referer: https://app.titopay.co.za/
Origin:  https://app.titopay.co.za
```

Built in `src/services/peach-checkout-service.js`:

```js
function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "https://app.titopay.co.za").replace(/\/+$/, "");
}
…
headers: {
  authorization: `Bearer ${accessToken}`,
  accept: "application/json",
  "user-agent": "TitoPay-PeachCheckout/1.0",
  origin: appBaseUrl(),
  referer: `${appBaseUrl()}/`
}
```

Verified against a stand-in that records what it actually received —
`domain-allowlist.spec.js` asserts the **app** domain arrives, not the API
domain, and that it is a well-formed absolute URL.

## 2. Why the Referer, and not shopperResultUrl

The published reference for `POST /v2/checkout` marks **`Referer` as a required
header parameter**, described as *"An allowlisted domain for the merchant."*
That is the value Peach checks. `shopperResultUrl`, `cancelUrl` and
`notificationUrl` legitimately point at `api.titopay.co.za` — they are
server-side callbacks, not the merchant domain, and the reference does not
require them to be allowlisted.

Reference: https://developer.peachpayments.com/reference/post_v2-checkout

## 3. Is the TitoPay code correct?

**Yes — no correction required**, provided `APP_BASE_URL` is not overridden to
something else in production. The default and the intended value are both
`https://app.titopay.co.za`.

Confirm on the server:

```bash
pm2 env 0 | grep APP_BASE_URL      # or: grep APP_BASE_URL /opt/titopay-api/.env
```

* Unset, or `https://app.titopay.co.za` → the code is sending the right domain.
* Anything else (especially `https://api.titopay.co.za`) → that env var is the
  fault; correct it and restart. No code change needed either way.

## 4. Does Peach have to do the allowlisting?

**Yes.**

> **Peach must allowlist `app.titopay.co.za` for this Sandbox merchant.**

Nothing in TitoPay can satisfy this, and nothing should try to. Domain
allowlisting is a Peach-side merchant control; working around it would defeat
the protection it exists to provide. No workaround has been added.

## 5. Error classification (point 7)

A Peach 400 carrying a domain rejection previously fell into the generic
`PROVIDER_REQUEST_FAILED` bucket. It is now recognised and classified:

| | |
| --- | --- |
| HTTP to the PWA | **503** (not a generic 502 — retrying cannot help until Peach allowlists) |
| Diagnostic code | **`PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED`** |
| Customer sees | *"Card top-ups are temporarily unavailable while TitoPay completes a payment-provider setup step. Nothing was charged and your wallet is unchanged."* |
| Customer does **not** see | Peach's wording, the provider name, the domain, or any internal detail |
| Transaction | recorded **failed** — never left pending |

The server log now names the cause and the exact domain presented, so this
question never needs asking again:

```
[peach-checkout] PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED — Peach must allowlist this domain for the merchant
  domainSent: 'https://app.titopay.co.za'
  action: 'Add this exact domain under the Peach Dashboard for this merchant, or correct APP_BASE_URL if it is wrong.'
```

Matching is on the distinctive parts (`domain` + `allowlist|whitelist|not
permitted|not registered`) rather than the exact sentence, so a rephrasing by
Peach does not send it back to the generic bucket.

## 6. The 401 "Bearer token required" entries

Investigated **separately**, and they are a different fault — the evidence does
not tie them to this checkout failure. They were caused by a client-side defect
in which `api()` called `refreshCustomerSession()` inside its network `try`
block, so a failed session refresh was rewritten as *"TitoPay services are not
reachable"* and attributed to `/v1/payments/topup`. Fixed in the PWA (v281),
documented in `PEACH_PROVIDER_TIMEOUT_FIX.md`, addendum 4. It is unrelated to
the domain allowlist and neither fix depends on the other.

## Files changed

`src/services/peach-checkout-service.js` — one new classifier
(`isMerchantDomainRejection`), the branch that uses it, and the domain added to
the failure log. **No change** to credentials, authentication, the Peach Payout
integration, the wallet ledger, balances, confirmation security, KYC/FICA, or
any unrelated route.

## Verification

`domain-allowlist.spec.js` — **11/11**: proves which domain is sent, that a
rejection is classified as `PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED` with 503,
that the customer sees none of the provider detail, that the attempt is
recorded failed rather than pending, and that top-ups resume the moment the
domain is accepted.

Regression: top-up 32/32 · fee preview 31/31 · withdrawal 61/61 · service
routing 51/51 · PWA routing 44/44 · unit suite 207/210 (the same three that fail
in the original build).
