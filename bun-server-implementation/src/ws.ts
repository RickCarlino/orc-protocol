import { nowTs, newId128 } from "./utils";
import type { Id, Message } from "./types";

export interface ClientHello {
  type: "hello";
  client: { name: string; version: string };
  subscriptions?: { rooms?: Id[]; dms?: boolean };
  cursors?: Record<string, number>;
  want?: string[];
}

export type Incoming = ClientHello | { type: "ack"; cursors: Record<string, number> } | { type: "pong"; ts?: string } | Record<string, unknown>;

type Socket = any; // avoid Bun type dependency for strict TS without @types

interface Hub {
  byRoom: Map<Id, Set<Socket>>;
  byUserDM: Map<Id, Set<Socket>>; // all DMs for user
  allSockets: Set<Socket>;
}

export const hub: Hub = {
  byRoom: new Map(),
  byUserDM: new Map(),
  allSockets: new Set(),
};

export function attachSocket(ws: Socket, user_id: Id): void {
  ws.data = { user_id, session_id: newId128(), rooms: new Set(), dms: false };
  hub.allSockets.add(ws);

  const heartbeatMs = 30_000;
  const timer = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping", ts: nowTs() }));
    } catch {
      clearInterval(timer);
    }
  }, heartbeatMs);

  // Be lenient and send an initial ready frame before hello, to ease client interop
  try {
    ws.send(
      JSON.stringify({
        type: "ready",
        session_id: ws.data.session_id,
        heartbeat_ms: heartbeatMs,
        server_time: nowTs(),
        capabilities: ["uploads", "security.insecure_ok", "search.basic"],
      }),
    );
  } catch {}

  ws.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(String(e.data)) as Incoming;
      if (msg && (msg as any).type === "hello") {
        const sub = (msg as any as ClientHello).subscriptions || {};
        const rooms = new Set<Id>(sub.rooms || []);
        ws.data.rooms = rooms;
        ws.data.dms = !!sub.dms;
        // announce readiness
        ws.send(
          JSON.stringify({
            type: "ready",
            session_id: ws.data.session_id,
            heartbeat_ms: heartbeatMs,
            server_time: nowTs(),
            capabilities: ["uploads", "security.insecure_ok", "search.basic"],
          }),
        );
        updateSubscriptions(ws);
      } else if (msg && msg.type === "ack") {
        // cursors are updated via HTTP in this demo; could store if needed
      } else if (msg && msg.type === "pong") {
        // ok
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    hub.allSockets.delete(ws);
    for (const [room, set] of hub.byRoom) {
      if (set.delete(ws) && set.size === 0) hub.byRoom.delete(room);
    }
    for (const [uid, set] of hub.byUserDM) {
      if (set.delete(ws) && set.size === 0) hub.byUserDM.delete(uid);
    }
    clearInterval(timer);
  };
}

export function updateSubscriptions(ws: Socket): void {
  for (const [room, set] of hub.byRoom) {
    if (!ws.data.rooms.has(room)) set.delete(ws);
  }
  for (const r of ws.data.rooms) {
    let set = hub.byRoom.get(r);
    if (!set) hub.byRoom.set(r, (set = new Set()));
    set.add(ws);
  }

  if (ws.data.dms) {
    let set = hub.byUserDM.get(ws.data.user_id);
    if (!set) hub.byUserDM.set(ws.data.user_id, (set = new Set()));
    set.add(ws);
  } else {
    const set = hub.byUserDM.get(ws.data.user_id);
    set?.delete(ws);
  }
}

export function broadcastRoomMessage(room_id: Id, message: Message): void {
  const frame = JSON.stringify({ type: "event.message.create", message });
  const set = hub.byRoom.get(room_id);
  if (set) for (const ws of set) try { ws.send(frame); } catch {}
}

export function broadcastRoomEdit(room_id: Id, message: Message): void {
  const frame = JSON.stringify({ type: "event.message.edit", message });
  const set = hub.byRoom.get(room_id);
  if (set) for (const ws of set) try { ws.send(frame); } catch {}
}

export function broadcastRoomDelete(room_id: Id, message_id: Id, ts?: string): void {
  const frame = JSON.stringify({ type: "event.message.delete", message_id, room_id, ts: ts || nowTs() });
  const set = hub.byRoom.get(room_id);
  if (set) for (const ws of set) try { ws.send(frame); } catch {}
}

export function broadcastRoomReaction(room_id: Id, message_id: Id, emoji: string, counts: { emoji: string; count: number }[]): void {
  const frameAdd = JSON.stringify({ type: "event.reaction.add", message_id, emoji, counts });
  const set = hub.byRoom.get(room_id);
  if (set) for (const ws of set) try { ws.send(frameAdd); } catch {}
}

export function broadcastDmMessage(toA: Id, toB: Id, message: Message): void {
  const frame = JSON.stringify({ type: "event.message.create", message });
  for (const uid of [toA, toB]) {
    const set = hub.byUserDM.get(uid);
    if (set) for (const ws of set) try { ws.send(frame); } catch {}
  }
}
