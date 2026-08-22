# Penetration Test — Scope of Work & Commissioning Pack

This is the document TitoPay hands to a CREST/OSCP-credentialed testing firm
to get a fixed quote and a booking. It exists because a bank's first
security question is "show us your latest independent penetration test," and
the honest current answer is "none." The fastest close to that finding is
not more code — it is commissioning this engagement. Everything below is
what a testing firm needs to price and scope the work; nothing here is a
finding, because the whole point is that findings must come from an
independent party.

## 1. Engagement objective

Independent security assessment of the TitoPay platform sufficient to
support (a) sponsor-bank due diligence, (b) POS partner (Flash/Yoco/iKhokha)
security reviews, and (c) the platform's own assurance baseline. TitoPay
seeks a **grey-box** test: authenticated credentials and this documentation
provided, source access offered for the API on request (the team believes
transparency yields better findings than a black-box guess).

## 2. Assets in scope

| Asset | Detail | Priority |
|---|---|---|
| Production API | `https://api.titopay.co.za` — Node/Express, ~200 route groups | **Critical** |
| Sandbox API | `https://api-sandbox.titopay.co.za` — identical code, `TITOPAY_ENV=sandbox` | High |
| Customer PWA | `https://app.titopay.co.za` | High |
| Admin console | `https://admin.titopay.co.za` — RBAC, dual-auth flows | **Critical** |
| Developer portal | `https://developers.titopay.co.za` — in-browser terminal signing | Medium |
| POS terminal API | HMAC-authenticated `/v1/pos/*` | **Critical** |
| Partner + webhook APIs | key auth, outbound signed webhooks (SSRF surface) | High |

## 3. Test focus areas (map findings to these)

1. **Authentication & session** — customer JWT + opt-in MFA; admin email-OTP
   with break-glass; refresh/rotation; account lockout; password/PIN reset
   flows (multiple, historically sensitive).
2. **Authorization / IDOR** — every object is meant to be owner-scoped; a
   prior internal review found none exploitable — try to break that claim
   across wallets, transactions, merchants, settlements, TitoKids, stokvels.
3. **Money-movement integrity from the outside** — attempt via the API what
   the internal tests attempt in-process: replay, double-spend a dynamic QR,
   refund beyond original, tamper idempotency keys, race limits.
4. **POS terminal HMAC** — canonical-request construction, timestamp window
   (±300s), nonce replay, signature bypass.
5. **Partner keys & webhooks** — key enumeration/leakage; environment-bind
   bypass (sandbox key on production); **SSRF via webhook endpoint
   registration** (a guard exists — try to defeat it); signature forgery.
6. **Admin & privilege escalation** — RBAC enforcement per permission;
   defeat the dual-authorization control (self-approval is refused in code
   AND by DB CHECK — attempt to circumvent both).
7. **Injection & input** — SQLi (parameterised throughout — verify), XSS in
   the PWA/console/portal, template injection in emails.
8. **Rate limiting & DoS** — limiter bypass; the limiter degrades to
   in-memory rather than failing open — confirm.
9. **Crypto & secrets** — token/OTP/ticket-code randomness; secret exposure
   in responses, logs, error messages, or the developer portal's browser-side
   signing.
10. **Business logic** — fees, limits, settlement windows, coupon/discount
    abuse, ticket/gate-scan double-use.

## 4. Rules of engagement

- **Environment:** primary testing against **sandbox** (production-identical
  code); a bounded, scheduled production window for checks that cannot be
  sandbox-verified, agreed in writing per session.
- **Windows:** business-hours SAST with the operator reachable; DoS/stress
  only in a pre-agreed window with rollback ready.
- **Data:** sandbox provisions its own synthetic merchants/customers — use
  those. Any real personal data encountered must be reported, not retained;
  do not exfiltrate production data as "proof" — a redacted reference
  suffices.
- **Money:** sandbox money is not real. Do not attempt to move real customer
  float in production; demonstrate money-movement findings in sandbox.
- **Stop conditions:** halt and call the operator on discovery of a live
  critical (active data exposure, funds at risk) rather than proceeding.
- **Retest:** a remediation retest of all High/Critical findings is included
  in scope.

## 5. Deliverables required from the tester

1. Executive summary suitable for a bank due-diligence pack.
2. Findings with CVSS v3.1, reproduction steps, evidence, and remediation.
3. A signed attestation letter naming the firm, credentials (CREST etc.),
   dates, scope, and methodology (OWASP ASVS / WSTG, PTES).
4. Remediation retest report.
5. A one-page **letter of engagement completion** — the artifact TitoPay
   shows a sponsor bank.

## 6. Standards to test against

OWASP ASVS L2 (payment application target), OWASP WSTG, OWASP API Security
Top 10, PTES. Where the platform's PCI scope is relevant (hosted Peach
checkout — card data does not touch TitoPay), confirm scope minimisation
rather than full PCI penetration.

## 7. Commercial

Fixed-price quote requested against the asset list and focus areas above.
Indicative market range for a platform of this surface is a 5–10 day
engagement plus retest; TitoPay will provide credentials, this pack, and
same-day access to the operator throughout. Preferred start: within 30 days
of sponsor-bank discovery kick-off, so the attestation exists before the
first security workshop.

## 8. What TitoPay provides on day one

Sandbox credentials and partner API keys; this repository's assurance docs;
the OpenAPI specification (`docs/openapi-titopay.yaml`); the architecture
summary in `docs/assurance/SPONSOR-BANK-STRUCTURE.md`; and a direct channel
to the operator for the duration.
