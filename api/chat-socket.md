# Chat websocket

`wss://api.titopay.co.za/v1/chat/socket`

The one surface that cannot be expressed as an OpenAPI path, documented here so
the contract is complete. Everything below is what the **shipped client already
does** — this is a description of an existing implementation, not a proposal.

Whether the socket is used at all is decided at runtime by
`GET /v1/chat/config` → `socketEnabled` (see `openapi-app.yaml`). When it is
`false` the client stops attempting the socket and polls at
`pollIntervalSeconds` instead. That flag exists because the fallback below
currently masks a dead socket as ordinary slowness.

---

## Connecting

The client builds the URL by taking `API_BASE`, swapping `https:` for `wss:`,
and setting the path. No query string, no cookie.

**Authentication is carried in the websocket subprotocol header**, not a query
parameter and not an `Authorization` header — browsers cannot set headers on a
`WebSocket` constructor:

```js
new WebSocket(url, ["titopay-chat", `bearer.${accessToken}`])
```

So the server sees:

```
Sec-WebSocket-Protocol: titopay-chat, bearer.eyJhbGciOi…
```

It must parse the token out of the second value, validate it as it would a
`Bearer` token, and **echo back `titopay-chat`** as the negotiated subprotocol.
Echoing back the `bearer.…` value instead will leak the access token into proxy
and server logs.

Reject an invalid or expired token by closing the connection. The client treats
any close as transient and reconnects — it does **not** refresh the token on a
socket close, so a token that has expired mid-session will reconnect-loop until
the next REST call triggers a refresh. Closing with `4401` lets you distinguish
this in your own logs.

### Reconnection

Linear backoff, capped: `min(10000, 1000 × attempts)` milliseconds — 1s, 2s,
3s … 10s, 10s. The counter resets to zero on a successful `open`. There is no
give-up: the client reconnects for as long as it holds an access token.

On every `open` the client re-syncs over REST — `GET /v1/chat/threads` and
`GET /v1/chat/notifications` — so the socket does not need to replay missed
history. It only needs to deliver what happens from now on.

On every `close` all pending message acknowledgements are rejected and the
client falls back to REST for those messages.

---

## Server → client events

One JSON object per frame, discriminated by `type`. Anything the client does
not recognise is ignored silently.

### `chat:message`

A new message in a thread the user is part of.

```json
{ "type": "chat:message", "message": { … ChatMessage … } }
```

### `chat:ack`

Acknowledges a message the client sent over the socket. **`clientMessageId` is
at the top level of the event, not inside `message`** — the client looks it up
there to resolve the pending send.

```json
{
  "type": "chat:ack",
  "clientMessageId": "local-1753781234-8891",
  "message": { "id": "m_…", "status": "delivered", … }
}
```

`message.status` of anything other than `"sent"` is treated as delivered.

### `chat:status`

A delivery or read-state change on an existing message. Same `message` shape;
the client merges it into the thread by id.

```json
{ "type": "chat:status", "message": { "id": "m_…", "status": "read" } }
```

### `chat:signal`

Out-of-band signals on a thread.

```json
{ "type": "chat:signal", "signal": { "kind": "typing", "threadId": "t_…", "senderId": "u_…", "active": true } }
```

`kind: "typing"` is the only signal the client acts on, and only when that
thread is on screen.

**Do not build call signalling yet.** The client currently intercepts every
`kind` beginning with `call:` and answers "Voice calls are available only
through TitoPay Customer Care." The `call:offer` handling further down that
function is unreachable behind that check. Peer-to-peer calling is effectively
disabled client-side, and sending call signals will only produce that toast.

### `support:*`

Any `type` starting with `support:` is a live-agent event. The client reads
`conversationId` (or `conversation.id`, or `message.conversationId`) and
caches `conversation.status` — which is what decides whether the user's next
message goes to an agent or back to the bot. See `SupportConversationStatus` in
`openapi-app.yaml`; the values are uppercase and exact.

```json
{
  "type": "support:message",
  "conversationId": "c_…",
  "conversation": { "status": "AGENT_ACTIVE" },
  "message": { "senderType": "AGENT", "body": "Hi Thabo, I can help with that." }
}
```

A message with `senderType: "CUSTOMER"` is not rendered — that is the user's own
message echoed back, and it is already on their screen.

---

## Client → server events

### `chat:send`

The only frame the client sends.

```json
{
  "type": "chat:send",
  "clientMessageId": "local-1753781234-8891",
  "payload": { … }
}
```

The client waits **7 seconds** for a matching `chat:ack`. On timeout it falls
back to `POST /v1/chat/messages`, then to
`POST /v1/chat/threads/{threadId}/messages`, sending **the same
`clientMessageId`**. Both paths must be idempotent on that value or a slow ack
becomes a duplicate message.

### The `payload` shape, and what to do about it

The client sends the same field under several names, because the canonical one
was never documented:

| Concept | Fields sent |
|---|---|
| The text | `message`, `text`, `body` |
| The thread | `threadId`, `clientThreadId` |
| The other party | `recipient` (object), `participantId`, `identifier` |
| The client's id for the message | `clientMessageId`, `localMessageId` |

```json
{
  "threadId": "t_…",
  "clientThreadId": "local-thread-4",
  "recipient": { "id": "u_…", "username": "thabo" },
  "participantId": "u_…",
  "identifier": "thabo",
  "message": "Sent you the R250",
  "text": "Sent you the R250",
  "body": "Sent you the R250",
  "clientMessageId": "local-1753781234-8891",
  "localMessageId": "local-1753781234-8891",
  "type": "text",
  "mode": "direct"
}
```

The identical `payload` is posted to the REST fallbacks, so whatever the server
accepts must be consistent across all three transports.

**Pick one name per concept and say which** — `body`, `threadId`,
`participantId`, `clientMessageId` are the ones used in `openapi-app.yaml` — and
the duplicates will be removed from the client. Until then, read whichever you
prefer; they always carry the same value.

`clientThreadId` is worth keeping regardless: the client creates a thread
locally before the server has ever seen it, and this is how the first message
in a brand-new conversation identifies itself.

---

## What to confirm

1. **Is the socket live in production?** Set `socketEnabled` on
   `GET /v1/chat/config` accordingly. If it is not, saying so stops the client
   attempting a connection it cannot make and cuts the reconnect loop.
2. **Which field names are canonical?** The duplicates above come out of the
   client once you say.
3. **Is `chat:ack` emitted today?** If not, every socket send costs 7 seconds
   before falling back to REST, which is the slowest possible path to sending a
   message.
