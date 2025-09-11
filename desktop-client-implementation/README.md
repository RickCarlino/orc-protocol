Open Rooms Chat — Minimal Desktop Client (Tkinter)

Overview
- Minimal, no-extra-deps desktop client for the Open Rooms Chat protocol (SPEC.md).
- Uses HTTP for auth, listing rooms, sending and fetching messages.
- Uses polling (HTTP) for new messages to avoid WebSocket dependencies.

Features
- Guest login
- List rooms you belong to; join public rooms
- Select a room to view and send messages
- Auto-poll for new messages with cursors (seq) and ack

Requirements
- Python 3.8+
- Tkinter standard library (install `python3-tk` if missing)

Run
- `python3 app.py` (from this directory)

Notes
- This client prioritizes zero setup. It does not require `pip install`.
- If the server supports only WebSockets for realtime events, this client still works by polling `/rooms/{room_id}/messages?from_seq=...` every 2s.
- For HTTPS with self-signed certs, Python may block requests. Use HTTP for testing or install proper certs.

Planned Enhancements
- Optional WebSocket support if `websocket-client` is present
- Reactions, edits, deletes, DMs, typing indicators

