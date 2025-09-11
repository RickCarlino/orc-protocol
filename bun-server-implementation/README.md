Open Rooms Chat — Bun Server (Demo)

This is a minimal in-memory implementation of the Open Rooms Chat server protocol using Bun + TypeScript. It focuses on the core HTTP and WebSocket flows for demos and local development.

Highlights
- Bun runtime with zero external dependencies
- Strict TypeScript settings
- CORS enabled (Access-Control-Allow-Origin: *)
- In-memory storage (users, rooms, messages, cursors, sessions)
- Core endpoints: meta, auth (guest), users (me), rooms (basic), messages (post/list/edit/delete), reactions, cursors, DMs (basic), uploads (octet-stream)
- WebSocket realtime with hello/ready, ping/pong, message + reaction events, acks

Requirements
- Bun v1.1+ (https://bun.sh)

Run
- Development: `bun run bun-server-implementation/src/server.ts`
- Port: `PORT=8080 bun run bun-server-implementation/src/server.ts`

Notes
- This is a demo; no persistence and minimal auth (guest tokens only).
- For uploads, only `Content-Type: application/octet-stream` is supported.
- Search, previews, push, moderation, OAuth, and advanced room/role enforcement are stubbed or omitted.

