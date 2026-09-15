# TitoPay Chat and Support Takeover Repair

## Root causes repaired

- Chatbot messages were transient HTTP responses and were not persisted.
- Escalation created only a support ticket; it did not create a conversation.
- Admin Support listed ordinary user-to-user chat threads instead of escalations.
- No atomic agent takeover operation or support lifecycle existed.
- Support agents were rejected by the existing WebSocket authenticator.
- No persisted agent/customer message model connected the chatbot to live support.
- The bot had no database status check preventing replies after takeover.

## Additive database migration

`npm run db:migrate` adds:

- `support_conversations`
- `support_conversation_messages`
- `support_conversation_events`
- `chat_thread_participant_settings`

Existing authentication, wallets, transactions, payments, POS, QR, KYC, HR,
merchant and Peach webhook tables are not altered by this repair.

## Support lifecycle

`BOT_ACTIVE → ESCALATED → WAITING_FOR_AGENT → AGENT_ACTIVE → RESOLVED → CLOSED`

`RESOLVED` and `CLOSED` may transition to `REOPENED`. Conversation status in
PostgreSQL is authoritative.

## Customer APIs

- `POST /v1/chatbot/messages`
- `POST /v1/chatbot/escalations`
- `GET /v1/support/conversations`
- `GET /v1/support/conversations/:id`
- `GET /v1/support/conversations/:id/messages`
- `POST /v1/support/conversations/:id/messages`
- `POST /v1/support/conversations/:id/read`

All require the existing customer JWT and enforce conversation ownership.

## Admin APIs

- `GET /v1/admin/support/conversations`
- `GET /v1/admin/support/conversations/:id`
- `GET /v1/admin/support/conversations/:id/messages`
- `GET /v1/admin/support/conversations/:id/context`
- `POST /v1/admin/support/conversations/:id/takeover`
- `POST /v1/admin/support/conversations/:id/messages`
- `POST /v1/admin/support/conversations/:id/assign`
- `POST /v1/admin/support/conversations/:id/unassign`
- `POST /v1/admin/support/conversations/:id/transfer`
- `POST /v1/admin/support/conversations/:id/resolve`
- `POST /v1/admin/support/conversations/:id/close`
- `POST /v1/admin/support/conversations/:id/reopen`
- `POST /v1/admin/support/conversations/:id/notes`

All require the existing admin JWT and backend `support` permission.

## Realtime

The existing `/v1/chat/socket` endpoint now accepts authorised Customer Support
admin sessions as well as verified customer sessions. Support messages are
persisted before broadcast. Reconnects recover complete history through the HTTP
conversation endpoints, and client message IDs prevent duplicate persistence.

