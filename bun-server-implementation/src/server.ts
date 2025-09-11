import { addMember, createGuestToken, createRoom, dmCursors, dmNextSeq, dmPairs, ensureDmPair, normalizeRoomName, pairKey, removeMember, roomByName, roomCursors, roomMembers, roomMessages, roomNextSeq, rooms, sessions, tokens, uploads, users, wsTickets } from "./state";
import type { Id, MemberEntry, Message, Room, UploadMeta, User } from "./types";
import { cidFor, error, jsonResponse, matchPath, newId128, noContent, nowTs, ok, parseUrl, readJson, sha256Hex, withCors } from "./utils";
import { attachSocket, broadcastDmMessage, broadcastRoomDelete, broadcastRoomEdit, broadcastRoomMessage, broadcastRoomReaction, hub, updateSubscriptions } from "./ws";

// Basic router on Bun.serve

function corsPreflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

function bearer(req: Request): string | null {
  const a = req.headers.get("authorization");
  if (!a) return null;
  const m = /^Bearer\s+(.+)$/i.exec(a);
  return m?.[1] ?? null;
}

function authedUser(req: Request): User | null {
  const tok = bearer(req);
  if (!tok) return null;
  const rec = tokens.get(tok);
  if (!rec) return null;
  const user = users.get(rec.user_id) || null;
  return user;
}

function requireAuth(req: Request): User | Response {
  const u = authedUser(req);
  if (!u) return error("unauthorized", "missing or invalid token", 401);
  return u;
}

function capResponse() {
  return ok({
    capabilities: [
      "auth.guest",
      "uploads",
      "security.insecure_ok",
      "search.basic",
    ],
    limits: {
      max_message_bytes: 4000,
      max_upload_bytes: 16_777_216,
      max_reactions_per_message: 32,
      cursor_idle_timeout_ms: 300_000,
      rate_limits: { burst: 20, per_minute: 120 },
    },
    server: { name: "orcp-demo", description: "Open Rooms Chat demo", contact: "admin@example.test" },
  });
}

async function handleRequest(req: Request, server: any) {
  const url = parseUrl(req);
  const { pathname, searchParams } = url;

  if (req.method === "OPTIONS") return corsPreflight();

  // Meta
  if (req.method === "GET" && pathname === "/meta/capabilities") {
    return capResponse();
  }

  // Auth (guest)
  if (req.method === "POST" && pathname === "/auth/guest") {
    const tok = createGuestToken();
    const user = users.get(tok.user_id)!;
    return ok({ access_token: tok.access_token, user });
  }

  // Realtime WS ticket
  if (req.method === "POST" && pathname === "/rtm/ticket") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const ticket = newId128();
    const ttlMs = 60_000;
    wsTickets.set(ticket, { user_id: u.user_id, expires_at: Date.now() + ttlMs, used: false });
    return ok({ ticket, expires_in_ms: ttlMs });
  }

  // Users
  if (req.method === "GET" && pathname === "/users/me") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    return ok({ user: u });
  }
  if (req.method === "PATCH" && pathname === "/users/me") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    type Patch = { display_name?: string; bio?: string; status_text?: string; status_emoji?: string; photo_cid?: Id };
    const body = await readJson<Patch>(req);
    if (!body) return error("bad_request", "invalid json");
    const nu: User = { ...u, ...body };
    users.set(u.user_id, nu);
    return ok({ user: nu });
  }

  // Directory: users (simple search)
  if (req.method === "GET" && pathname === "/directory/users") {
    const q = (searchParams.get("q") || "").toLowerCase();
    const all = [...users.values()].filter((v) => !q || v.display_name.toLowerCase().includes(q));
    return ok({ users: all, next_cursor: undefined });
  }

  // Rooms
  if (req.method === "GET" && pathname === "/directory/rooms") {
    const q = (searchParams.get("q") || "").toLowerCase();
    const list = [...rooms.values()].filter((r) => r.visibility === "public" && (!q || r.name.toLowerCase().includes(q)));
    return ok({ rooms: list, next_cursor: undefined });
  }

  if (req.method === "GET" && pathname === "/rooms") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const mine = searchParams.get("mine") !== "false";
    let list: Room[] = [];
    if (mine) {
      list = [...rooms.values()].filter((r) => roomMembers.get(r.room_id)?.has(u.user_id));
    } else {
      list = [...rooms.values()];
    }
    return ok({ rooms: list, next_cursor: undefined });
  }

  if (req.method === "POST" && pathname === "/rooms") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    type CreateBody = { name: string; visibility: "public" | "private"; topic?: string };
    const body = await readJson<CreateBody>(req);
    if (!body || !body.name || !body.visibility) return error("bad_request", "missing fields");
    // enforce globally-unique names (case-insensitive)
    const norm = normalizeRoomName(body.name);
    if (roomByName.has(norm)) return error("conflict", "room name already exists", 409);
    const room = createRoom(u.user_id, body.name, body.visibility, body.topic || "");
    return jsonResponse({ room }, { status: 201 });
  }

  const mRoom = matchPath(pathname, /^\/rooms\/([a-z2-7]+)$/);
  if (mRoom) {
    const room_id = mRoom[1] as Id;
    if (!rooms.has(room_id)) return error("not_found", "room not found", 404);
    if (req.method === "GET") {
      return ok({ room: rooms.get(room_id) });
    }
    if (req.method === "PATCH") {
      const u = requireAuth(req);
      if (u instanceof Response) return u;
      const room = rooms.get(room_id)!;
      const body = await readJson<Partial<Pick<Room, "name" | "topic" | "visibility">>>(req);
      if (!body) return error("bad_request", "invalid json");
      // if renaming, enforce unique name
      if (body.name && normalizeRoomName(body.name) !== normalizeRoomName(room.name)) {
        const normNew = normalizeRoomName(body.name);
        if (roomByName.has(normNew)) return error("conflict", "room name already exists", 409);
        // remove old mapping and set new
        roomByName.delete(normalizeRoomName(room.name));
        roomByName.set(normNew, room.room_id);
      }
      const updated = { ...room, ...body } satisfies Room;
      rooms.set(room_id, updated);
      return ok({ room: updated });
    }
  }

  const mMembers = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/members$/);
  if (mMembers && req.method === "GET") {
    const room_id = mMembers[1] as Id;
    const map = roomMembers.get(room_id) || new Map();
    const members: MemberEntry[] = [...map.entries()].map(([user_id, role]) => ({ user_id, role }));
    return ok({ members, next_cursor: undefined });
  }

  const mInvite = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/invite$/);
  if (mInvite && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const room_id = mInvite[1] as Id;
    const body = await readJson<{ user_id: Id }>(req);
    if (!body?.user_id) return error("bad_request", "missing user_id");
    addMember(room_id, body.user_id, "member");
    return noContent();
  }

  const mJoin = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/join$/);
  if (mJoin && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const room_id = mJoin[1] as Id;
    addMember(room_id, u.user_id, "member");
    return noContent();
  }

  // By-name endpoints
  const mRoomByName = matchPath(pathname, /^\/rooms\/by-name\/([^/]+)$/);
  if (mRoomByName && req.method === "GET") {
    const name = decodeURIComponent(mRoomByName[1]);
    const rid = roomByName.get(normalizeRoomName(name));
    if (!rid) return error("not_found", "room not found", 404);
    return ok({ room: rooms.get(rid) });
  }

  const mJoinByName = matchPath(pathname, /^\/rooms\/by-name\/([^/]+)\/join$/);
  if (mJoinByName && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const name = decodeURIComponent(mJoinByName[1]);
    const rid = roomByName.get(normalizeRoomName(name));
    if (!rid) return error("not_found", "room not found", 404);
    addMember(rid as Id, u.user_id, "member");
    return noContent();
  }

  const mLeave = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/leave$/);
  if (mLeave && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const room_id = mLeave[1] as Id;
    removeMember(room_id, u.user_id);
    return noContent();
  }

  const mPins = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/pins$/);
  if (mPins) {
    const room_id = mPins[1] as Id;
    const room = rooms.get(room_id);
    if (!room) return error("not_found", "room not found", 404);
    if (req.method === "POST") {
      const body = await readJson<{ message_id: Id }>(req);
      if (!body?.message_id) return error("bad_request", "missing message_id");
      if (!room.pinned_message_ids.includes(body.message_id)) room.pinned_message_ids.push(body.message_id);
      return noContent();
    }
    if (req.method === "DELETE") {
      const message_id = (searchParams.get("message_id") || "") as Id;
      room.pinned_message_ids = room.pinned_message_ids.filter((m) => m !== message_id);
      rooms.set(room_id, room);
      return noContent();
    }
  }

  // Room messages
  const mRoomMsgs = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/messages$/);
  if (mRoomMsgs) {
    const room_id = mRoomMsgs[1] as Id;
    if (!rooms.has(room_id)) return error("not_found", "room not found", 404);
    if (req.method === "GET") {
      const fromSeq = Number(searchParams.get("from_seq") || 0);
      const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
      const arr = roomMessages.get(room_id) || [];
      const slice = arr.filter((m) => m.seq >= fromSeq).slice(0, limit);
      const last = slice.length > 0 ? slice[slice.length - 1] : undefined;
      const next_seq = last ? last.seq + 1 : (roomNextSeq.get(room_id) ?? 1);
      return ok({ messages: slice, next_seq });
    }
    if (req.method === "POST") {
      const u = requireAuth(req);
      if (u instanceof Response) return u;
      type Body = { text: string; content_type?: string; attachments?: Message["attachments"]; parent_id?: Id | null };
      const body = await readJson<Body>(req);
      if (!body?.text) return error("bad_request", "missing text");
      const seq = roomNextSeq.get(room_id) || 1;
      const msg: Message = {
        message_id: newId128(),
        room_id,
        dm_peer_id: null,
        author_id: u.user_id,
        seq,
        ts: nowTs(),
        parent_id: body.parent_id ?? null,
        content_type: body.content_type || "text/markdown",
        text: body.text,
        tombstone: false,
        reactions: [],
      };
      if (body.attachments && body.attachments.length) (msg as any).attachments = body.attachments;
      roomNextSeq.set(room_id, seq + 1);
      const arr = roomMessages.get(room_id)!;
      arr.push(msg);
      broadcastRoomMessage(room_id, msg);
      return jsonResponse({ message: msg }, { status: 201 });
    }
  }

  const mRoomBackfill = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/messages\/backfill$/);
  if (mRoomBackfill && req.method === "GET") {
    const room_id = mRoomBackfill[1] as Id;
    const before = Number(searchParams.get("before_seq") || Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
    const arr = roomMessages.get(room_id) || [];
    const slice = arr.filter((m) => m.seq < before).slice(-limit);
    const first = slice.length > 0 ? slice[0] : undefined;
    const prev_seq = first ? first.seq : 0;
    return ok({ messages: slice, prev_seq });
  }

  // Message edit/delete
  const mMsg = matchPath(pathname, /^\/messages\/([a-z2-7]+)$/);
  if (mMsg) {
    const message_id = mMsg[1] as Id;
    // find in rooms
    for (const [room_id, arr] of roomMessages) {
      const idx = arr.findIndex((m) => m.message_id === message_id);
      if (idx !== -1) {
        const existing = arr[idx]!;
        if (req.method === "PATCH") {
          const u = requireAuth(req);
          if (u instanceof Response) return u;
          if (existing.author_id !== u.user_id) return error("forbidden", "not the author", 403);
          const body = await readJson<Partial<Pick<Message, "text" | "attachments">>>(req);
          if (!body) return error("bad_request", "invalid json");
          const updated: Message = { ...existing, ...body, edited_at: nowTs() } as Message;
          arr[idx] = updated;
          broadcastRoomEdit(room_id, updated);
          return ok({ message: updated });
        }
        if (req.method === "DELETE") {
          const deleted: Message = { ...existing, tombstone: true, ts: nowTs() };
          arr[idx] = deleted;
          broadcastRoomDelete(room_id, message_id, deleted.ts);
          return ok({ message_id, tombstone: true, ts: deleted.ts, moderation_reason: null });
        }
      }
    }
    return error("not_found", "message not found", 404);
  }

  // Reactions
  const mReact = matchPath(pathname, /^\/messages\/([a-z2-7]+)\/reactions$/);
  if (mReact) {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const message_id = mReact[1] as Id;
    for (const [room_id, arr] of roomMessages) {
      const msg = arr.find((m) => m.message_id === message_id);
      if (!msg) continue;
      // maintain per-emoji per-user uniqueness via a map on message (in-memory)
      // We'll reconstruct counts from a set of user ids per emoji stored on msg as any field.
      const anyMsg = msg as Message & { _react?: Map<string, Set<Id>> };
      if (!anyMsg._react) anyMsg._react = new Map();
      if (req.method === "POST") {
        const body = await readJson<{ emoji: string }>(req);
        if (!body?.emoji) return error("bad_request", "missing emoji");
        let set = anyMsg._react.get(body.emoji);
        if (!set) anyMsg._react.set(body.emoji, (set = new Set()));
        set.add(u.user_id);
        const reactions = [...anyMsg._react.entries()].map(([emoji, s]) => {
          const base: any = { emoji, count: s.size };
          if (emoji === body.emoji) base.me = s.has(u.user_id);
          return base;
        });
        msg.reactions = reactions as any;
        broadcastRoomReaction(room_id, message_id, body.emoji, reactions.map((r: any) => ({ emoji: r.emoji, count: r.count })));
        return ok({ message_id, reactions });
      }
      if (req.method === "DELETE") {
        const body = await readJson<{ emoji: string }>(req);
        if (!body?.emoji) return error("bad_request", "missing emoji");
        const set = anyMsg._react.get(body.emoji);
        set?.delete(u.user_id);
        const reactions = [...(anyMsg._react?.entries() || [])].map(([emoji, s]) => {
          const base: any = { emoji, count: s.size };
          if (emoji === body.emoji) base.me = s.has(u.user_id);
          return base;
        });
        msg.reactions = reactions as any;
        broadcastRoomReaction(room_id, message_id, body.emoji, reactions.map((r: any) => ({ emoji: r.emoji, count: r.count })));
        return ok({ message_id, reactions });
      }
    }
    return error("not_found", "message not found", 404);
  }

  // Cursors (rooms)
  const mAckRoom = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/ack$/);
  if (mAckRoom && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const room_id = mAckRoom[1] as Id;
    const body = await readJson<{ seq: number }>(req);
    if (!body) return error("bad_request", "invalid json");
    let map = roomCursors.get(room_id);
    if (!map) roomCursors.set(room_id, (map = new Map()));
    map.set(u.user_id, body.seq);
    return noContent();
  }
  const mCurRoom = matchPath(pathname, /^\/rooms\/([a-z2-7]+)\/cursor$/);
  if (mCurRoom && req.method === "GET") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const room_id = mCurRoom[1] as Id;
    const seq = roomCursors.get(room_id)?.get(u.user_id) || 0;
    return ok({ seq });
  }

  // DMs
  if (req.method === "GET" && pathname === "/dms") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    // list peers with last ts/seq
    const peers = new Map<Id, { user_id: Id; last_ts: string; last_seq: number }>();
    for (const [key, msgs] of dmPairs) {
      const [a, b] = key.split(":") as [Id, Id];
      const peer = u.user_id === a ? b : u.user_id === b ? a : null;
      if (!peer) continue;
      const last = msgs[msgs.length - 1];
      peers.set(peer, { user_id: peer, last_ts: last?.ts || nowTs(), last_seq: last?.seq || 0 });
    }
    return ok({ peers: [...peers.values()], next_cursor: undefined });
  }

  // Search (basic substring)
  if (req.method === "GET" && pathname === "/search/messages") {
    const u = authedUser(req); // allow unauth? Demo keeps it authed
    if (!u) return error("unauthorized", "missing or invalid token", 401);
    const q = (searchParams.get("q") || "").toLowerCase();
    if (!q) return error("bad_request", "missing q");
    const room_id = (searchParams.get("room_id") || "") as Id;
    const dm_peer_id = (searchParams.get("dm_peer_id") || "") as Id;
    const before_ts = searchParams.get("before_ts");
    const after_ts = searchParams.get("after_ts");
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));

    const matches: { message: Message; score: number }[] = [];
    const inTsRange = (ts: string) => {
      if (before_ts && ts >= before_ts) return false;
      if (after_ts && ts <= after_ts) return false;
      return true;
    };

    if (room_id) {
      const arr = roomMessages.get(room_id) || [];
      for (const m of arr) if (m.text.toLowerCase().includes(q) && inTsRange(m.ts)) matches.push({ message: m, score: 1.0 });
    } else {
      for (const [rid, arr] of roomMessages) {
        if (!roomMembers.get(rid)?.has(u.user_id)) continue;
        for (const m of arr) if (m.text.toLowerCase().includes(q) && inTsRange(m.ts)) matches.push({ message: m, score: 1.0 });
      }
    }
    if (dm_peer_id) {
      const key = pairKey(u.user_id, dm_peer_id);
      for (const m of dmPairs.get(key) || []) if (m.text.toLowerCase().includes(q) && inTsRange(m.ts)) matches.push({ message: m, score: 1.0 });
    } else {
      for (const [key, arr] of dmPairs) {
        const [a, b] = key.split(":") as [Id, Id];
        if (a !== u.user_id && b !== u.user_id) continue;
        for (const m of arr) if (m.text.toLowerCase().includes(q) && inTsRange(m.ts)) matches.push({ message: m, score: 1.0 });
      }
    }
    return ok({ results: matches.slice(0, limit), next_cursor: undefined });
  }

  const mDmMsgs = matchPath(pathname, /^\/dms\/([a-z2-7]+)\/messages$/);
  if (mDmMsgs) {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const peer = mDmMsgs[1] as Id;
    const key = ensureDmPair(u.user_id, peer);
    if (req.method === "GET") {
      const fromSeq = Number(searchParams.get("from_seq") || 0);
      const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
      const arr = dmPairs.get(key) || [];
      const slice = arr.filter((m) => m.seq >= fromSeq).slice(0, limit);
      const last = slice.length > 0 ? slice[slice.length - 1] : undefined;
      const next_seq = last ? last.seq + 1 : (dmNextSeq.get(key) ?? 1);
      return ok({ messages: slice, next_seq });
    }
    if (req.method === "POST") {
      type Body = { text: string; content_type?: string; attachments?: Message["attachments"] };
      const body = await readJson<Body>(req);
      if (!body?.text) return error("bad_request", "missing text");
      const seq = dmNextSeq.get(key) || 1;
      const msg: Message = {
        message_id: newId128(),
        room_id: null,
        dm_peer_id: peer,
        author_id: u.user_id,
        seq,
        ts: nowTs(),
        parent_id: null,
        content_type: body.content_type || "text/markdown",
        text: body.text,
        tombstone: false,
        reactions: [],
      };
      if (body.attachments && body.attachments.length) (msg as any).attachments = body.attachments;
      dmNextSeq.set(key, seq + 1);
      const arr = dmPairs.get(key)!;
      arr.push(msg);
      broadcastDmMessage(u.user_id, peer, msg);
      return jsonResponse({ message: msg }, { status: 201 });
    }
  }

  const mDmBackfill = matchPath(pathname, /^\/dms\/([a-z2-7]+)\/messages\/backfill$/);
  if (mDmBackfill && req.method === "GET") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const peer = mDmBackfill[1] as Id;
    const key = ensureDmPair(u.user_id, peer);
    const before = Number(searchParams.get("before_seq") || Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
    const arr = dmPairs.get(key) || [];
    const slice = arr.filter((m) => m.seq < before).slice(-limit);
    const first = slice.length > 0 ? slice[0] : undefined;
    const prev_seq = first ? first.seq : 0;
    return ok({ messages: slice, prev_seq });
  }

  const mDmAck = matchPath(pathname, /^\/dms\/([a-z2-7]+)\/ack$/);
  if (mDmAck && req.method === "POST") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const peer = mDmAck[1] as Id;
    const key = ensureDmPair(u.user_id, peer);
    const body = await readJson<{ seq: number }>(req);
    if (!body) return error("bad_request", "invalid json");
    let map = dmCursors.get(key);
    if (!map) dmCursors.set(key, (map = new Map()));
    map.set(u.user_id, body.seq);
    return noContent();
  }

  const mDmCur = matchPath(pathname, /^\/dms\/([a-z2-7]+)\/cursor$/);
  if (mDmCur && req.method === "GET") {
    const u = requireAuth(req);
    if (u instanceof Response) return u;
    const peer = mDmCur[1] as Id;
    const key = pairKey(u.user_id, peer);
    const seq = dmCursors.get(key)?.get(u.user_id) || 0;
    return ok({ seq });
  }

  // Uploads (octet-stream only)
  if (req.method === "POST" && pathname === "/uploads") {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("application/octet-stream")) return error("bad_request", "only application/octet-stream supported", 400);
    const buf = new Uint8Array(await req.arrayBuffer());
    const cid = await cidFor(buf);
    const meta: UploadMeta = { cid, bytes: buf.byteLength, mime: req.headers.get("x-file-mime") || "application/octet-stream", sha256: await sha256Hex(buf), data: buf };
    uploads.set(cid, meta);
    return jsonResponse({ cid: meta.cid, bytes: meta.bytes, mime: meta.mime, sha256: meta.sha256 }, { status: 201 });
  }
  const mMedia = matchPath(pathname, /^\/media\/([a-z2-7]+)$/);
  if (mMedia) {
    const cid = mMedia[1] as Id;
    const meta = uploads.get(cid);
    if (!meta) return error("not_found", "not found", 404);
    if (req.method === "GET") {
      return withCors(new Response(meta.data, { headers: { "content-type": meta.mime, "content-length": String(meta.bytes) } }));
    }
    if (req.method === "HEAD") {
      return withCors(new Response(null, { headers: { "content-type": meta.mime, "content-length": String(meta.bytes) } }));
    }
  }

  // Realtime WS
  if (req.method === "GET" && pathname === "/rtm") {
    // Allow token via Authorization header (preferred), query param, or subprotocol fallback
    let u = authedUser(req);
    if (!u) {
      const urlObj = new URL(req.url);
      // Prefer ticket if present
      const qpTicket = urlObj.searchParams.get("ticket");
      if (qpTicket) {
        const rec = wsTickets.get(qpTicket);
        if (rec && !rec.used && rec.expires_at > Date.now()) {
          u = users.get(rec.user_id) || null;
          if (u) { rec.used = true; wsTickets.set(qpTicket, rec); }
        }
      }
      const qpTok = (!u && (urlObj.searchParams.get("token") || urlObj.searchParams.get("access_token"))) || null;
      if (qpTok) {
        const rec = tokens.get(qpTok);
        if (rec) u = users.get(rec.user_id) || null;
      }
    }
    if (!u) {
      // Check Sec-WebSocket-Protocol for a value like "bearer.<token>" or just the token
      const proto = req.headers.get("sec-websocket-protocol") || "";
      const parts = proto.split(",").map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p.startsWith("ticket.")) {
          const t = p.slice("ticket.".length);
          const rec = wsTickets.get(t);
          if (rec && !rec.used && rec.expires_at > Date.now()) {
            u = users.get(rec.user_id) || null;
            if (u) { rec.used = true; wsTickets.set(t, rec); break; }
          }
        } else {
          const token = p.startsWith("bearer.") ? p.slice("bearer.".length) : p;
          const rec = tokens.get(token);
          if (rec) { u = users.get(rec.user_id) || null; if (u) break; }
        }
      }
    }
    if (!u) return error("unauthorized", "missing or invalid token", 401);
    const upgraded = server.upgrade(req, {
      data: { user_id: u.user_id, session_id: newId128(), rooms: new Set<Id>(), dms: false },
    });
    if (!upgraded) return error("internal", "upgrade failed", 500);
    return undefined; // Bun will handle
  }

  return error("not_found", "not found", 404);
}

const bunEnv = (globalThis as any).Bun?.env as { PORT?: string } | undefined;
const port = Number((bunEnv?.PORT ?? 8080));

const server = (Bun as any).serve({
  port,
  fetch(req: Request, srv: any) {
    return handleRequest(req, srv) as any;
  },
  websocket: {
    open(ws: any) {
      attachSocket(ws as any, (ws as any).data.user_id);
      updateSubscriptions(ws as any);
    },
    message(ws: any, msg: any) {
      // subscriptions can be updated after hello
      updateSubscriptions(ws as any);
    },
    close(ws: any) {
      // handled in attachSocket.onclose
    },
  },
});

console.log(`ORC demo server listening on http://localhost:${port}`);
