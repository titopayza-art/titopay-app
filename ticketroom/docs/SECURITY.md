# Security threat model

The method is STRIDE-style, applied to each asset. Status is one of: **Mitigated (tested)**, **Mitigated**, **Partial** or **Open**. The tests are in `tests/*.test.js`.

## Assets

Customer funds and balances. Ticket entitlement. Personal information (POPIA). Organiser revenue and bank details. Ledger integrity. Platform keys.

## Threats and controls

| # | Threat | Control | Status |
|---|---|---|---|
| 1 | **QR copying and replay** (screenshots) | Random 10-character code plus HMAC signature with version. Admission is one atomic `UPDATE … WHERE status='valid'`. Transfer or reissue bumps the version and kills old copies. Users are told "first scan wins". | Mitigated (tested). A copied *current* QR still works once: inherent to static QR. Dynamic/rotating QR is future work. |
| 2 | **Guessed or forged QR** | 22-character truncated HMAC-SHA256 (~128 bits) is checked before any lookup | Mitigated (tested) |
| 3 | **RFID/NFC cloning** | Raw tag values are never stored (HMAC with pepper). UID-only tags are refused for payment by default. A PIN is required ≥ R200. Balance cap R5,000. Instant lost-tag block. Per-sale cap. | **Partial.** NDEF-token and QR tags are copyable. Cryptographic tags (NTAG 424 DNA SUN) are not yet supported (`HARDWARE.md`). |
| 4 | **Tag theft / unauthorised relink** | Self-link needs display code **and** a secret activation code (scrypt-hashed, 5 tries/hour lockout). One active tag per person per event. Relink only through desk staff. Every change is in `tag_events`. | Mitigated (tested) |
| 5 | **Vendor terminal compromise** | A terminal key (hashed) **and** a cashier session from the same vendor are both required. Suspend from organiser/admin. `last_seen_at` monitoring. Server prices only. | Mitigated (tested). The key is in device localStorage, so a stolen *unlocked* device with a session can transact until suspended. |
| 6 | **Forged payment confirmation** | Only verified provider webhooks or direct provider queries confirm. The success-page redirect changes nothing. The amount must equal the expected amount. | Mitigated (tested) |
| 7 | **Duplicate purchases or charges** | Idempotency keys (orders, top-ups, POS) with unique indexes. Unique provider references. Journal idempotency keys. Refund idempotency key at the provider. | Mitigated (tested) |
| 8 | **Race conditions / overdraft / oversell** | Row locks plus conditional updates plus CHECK constraints. Deadlock retry. | Mitigated (tested: 20 buyers for 5 tickets, 12 spenders on 1 balance, 8 gates on 1 ticket) |
| 9 | **Webhook forgery and replay** | HMAC-SHA256 with timestamp, 300 s tolerance, and unique event ids. Rejected deliveries are stored (size only) and visible to admins. | Mitigated (tested) |
| 10 | **Broken object-level authorisation** | All organiser, vendor and event access goes through `access.js`. Tenancy is checked on every nested id. 404 for foreign objects. | Mitigated (tested: 14 foreign-tenant probes) |
| 11 | **Privilege escalation** | Platform roles are server-side. No self role changes. Finance approvals are separate from admin. The organiser member role matrix is enforced. | Mitigated (tested) |
| 12 | **Refund fraud** | Maker-checker (code + DB CHECK). Refunds go only to the original payment method via the provider. A ticket must still be valid (unused). One open refund per ticket or sale. | Mitigated (tested) |
| 13 | **Organiser/vendor account takeover** | scrypt passwords (≥ 10 chars). Generic login errors. Lockout after 5 failures. Session revocation on password change or reset. Bank change audited. **No MFA yet.** | **Partial.** MFA for organiser owners, finance and admin is required before the pilot. |
| 14 | **Data exposure** | Minimal PII. Bank account AES-256-GCM encrypted (last 4 in clear). Finance-only, audited reveal. Masked addresses in admin message views. Export and delete for data subjects. Retention jobs. | Mitigated |
| 15 | **Malicious uploads** | 2 MB cap. Type decided by magic bytes (PNG/JPEG/WebP only, SVG refused). Random id file names outside the web root. Served with `nosniff` and a `sandbox` CSP. | Mitigated (tested). Images are not re-encoded (future: strip metadata). |
| 16 | **XSS** | Strict CSP (`script-src 'self'`, no `unsafe-inline` for scripts or styles). Every interpolation escaped through `html```. | Mitigated (tested: zero CSP violations in the browser walkthrough) |
| 17 | **CSRF** | SameSite=Lax cookie, JSON-only bodies, and a per-session `X-CSRF-Token` | Mitigated (tested) |
| 18 | **SQL injection** | Parameterised queries only. LIKE patterns escaped. | Mitigated |
| 19 | **Dependency vulnerabilities** | Exact pinned versions with a lockfile. `npm audit` gives 0 vulnerabilities after the Express 4.22.3 upgrade. Audit runs in CI. | Mitigated (process needed: monthly review) |
| 20 | **Denial of service** | Per-IP, user and terminal rate limits. Body size limits. Paged/limited queries. | **Partial.** The limiter is in-memory, single instance. Use Cloudflare/WAF and a shared limiter for multiple instances. |
| 21 | **Ledger manipulation** | Append-only triggers. Balance trigger. Reversal-only corrections. Hash-chained audit log detects edits made around the triggers. | Mitigated (tested). **Requirement:** run the app as a DB role that does **not** own the tables, so it cannot disable triggers. |
| 22 | **CSV/formula injection in exports** | Cells starting `= + - @` are prefixed | Mitigated |
| 23 | **Secret exposure** | No secrets in the repo. Production refuses dev keys. Logs carry request ids, not bodies or headers. The audit scrubber redacts password/pin/token/key/account fields. | Mitigated (tested) |
| 24 | **Marketing abuse / spam** | Consent per organiser per channel. Re-checked at send time. Signed unsubscribe (POST, not link prefetch). Organiser must be approved. 10 campaigns/day. | Mitigated (tested) |

## Operational security requirements before a pilot

1. Separate database roles: `ticketroom_owner` for migrations, and `ticketroom_app` with DML only (no DDL, not the table owner). See `OPERATIONS.md`.
2. TLS everywhere. HSTS is on in production. Cloudflare in front with WAF rules on `/api/auth/*`, `/api/webhooks/*` and `/api/pos/*`.
3. MFA (TOTP) for organiser owner/finance and all platform roles. **Not built.**
4. Keys from a secret manager. Rotate `LINK_SIGNING_KEY` and `SIM/provider` secrets yearly. `QR_SIGNING_KEY` rotation needs key versioning, which is not built.
5. An independent penetration test and a review of this threat model.
