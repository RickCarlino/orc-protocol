import { AuthRegistry, apiResponse, bearer, error, json, parseJsonBody, newId } from "./util";
import type { components } from "./api/types";
import type { InMemoryStore } from "./store";
import { log } from "./logger";

type CapabilityResponse = components["schemas"]["CapabilityResponse"];

export function createApi(store: InMemoryStore) {
  // --- Helpers ---
  function requireRoom(name?: string) {
    if (!name) return undefined;
    const room = store.getRoomByName(name);
    if (!room) return undefined;
    return room;
  }

  // --- Meta ---
  const meta = {
    capabilities: () => {
      log.info("meta", "capabilities");
      return apiResponse<CapabilityResponse>({
        capabilities: [
          "auth.guest",
          // Minimal set for demo
        ],
        limits: {
          max_message_bytes: 4000,
          max_upload_bytes: 16 * 1024 * 1024,
          max_reactions_per_message: 32,
          cursor_idle_timeout_ms: 300000,
          rate_limits: { burst: 20, per_minute: 120 },
        },
        server: { name: "orcp-demo", description: "ORC demo server (in-memory)", contact: "admin@example.test" },
      });
    },
  };

  // --- Auth ---
  const auth = {
    guest: async (req: Request) => {
      const body = await parseJsonBody<components["schemas"]["GuestRequest"]>(req);
      if (!body?.username || body.username.trim().length < 1) return error(400, "bad_request", "username required");
      log.info("auth", `guest username=${body.username}`);
      const user = store.getOrCreateUser(body.username.trim());
      const { access, refresh } = store.issueToken(user.user_id);
      AuthRegistry.set(access, user.user_id);
      const res: components["schemas"]["LoginResponse"] = {
        access_token: access,
        refresh_token: refresh,
        user,
      } as any;
      return json(200, res);
    },
  };

  // --- Users ---
  const users = {
    me: ({ userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      log.debug("users", `me user=${userId}`);
      const user = store.users.get(userId)!;
      return json(200, user);
    },
    patchMe: async ({ req, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const patch = await parseJsonBody<any>(req);
      log.info("users", `patch user=${userId}`);
      const user = store.users.get(userId)!;
      Object.assign(user, sanitizeProfilePatch(patch));
      return json(200, user);
    },
  };

  // --- Rooms ---
  const rooms = {
    directory: ({ req, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const q = new URL(req.url).searchParams.get("q")?.toLowerCase() ?? "";
      log.debug("rooms", `directory q=${q}`);
      const rooms = [...store.rooms.values()].filter((r) => r.visibility === "public" && r.name.toLowerCase().includes(q));
      return json(200, { rooms, next_cursor: null });
    },
    mine: ({ userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const rooms = [...store.rooms.values()].filter((r) => r.members.has(userId));
      log.debug("rooms", `mine user=${userId} count=${rooms.length}`);
      return json(200, { rooms, next_cursor: null });
    },
    create: async ({ req, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const body = await parseJsonBody<components["schemas"]["CreateRoomRequest"]>(req);
      if (!body?.name || !body.visibility) return error(400, "bad_request", "name and visibility required");
      try {
        log.info("rooms", `create name=${body.name} visibility=${body.visibility}`);
        const room = store.createRoom(userId, body.name, body.visibility as any, body.topic ?? undefined);
        return json(201, room);
      } catch {
        log.warn("rooms", `create conflict name=${body.name}`);
        return error(409, "conflict", "room name exists");
      }
    },
    get: ({ params }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      log.debug("rooms", `get ${params.room_name}`);
      return json(200, room);
    },
    patch: async ({ req, params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      if (room.owner_id !== userId) return error(403, "forbidden", "only owner");
      const patch = await parseJsonBody<components["schemas"]["PatchRoomRequest"]>(req);
      if (!patch || Object.keys(patch).length === 0) return error(400, "bad_request", "empty patch");
      log.info("rooms", `patch ${params.room_name}`);
      if (patch.name && patch.name.toLowerCase() !== room.name.toLowerCase()) {
        if (store.getRoomByName(patch.name)) return error(409, "conflict", "room name exists");
        room.name = patch.name;
      }
      if (patch.topic !== undefined) room.topic = patch.topic;
      if (patch.visibility) room.visibility = patch.visibility as any;
      return json(200, room);
    },
  };

  // --- Messages ---
  const messages = {
    forward: ({ req, params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      if (!room.members.has(userId)) return error(403, "forbidden", "join first");
      const u = new URL(req.url);
      const from_seq = numOrNull(u.searchParams.get("from_seq"));
      const limit = clampInt(u.searchParams.get("limit"), 1, 200, 50);
      log.debug("messages", `forward room=${room.name} from_seq=${from_seq} limit=${limit}`);
      const { messages, next_seq } = store.listMessages(room, from_seq, limit);
      return json(200, { messages, next_seq });
    },
    backfill: ({ req, params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      if (!room.members.has(userId)) return error(403, "forbidden", "join first");
      const u = new URL(req.url);
      const before_seq = numOrNull(u.searchParams.get("before_seq"));
      const limit = clampInt(u.searchParams.get("limit"), 1, 200, 50);
      log.debug("messages", `backfill room=${room.name} before_seq=${before_seq} limit=${limit}`);
      const { messages, prev_seq } = store.backfillMessages(room, before_seq, limit);
      return json(200, { messages, prev_seq });
    },
    post: async ({ req, params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      store.joinRoom(userId, room); // auto-join for demo
      const body = await parseJsonBody<components["schemas"]["MessageCreate"]>(req);
      if (!body?.text) return error(400, "bad_request", "text required");
      if ((body.text ?? "").length > 4000) return error(400, "bad_request", "too long");
      log.info("messages", `post room=${room.name} user=${userId}`);
      const msg = store.postMessage(room, userId, body.text, body.parent_id as any);
      // Broadcast
      ws.broadcastMessageCreate(room, msg);
      return json(201, msg);
    },
    ack: async ({ req, params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      const body = await parseJsonBody<components["schemas"]["AckRequest"]>(req);
      if (!body?.seq && body?.seq !== 0) return error(400, "bad_request", "seq required");
      log.debug("messages", `ack room=${room.name} user=${userId} seq=${body.seq}`);
      store.setCursor(userId, room, body.seq);
      return new Response(null, { status: 204 });
    },
    cursor: ({ params, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const room = requireRoom(params.room_name);
      if (!room) return error(404, "not_found", "room");
      const seq = store.getCursor(userId, room);
      return json(200, { seq });
    },
  };

  // --- RTM ---
  const ws = createWsApi(store);
  const rtm = {
    ticket: ({ req, userId }: { req: Request; params: Record<string, string>; userId: string }) => {
      const ticket = issueTicket(store, userId);
      log.info("rtm", `ticket issued user=${userId} ticket=${ticket}`);
      return json(200, { ticket, expires_in_ms: 60_000 });
    },
    upgrade: (req: Request, server: Server) => upgradeToRtm(req, server, store, ws),
  };

  return { meta, auth, users, rooms, messages, rtm, ws };
}

export type Api = ReturnType<typeof createApi>;

function sanitizeProfilePatch(p: any): Partial<components["schemas"]["User"]> {
  const out: any = {};
  if (typeof p?.display_name === "string") out.display_name = p.display_name;
  if (typeof p?.bio === "string") out.bio = p.bio;
  if (typeof p?.status_text === "string") out.status_text = p.status_text;
  if (typeof p?.status_emoji === "string") out.status_emoji = p.status_emoji;
  if (typeof p?.photo_cid === "string") out.photo_cid = p.photo_cid;
  return out;
}

function clampInt(v: string | null, min: number, max: number, dflt: number) {
  const n = v ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function numOrNull(v: string | null): number | null { return v ? parseInt(v, 10) : null; }

// --- RTM internals ---
function issueTicket(store: InMemoryStore, user_id: string): string {
  // Spec-friendly opaque ticket: base32, short-lived, single-use.
  const ticket = newId(16);
  const expires_at = Date.now() + 60_000;
  store.tickets.set(ticket, { user_id, expires_at });
  return ticket;
}

function upgradeToRtm(req: Request, server: Server, store: InMemoryStore, wsApi: ReturnType<typeof createWsApi>): boolean {
  const url = new URL(req.url);
  // Accept either subprotocol ticket.ticket or query param
  let ticket = url.searchParams.get("ticket");
  const sub = req.headers.get("sec-websocket-protocol");
  if (!ticket && sub) {
    const parts = sub.split(/,\s*/);
    const t = parts.find((p) => p.startsWith("ticket."));
    if (t) {
      const part = t.split(".")[1] ?? null;
      ticket = part;
    }
  }
  if (ticket) {
    const origin = req.headers.get("origin") ?? "";
    if (!isOriginAllowed(origin)) {
      log.warn("rtm", `origin rejected origin=${origin}`);
      return false;
    }
    log.info("rtm", `upgrade ticket attempt origin=${origin}`);
    const entry = store.tickets.get(ticket);
    if (!entry) { log.warn("rtm", "ticket not found", { ticket }); return false; }
    if (entry.expires_at < Date.now()) { log.warn("rtm", "ticket expired", { ticket }); return false; }
    // single-use
    store.tickets.delete(ticket);
    const ok = server.upgrade(req, { data: { userId: entry.user_id } });
    if (!ok) log.error("rtm", "server.upgrade failed");
    return ok;
  }
  // Tickets-only: deny if no valid ticket provided
  return false;
}

function isOriginAllowed(origin: string): boolean {
  if (!origin) return true; // allow non-browser contexts
  const allowList = (process.env?.WS_ORIGIN_ALLOW as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    ?? ["http://localhost:3000", "http://localhost:5173", "http://localhost:1234"];
  return allowList.includes(origin);
}

function createWsApi(store: InMemoryStore) {
  const socketsByUser = store.sockets;

  function onOpen(ws: ServerWebSocket<any>) {
    const userId: string | undefined = ws.data?.userId;
    if (!userId) return ws.close(1008, "unauthorized");
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId)!.add(ws);
    // Auto-join default room for demo
    const general = store.getRoomByName("general");
    if (general) store.joinRoom(userId, general);
    // Optionally send ready immediately (per spec MAY)
    send(ws, { type: "ready", heartbeat_ms: 30000, server_time: new Date().toISOString(), capabilities: [] });
    // Heartbeat ping
    ws.data.heartbeat = setInterval(() => {
      try { send(ws, { type: "ping", ts: new Date().toISOString() }); } catch {}
    }, 30000);
    log.info("ws", `ready sent user=${userId}`);
  }

  function onMessage(ws: ServerWebSocket<any>, msg: string | Uint8Array) {
    try {
      const data = typeof msg === "string" ? JSON.parse(msg) : JSON.parse(new TextDecoder().decode(msg as Uint8Array));
      if (data?.type === "hello") {
        // Echo canonical ready
        send(ws, { type: "ready", heartbeat_ms: 30000, server_time: new Date().toISOString(), capabilities: [] });
        log.debug("ws", `hello -> ready user=${ws.data?.userId ?? "?"}`);
        return;
      }
      if (data?.type === "pong") {
        log.debug("ws", `pong user=${ws.data?.userId ?? "?"}`);
        return; // ignore in demo
      }
      if (data?.type === "ack" && data?.cursors && typeof data.cursors === "object") {
        const userId: string | undefined = ws.data?.userId;
        if (!userId) return;
        for (const [k, v] of Object.entries<number>(data.cursors)) {
          if (!Number.isFinite(v)) continue;
          if (k.startsWith("room:")) {
            const roomName = k.slice("room:".length);
            const room = store.getRoomByName(roomName);
            if (room) store.setCursor(userId, room, v);
          }
        }
        log.debug("ws", `ack user=${userId}`);
        return;
      }
      // Vendor extension: simple WS typing signal for demo
      if (data?.type === "x.typing") {
        const userId: string | undefined = ws.data?.userId;
        if (!userId) return;
        const roomName = data?.room ?? "general";
        const state = data?.state === "start" ? "start" : "stop";
        const room = store.getRoomByName(roomName);
        if (room && room.members.has(userId)) broadcastTyping(room, userId, state);
        log.debug("ws", `typing user=${userId} room=${roomName} state=${state}`);
        return;
      }
      // Vendor extension: post a message via WS into a room (demo-only)
      if (data?.type === "x.post" && typeof data?.text === "string") {
        const userId: string | undefined = ws.data?.userId;
        if (!userId) return;
        const roomName = data?.room ?? "general";
        const room = store.getRoomByName(roomName);
        if (!room) return;
        store.joinRoom(userId, room);
        const msg = store.postMessage(room, userId, String(data.text).slice(0, 4000));
        broadcastMessageCreate(room, msg);
        log.info("ws", `post user=${userId} room=${roomName}`);
        return;
      }
    } catch {
      log.error("ws", "invalid json");
      ws.close(1003, "invalid json");
    }
  }

  function onClose(ws: ServerWebSocket<any>) {
    const userId: string | undefined = ws.data?.userId;
    if (!userId) return;
    socketsByUser.get(userId)?.delete(ws);
    try { if (ws.data?.heartbeat) clearInterval(ws.data.heartbeat); } catch {}
  }

  function broadcastMessageCreate(room: { room_id: string }, message: components["schemas"]["Message"]) {
    // Send to all connected users that are members of the room
    const payload = { type: "event.message.create", message };
    log.debug("ws", `broadcast message room_id=${room.room_id}`);
    for (const [uid, set] of socketsByUser.entries()) {
      const roomObj = [...store.rooms.values()].find((r) => r.room_id === room.room_id);
      if (!roomObj) continue;
      if (!roomObj.members.has(uid)) continue;
      for (const s of set) send(s, payload);
    }
  }

  function send(ws: ServerWebSocket<any>, obj: any) {
    ws.send(JSON.stringify(obj));
  }

  function broadcastTyping(room: { room_id: string }, user_id: string, state: "start" | "stop") {
    const payload = { type: "event.typing", room_id: room.room_id, user_id, state };
    for (const [uid, set] of socketsByUser.entries()) {
      const roomObj = [...store.rooms.values()].find((r) => r.room_id === room.room_id);
      if (!roomObj) continue;
      if (!roomObj.members.has(uid)) continue;
      for (const s of set) send(s, payload);
    }
  }

  return { onOpen, onMessage, onClose, broadcastMessageCreate };
}
