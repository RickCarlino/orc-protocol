ORC Demo Server (Bun)

This is a clean, in-memory Bun + TypeScript server that demonstrates how to implement the ORC HTTP + WebSocket spec. It favors readability over features and is not production-ready.

What’s included
- WebSocket RTM demo: tickets-only auth, `hello` → `ready`, heartbeat ping/pong, cursor `ack` handling, vendor `x.post` and `x.typing` frames for interactive demos, and broadcasts (`event.message.create`, `event.typing`).
- Minimal HTTP just to support auth and tickets (kept small and clean).
- Default public room `general`; connections auto-join this room for demos.
- In-memory store for users, rooms, messages, cursors, tokens, and RTM tickets.
- Types generated from `OAD.yaml` using `openapi-typescript` (already present via the web client’s devDeps).

Run
- Generate types (optional, already generated): `bun run gen:types`
- Start dev server: `bun run dev` (default port `3000`)

WebSocket demo flow (tickets-only)
1) `POST /auth/guest` body `{ "username":"alice" }` → `{ access_token }`
2) `POST /rtm/ticket` with `Authorization: Bearer <token>` → `{ ticket }`
3) Connect WebSocket using the ticket:
   - Query: `ws://localhost:3000/rtm?ticket=<ticket>`
   - Or subprotocol: `Sec-WebSocket-Protocol: orcp, ticket.<ticket>`
   - Client sends: `{ "type":"hello" }`
   - Server replies: `{ "type":"ready", "heartbeat_ms":30000, ... }`
4) Post a message (demo vendor): send `{ "type":"x.post", "room":"general", "text":"hello" }`
   - Server broadcasts: `{ "type":"event.message.create", "message":{ ... } }`
5) Typing (demo vendor): send `{ "type":"x.typing", "room":"general", "state":"start" }`
   - Server broadcasts: `{ "type":"event.typing", "room_id":"...", "user_id":"...", "state":"start" }`
6) Ack cursors: `{ "type":"ack", "cursors": { "room:general": 10 } }`

Notes
- This demo auto-joins connections to `general`; `x.post` also joins that room.
- `x.post` and `x.typing` are vendor demo frames intended for development convenience.
- Core WS behavior—tickets-only auth, `hello`/`ready`, heartbeat, `ack`, and event broadcasts—follows the spec.
- All state is in-memory and resets on restart.
- HTTP CORS: responses include permissive `Access-Control-*` headers and `OPTIONS` preflight returns `204`, to simplify browser testing during development.
- WebSocket Origin validation: Set `WS_ORIGIN_ALLOW` (comma-separated) to control allowed origins. Defaults include common local dev origins.
