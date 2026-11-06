# Roles and permission matrix

Every check runs on the server (`src/middleware/access.js`, `requirePlatformRole`, and in-service checks). The UI only hides controls. Objects outside the caller's tenancy return 404.

## Roles

| Role | Scope | How granted |
|---|---|---|
| Attendee | Own data | Any account |
| Organiser **owner** / **manager** / **marketing** / **finance** / **viewer** | One organiser | Organiser owner adds by email |
| Event staff (`can_scan`, `can_manage_tags`) | One event | Organiser owner/manager |
| Vendor **manager** / **cashier** | One vendor (one event) | Organiser owner/manager |
| Platform **support** | All customers (read), tag blocking, QR reissue, cases | Admin |
| Platform **finance** | Refund, payout and reconciliation decisions | Admin |
| Platform **admin** | Approvals, users, roles, events, tag batches, terminals | Admin (not self) |

## Matrix (✓ allowed · ✗ refused · — not applicable)

| Capability | Attendee | Org owner | Org manager | Org marketing | Org finance | Org viewer | Event staff | Vendor mgr | Cashier | Support | Finance | Admin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Buy, view and transfer own tickets | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Link a tag, report it lost, top up, request balance refund | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create and edit events and ticket types | — | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Submit an event for approval | — | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Publish, reject or suspend an event | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Request event cancellation | — | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — |
| Cancel an event and raise refunds | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Promo codes and tracking links | — | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Analytics and dashboard | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Orders list | — | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ (admin search) | ✓ (admin search) | ✓ |
| Attendee list and CSV export (audited) | — | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Request a ticket refund | — | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | (via cancel) |
| **Approve a ticket or balance refund** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ ¹ | ✗ |
| Request a POS refund | — | — | — | — | — | — | — | ✓ | ✓ | — | — | — |
| Approve a POS refund | — | ✓ ¹ | ✓ ¹ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ ¹ | ✗ |
| Email and SMS campaigns | — | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Manage team and staff | — | ✓ (team) / ✓ (staff) | ✓ (staff) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Vendors and terminal registration | — | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ (own terminals) | ✗ | ✗ | ✗ | ✓ |
| Products | — | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | view | ✗ | ✗ | ✓ |
| Charge a tag at the POS (needs terminal key) | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ ² |
| Scan tickets at the gate | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | `can_scan` | ✗ | ✗ | ✓ | ✗ | ✓ |
| Desk: link, replace and block tags | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | `can_manage_tags` | ✗ | ✗ | ✓ | ✗ | ✓ |
| Bank details: view and edit | — | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | last 4 / reveal (audited) | last 4 |
| Request an organiser or vendor payout | — | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Approve a payout / record EFT** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ ¹ | ✗ |
| Reconciliation run and resolve | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | view | ✓ | view |
| Tag batches (mint/import) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Reissue a ticket QR | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| Revoke a ticket | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Suspend users, grant roles | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (never self) |
| Audit log view and verify | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |

¹ **Maker-checker:** never for a request you made yourself. This is enforced in code and by database CHECK constraints.
² Admins are not vendor members. Granting POS access means adding the person as a vendor member, which is audited.

High-risk actions are audit-logged with actor and role. They include bank-detail changes, account-number reveals, role grants, refunds, payouts, ticket revocation and reissue, tag status changes, attendee exports and event cancellation. No role can edit or delete ledger, audit, admission or consent history: the database rejects UPDATE and DELETE on those tables.
