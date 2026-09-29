# POS Acquiring-Bank Integration Contract

The TitoPay wallet-funded dynamic QR flow is implemented. No undocumented bank
or Speedpoint API has been fabricated.

Provider adapters exist for `STANDARD_BANK`, `ABSA`, `NEDBANK`, `CAPITEC`, and
`OTHER`. Until official provider documentation and credentials are supplied,
the adapters return:

```json
{
  "supported": false,
  "reason": "Awaiting official acquiring-bank/POS integration specification."
}
```

To activate a provider, supply its official:

- terminal registration and credential lifecycle;
- request signing canonicalisation and key rotation policy;
- payment request and cancellation schemas;
- status notification/webhook schema;
- refund and reversal rules;
- retry, timeout, idempotency, and reconciliation rules;
- sandbox base URL and test credentials;
- production allow-listing requirements.

Provider-specific code must stay behind `src/pos/providers/`. It must not write
wallet balances directly. A provider status is evidence only; TitoPay settlement
must continue through the existing transaction and wallet-ledger transaction.

