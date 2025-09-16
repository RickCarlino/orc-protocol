# ORCP Web Client (React + Parcel)

- No backend here. Points to an ORCP server that implements the spec in `../SPEC.md` and `../OAD.yaml`.
- Clean, minimal code to demonstrate building against the spec.

## Quick Start

1) Install deps

```
cd client-web
npm install
```

2) Generate types from the OpenAPI document (OAD)

```
npm run gen
```

3) Start the dev server (HMR) on port 4000

```
npm run dev
```

4) Set API Base URL in the header (defaults to `http://localhost:3000`).

- This should point at a running ORCP server (implements `/auth/guest`, `/rooms`, `/directory/rooms`, message endpoints, and `/rtm` ticket + websocket).

## Features (per request)

- Guest login (`POST /auth/guest`).
- Create rooms, list my rooms, list public directory.
- Join rooms.
- Send messages to a room, display recent messages.
- Receive new messages over WebSocket using ticket auth (`POST /rtm/ticket` → `Sec-WebSocket-Protocol: orcp, ticket.<ticket>`).
- Presence/typing not implemented.

## Tech

- React 18
- Parcel 2 (dev server with hot reloading, port 4000)
- openapi-typescript for typed models generated from `../OAD.yaml` (see `src/types/orcp.ts`).

## Notes

- API base is editable from the header for convenience.
- The app keeps code intentionally small and readable; no global state libs.
- The WebSocket listener appends room messages for the selected room. HTTP fetch provides initial history.

