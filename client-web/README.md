ORC Web Client (Demo)

This is a minimal, clean, dependency-light web client for the ORC protocol.
It demonstrates how to consume a strict HTTP+WebSocket API using an
OpenAPI Descriptor (OAD) to generate TypeScript types.

Notes
- No backend: this is a static Parcel app for local dev only.
- Do not modify files outside of `client-web/` (enforced for this task).
- Types are generated from `../OAD.yaml` using `openapi-typescript`.

Quick Start
1) Install deps and generate types
   - `npm install`
   - `npm run gen:api`
2) Start dev server with hot reload
   - `npm run dev`
3) In the UI, set the Server URL (e.g., `http://localhost:3000` if you run a test server)
4) Authenticate as Guest by entering a username
5) Browse capabilities, discover rooms, join one, read and send messages

Scripts
- `npm run gen:api` — generate `src/api/types.ts` from `../OAD.yaml`
- `npm run dev` — Parcel dev server with HMR
- `npm run build` — production build to `dist/`
- `npm run check` — type-check the project

Structure
- `src/index.html` — simple, accessible UI skeleton
- `src/main.ts` — view logic and event wiring
- `src/state/session.ts` — session and token storage
- `src/api/client.ts` — tiny, explicit HTTP client using fetch
- `src/lib/ws.ts` — minimal WebSocket RTM helper

Design Choices
- Strongly typed models via generated `src/api/types.ts` (from OAD)
- Minimal runtime deps; direct `fetch` for clarity
- Clean, small modules; no framework required
- WS implemented with a permissive `?ticket=<access_token>` approach, matching the spec’s ticket guidance for browsers

Limitations
- No presence/typing/reactions UI.
- Room membership assumed by name; DM UI out of scope.
- Minimal Markdown rendering (plain text displayed; no rich parse).
- Messages appended in real-time only for the active room.
- No pagination/backfill UI beyond initial 100 messages.

Configuration
- Server URL is user-provided at runtime in the UI.
- Types are generated from the root `OAD.yaml`; regenerate after spec changes with `npm run gen:api`.

Development Notes
- Keep changes scoped within `client-web/` only.
- The HTTP client in `src/api/client.ts` intentionally mirrors the spec: explicit endpoints, narrow types.
- WebSocket auth uses minted tickets per spec via `POST /rtm/ticket` and a subprotocol fallback.
- Real-time ‘ticket’ endpoint is not modeled here; servers that accept a `ticket` query or permissive upgrade will work.
- Rich Markdown rendering, uploads, reactions, and moderation UI are omitted for brevity.
