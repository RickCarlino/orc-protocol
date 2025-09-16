import { db } from "./inmemory";
import { error, getBearer, json, noContent, parseUrl, preflight } from "./utils";
import { extractTicket, websocket } from "./ws";

// Username regex from SPEC
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

function requireAuth(req: Request) {
  const token = getBearer(req);
  const session = db.auth(token);
  if (!session) throw { status: 401, code: "unauthorized", message: "missing or invalid token" };
  return session;
}

async function handle(req: Request, server: Server): Promise<Response | undefined> {
  // WebSocket upgrade path
  const urlForWs = new URL(req.url);
  if (urlForWs.pathname === "/rtm") {
    const ticket = extractTicket(req);
    const username = ticket ? db.useTicket(ticket) : null;
    if (!username) return new Response("forbidden", { status: 403 });
    // subprotocol selection: prefer 'orcp' if present
    const offered = (req.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const selected = offered.find((p) => p === "orcp");
    const ok = server.upgrade(req, {
      data: { username },
      headers: selected ? { "Sec-WebSocket-Protocol": selected } : undefined,
    });
    if (ok) return; // upgraded; no Response to return
    return new Response("upgrade failed", { status: 500 });
  }

  const url = parseUrl(req);
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") return preflight();

  // Meta
  if (method === "GET" && pathname === "/meta/capabilities") {
    return json({
      capabilities: ["auth.guest", "uploads", "search.basic", "push.poll"],
      limits: {
        max_message_bytes: 4000,
        max_upload_bytes: 16_777_216,
        max_reactions_per_message: 32,
        cursor_idle_timeout_ms: 300_000,
        rate_limits: { burst: 20, per_minute: 120 },
      },
      server: { name: "orcp-demo", description: "ORCP demo server", contact: "admin@example.test" },
    });
  }

  // Auth: guest
  if (method === "POST" && pathname === "/auth/guest") {
    const body = await req.json().catch(() => ({}));
    const username = String(body?.username || "");
    if (!USERNAME_RE.test(username)) return error(400, { code: "bad_request", message: "invalid username" });
    db.createGuest(username);
    const s = db.createSession(username);
    return json({ access_token: s.access_token, user: db.users.get(username) });
  }

  // Auth: refresh (no-op demo that re-issues)
  if (method === "POST" && pathname === "/auth/refresh") {
    const body = await req.json().catch(() => ({}));
    const rt = String(body?.refresh_token || "");
    if (!rt) return error(400, { code: "bad_request", message: "missing refresh_token" });
    // In demo: accept any presented refresh token and mint a new access token for user "guest"
    const s = db.createSession("guest");
    return json({ access_token: s.access_token });
  }

  // Auth: logout
  if (method === "POST" && pathname === "/auth/logout") {
    const token = getBearer(req);
    if (!token) return error(401, { code: "unauthorized", message: "missing token" });
    db.revoke(token);
    return noContent();
  }

  // Auth: sessions
  if (method === "GET" && pathname === "/auth/sessions") {
    const s = requireAuth(req);
    // This demo tracks only current token; return just it.
    return json({ sessions: [{ session_id: s.session_id, device: s.device, created_at: s.created_at, last_seen_at: s.last_seen_at }] });
  }

  // Users me
  if (pathname === "/users/me") {
    const s = requireAuth(req);
    if (method === "GET") return json(db.users.get(s.username));
    if (method === "PATCH") {
      const patch = await req.json().catch(() => ({}));
      const u = db.users.get(s.username)!;
      Object.assign(u, patch);
      return json(u);
    }
  }

  // Presence (no-op)
  if (method === "PATCH" && pathname === "/users/me/presence") {
    requireAuth(req);
    return noContent();
  }

  // RTM ticket
  if (method === "POST" && pathname === "/rtm/ticket") {
    const s = requireAuth(req);
    const t = db.mintTicket(s.username);
    return json({ ticket: t.ticket, expires_in_ms: Math.max(1, t.expires_at - Date.now()) });
  }

  // Rooms directory minimal
  if (method === "GET" && pathname === "/directory/rooms") {
    const rooms = [...db.roomsByName.values()].map((r) => r.room);
    return json({ rooms });
  }

  // Create room
  if (method === "POST" && pathname === "/rooms") {
    const s = requireAuth(req);
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "");
    const visibility = body?.visibility === "private" ? "private" : "public" as const;
    const topic = typeof body?.topic === "string" ? body.topic : undefined;
    if (!name) return error(400, { code: "bad_request", message: "name required" });
    try {
      const st = db.createRoom(name, visibility, s.username, topic);
      return json({ room: st.room }, { status: 201 });
    } catch (e) {
      return error(409, { code: "conflict", message: "room exists" });
    }
  }

  // GET /rooms/{room_name} and sub-resources
  const roomMatch = pathname.match(/^\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (roomMatch) {
    const roomName = decodeURIComponent(roomMatch[1]);
    const tail = roomMatch[2] || "";
    const st = db.getRoomByName(roomName);
    if (!st) return error(404, { code: "not_found", message: "room not found" });

    if (method === "GET" && tail === "") return json({ room: st.room });

    // messages forward
    if (method === "GET" && tail === "messages") {
      const fromSeq = Number(searchParams.get("from_seq") || 0);
      const limit = Math.min(200, Number(searchParams.get("limit") || 50));
      const msgs = st.messages.filter((m) => m.seq >= fromSeq).slice(0, limit);
      const next_seq = msgs.length ? msgs[msgs.length - 1].seq + 1 : st.nextSeq;
      return json({ messages: msgs, next_seq });
    }

    // messages backfill
    if (method === "GET" && tail === "messages/backfill") {
      const before = Number(searchParams.get("before_seq") || st.nextSeq);
      const limit = Math.min(200, Number(searchParams.get("limit") || 50));
      const msgs = st.messages.filter((m) => m.seq < before).slice(-limit);
      const prev_seq = msgs.length ? msgs[0].seq : 0;
      return json({ messages: msgs, prev_seq });
    }

    // post message
    if (method === "POST" && tail === "messages") {
      const s = requireAuth(req);
      const body = await req.json().catch(() => ({}));
      if (!body?.text) return error(400, { code: "bad_request", message: "text required" });
      const msg = db.postMessageToRoom(roomName, s.username, { text: String(body.text), parent_id: body.parent_id || undefined, attachments: body.attachments || undefined });
      return json(msg, { status: 201 });
    }

    // ack (cursor ignored, demo only)
    if (method === "POST" && tail === "ack") {
      requireAuth(req);
      return noContent();
    }

    // cursor (demo always returns last)
    if (method === "GET" && tail === "cursor") {
      return json({ seq: st.nextSeq - 1 });
    }
  }

  // Message by id: edit/delete/reactions
  const msgMatch = pathname.match(/^\/messages\/([a-z2-7]+)(?:\/(reactions))?$/);
  if (msgMatch) {
    const message_id = msgMatch[1];
    const sub = msgMatch[2];
    if (!sub && method === "PATCH") {
      const s = requireAuth(req);
      const patch = await req.json().catch(() => ({}));
      try {
        const m = db.editMessage(message_id, s.username, { text: patch.text, attachments: patch.attachments });
        if (!m) return error(404, { code: "not_found", message: "message not found" });
        return json(m);
      } catch (e) {
        return error(403, { code: "forbidden", message: "not author" });
      }
    }
    if (!sub && method === "DELETE") {
      const s = requireAuth(req);
      try {
        const out = db.deleteMessage(message_id, s.username);
        if (!out) return error(404, { code: "not_found", message: "message not found" });
        return json(out);
      } catch (e) {
        return error(403, { code: "forbidden", message: "not author" });
      }
    }
    if (sub === "reactions") {
      if (method === "POST") {
        const s = requireAuth(req);
        const body = await req.json().catch(() => ({}));
        const emoji = String(body?.emoji || "");
        if (!emoji) return error(400, { code: "bad_request", message: "emoji required" });
        const res = db.react(message_id, s.username, emoji, true);
        if (!res) return error(404, { code: "not_found", message: "message not found" });
        return json(res);
      }
      if (method === "DELETE") {
        const s = requireAuth(req);
        const body = await req.json().catch(() => ({}));
        const emoji = String(body?.emoji || "");
        if (!emoji) return error(400, { code: "bad_request", message: "emoji required" });
        const res = db.react(message_id, s.username, emoji, false);
        if (!res) return error(404, { code: "not_found", message: "message not found" });
        return json(res);
      }
    }
  }

  return error(404, { code: "not_found", message: "no route" });
}

const port = Number(process.env.PORT || 3000);

Bun.serve({
  port,
  fetch: (req, server) => handle(req, server) as any,
  websocket,
});

console.log(`ORCP demo listening on http://localhost:${port}`);
