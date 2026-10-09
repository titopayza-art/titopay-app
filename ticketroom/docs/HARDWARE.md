# Tags, readers and hardware plan

> **No hardware has been tested.** Everything below is a specification and procurement guide. The software accepts the input formats described, and the tests exercise those formats with simulated reader input.

## What the software accepts today

| Tag | What is read | Format sent to the API | Security level | Payment |
|---|---|---|---|---|
| **QR tag** (printed card, sticker or wristband) | QR text | `TRT1.<24-char random token>` | `random_token` | Yes, with PIN ≥ R200 and caps |
| **NFC wristband or card with an NDEF record** | NDEF text record written at encoding time | `TRT1.<token>` | `random_token` | Yes, same as QR |
| **NFC chip UID only** (factory serial) | Chip UID | `UID:04A1B2C3D4E5F6` (4/7/10-byte UIDs) | `uid_only` | **No** by default (`UID_ONLY_MAX_SALE_CENTS=0`). Admission and identification only. |

Readers:

* **Android phones (Chrome):** Web NFC reads NDEF text and the serial number. This is built into `/scan` and `/pos`. **iOS Safari has no Web NFC**, so iPhone tills must use QR tags or an external reader.
* **USB/Bluetooth HID readers** that "type" the value: these work with the manual-entry fields on `/scan` and `/pos`. Configure them to output the NDEF text, or the UID in hex.
* **Camera:** QR via `BarcodeDetector`, with a jsQR fallback.

## Why UID-only is not a payment credential

A chip UID is broadcast to any reader and can be cloned onto "magic" UID-changeable cards for a few rand. It identifies; it does not authenticate. The same applies to plain NDEF text, which can be copied with a phone app. The current mitigations (PIN for larger spends, low balance cap, instant blocking, per-event scoping) bound the loss but do not remove it.

## Recommended for real-money cashless

**NXP NTAG 424 DNA** wristbands or cards using **SUN/SDM**. Each tap produces a URL or record carrying an encrypted UID, a tap counter and an AES-CMAC that only the server can verify. Copied data is rejected because the counter must increase and the CMAC is per-tap.

Work needed (not built): per-tag AES key diversification from a master key held in an HSM/KMS, an encoding station, a `crypto_auth` security level, server-side CMAC and counter verification, and replay rejection on counter regression.

## Procurement criteria

| Criterion | Requirement |
|---|---|
| Chip | NTAG 424 DNA (payment). NTAG 213/215/216 acceptable for admission-only or identification. **Not** MIFARE Classic (broken crypto). |
| Standard | ISO/IEC 14443-A, NFC Forum Type 4 (424 DNA) or Type 2 (NTAG21x) |
| Read range | 1–4 cm (tap). Long-range UHF RFID is **out of scope**: not phone-readable, and a different threat model. |
| Wristband | Woven fabric or silicone, one-way locking closure (tamper-evident), IP67 or better, printable with display code and QR |
| Cards | PVC ISO ID-1, printable with display code. Scratch panel for the activation code. |
| Readers | Android 10+ phones with NFC (Chrome) for POS and desk. Optional USB HID readers (ACR122U-class) for fixed desks. |
| Throughput | Plan for ≤ 2 s per POS sale online, and ≥ 15 admissions/min per gate per device |
| Supply | Factory-unique UIDs, encoding service available, sample batch of 50 for a pilot test |
| Data on tag | **Never** a balance or card data. Only the token or UID. |

## QR implementation details

* Ticket QR: `TR1.<code>.<version>.<HMAC>`, error correction M, rendered server-side as SVG. It is cached on the device for offline display in the wallet.
* QR tags: `TRT1.<token>`, generated in admin batches and exported once as CSV for the printer. Display code `XXXX-XXXX` and a 6-character activation code are printed separately (scratch panel).
* Copied QR tags: limited the same way as NDEF (PIN, caps, blocking). Encourage attendees to keep tag QR codes covered.
