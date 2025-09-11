
# Part A — Introduction

Open Rooms Chat is a minimal, strict, JSON‑over‑HTTP+WebSocket chat protocol for small communities (usually 0–10k users per server). It is **not federated**; a client may connect to many servers, but servers do not talk to each other. History lives on the server so that phones and tiny devices can come and go without losing context.

The protocol is designed to be:

 - Small enough that a reasonably good LLM can produce a working server and client in one shot.
 - Small enough that an individual developer can write a server or write a client in two weekends or less.
 - Light enough to run a simple client on a 2025 Arduino Uno R4 and a server on a Raspberry Pi.
 - Useful enough to actually be used in the real world.

**Design stance**

* **Simple:** HTTP(S) for slow ops; WebSocket for events. JSON only. No XML, no WebRTC, no P2P.
* **Practical:** Server‑side history; message edit/delete; threads; reactions; search (server‑chosen semantics with a minimal baseline); mentions; pins; uploads by content ID.
* **Mobile‑proof:** Sequence numbers, cursors, resume; no join/part spam; optional push; robust pull notifications.
* **Admin‑friendly:** Roles/permissions and kick/ban/mute at the protocol level.
* **Extensible but sane:** Strict core schemas with capability flags for optional features. Vendor extensions via `x_` fields.
* **Security without overkill:** TLS recommended; end‑to‑end encryption out of scope. 2FA optional. OAuth optional.

---

# Part B — Protocol Specification (Normative)

## 0. Conventions

* **Keywords:** **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** per RFC 2119.
* **Encoding:** All HTTP request/response bodies are UTF‑8 JSON unless specified.
* **Keys:** JSON keys use `snake_case`.
* **Time:** RFC 3339 UTC strings with `Z`.
* **IDs:** `user_id`, `room_id`, `message_id`, `file_cid` are **server‑scoped strings** using **rfc4648 Base32**.
* **Unknowns:** Clients MUST ignore unknown keys and unknown capability names. Servers MUST ignore unknown client hint fields.
* **Boolean flags:** Explicit `true`/`false`; absent does not equal false unless specified.

## 1. Transport

* **HTTP(S)** for resource CRUD (auth, users, rooms, search, uploads, notifications registration).
* **WebSocket (WS/WSS)** for real‑time events and cursor acks.
  * Authentication uses short‑lived tickets minted via `POST /rtm/ticket` (see §9.0).
* TLS (**HTTPS/WSS**) is RECOMMENDED. If a server permits cleartext, it MUST advertise `security.insecure_ok` capability.

## 2. Capabilities & Limits

### 2.1 Discovery

`GET /meta/capabilities`

**Response 200**

```json
{
  "capabilities": [
    "auth.guest",
    "auth.password",
    "auth.oauth",
    "security.insecure_ok",
    "uploads",
    "search.basic",
    "search.regex",
    "previews",
    "push.sse",
    "push.poll",
    "push.apns",
    "push.fcm",
    "emoji.packs",
    "retention.ephemeral"
  ],
  "limits": {
    "max_message_bytes": 4000,
    "max_upload_bytes": 16777216,
    "max_reactions_per_message": 32,
    "cursor_idle_timeout_ms": 300000,
    "rate_limits": { "burst": 20, "per_minute": 120 }
  },
  "server": {
    "name": "example",
    "description": "Example community",
    "contact": "admin@example.test"
  }
}
```

* Capabilities listed above are OPTIONAL unless referenced below as required. Servers MAY add vendor capabilities (prefix `x_`).
* Clients MAY send a list of desired optional features during WS handshake; the server’s authoritative set remains this endpoint and the WS `ready` frame.

## 3. Identity, IDs, and Profiles

### 3.1 ID Generation (server recommendation)

* `user_id`, `room_id`, `message_id`: 128‑bit random, Base32 (no padding).
* `file_cid`: SHA‑256 digest of the file bytes, Base32 (no padding).

### 3.2 Users

* Immutable `user_id`.
* Mutable fields: `display_name` (1–128 chars), `photo_cid` (optional), `bio` (≤ 1024), `status_text` (≤ 80), `status_emoji` (Unicode emoji).

**Endpoints**

* `GET /users/me` → 200 `{ user }`
* `PATCH /users/me` body `{ display_name?, bio?, status_text?, status_emoji?, photo_cid? }` → 200 `{ user }`
* `GET /users/{user_id}` → 200 `{ user }` (public profile)
* `GET /directory/users?q=&limit=&cursor=` → 200 `{ users:[...], next_cursor? }`

### 3.3 Handles

* Servers MAY support `@handle` aliases scoped to the server. Handles are not part of IDs.

### 3.4 Presence

* States: `online`, `away`, `dnd`.
* `PATCH /users/me/presence` → body `{ state }` → 200.
* WS event `event.presence` → `{ user_id, state }`. Ephemeral; servers SHOULD debounce.

### 3.5 Blocking

* Local client block is always permitted.
* Server‑assisted block (optional): `POST /blocks/{user_id}` / `DELETE /blocks/{user_id}`. If unsupported, return `400` `unsupported_capability`.

## 4. Authentication

Servers MAY support any subset of: guest, password, OAuth. Guest users are **not** read‑only; permissions are role‑based (§6.2).

### 4.1 Tokens

* **Access Token:** Opaque string; sent as `Authorization: Bearer <token>`.
* **Refresh Token:** Opaque string for renewal.
* Tokens are per device session.

### 4.2 Endpoints

* `POST /auth/guest` → 200 `{ access_token, refresh_token?, user }`
* `POST /auth/login` body `{ username, password, otp_code? }` → 200 `{ access_token, refresh_token, user }`
* `POST /auth/refresh` body `{ refresh_token }` → 200 `{ access_token, refresh_token? }`
* `POST /auth/logout` → 204 (revokes current device)
* `GET /auth/sessions` → 200 `{ sessions:[{ session_id, device, created_at, last_seen_at }] }`
* `DELETE /auth/sessions/{session_id}` → 204

### 4.3 OAuth (optional, `auth.oauth`)

* `POST /auth/oauth/start` → 200 `{ redirect_url }`
* `POST /auth/oauth/callback` body `{ code, state }` → 200 `{ access_token, refresh_token, user }`

### 4.4 2FA (optional)

* If 2FA required, `/auth/login` MAY return `401` with error `otp_required` OR `200 { requires_otp:true }`. Client then retries with `otp_code`.

## 5. Rooms

### 5.1 Data

Room object:

```json
{
  "room_id": "b32...",
  "name": "general",
  "topic": "Welcome",
  "visibility": "public",         // "public" or "private"
  "owner_id": "b32...",
  "created_at": "2025-09-08T12:00:00Z",
  "counts": { "members": 42 },
  "pinned_message_ids": ["b32...", "b32..."]
}
```

### 5.2 Directory & Membership

* Public rooms are discoverable and open to join.
* Private rooms require invite.

**Endpoints**

* `GET /directory/rooms?q=&limit=&cursor=` → 200 `{ rooms:[...], next_cursor? }`
* `GET /rooms?mine=true&limit=&cursor=` → rooms the caller belongs to.
* `POST /rooms` body `{ name, visibility, topic? }` → 201 `{ room }`
* `GET /rooms/{room_name}` → 200 `{ room }`
* `PATCH /rooms/{room_name}` body `{ name?, topic?, visibility? }` (owner/admin) → 200 `{ room }`
* `GET /rooms/{room_name}/members?limit=&cursor=` → 200 `{ members:[{user_id, role}], next_cursor? }`
* `POST /rooms/{room_name}/invite` body `{ user_id }` → 204
* `POST /rooms/{room_name}/join` → 204
* `POST /rooms/{room_name}/leave` → 204
* `POST /rooms/{room_name}/pins` body `{ message_id }` → 204
* `DELETE /rooms/{room_name}/pins/{message_id}` → 204

### 5.3 Roles & Permissions

Baseline roles (server MAY extend but MUST map to these minimums):

* `owner`: manage everything; assign roles.
* `admin`: edit room settings; ban/mute/kick; manage pins.
* `moderator`: ban/mute/kick; purge messages; manage pins.
* `member`: read, post, react, edit/delete own messages.
* `guest`: same as `member` unless server policy restricts; **not inherently read‑only**.

Endpoints:

* `GET /rooms/{room_name}/roles` → 200 `{ roles:[{name, permissions:[...]}] }`
* `POST /rooms/{room_name}/roles/assign` body `{ user_id, role }` → 204

## 6. Direct Messages (DM)

* DMs are **pairwise**. Group chats use (possibly private) rooms.
* A DM stream is identified by **peer user\_id** from the caller’s perspective.
* The server MUST create the DM stream implicitly when the first message is sent.

**Endpoints**

* `GET /dms?limit=&cursor=` → 200 `{ peers:[{ user_id, last_ts, last_seq }], next_cursor? }`
* `GET /dms/{user_id}/messages?from_seq=&limit=` → 200 `{ messages:[...], next_seq }`
* `GET /dms/{user_id}/messages/backfill?before_seq=&limit=` → 200 `{ messages:[...], prev_seq }`
* `POST /dms/{user_id}/messages` body `{ text, content_type?, attachments? }` → 201 `{ message }`
* `POST /dms/{user_id}/ack` body `{ seq }` → 204
* `GET /dms/{user_id}/cursor` → 200 `{ seq }`

## 7. Messages

### 7.1 Ordering and Identity

* Each stream (room or DM) has a **monotonic uint64 `seq`** assigned by the server.
* `ts` MUST be non‑decreasing with `seq`.
* `(room_id, message_id)` or `(dm_peer_id, message_id)` uniquely identifies a message.

### 7.2 Schema

```json
{
  "message_id": "b32...",
  "room_id": "b32...",          // present for rooms; null for DMs
  "dm_peer_id": null,           // present for DMs; null for rooms
  "author_id": "b32...",
  "seq": 12345,
  "ts": "2025-09-08T12:34:56Z",
  "parent_id": null,            // for threads; message_id only
  "content_type": "text/markdown",
  "text": "hello **world**",
  "entities": {
    "mentions": [ { "user_id":"b32...", "range":[6,11] } ],
    "links":    [ { "url":"https://example", "range":[0,5] } ]
  },
  "attachments": [
    { "cid":"b32...", "name":"photo.png", "bytes":1234, "mime":"image/png" }
  ],
  "reactions": [ { "emoji":"👍", "count":3, "me":true } ],
  "tombstone": false,
  "edited_at": null,
  "moderation_reason": null
}
```

* **Markdown subset supported:** `*italic*`, `**bold**`, `` `code` ``, fenced code, links `[text](url)`. Servers MAY sanitize unsafe HTML.
* **Threads:** `parent_id` MUST reference an existing message; parent is a message, not a room.

### 7.3 CRUD

Rooms:

* `GET /rooms/{room_name}/messages?from_seq=&limit=` → 200 `{ messages:[...], next_seq }`
* `GET /rooms/{room_name}/messages/backfill?before_seq=&limit=` → 200 `{ messages:[...], prev_seq }`
* `POST /rooms/{room_name}/messages` → 201 `{ message }`
* `PATCH /messages/{message_id}` body `{ text?, attachments? }` (author only) → 200 `{ message }`
* `DELETE /messages/{message_id}` → 200 `{ message_id, tombstone:true, ts:"...", moderation_reason:null }`

Reactions:

* `POST /messages/{message_id}/reactions` body `{ emoji }` → 200 `{ message_id, reactions:[...]}`
* `DELETE /messages/{message_id}/reactions` body `{ emoji }` → 200 `{ message_id, reactions:[...] }`
* A user MAY apply at most one instance of a given emoji per message.

Mentions & notify:

* Servers SHOULD parse mentions by handle or by `entities.mentions` and generate notifications per user preferences.

### 7.4 Pins

* Pins are room‑scoped.
* See §5.2 endpoints. Server MUST update `pinned_message_ids` and emit WS events.

## 8. Cursors, Acknowledgements, Resume

### 8.1 Model

* A **cursor** is the last `seq` the client has **fully processed** in a stream.
* Advancing the cursor influences notification counts.

### 8.2 HTTP

* Rooms: `POST /rooms/{room_name}/ack` `{ seq }` → 204; `GET /rooms/{room_name}/cursor` → 200 `{ seq }`
* DMs: `POST /dms/{user_id}/ack` `{ seq }` → 204; `GET /dms/{user_id}/cursor` → 200 `{ seq }`

### 8.3 WebSocket Ack

* Client MAY batch acks:

```json
{ "type":"ack", "cursors": { "room:<room_id>":12345, "dm:<user_id>":678 } }
```

### 8.4 Resume

* On WS connect, client MAY attempt resume by sending prior `session_id` and cursor map in `hello`. Server either resumes or instructs backfill via HTTP.

## 9. WebSocket Real‑Time

**Endpoint:** `GET /rtm`
**Frames:** One JSON object per RFC 6455 text frame.

### 9.0 Authentication (Tickets)

To keep browser and native clients simple and consistent, WebSocket connections authenticate via short‑lived tickets.

1) Obtain a ticket over HTTP using your normal auth (guest/password/OAuth):

`POST /rtm/ticket`  with `Authorization: Bearer <access_token>` (or server‑accepted cookie)

Response 200:

```json
{ "ticket": "b32...", "expires_in_ms": 60000 }
```

2) Connect the WebSocket using the ticket (choose one):

- Subprotocol (RECOMMENDED for browsers): `Sec-WebSocket-Protocol: orcp, ticket.<ticket>`
- Query parameter (PERMITTED): `/rtm?ticket=<ticket>`

Requirements:

- Tickets MUST be single‑use and short‑lived (RECOMMENDED ≤ 60 s).
- Servers MAY also accept `Authorization: Bearer <token>` or an authenticated cookie on WS upgrade for native/first‑party apps.
- Servers MUST validate the `Origin` header of WS upgrades against an allowlist; reject others.

### 9.1 Handshake

Client → Server:

```json
{
  "type": "hello",
  "client": { "name":"myclient", "version":"0.1" },
  "subscriptions": { "rooms":["<room_id>","..."], "dms": true },
  "cursors": { "room:<room_id>":12345, "dm:<user_id>":78 },
  "want": ["presence","typing","reactions"]   // optional
}
```

Server → Client:

```json
{
  "type": "ready",
  "session_id": "b32...",
  "heartbeat_ms": 30000,
  "server_time": "2025-09-08T12:35:00Z",
  "capabilities": ["uploads","search.basic","push.sse"]
}
```

Servers MAY send an initial `{"type":"ready"...}` immediately after connect to ease interop, but the canonical flow remains client `hello` → server `ready`.

### 9.2 Events

* `event.message.create` → `{ message }`
* `event.message.edit` → `{ message }`
* `event.message.delete` → `{ message_id, room_id?, dm_peer_id?, ts }`
* `event.reaction.add` → `{ message_id, emoji, counts:[{emoji,count}] }`
* `event.reaction.remove` → same shape
* `event.typing` → `{ room_id|dm_peer_id, user_id, state:"start"|"stop" }`
* `event.presence` → `{ user_id, state }`
* `event.pin.add` / `event.pin.remove` → `{ room_id, message_id }`
* `event.moderation.kick|ban|unban|mute|unmute` → `{ scope:"room"|"server", room_id?, user_id, by, reason?, until? }`

### 9.3 Heartbeats

* Server sends `{"type":"ping","ts":"..."}` every `heartbeat_ms`. Client replies `{"type":"pong","ts":"..."}`. After two consecutive missed pings, server MAY close.

## 10. Search

**Endpoint:** `GET /search/messages`

* Query parameters: `q` (required), `room_id?`, `dm_peer_id?`, `before_ts?`, `after_ts?`, `limit?`, `cursor?`
* **Baseline requirement:** substring match over `text` (case‑insensitive).

**Response 200**

```json
{ "results": [ { "message": { /* message */ }, "score": 1.0 } ], "next_cursor": "..." }
```

## 11. Uploads (Media & Files)

**Capability:** `uploads`

* `POST /uploads`

  * Either `Content-Type: application/octet-stream` with raw bytes, or `multipart/form-data` with part `file`.
  * Response 201:

    ```json
    { "cid":"b32...", "bytes":1234, "mime":"image/png", "sha256":"<hex>" }
    ```
* `GET /media/{cid}` → 200 raw bytes (subject to auth and retention)
* `HEAD /media/{cid}` → 200 headers include `Content-Type`, `Content-Length`; JSON body optional.

**Content IDs:** `cid = base32(sha256(bytes))` (lowercase, no padding).

**Retention:** Server policy. If ephemeral, server MUST advertise `retention.ephemeral`. Profile photos and emoji SHOULD be retained until replaced.

## 12. URL Previews (Optional)

**Capability:** `previews`

* Servers MAY fetch and attach preview metadata.
* Opt‑out: `PATCH /prefs` body `{ link_previews:false }` → 204
* Preview schema embedded alongside message or fetched via `GET /previews?url=...`:

  ```json
  { "url":"https://...", "title":"...", "description":"...", "image_cid":"b32..." }
  ```
* Servers MUST implement SSRF protections.

## 13. Notifications

### 13.1 Pull (Universal)

* **SSE:** `GET /notifications/stream` → `text/event-stream`

  * Event types: `mention`, `dm`, `invite`
  * Event data JSON: `{ "type":"mention", "room_id":"...", "message_id":"...", "ts":"..." }`
* **Long‑poll:** `GET /notifications/poll?cursor=&timeout_s=30`

  * Response 200: `{ notifications:[...], next_cursor }`

### 13.2 Push (Optional)

* **Capabilities:** `push.apns`, `push.fcm`, `push.sse` (SSE already covered), `push.poll` (long‑poll).
* Register: `POST /push/register` body `{ platform:"webpush"|"apns"|"fcm", token, device_id }` → 204
* Unregister: `DELETE /push/register/{device_id}` → 204
* Servers SHOULD send push for DMs and mentions respecting user prefs.

**Preferences**

* `PATCH /prefs/notifications`

  ```json
  {
    "room_overrides": { "<room_id>": { "mute": true } },
    "thread_mutes": ["<message_id>"],
    "user_mutes": ["<user_id>"]
  }
  ```

## 14. Moderation

### 14.1 User Actions

* **Kick (room):** `POST /rooms/{room_name}/kick` body `{ user_id, reason? }` → 204
* **Ban (room):** `POST /rooms/{room_name}/bans` body `{ user_id, reason?, duration_sec? }` → 204
* **Unban (room):** `DELETE /rooms/{room_name}/bans/{user_id}` → 204
* **Mute (room):** `POST /rooms/{room_name}/mutes` body `{ user_id, duration_sec? }` → 204
* **Unmute (room):** `DELETE /rooms/{room_name}/mutes/{user_id}` → 204
* **Ban (server):** `POST /bans` body `{ user_id, reason?, duration_sec? }` → 204
* **Unban (server):** `DELETE /bans/{user_id}` → 204

### 14.2 Message Actions

* **Purge:** `DELETE /messages/{message_id}/purge` → 200 `{ message_id, tombstone:true, moderation_reason:"..." }`

### 14.3 Events

* Server MUST emit WS `event.moderation.*` to affected user and room staff.

## 15. Presence & Typing

* Typing indicator (ephemeral):

  * WS event `event.typing` with `{ state:"start"|"stop" }`.
  * Servers MUST rate‑limit (≥ 3 s between broadcasts per user/stream).
* Presence updates SHOULD be debounced (e.g., idle → `away` after 5 minutes).

## 16. Searchability & History

* Servers MUST retain messages for a configured period (unbounded allowed).
* For pruned ranges, HTTP reads MUST return **410 Gone** with `error.code = "history_pruned"`.
* Minimal search: case‑insensitive substring on `text` across the addressed stream unless `room_id`/`dm_peer_id` filters are provided.

## 17. Pagination

* List endpoints use `limit` (default server‑chosen, max MAY be constrained by `limits`) and opaque `cursor`.
* Responses include `next_cursor` when more results exist; absence of `next_cursor` indicates end.
* Message backfill uses `before_seq` with reverse chronological order; forward reads use `from_seq` inclusive.

## 18. Error Model & Status Codes

### 18.1 HTTP Status

* 200 OK, 201 Created, 204 No Content on success as specified per endpoint.
* 400 Bad Request (malformed/invalid fields; unsupported capability → see code)
* 401 Unauthorized (missing/invalid token; or `otp_required`)
* 403 Forbidden (permission denied)
* 404 Not Found (resource missing)
* 409 Conflict (edit/delete conflict)
* 410 Gone (history pruned)
* 413 Payload Too Large (message/upload exceeds limits)
* 429 Too Many Requests (rate limit)
* 500 Internal Server Error

### 18.2 Error Body

All non‑2xx responses with bodies MUST use:

```json
{
  "error": {
    "code": "bad_request|unauthorized|forbidden|not_found|unsupported_capability|rate_limited|conflict|history_pruned|internal",
    "message": "human readable",
    "details": { }
  }
}
```

Servers SHOULD also set:

* `Retry-After` for 429 (seconds).
* `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset`.

### 18.3 WebSocket Errors

WS error frame:

```json
{ "type":"error", "error": { "code":"forbidden", "message":"..." } }
```

## 19. Limits & Hints

* `GET /meta/capabilities` exposes `limits`.
* Servers MAY additionally include per‑request headers:

  * `X-Rate-Limit-*` as in §18.2.
* Clients MUST respect `limits.max_message_bytes` and SHOULD pre‑validate before sending.

## 20. Security

* TLS strongly RECOMMENDED. If not enforced, advertise `security.insecure_ok`.
* Servers MUST sanitize link previews and guard against SSRF (§12).
* Authentication tokens SHOULD be bound to device sessions and revocable via `/auth/sessions`.

## 21. Compatibility & Extensibility

* No version negotiation in‑band.
* Optional features are strictly gated by capabilities.
* Vendor extensions MUST use `x_` key prefix and MUST NOT change core semantics.

---

## Annex A — Example Exchanges (Normative Examples)

### A.1 Guest Auth → Create Room → WS → Post → React

1. Guest token

```http
POST /auth/guest
→ 200
{"access_token":"tA","user":{"user_id":"u1","display_name":"Guest"}}
```

2. Create public room

```http
POST /rooms
Authorization: Bearer tA
{"name":"general","visibility":"public"}
→ 201 {"room_id":"r1","name":"general","visibility":"public","owner_id":"u1","created_at":"...","counts":{"members":1},"pinned_message_ids":[]}
```

3. WS connect (ticket‑based)

```http
POST /rtm/ticket
Authorization: Bearer tA
→ 200 {"ticket":"T1","expires_in_ms":60000}
```

Client upgrades WebSocket using the ticket, e.g. `GET /rtm?ticket=T1` or `Sec-WebSocket-Protocol: orcp, ticket.T1`.

Client sends:

```json
{"type":"hello","client":{"name":"cli","version":"0.1"},"subscriptions":{"rooms":["r1"],"dms":true},"cursors":{}}
```

Server:

```json
{"type":"ready","session_id":"s1","heartbeat_ms":30000,"server_time":"...","capabilities":["uploads","search.basic","push.sse"]}
```

4. Post

```http
POST /rooms/r1/messages
Authorization: Bearer tA
{"text":"hello **world**"}
→ 201 {"message_id":"m1","room_id":"r1","author_id":"u1","seq":1,"ts":"...","text":"hello **world**","content_type":"text/markdown","tombstone":false}
```

WS:

```json
{"type":"event.message.create","message":{"message_id":"m1","room_id":"r1","author_id":"u1","seq":1,"ts":"...","text":"hello **world**","content_type":"text/markdown","tombstone":false}}
```

5. React

```http
POST /messages/m1/reactions
Authorization: Bearer tA
{"emoji":"👍"}
→ 200 {"message_id":"m1","reactions":[{"emoji":"👍","count":1,"me":true}]}
```

WS:

```json
{"type":"event.reaction.add","message_id":"m1","emoji":"👍","counts":[{"emoji":"👍","count":1}]}
```

6. Ack

```json
{"type":"ack","cursors":{"room:r1":1}}
```

### A.2 Thread, Delete Parent (Tombstone), Child Persists

Reply:

```http
POST /rooms/r1/messages
{"text":"reply","parent_id":"m1"} → 201 {"message_id":"m2","parent_id":"m1","seq":2,"ts":"...","text":"reply"}
```

Delete parent:

```http
DELETE /messages/m1 → 200 {"message_id":"m1","tombstone":true,"ts":"...","moderation_reason":null}
```

Backfill returns `m2` with `parent_id:"m1"`.

### A.3 Upload and Attach

```http
POST /uploads
Content-Type: application/octet-stream

<bytes>
→ 201 {"cid":"c1","bytes":123,"mime":"image/png","sha256":"..."}
POST /rooms/r1/messages
{"text":"photo","attachments":[{"cid":"c1","name":"p.png","bytes":123,"mime":"image/png"}]}
→ 201 { "message_id":"m3", ... }
```


```yml
openapi: 3.1.0
info:
  title: Open Rooms Chat API
  version: "2025-09-09"
  description: >
    Open Rooms Chat is a strict JSON-over-HTTP+WebSocket protocol for small,
    non-federated communities. This OpenAPI describes the HTTP portion. Real-time
    WebSocket frames and event schemas are described under components/schemas.
servers:
  - url: https://api.example.com
    description: Default server
tags:
  - name: Meta
  - name: Auth
  - name: Users
  - name: Rooms
  - name: DMs
  - name: Messages
  - name: Search
  - name: Uploads
  - name: Notifications
  - name: Moderation
  - name: Preferences
  - name: Directory
  - name: Emoji
  - name: Export
  - name: Realtime

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: bearer
  parameters:
    Limit:
      name: limit
      in: query
      description: Maximum number of items to return.
      required: false
      schema: { type: integer, minimum: 1, maximum: 200 }
    Cursor:
      name: cursor
      in: query
      description: Opaque pagination cursor returned by a previous call.
      required: false
      schema: { type: string }
    FromSeq:
      name: from_seq
      in: query
      description: Inclusive starting sequence number for forward pagination.
      required: false
      schema: { type: integer, minimum: 0 }
    BeforeSeq:
      name: before_seq
      in: query
      description: Exclusive sequence number to backfill before, descending.
      required: false
      schema: { type: integer, minimum: 0 }
    RoomId:
      name: room_id
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
    UserId:
      name: user_id
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
    MessageId:
      name: message_id
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
    SessionId:
      name: session_id
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
    Cid:
      name: cid
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
    DeviceId:
      name: device_id
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Id' }
  responses:
    ErrorResponse:
      description: Error
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    NoContent:
      description: No Content
  schemas:
    Id:
      type: string
      description: rfc4648 Base32 (no padding), server-scoped.
      pattern: '^[a-z2-7]+$'
    Timestamp:
      type: string
      format: date-time
      description: RFC 3339 UTC with Z
    User:
      type: object
      required: [user_id, display_name]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
        display_name: { type: string, minLength: 1, maxLength: 128 }
        photo_cid: { $ref: '#/components/schemas/Id' }
        bio: { type: string, maxLength: 1024 }
        status_text: { type: string, maxLength: 80 }
        status_emoji: { type: string }
      additionalProperties: true
    PresenceState:
      type: string
      enum: [online, away, dnd]
    PresenceUpdate:
      type: object
      required: [state]
      properties:
        state: { $ref: '#/components/schemas/PresenceState' }
    Room:
      type: object
      required: [room_id, name, visibility, owner_id, created_at]
      properties:
        room_id: { $ref: '#/components/schemas/Id' }
        name: { type: string, minLength: 1, maxLength: 80 }
        topic: { type: string, maxLength: 512 }
        visibility: { type: string, enum: [public, private] }
        owner_id: { $ref: '#/components/schemas/Id' }
        created_at: { $ref: '#/components/schemas/Timestamp' }
        counts:
          type: object
          properties:
            members: { type: integer, minimum: 0 }
          additionalProperties: true
        pinned_message_ids:
          type: array
          items: { $ref: '#/components/schemas/Id' }
      additionalProperties: true
    RoomMember:
      type: object
      required: [user_id, role]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
        role:
          type: string
          enum: [owner, admin, moderator, member, guest]
    Permission:
      type: string
      enum:
        - manage_room
        - manage_pins
        - manage_roles
        - kick
        - ban
        - mute
        - purge_message
        - post
        - react
        - edit_own_message
        - delete_own_message
        - read
    Role:
      type: object
      required: [name, permissions]
      properties:
        name:
          type: string
          enum: [owner, admin, moderator, member, guest]
        permissions:
          type: array
          items: { $ref: '#/components/schemas/Permission' }
    Attachment:
      type: object
      required: [cid, mime, name, bytes]
      properties:
        cid: { $ref: '#/components/schemas/Id' }
        mime: { type: string }
        name: { type: string }
        bytes: { type: integer, minimum: 0 }
      additionalProperties: true
    Reaction:
      type: object
      required: [emoji, count]
      properties:
        emoji: { type: string }
        count: { type: integer, minimum: 0 }
        me: { type: boolean }
    Message:
      type: object
      required: [message_id, author_id, seq, ts]
      properties:
        message_id: { $ref: '#/components/schemas/Id' }
        room_id: { anyOf: [ { $ref: '#/components/schemas/Id' }, { type: 'null' } ] }
        dm_peer_id: { anyOf: [ { $ref: '#/components/schemas/Id' }, { type: 'null' } ] }
        author_id: { $ref: '#/components/schemas/Id' }
        seq: { type: integer, minimum: 0 }
        ts: { $ref: '#/components/schemas/Timestamp' }
        parent_id: { anyOf: [ { $ref: '#/components/schemas/Id' }, { type: 'null' } ] }
        content_type: { type: string, const: text/markdown }
        text: { type: string, description: "Markdown subset", maxLength: 4000 }
        entities:
          type: object
          properties:
            mentions:
              type: array
              items:
                type: object
                required: [user_id, range]
                properties:
                  user_id: { $ref: '#/components/schemas/Id' }
                  range:
                    type: array
                    items: { type: integer, minimum: 0 }
                    minItems: 2
                    maxItems: 2
            links:
              type: array
              items:
                type: object
                required: [url, range]
                properties:
                  url: { type: string, format: uri }
                  range:
                    type: array
                    items: { type: integer, minimum: 0 }
                    minItems: 2
                    maxItems: 2
          additionalProperties: true
        attachments:
          type: array
          items: { $ref: '#/components/schemas/Attachment' }
        reactions:
          type: array
          items: { $ref: '#/components/schemas/Reaction' }
        tombstone: { type: boolean }
        edited_at: { anyOf: [ { $ref: '#/components/schemas/Timestamp' }, { type: 'null' } ] }
        moderation_reason: { anyOf: [ { type: string }, { type: 'null' } ] }
      additionalProperties: true
    MessageCreate:
      type: object
      properties:
        text: { type: string, maxLength: 4000 }
        content_type: { type: string, default: text/markdown, enum: [text/markdown] }
        parent_id: { $ref: '#/components/schemas/Id' }
        attachments:
          type: array
          items: { $ref: '#/components/schemas/Attachment' }
      required: [text]
    MessageEdit:
      type: object
      properties:
        text: { type: string, maxLength: 4000 }
        attachments:
          type: array
          items: { $ref: '#/components/schemas/Attachment' }
      minProperties: 1
    ReactionRequest:
      type: object
      required: [emoji]
      properties:
        emoji: { type: string }
    AckRequest:
      type: object
      required: [seq]
      properties:
        seq: { type: integer, minimum: 0 }
    CreateRoomRequest:
      type: object
      required: [name, visibility]
      properties:
        name: { type: string, minLength: 1, maxLength: 80 }
        visibility: { type: string, enum: [public, private] }
        topic: { type: string, maxLength: 512 }
    PatchRoomRequest:
      type: object
      properties:
        name: { type: string, minLength: 1, maxLength: 80 }
        visibility: { type: string, enum: [public, private] }
        topic: { type: string, maxLength: 512 }
      minProperties: 1
    InviteRequest:
      type: object
      required: [user_id]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
    RoleAssignRequest:
      type: object
      required: [user_id, role]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
        role: { type: string, enum: [owner, admin, moderator, member, guest] }
    BanRequest:
      type: object
      required: [user_id]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
        reason: { type: string }
        duration_sec: { type: integer, minimum: 1 }
    MuteRequest:
      type: object
      required: [user_id]
      properties:
        user_id: { $ref: '#/components/schemas/Id' }
        duration_sec: { type: integer, minimum: 1 }
    ReportRequest:
      type: object
      properties:
        message_id: { $ref: '#/components/schemas/Id' }
        user_id: { $ref: '#/components/schemas/Id' }
        reason: { type: string }
        notes: { type: string }
      minProperties: 1
      required: [reason]
    UploadResponse:
      type: object
      required: [cid, bytes, mime, sha256]
      properties:
        cid: { $ref: '#/components/schemas/Id' }
        bytes: { type: integer, minimum: 0 }
        mime: { type: string }
        sha256: { type: string }
    Preview:
      type: object
      required: [url]
      properties:
        url: { type: string, format: uri }
        title: { type: string }
        description: { type: string }
        image_cid: { $ref: '#/components/schemas/Id' }
    NotificationPrefsPatch:
      type: object
      properties:
        room_overrides:
          type: object
          additionalProperties:
            type: object
            properties:
              mute: { type: boolean }
        thread_mutes:
          type: array
          items: { $ref: '#/components/schemas/Id' }
        user_mutes:
          type: array
          items: { $ref: '#/components/schemas/Id' }
    PrefsPatch:
      type: object
      properties:
        link_previews: { type: boolean }
    CapabilityResponse:
      type: object
      required: [capabilities, limits, server]
      properties:
        capabilities:
          type: array
          items: { type: string }
        limits:
          type: object
          required: [max_message_bytes, max_upload_bytes, max_reactions_per_message, cursor_idle_timeout_ms, rate_limits]
          properties:
            max_message_bytes: { type: integer, minimum: 1 }
            max_upload_bytes: { type: integer, minimum: 0 }
            max_reactions_per_message: { type: integer, minimum: 0 }
            cursor_idle_timeout_ms: { type: integer, minimum: 0 }
            rate_limits:
              type: object
              required: [burst, per_minute]
              properties:
                burst: { type: integer, minimum: 0 }
                per_minute: { type: integer, minimum: 0 }
        server:
          type: object
          required: [name]
          properties:
            name: { type: string }
            description: { type: string }
            contact: { type: string }
    Session:
      type: object
      required: [session_id, created_at]
      properties:
        session_id: { $ref: '#/components/schemas/Id' }
        device: { type: string }
        created_at: { $ref: '#/components/schemas/Timestamp' }
        last_seen_at: { $ref: '#/components/schemas/Timestamp' }
    ErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              enum:
                - bad_request
                - unauthorized
                - forbidden
                - not_found
                - unsupported_capability
                - rate_limited
                - conflict
                - history_pruned
                - internal
                - otp_required
            message: { type: string }
            details: { type: object }
    OAuthStartRequest:
      type: object
      required: [provider]
      properties:
        provider: { type: string }
    OAuthStartResponse:
      type: object
      required: [redirect_url]
      properties:
        redirect_url: { type: string, format: uri }
    OAuthCallbackRequest:
      type: object
      required: [code, state]
      properties:
        code: { type: string }
        state: { type: string }
    LoginRequest:
      type: object
      required: [username, password]
      properties:
        username: { type: string }
        password: { type: string }
        otp_code: { type: string }
    LoginResponse:
      type: object
      required: [access_token, user]
      properties:
        access_token: { type: string }
        refresh_token: { type: string }
        user: { $ref: '#/components/schemas/User' }
    RefreshRequest:
      type: object
      required: [refresh_token]
      properties:
        refresh_token: { type: string }
    RefreshResponse:
      type: object
      required: [access_token]
      properties:
        access_token: { type: string }
        refresh_token: { type: string }
    RegisterPushRequest:
      type: object
      required: [platform, token, device_id]
      properties:
        platform:
          type: string
          enum: [webpush, apns, fcm]
        token: { type: string }
        device_id: { $ref: '#/components/schemas/Id' }
    ExportResponse:
      type: object
      required: [export_id, status]
      properties:
        export_id: { $ref: '#/components/schemas/Id' }
        status: { type: string, enum: [queued, running, complete, failed] }
        url: { type: string, format: uri }

    # --- WebSocket message schemas (for documentation) ---
    WSHello:
      type: object
      required: [type, client, subscriptions]
      properties:
        type: { type: string, const: hello }
        client:
          type: object
          required: [name, version]
          properties:
            name: { type: string }
            version: { type: string }
        subscriptions:
          type: object
          properties:
            rooms:
              type: array
              items: { $ref: '#/components/schemas/Id' }
            dms: { type: boolean }
        cursors:
          type: object
          additionalProperties: { type: integer, minimum: 0 }
        want:
          type: array
          items: { type: string }
    WSReady:
      type: object
      required: [type, session_id, heartbeat_ms, server_time]
      properties:
        type: { type: string, const: ready }
        session_id: { $ref: '#/components/schemas/Id' }
        heartbeat_ms: { type: integer, minimum: 1000 }
        server_time: { $ref: '#/components/schemas/Timestamp' }
        capabilities:
          type: array
          items: { type: string }
    WSEventMessageCreate:
      type: object
      required: [type, message]
      properties:
        type: { type: string, const: event.message.create }
        message: { $ref: '#/components/schemas/Message' }
    WSEventMessageEdit:
      type: object
      required: [type, message]
      properties:
        type: { type: string, const: event.message.edit }
        message: { $ref: '#/components/schemas/Message' }
    WSEventMessageDelete:
      type: object
      required: [type, message_id]
      properties:
        type: { type: string, const: event.message.delete }
        message_id: { $ref: '#/components/schemas/Id' }
        room_id: { $ref: '#/components/schemas/Id' }
        dm_peer_id: { $ref: '#/components/schemas/Id' }
        ts: { $ref: '#/components/schemas/Timestamp' }
    WSEventReactionAdd:
      type: object
      required: [type, message_id, emoji]
      properties:
        type: { type: string, const: event.reaction.add }
        message_id: { $ref: '#/components/schemas/Id' }
        emoji: { type: string }
        counts:
          type: array
          items:
            type: object
            required: [emoji, count]
            properties:
              emoji: { type: string }
              count: { type: integer, minimum: 0 }
    WSEventTyping:
      type: object
      required: [type, user_id, state]
      properties:
        type: { type: string, const: event.typing }
        room_id: { $ref: '#/components/schemas/Id' }
        dm_peer_id: { $ref: '#/components/schemas/Id' }
        user_id: { $ref: '#/components/schemas/Id' }
        state: { type: string, enum: [start, stop] }
    WSError:
      type: object
      required: [type, error]
      properties:
        type: { type: string, const: error }
        error: { $ref: '#/components/schemas/ErrorResponse' }

paths:
  /meta/capabilities:
    get:
      tags: [Meta]
      summary: Discover server capabilities and limits
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CapabilityResponse' }

  /auth/guest:
    post:
      tags: [Auth]
      summary: Obtain a guest session
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/LoginResponse' }
        '400': { $ref: '#/components/responses/ErrorResponse' }

  /auth/login:
    post:
      tags: [Auth]
      summary: Login with username/password (and optional OTP)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/LoginRequest' }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/LoginResponse' }
        '401':
          description: Unauthorized (invalid credentials or OTP required)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }

  /auth/refresh:
    post:
      tags: [Auth]
      summary: Refresh an access token
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RefreshRequest' }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RefreshResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /auth/logout:
    post:
      tags: [Auth]
      summary: Revoke the current device session
      security: [{ BearerAuth: [] }]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /auth/sessions:
    get:
      tags: [Auth]
      summary: List active device sessions
      security: [{ BearerAuth: [] }]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  sessions:
                    type: array
                    items: { $ref: '#/components/schemas/Session' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /auth/sessions/{session_id}:
    delete:
      tags: [Auth]
      summary: Revoke another device session
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/SessionId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '404': { $ref: '#/components/responses/ErrorResponse' }

  /auth/oauth/start:
    post:
      tags: [Auth]
      summary: Start OAuth flow (optional feature)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/OAuthStartRequest' }
      responses:
        '200':
          description: Redirect URL
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OAuthStartResponse' }
        '400': { $ref: '#/components/responses/ErrorResponse' }

  /auth/oauth/callback:
    post:
      tags: [Auth]
      summary: Complete OAuth flow (optional feature)
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/OAuthCallbackRequest' }
      responses:
        '200':
          description: Tokens and user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/LoginResponse' }
        '400': { $ref: '#/components/responses/ErrorResponse' }

  /users/me:
    get:
      tags: [Users]
      summary: Get current user
      security: [{ BearerAuth: [] }]
      responses:
        '200':
          description: Current user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
    patch:
      tags: [Users]
      summary: Update current user profile
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                display_name: { type: string, minLength: 1, maxLength: 128 }
                bio: { type: string, maxLength: 1024 }
                status_text: { type: string, maxLength: 80 }
                status_emoji: { type: string }
                photo_cid: { $ref: '#/components/schemas/Id' }
      responses:
        '200':
          description: Updated user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /users/me/presence:
    patch:
      tags: [Users]
      summary: Set presence state
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PresenceUpdate' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /users/{user_id}:
    get:
      tags: [Users]
      summary: Get a user's public profile
      security: [{ BearerAuth: [] }, {}]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      responses:
        '200':
          description: User
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '404': { $ref: '#/components/responses/ErrorResponse' }

  /blocks/{user_id}:
    post:
      tags: [Users]
      summary: Server-assisted block (optional)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
    delete:
      tags: [Users]
      summary: Remove server-assisted block (optional)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /directory/users:
    get:
      tags: [Directory]
      summary: Searchable user directory
      security: [{ BearerAuth: [] }, {}]
      parameters:
        - name: q
          in: query
          required: false
          schema: { type: string }
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Users
          content:
            application/json:
              schema:
                type: object
                properties:
                  users:
                    type: array
                    items: { $ref: '#/components/schemas/User' }
                  next_cursor: { type: string }

  /directory/rooms:
    get:
      tags: [Directory]
      summary: Discover public rooms
      security: [{ BearerAuth: [] }, {}]
      parameters:
        - name: q
          in: query
          required: false
          schema: { type: string }
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Rooms
          content:
            application/json:
              schema:
                type: object
                properties:
                  rooms:
                    type: array
                    items: { $ref: '#/components/schemas/Room' }
                  next_cursor: { type: string }

  /rooms:
    get:
      tags: [Rooms]
      summary: List rooms for the current user
      security: [{ BearerAuth: [] }]
      parameters:
        - name: mine
          in: query
          required: false
          schema: { type: boolean, default: true }
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Rooms
          content:
            application/json:
              schema:
                type: object
                properties:
                  rooms:
                    type: array
                    items: { $ref: '#/components/schemas/Room' }
                  next_cursor: { type: string }
        '401': { $ref: '#/components/responses/ErrorResponse' }
    post:
      tags: [Rooms]
      summary: Create a room
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateRoomRequest' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Room' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}:
    get:
      tags: [Rooms]
      summary: Get a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      responses:
        '200':
          description: Room
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Room' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '404': { $ref: '#/components/responses/ErrorResponse' }
    patch:
      tags: [Rooms]
      summary: Update a room (owner/admin)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PatchRoomRequest' }
      responses:
        '200':
          description: Room
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Room' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/members:
    get:
      tags: [Rooms]
      summary: List room members
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Members
          content:
            application/json:
              schema:
                type: object
                properties:
                  members:
                    type: array
                    items: { $ref: '#/components/schemas/RoomMember' }
                  next_cursor: { type: string }

  /rooms/{room_name}/invite:
    post:
      tags: [Rooms]
      summary: Invite a user to a private room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/InviteRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '403': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/join:
    post:
      tags: [Rooms]
      summary: Join a room
      security: [{ BearerAuth: [] }, {}]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '403': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/leave:
    post:
      tags: [Rooms]
      summary: Leave a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/pins:
    post:
      tags: [Rooms]
      summary: Pin a message
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [message_id]
              properties:
                message_id: { $ref: '#/components/schemas/Id' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
    delete:
      tags: [Rooms]
      summary: Unpin a message
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - name: message_id
          in: query
          required: true
          schema: { $ref: '#/components/schemas/Id' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/roles:
    get:
      tags: [Rooms]
      summary: Get role definitions for the room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      responses:
        '200':
          description: Roles
          content:
            application/json:
              schema:
                type: object
                properties:
                  roles:
                    type: array
                    items: { $ref: '#/components/schemas/Role' }

  /rooms/{room_name}/roles/assign:
    post:
      tags: [Rooms]
      summary: Assign a role to a user
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RoleAssignRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '403': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/messages:
    get:
      tags: [Messages]
      summary: Read forward room history
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - $ref: '#/components/parameters/FromSeq'
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: Messages
          content:
            application/json:
              schema:
                type: object
                properties:
                  messages:
                    type: array
                    items: { $ref: '#/components/schemas/Message' }
                  next_seq: { type: integer, minimum: 0 }
    post:
      tags: [Messages]
      summary: Send a message to a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MessageCreate' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Message' }
        '400': { $ref: '#/components/responses/ErrorResponse' }

  /rooms/{room_name}/messages/backfill:
    get:
      tags: [Messages]
      summary: Backfill room history (reverse)
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - $ref: '#/components/parameters/BeforeSeq'
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: Messages
          content:
            application/json:
              schema:
                type: object
                properties:
                  messages:
                    type: array
                    items: { $ref: '#/components/schemas/Message' }
                  prev_seq: { type: integer, minimum: 0 }

  /rooms/{room_name}/ack:
    post:
      tags: [Messages]
      summary: Advance the room cursor
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AckRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/cursor:
    get:
      tags: [Messages]
      summary: Read the room cursor
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      responses:
        '200':
          description: Cursor
          content:
            application/json:
              schema:
                type: object
                properties:
                  seq: { type: integer, minimum: 0 }

  /dms:
    get:
      tags: [DMs]
      summary: List DM peers for the current user
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Peers
          content:
            application/json:
              schema:
                type: object
                properties:
                  peers:
                    type: array
                    items:
                      type: object
                      required: [user_id]
                      properties:
                        user_id: { $ref: '#/components/schemas/Id' }
                        last_ts: { $ref: '#/components/schemas/Timestamp' }
                        last_seq: { type: integer, minimum: 0 }
                  next_cursor: { type: string }

  /dms/{user_id}/messages:
    get:
      tags: [DMs]
      summary: Read forward DM history
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/UserId'
        - $ref: '#/components/parameters/FromSeq'
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: Messages
          content:
            application/json:
              schema:
                type: object
                properties:
                  messages:
                    type: array
                    items: { $ref: '#/components/schemas/Message' }
                  next_seq: { type: integer, minimum: 0 }
    post:
      tags: [DMs]
      summary: Send a direct message
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MessageCreate' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Message' }

  /dms/{user_id}/messages/backfill:
    get:
      tags: [DMs]
      summary: Backfill DM history (reverse)
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/UserId'
        - $ref: '#/components/parameters/BeforeSeq'
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: Messages
          content:
            application/json:
              schema:
                type: object
                properties:
                  messages:
                    type: array
                    items: { $ref: '#/components/schemas/Message' }
                  prev_seq: { type: integer, minimum: 0 }

  /dms/{user_id}/ack:
    post:
      tags: [DMs]
      summary: Advance the DM cursor
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AckRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /dms/{user_id}/cursor:
    get:
      tags: [DMs]
      summary: Read the DM cursor
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      responses:
        '200':
          description: Cursor
          content:
            application/json:
              schema:
                type: object
                properties:
                  seq: { type: integer, minimum: 0 }

  /messages/{message_id}:
    patch:
      tags: [Messages]
      summary: Edit a message (author only)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/MessageId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MessageEdit' }
      responses:
        '200':
          description: Updated
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Message' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '403': { $ref: '#/components/responses/ErrorResponse' }
        '404': { $ref: '#/components/responses/ErrorResponse' }
    delete:
      tags: [Messages]
      summary: Delete own message (tombstone)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/MessageId' } ]
      responses:
        '200':
          description: Tombstoned
          content:
            application/json:
              schema:
                type: object
                properties:
                  message_id: { $ref: '#/components/schemas/Id' }
                  tombstone: { type: boolean }
                  ts: { $ref: '#/components/schemas/Timestamp' }

  /messages/{message_id}/reactions:
    post:
      tags: [Messages]
      summary: Add a reaction
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/MessageId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ReactionRequest' }
      responses:
        '200':
          description: Reaction counts
          content:
            application/json:
              schema:
                type: object
                properties:
                  message_id: { $ref: '#/components/schemas/Id' }
                  reactions:
                    type: array
                    items: { $ref: '#/components/schemas/Reaction' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '404': { $ref: '#/components/responses/ErrorResponse' }
    delete:
      tags: [Messages]
      summary: Remove own reaction
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/MessageId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ReactionRequest' }
      responses:
        '200':
          description: Reaction counts
          content:
            application/json:
              schema:
                type: object
                properties:
                  message_id: { $ref: '#/components/schemas/Id' }
                  reactions:
                    type: array
                    items: { $ref: '#/components/schemas/Reaction' }

  /messages/{message_id}/purge:
    delete:
      tags: [Moderation]
      summary: Purge a message for policy violation (moderator/admin)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/MessageId' } ]
      responses:
        '200':
          description: Purged (tombstoned with reason)
          content:
            application/json:
              schema:
                type: object
                properties:
                  message_id: { $ref: '#/components/schemas/Id' }
                  tombstone: { type: boolean }
                  moderation_reason: { type: string }

  /search/messages:
    get:
      tags: [Search]
      summary: Search messages (substring baseline)
      security: [{ BearerAuth: [] }]
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string }
        - name: room_id
          in: query
          required: false
          schema: { $ref: '#/components/schemas/Id' }
        - name: dm_peer_id
          in: query
          required: false
          schema: { $ref: '#/components/schemas/Id' }
        - name: before_ts
          in: query
          schema: { $ref: '#/components/schemas/Timestamp' }
        - name: after_ts
          in: query
          schema: { $ref: '#/components/schemas/Timestamp' }
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
      responses:
        '200':
          description: Results
          content:
            application/json:
              schema:
                type: object
                properties:
                  results:
                    type: array
                    items:
                      type: object
                      properties:
                        message: { $ref: '#/components/schemas/Message' }
                        score: { type: number }
                  next_cursor: { type: string }

  /uploads:
    post:
      tags: [Uploads]
      summary: Upload a file and obtain CID
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/octet-stream:
            schema: { type: string, format: binary }
          multipart/form-data:
            schema:
              type: object
              properties:
                file:
                  type: string
                  format: binary
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UploadResponse' }
        '413': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /media/{cid}:
    get:
      tags: [Uploads]
      summary: Download media by CID
      security: [{ BearerAuth: [] }, {}]
      parameters: [ { $ref: '#/components/parameters/Cid' } ]
      responses:
        '200':
          description: Media bytes
          content:
            '*/*':
              schema: { type: string, format: binary }
        '401': { $ref: '#/components/responses/ErrorResponse' }
        '404': { $ref: '#/components/responses/ErrorResponse' }
    head:
      tags: [Uploads]
      summary: Media metadata
      security: [{ BearerAuth: [] }, {}]
      parameters: [ { $ref: '#/components/parameters/Cid' } ]
      responses:
        '200':
          description: OK
        '404': { $ref: '#/components/responses/ErrorResponse' }

  /previews:
    get:
      tags: [Uploads]
      summary: Fetch URL preview metadata (optional capability `previews`)
      security: [{ BearerAuth: [] }]
      parameters:
        - name: url
          in: query
          required: true
          schema: { type: string, format: uri }
      responses:
        '200':
          description: Preview
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Preview' }
        '400': { $ref: '#/components/responses/ErrorResponse' }

  /notifications/stream:
    get:
      tags: [Notifications]
      summary: Server-Sent Events stream for mentions, DMs, invites
      security: [{ BearerAuth: [] }]
      responses:
        '200':
          description: SSE stream (text/event-stream with JSON payload per event)
          content:
            text/event-stream:
              schema: { type: string, description: "SSE event stream" }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /notifications/poll:
    get:
      tags: [Notifications]
      summary: Long-poll notifications
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/Cursor'
        - name: timeout_s
          in: query
          schema: { type: integer, minimum: 1, maximum: 60, default: 30 }
      responses:
        '200':
          description: Notifications batch
          content:
            application/json:
              schema:
                type: object
                properties:
                  notifications:
                    type: array
                    items:
                      type: object
                      properties:
                        type: { type: string, enum: [mention, dm, invite] }
                        room_id: { $ref: '#/components/schemas/Id' }
                        message_id: { $ref: '#/components/schemas/Id' }
                        ts: { $ref: '#/components/schemas/Timestamp' }
                  next_cursor: { type: string }

  /push/register:
    post:
      tags: [Notifications]
      summary: Register a push device (optional)
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RegisterPushRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '400': { $ref: '#/components/responses/ErrorResponse' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /push/register/{device_id}:
    delete:
      tags: [Notifications]
      summary: Unregister a push device (optional)
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/DeviceId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }
        '401': { $ref: '#/components/responses/ErrorResponse' }

  /prefs:
    patch:
      tags: [Preferences]
      summary: Patch general preferences (e.g., link previews opt-out)
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PrefsPatch' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /prefs/notifications:
    patch:
      tags: [Preferences]
      summary: Patch notification preferences
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NotificationPrefsPatch' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/kick:
    post:
      tags: [Moderation]
      summary: Kick a user from a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [user_id]
              properties:
                user_id: { $ref: '#/components/schemas/Id' }
                reason: { type: string }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/bans:
    post:
      tags: [Moderation]
      summary: Ban a user in a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BanRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/bans/{user_id}:
    delete:
      tags: [Moderation]
      summary: Unban a user in a room
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - $ref: '#/components/parameters/UserId'
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/mutes:
    post:
      tags: [Moderation]
      summary: Mute a user in a room
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/RoomId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MuteRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /rooms/{room_name}/mutes/{user_id}:
    delete:
      tags: [Moderation]
      summary: Unmute a user in a room
      security: [{ BearerAuth: [] }]
      parameters:
        - $ref: '#/components/parameters/RoomId'
        - $ref: '#/components/parameters/UserId'
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /bans:
    post:
      tags: [Moderation]
      summary: Server-wide ban a user
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BanRequest' }
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /bans/{user_id}:
    delete:
      tags: [Moderation]
      summary: Remove server-wide ban
      security: [{ BearerAuth: [] }]
      parameters: [ { $ref: '#/components/parameters/UserId' } ]
      responses:
        '204': { $ref: '#/components/responses/NoContent' }

  /reports:
    post:
      tags: [Moderation]
      summary: Report a user or message for moderation review
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ReportRequest' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  report_id: { $ref: '#/components/schemas/Id' }

  /emoji:
    get:
      tags: [Emoji]
      summary: List server emoji packs (optional)
      security: [{ BearerAuth: [] }, {}]
      responses:
        '200':
          description: Emoji packs
          content:
            application/json:
              schema:
                type: object
                properties:
                  packs:
                    type: array
                    items:
                      type: object
                      required: [shortcode]
                      properties:
                        shortcode: { type: string }
                        emoji: { type: string }
                        cid: { $ref: '#/components/schemas/Id' }

  /export:
    post:
      tags: [Export]
      summary: Request export of personal data (optional)
      security: [{ BearerAuth: [] }]
      responses:
        '202':
          description: Accepted
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ExportResponse' }

  /rtm:
    get:
      tags: [Realtime]
      summary: Establish WebSocket connection for real-time events
      description: >
        Perform an HTTP GET that upgrades to WebSocket (WSS strongly recommended).
        After upgrade, client sends a `WSHello` frame and receives a `WSReady`
        frame, then event frames as defined under components/schemas.
      security: [{ BearerAuth: [] }]
      responses:
        '101':
          description: Switching Protocols (WebSocket Upgrade)
        '401': { $ref: '#/components/responses/ErrorResponse' }

```
