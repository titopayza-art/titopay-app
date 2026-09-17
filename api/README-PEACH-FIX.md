# Peach Payments 403 fix — API files

The TitoPay API is deployed from its own package (`api.zip`), not from this repository. This
directory carries **only the files changed by the Peach Payments Test Connection 403 fix**, at
their real paths inside the API package, so the change is reviewable and durable here.

It is not a full copy of the API. To deploy, use the corrected `api.zip` produced alongside this
change, or drop these files over an existing checkout at the same paths.

| File | Change |
| :-- | :-- |
| `src/services/peach-checkout-auth-service.js` | **New.** Peach Checkout V2 OAuth authentication. |
| `src/services/peach-payments-service.js` | `testPeachConnection()` delegates to Checkout auth. |
| `src/routes/admin.routes.js` | Test Connection routing, required fields, auth type; removed the Basic-auth probe that transmitted the Client Secret. |
| `src/routes/integrations.routes.js` | Peach `configured` flag reflects Checkout credentials. |
| `test/peach-payments-v2.test.js` | Checkout V2 authentication coverage. |
| `PEACH_PAYMENTS_V2_IMPLEMENTATION.md` | Scope note — that document covers the separate Payments API flow. |

`PEACH_CHECKOUT_403_FIX.md` documents the root cause, the exact authentication correction, and the
deployment notes. `PEACH_CHECKOUT_403_FIX.diff` is the complete diff against the previous API
package.
