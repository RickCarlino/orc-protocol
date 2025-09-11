For a machine readable OpenAI Descriptor, see [OAD.yml](./oad.yml)

# Part A — Introduction

Open Rooms Chat is a minimal, strict, JSON‑over‑HTTP+WebSocket chat protocol for small communities (usually 0–10k users per server). It is **not federated**; a client may connect to many servers, but servers do not talk to each other. History lives on the server so that phones and tiny devices can come and go without losing context.

The protocol is designed to be:

 - Small enough that an individual developer can write a server or write a client in two weekends or less.
 - Light enough to run a simple client on a 2025 Arduino Uno R4 and a server on a Raspberry Pi.
 - Small enough that a reasonably good LLM can produce a working server and client in one shot.
 - Useful enough to be hosted in the real world.

**Design stance**

* **Simple:** HTTP(S) for slow ops; WebSocket for events. JSON only. No XML, no WebRTC, no P2P. This spec must never exceed 2000 lines, excluding OpenAPI Descriptor.
* **Practical:** Server‑side history; message edit/delete; threads; reactions; search (server‑chosen semantics with a minimal baseline); mentions; pins; uploads by content ID.
* **Mobile‑friendly:** Sequence numbers, cursors, resume; no join/part spam; optional push; robust pull notifications.
* **Admin‑friendly:** Roles/permissions and kick/ban/mute at the protocol level.
* **Extensible but useful by default:** Strict core schemas with capability flags for optional features. Vendor extensions via `x-` fields.
* **Security without overkill:** TLS recommended; end‑to‑end encryption out of scope. 2FA planned. OAuth planned.

---

# Part B — Protocol Specification (Normative)

## 0. Conventions

* **Keywords:** **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** per RFC 2119.
* **Encoding:** All HTTP request/response bodies are UTF‑8 JSON unless specified.
* **Keys:** JSON keys use `snake_case`.
* **Time:** RFC 3339 UTC strings with `Z`.
* **IDs:** `user_id`, `room_id`, `message_id`, `file_cid` are **server‑scoped strings**.
* **Unknowns:** Clients MUST ignore unknown keys and unknown capability names. Servers MUST ignore unknown client hint fields.
* **Boolean flags:** Explicit `true`/`false`; absent does not equal false unless specified.

## 1. Transport

* **HTTP(S)** for resource CRUD (auth, users, rooms, search, uploads, notifications registration).
* **WebSocket (WS/WSS)** for real‑time events and cursor acks.
  * Authentication uses short‑lived tickets minted via `POST /rtm/ticket` (see §9.0).
* TLS (**HTTPS/WSS**) is RECOMMENDED. Cleartext is allowed but discouraged outside of development or LAN use.

## 2. Capabilities & Limits

### 2.1 Discovery

`GET /meta/capabilities`

**Response 200**

```json
{
  "capabilities": [
    "auth.guest",
    "auth.password",
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

* Capabilities listed above are OPTIONAL unless referenced below as required. Servers MAY add vendor capabilities (prefix `x-`).
* Clients MAY send a list of desired optional features during WS handshake; the server’s authoritative set remains this endpoint and the WS `ready` frame.

## 3. Identity, IDs, and Profiles

### 3.1 ID Generation (server recommendation)

* `user_id`, `room_id`, `message_id`: Unique per-resource string.
* `file_cid`: SHA‑256 digest of the file bytes, Base32 (no padding).

### 3.2 Users

* Immutable `user_id`.
* Mutable fields: `display_name` (1–128 chars), `photo_cid` (optional), `bio` (≤ 1024), `status_text` (≤ 80), `status_emoji` (Unicode emoji).

**Endpoints**

* `GET /users/me` → 200 `{ user }`
* `PATCH /users/me` body `{ display_name?, bio?, status_text?, status_emoji?, photo_cid? }` → 200 `{ user }`
* `GET /users/{user_id}` → 200 `{ user }` (public profile)
* `GET /directory/users?q=&limit=&cursor=` → 200 `{ users:[...], next_cursor? }`

### 3.3 Presence

* States: `online`, `away`, `dnd`.
* `PATCH /users/me/presence` → body `{ state }` → 200.
* WS event `event.presence` → `{ user_id, state }`. Ephemeral; servers SHOULD debounce.

### 3.4 Blocking

* Local client block is always permitted.
* Server‑assisted block (optional): `POST /blocks/{user_id}` / `DELETE /blocks/{user_id}`. If unsupported, return `400` `unsupported_capability`.

## 4. Authentication

Servers MAY support any subset of: guest, password, OAuth. permissions are role‑based (§6.2).

### 4.1 Tokens

* **Access Token:** Opaque string; sent as `Authorization: Bearer <token>`.
* **Refresh Token:** Opaque string for renewal.
* Tokens are per device session.

### 4.2 Endpoints

Guest sessions require a username and no password:

* `POST /auth/guest` body `{ username }` → 200 `{ access_token, refresh_token?, user }`
* `POST /auth/login` body `{ username, password, otp_code? }` → 200 `{ access_token, refresh_token, user }`
* `POST /auth/refresh` body `{ refresh_token }` → 200 `{ access_token, refresh_token? }`
* `POST /auth/logout` → 204 (revokes current device)
* `GET /auth/sessions` → 200 `{ sessions:[{ session_id, device, created_at, last_seen_at }] }`
* `DELETE /auth/sessions/{session_id}` → 204

### 4.3 OAuth (WIP, `auth.oauth`)

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

Name rules
- Room `name` is globally unique across the server.
- Uniqueness comparisons are case-insensitive. Servers MAY canonicalize stored casing.

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
* `guest`: same as `member` unless server policy restricts;

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

* **Markdown subset supported:** `*italic*`, `**bold**`, `` `code` ``, fenced code, links `[text](url)`.
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
{ "type":"ack", "cursors": { "room:<room_name>":12345, "dm:<user_id>":678 } }
```

### 8.4 Resume

* On WS connect, client MAY attempt resume by sending prior `session_id` and cursor map in `hello`. Server either resumes or instructs backfill via HTTP.

## 9. WebSocket Real‑Time

**Endpoint:** `GET /rtm`
**Frames:** One JSON object per RFC 6455 text frame.

### 9.0 Real‑Time Authentication (Tickets)

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
  "subscriptions": { "rooms":["<room_name>","..."], "dms": true },
  "cursors": { "room:<room_name>":12345, "dm:<user_id>":78 },
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

* Query parameters: `q` (required), `room_name?`, `dm_peer_id?`, `before_ts?`, `after_ts?`, `limit?`, `cursor?`
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

* TLS strongly RECOMMENDED.
* Servers MUST sanitize link previews and guard against SSRF (§12).
* Authentication tokens SHOULD be bound to device sessions and revocable via `/auth/sessions`.

## 21. Compatibility & Extensibility

* No version negotiation in‑band.
* Optional features are strictly gated by capabilities.
* Vendor extensions MUST use `x-` key prefix and MUST NOT change core semantics.

---

## Annex A — Example Exchanges (Normative Examples)

### A.1 Guest Auth → Create Room → WS → Post → React

1. Guest token (username required)

```http
POST /auth/guest
{"username":"guest1"}
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
POST /rooms/general/messages
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
{"type":"ack","cursors":{"room:general":1}}
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
