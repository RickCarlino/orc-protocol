#!/usr/bin/env python3
"""
Minimal Open Rooms Chat desktop client (Tkinter, no external deps)

Implements essential parts of SPEC.md:
- Guest auth (POST /auth/guest)
- List my rooms (GET /rooms?mine=true)
- Join public rooms (POST /rooms/{room_id}/join)
- Fetch messages with polling (GET /rooms/{room_id}/messages?from_seq=)
- Send messages (POST /rooms/{room_id}/messages)
- Acknowledge read cursor (POST /rooms/{room_id}/ack)

This avoids WebSocket dependency to keep setup simple. It can be extended
to use WS (/rtm) when a websocket client lib is available.
"""

import json
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
from dataclasses import dataclass, field
from queue import Queue, Empty
import ssl
import tkinter as tk
from tkinter import ttk, messagebox
from tkinter.scrolledtext import ScrolledText


def _json_request(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: float = 15.0):
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url=url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = e.read().decode("utf-8")
            j = json.loads(payload)
        except Exception:
            j = {"error": {"code": "http_error", "message": str(e)}}
        raise RuntimeError(j.get("error", {}).get("message", str(e)))
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e}")


@dataclass
class ApiClient:
    base_url: str
    token: str | None = None

    def _u(self, path: str) -> str:
        return self.base_url.rstrip("/") + path

    # Meta
    def get_capabilities(self):
        return _json_request("GET", self._u("/meta/capabilities"), self.token)

    # Auth
    def auth_guest(self):
        return _json_request("POST", self._u("/auth/guest"), None, {})

    # Rooms
    def get_my_rooms(self, limit: int = 100, cursor: str | None = None):
        qs = {"mine": "true", "limit": str(limit)}
        if cursor:
            qs["cursor"] = cursor
        return _json_request("GET", self._u("/rooms") + "?" + urllib.parse.urlencode(qs), self.token)

    def get_directory_rooms(self, q: str = "", limit: int = 50, cursor: str | None = None):
        qs = {"q": q, "limit": str(limit)}
        if cursor:
            qs["cursor"] = cursor
        return _json_request("GET", self._u("/directory/rooms") + "?" + urllib.parse.urlencode(qs), self.token)

    def join_room(self, room_id: str):
        return _json_request("POST", self._u(f"/rooms/{room_id}/join"), self.token, {})

    def get_room_messages(self, room_id: str, from_seq: int | None = None, limit: int = 100):
        qs = {}
        if from_seq is not None:
            qs["from_seq"] = str(from_seq)
        qs["limit"] = str(limit)
        url = self._u(f"/rooms/{room_id}/messages") + ("?" + urllib.parse.urlencode(qs) if qs else "")
        return _json_request("GET", url, self.token)

    def get_room_messages_backfill(self, room_id: str, before_seq: int | None = None, limit: int = 100):
        qs = {"limit": str(limit)}
        if before_seq is not None:
            qs["before_seq"] = str(before_seq)
        url = self._u(f"/rooms/{room_id}/messages/backfill") + ("?" + urllib.parse.urlencode(qs) if qs else "")
        return _json_request("GET", url, self.token)

    def post_room_message(self, room_id: str, text: str, content_type: str = "text/markdown"):
        body = {"text": text, "content_type": content_type}
        return _json_request("POST", self._u(f"/rooms/{room_id}/messages"), self.token, body)

    def post_room_ack(self, room_id: str, seq: int):
        body = {"seq": int(seq)}
        return _json_request("POST", self._u(f"/rooms/{room_id}/ack"), self.token, body)


@dataclass
class RoomState:
    room_id: str
    name: str
    next_seq: int = 0  # next from_seq to ask for
    last_seen_seq: int = 0  # last seq rendered/acked


class ChatApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Open Rooms Chat — Minimal Client")
        self.api: ApiClient | None = None
        self.rooms: dict[str, RoomState] = {}
        self.selected_room_id: str | None = None
        self.rx_queue: Queue = Queue()
        self.poller_thread: threading.Thread | None = None
        self.stop_flag = threading.Event()

        self._build_ui()
        self._install_shortcuts()
        self.root.after(200, self._drain_rx)

    def _build_ui(self):
        # Top bar: server URL and auth
        top = ttk.Frame(self.root)
        top.pack(fill="x", padx=8, pady=6)

        ttk.Label(top, text="Server:").pack(side="left")
        self.server_var = tk.StringVar(value="http://localhost:8080")
        self.server_entry = ttk.Entry(top, textvariable=self.server_var, width=40)
        self.server_entry.pack(side="left", padx=(4, 8))

        self.auth_btn = ttk.Button(top, text="Guest Login", command=self.on_guest_login)
        self.auth_btn.pack(side="left")

        self.status_var = tk.StringVar(value="Not connected")
        ttk.Label(top, textvariable=self.status_var).pack(side="right")

        # Main split: rooms list and chat panel
        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True)

        left = ttk.Frame(main, width=220)
        left.pack(side="left", fill="y", padx=(8, 4), pady=(0, 8))
        left.pack_propagate(False)

        ttk.Label(left, text="Rooms").pack(anchor="w")
        self.rooms_list = tk.Listbox(left, height=15)
        self.rooms_list.pack(fill="both", expand=True)
        self.rooms_list.bind("<<ListboxSelect>>", self.on_select_room)

        join_bar = ttk.Frame(left)
        join_bar.pack(fill="x", pady=(6, 0))
        self.join_room_var = tk.StringVar()
        ttk.Entry(join_bar, textvariable=self.join_room_var).pack(side="left", fill="x", expand=True)
        ttk.Button(join_bar, text="Join", command=self.on_join_room).pack(side="left", padx=(6, 0))

        # Chat panel
        right = ttk.Frame(main)
        right.pack(side="left", fill="both", expand=True, padx=(4, 8), pady=(0, 8))

        self.chat = ScrolledText(right, state="disabled", wrap="word", width=80, height=24)
        self.chat.pack(fill="both", expand=True)

        bottom = ttk.Frame(right)
        bottom.pack(fill="x", pady=(6, 0))
        self.entry_var = tk.StringVar()
        self.entry = ttk.Entry(bottom, textvariable=self.entry_var)
        self.entry.pack(side="left", fill="x", expand=True)
        self.entry.bind("<Return>", lambda e: self.on_send())
        ttk.Button(bottom, text="Send", command=self.on_send).pack(side="left", padx=(6, 0))

    def _install_shortcuts(self):
        self.root.bind("<Control-l>", lambda e: self.server_entry.focus_set())
        self.root.bind("<Control-j>", lambda e: self._focus_join())

    def _focus_join(self):
        self.join_room_var.set("")
        self.root.after(1, lambda: self.root.focus_set())

    # UI helpers
    def log(self, text: str):
        self.chat.configure(state="normal")
        self.chat.insert("end", text + "\n")
        self.chat.see("end")
        self.chat.configure(state="disabled")

    def set_status(self, text: str):
        self.status_var.set(text)

    # Event handlers
    def on_guest_login(self):
        base = self.server_var.get().strip()
        if not base:
            messagebox.showerror("Error", "Enter server URL")
            return
        self.api = ApiClient(base_url=base)
        try:
            self.set_status("Contacting server…")
            resp = self.api.auth_guest()
            self.api.token = resp.get("access_token")
            user = resp.get("user", {})
            self.set_status(f"Logged in as {user.get('display_name','guest')}")
            self.log("[system] Logged in (guest)")
            self.refresh_rooms()
            self._ensure_poller()
        except Exception as e:
            messagebox.showerror("Login failed", str(e))
            self.set_status("Not connected")

    def refresh_rooms(self):
        assert self.api
        try:
            rooms_resp = self.api.get_my_rooms()
            rooms = rooms_resp.get("rooms", []) if isinstance(rooms_resp, dict) else rooms_resp.get("rooms", [])
        except Exception as e:
            messagebox.showerror("Error", f"Failed to load rooms: {e}")
            return
        self.rooms_list.delete(0, "end")
        self.rooms.clear()
        for r in rooms:
            room_id = r.get("room_id")
            name = r.get("name", room_id)
            self.rooms[room_id] = RoomState(room_id=room_id, name=name)
            self.rooms_list.insert("end", f"{name} ({room_id})")

    def on_select_room(self, event=None):
        sel = self.rooms_list.curselection()
        if not sel:
            return
        idx = sel[0]
        # Map index back to room_id
        room_id = list(self.rooms.keys())[idx]
        self.selected_room_id = room_id
        rs = self.rooms[room_id]
        self.chat.configure(state="normal")
        self.chat.delete("1.0", "end")
        self.chat.configure(state="disabled")
        self.log(f"[system] Opened room {rs.name}")
        # Load recent history via backfill (latest page)
        threading.Thread(target=self._load_initial_history, args=(rs.room_id,), daemon=True).start()

    def on_join_room(self):
        if not self.api:
            messagebox.showinfo("Not logged in", "Login first")
            return
        room_id = self.join_room_var.get().strip()
        if not room_id:
            messagebox.showerror("Join Room", "Enter room_id to join (public)")
            return
        try:
            self.api.join_room(room_id)
            self.log(f"[system] Joined room {room_id}")
            # Add to list and select
            self.rooms[room_id] = RoomState(room_id=room_id, name=room_id)
            self.rooms_list.insert("end", f"{room_id} ({room_id})")
            # Auto-select the newly joined room and load history
            self.selected_room_id = room_id
            self.rooms_list.selection_clear(0, "end")
            self.rooms_list.selection_set("end")
            threading.Thread(target=self._load_initial_history, args=(room_id,), daemon=True).start()
        except Exception as e:
            messagebox.showerror("Join failed", str(e))

    def on_send(self):
        if not self.api or not self.selected_room_id:
            return
        text = self.entry_var.get().strip()
        if not text:
            return
        try:
            msg = self.api.post_room_message(self.selected_room_id, text)
            # Render immediately; server will echo in polling
            self._render_message(msg.get("message", msg))
            self.entry_var.set("")
        except Exception as e:
            messagebox.showerror("Send failed", str(e))

    # Background polling
    def _ensure_poller(self):
        if self.poller_thread and self.poller_thread.is_alive():
            return
        self.stop_flag.clear()
        self.poller_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.poller_thread.start()

    def _poll_loop(self):
        while not self.stop_flag.is_set():
            try:
                self._poll_once()
            except Exception as e:
                self.rx_queue.put(("system", f"Polling error: {e}"))
            time.sleep(2.0)

    def _poll_once(self):
        if not self.api:
            return
        # Only poll the selected room to keep it simple
        room_id = self.selected_room_id
        if not room_id:
            return
        rs = self.rooms.get(room_id)
        from_seq = rs.next_seq if rs.next_seq > 0 else None
        resp = self.api.get_room_messages(room_id, from_seq=from_seq, limit=100)
        messages = resp.get("messages", [])
        next_seq = resp.get("next_seq", rs.next_seq)
        for m in messages:
            self.rx_queue.put(("message", m))
            rs.last_seen_seq = max(rs.last_seen_seq, int(m.get("seq", 0)))
        rs.next_seq = int(next_seq or rs.next_seq)
        if rs.last_seen_seq:
            try:
                self.api.post_room_ack(room_id, rs.last_seen_seq)
            except Exception:
                # Ignore ack failures in minimal client
                pass

    def _drain_rx(self):
        try:
            while True:
                kind, payload = self.rx_queue.get_nowait()
                if kind == "message":
                    self._render_message(payload)
                else:
                    self.log(f"[system] {payload}")
        except Empty:
            pass
        self.root.after(200, self._drain_rx)

    def _render_message(self, m: dict):
        author = m.get("author_id", "?")
        text = m.get("text", "")
        seq = m.get("seq", 0)
        ts = m.get("ts", "")
        line = f"[{seq}] {author}: {text}"
        self.log(line)

    def _load_initial_history(self, room_id: str):
        # Fetch latest page via backfill and render chronologically
        try:
            resp = self.api.get_room_messages_backfill(room_id, before_seq=None, limit=100)
            messages = resp.get("messages", [])
            # backfill returns reverse chronological; render oldest first
            for m in reversed(messages):
                self.rx_queue.put(("message", m))
                rs = self.rooms.get(room_id)
                if rs:
                    seq = int(m.get("seq", 0))
                    rs.last_seen_seq = max(rs.last_seen_seq, seq)
                    rs.next_seq = max(rs.next_seq, seq)
        except Exception as e:
            self.rx_queue.put(("system", f"History load failed: {e}"))


def main():
    root = tk.Tk()
    app = ChatApp(root)
    root.protocol("WM_DELETE_WINDOW", lambda: (app.stop_flag.set(), root.destroy()))
    root.mainloop()


if __name__ == "__main__":
    main()
