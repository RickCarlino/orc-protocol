ORCP Demo Server (Bun + TypeScript)

Purpose
- Minimal, clean, in-memory server to demonstrate the ORC protocol (see ../SPEC.md and ../OAD.yaml).
- Focuses on clarity over completeness or performance. Not for production.

Requirements
- Bun >= 1.1

Install (dev-only)
- This project avoids heavy deps. For type-safety from the OAD, it uses openapi-typescript as a dev tool.

Commands
- `bun run codegen` — generate `src/types/orcp.ts` from `../OAD.yaml`.
- `bun run dev` — start the server with autoreload.
- `bun run start` — start the server.

Notes
- All data is ephemeral and stored in memory.
- WebSocket authentication uses short-lived tickets per the spec (`POST /rtm/ticket` then connect `/rtm?ticket=...`).
- HTTP authentication uses a simple opaque Bearer token issued by guest login.

