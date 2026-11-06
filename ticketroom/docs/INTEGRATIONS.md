# Integrations status

| Integration | Status | Notes |
|---|---|---|
| Payment provider | **SIMULATED** (`simulated` adapter) | Hosted checkout, signed webhooks, status query, idempotent refunds, settlement report. To be replaced by a real adapter when the provider, docs and sandbox credentials are supplied. TitoPay's existing provider integration lives in the TitoPay API (not visible here). |
| TitoPay wallet as a payment method | Not built | Needs a TitoPay-side API contract (debit with idempotency key, webhook or callback, refund). Would be added as provider adapter `titopay`. |
| Email delivery | **SIMULATED** (`log` adapter: records and marks "sent", sends nothing) | Add an SMTP or transactional-email adapter in `modules/messaging/outbox.js`. SPF, DKIM and DMARC for `ticketroom.co.za`. |
| SMS delivery | **SIMULATED** (`log`) | Add a local SMS gateway adapter. Sender ID registration needed. The cost estimate uses `SMS_COST_PER_SEGMENT_CENTS`. |
| NFC hardware | Untested | Web NFC (Android Chrome) and HID readers via manual input. See `HARDWARE.md`. |
| Bank payouts | Manual by design | Finance makes the EFT outside the system and records the reference. No bank API. |

The UI states clearly where delivery or payment is simulated: the simulator page banner, and the marketing page callout.
