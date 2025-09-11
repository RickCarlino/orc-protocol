Open Rooms Chat — Web Client
============================

Single‑page React client implemented with Parcel + TypeScript, using Tailwind via CDN (no Tailwind npm dependency). Stores server URL and tokens in localStorage so you don’t have to retype them.

Quick start
-----------

- Prereqs: Node 18+ and npm.
- From `web-client-implementation/`:

  - Install dev deps: `npm install`
- Start dev server: `npm run dev` (Parcel dev server)
- Type check: `npm run typecheck`
- Build: `npm run build`

Usage
-----

- Enter your server URL (e.g., `https://api.example.com`) and Save.
- Click “Guest Login” to get a token (if the server supports `auth.guest`).
- Refresh rooms to list rooms you’re in; create a room if needed.
- Select a room to load recent messages. Compose at the bottom to send.
- WebSocket connects to `/rtm` and subscribes to the selected room for new events.
- WebSocket auth: client requests a short‑lived ticket via `POST /rtm/ticket` and connects to `/rtm?ticket=...`. Falls back to bare `/rtm` if ticket is unsupported during early server bring‑up.

Notes
-----

- Tailwind is loaded via the official CDN in `index.html`. No Tailwind build step required.
- Parcel handles bundling TypeScript; we also run `tsc --noEmit` for type checks.
- The browser cannot set the `Authorization` header for a WebSocket upgrade; the server should accept session cookies or a token passed in an initial hello frame for development. Otherwise, fall back to HTTP polling or SSE per server capabilities.

Structure
---------

- `index.html`: App shell and Tailwind CDN
- `src/main.tsx`: React bootstrap
- `src/react/App.tsx`: Main React application (state, UI)
- `src/api.ts`: Minimal HTTP wrapper for endpoints used
- `src/ws.ts`: WebSocket client handling hello/ready, ping/pong, events
- `src/settings.ts`: localStorage persistence
- `src/types.ts`: Protocol types (subset)
