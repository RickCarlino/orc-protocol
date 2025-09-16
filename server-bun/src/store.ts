import { nowIso, newId } from "./util";
import type { components } from "./api/types";
import { log } from "./logger";

export type User = components["schemas"]["User"] & { created_at: string };
export type Room = components["schemas"]["Room"] & { members: Map<string, RoleName> };
export type Message = components["schemas"]["Message"];

export type RoleName = "owner" | "admin" | "moderator" | "member" | "guest";

export class InMemoryStore {
  users = new Map<string, User>(); // user_id -> user
  usernames = new Map<string, string>(); // username (display_name) -> user_id
  tokens = new Map<string, string>(); // access_token -> user_id
  refresh = new Map<string, string>(); // refresh_token -> user_id
  sessions = new Map<string, { user_id: string; created_at: string; last_seen_at: string; device?: string }>();

  rooms = new Map<string, Room>(); // by canonical name (lowercase)
  messages = new Map<string, Message[]>(); // by room_id
  seq = new Map<string, number>(); // stream seq by room_id
  roomCursors = new Map<string, Map<string, number>>(); // user_id -> (room_id -> seq)

  // RTM tickets: ticket -> user_id, expiry
  tickets = new Map<string, { user_id: string; expires_at: number }>();

  // WebSocket sessions per user
  sockets = new Map<string, Set<ServerWebSocket<any>>>();

  constructor() {
    // Seed with a system user and a default public room for WS demos
    const system = this.getOrCreateUser("system");
    if (!this.getRoomByName("general")) {
      const r = this.createRoom(system.user_id, "general", "public", "Welcome to ORC demo");
      log.info("store", `seed room=${r.name}`);
    }
  }

  getOrCreateUser(username: string): User {
    const key = username.toLowerCase();
    const existingId = this.usernames.get(key);
    if (existingId) return this.users.get(existingId)!;
    const user: User = {
      user_id: newId(),
      display_name: username,
      created_at: nowIso(),
    } as User;
    this.users.set(user.user_id, user);
    this.usernames.set(key, user.user_id);
    log.info("store", `create user=${username} id=${user.user_id}`);
    return user;
  }

  issueToken(user_id: string): { access: string; refresh: string } {
    const access = newId(20);
    const refresh = newId(20);
    this.tokens.set(access, user_id);
    this.refresh.set(refresh, user_id);
    const sid = newId(10);
    this.sessions.set(sid, { user_id, created_at: nowIso(), last_seen_at: nowIso() });
    log.info("store", `issue tokens user=${user_id}`);
    return { access, refresh };
  }

  userByToken(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const uid = this.tokens.get(token);
    return uid ? this.users.get(uid) : undefined;
  }

  createRoom(owner_id: string, name: string, visibility: "public" | "private", topic?: string): Room {
    const canonical = name.toLowerCase();
    if (this.rooms.has(canonical)) throw new Error("conflict");
    const room: Room = {
      room_id: newId(),
      name,
      topic,
      visibility,
      owner_id,
      created_at: nowIso(),
      counts: { members: 1 },
      pinned_message_ids: [],
      members: new Map([[owner_id, "owner"]]),
    } as Room;
    this.rooms.set(canonical, room);
    this.messages.set(room.room_id, []);
    this.seq.set(room.room_id, 0);
    log.info("store", `create room name=${name} vis=${visibility}`);
    return room;
  }

  getRoomByName(name: string): Room | undefined {
    return this.rooms.get(name.toLowerCase());
  }

  joinRoom(user_id: string, room: Room): void {
    if (!room.members.has(user_id)) {
      room.members.set(user_id, "member");
      room.counts = { ...(room.counts ?? {}), members: (room.counts?.members ?? 0) + 1 };
    }
  }

  leaveRoom(user_id: string, room: Room): void {
    if (room.members.delete(user_id)) {
      room.counts = { ...(room.counts ?? {}), members: Math.max(0, (room.counts?.members ?? 1) - 1) };
    }
  }

  postMessage(room: Room, author_id: string, text: string, parent_id?: string): Message {
    const seq = (this.seq.get(room.room_id) ?? 0) + 1;
    this.seq.set(room.room_id, seq);
    const msg: Message = {
      message_id: newId(),
      room_id: room.room_id,
      dm_peer_id: null,
      author_id,
      seq,
      ts: nowIso(),
      parent_id: parent_id ?? null,
      content_type: "text/markdown",
      text,
      entities: {},
      attachments: [],
      reactions: [],
      tombstone: false,
      edited_at: null,
      moderation_reason: null,
    } as Message;
    const arr = this.messages.get(room.room_id)!;
    arr.push(msg);
    log.debug("store", `message seq=${seq} room=${room.name} author=${author_id}`);
    return msg;
  }

  listMessages(room: Room, from_seq?: number | null, limit = 50): { messages: Message[]; next_seq: number } {
    const arr = this.messages.get(room.room_id)!;
    const start = from_seq ? arr.findIndex((m) => m.seq >= from_seq) : 0;
    const slice = arr.slice(start, start + limit);
    const next_seq = slice.length ? slice[slice.length - 1]!.seq + 1 : (this.seq.get(room.room_id) ?? 0);
    return { messages: slice, next_seq };
  }

  backfillMessages(room: Room, before_seq?: number | null, limit = 50): { messages: Message[]; prev_seq: number } {
    const arr = this.messages.get(room.room_id)!;
    const idx = before_seq ? arr.findIndex((m) => m.seq >= before_seq) : arr.length;
    const end = idx <= 0 ? 0 : idx - 1;
    const start = Math.max(0, end - limit + 1);
    const slice = arr.slice(start, end + 1);
    const prev_seq = slice.length ? slice[0]!.seq - 1 : 0;
    return { messages: slice, prev_seq };
  }

  setCursor(user_id: string, room: Room, seq: number): void {
    let m = this.roomCursors.get(user_id);
    if (!m) this.roomCursors.set(user_id, (m = new Map()));
    const prev = m.get(room.room_id) ?? 0;
    m.set(room.room_id, Math.max(prev, seq));
  }

  getCursor(user_id: string, room: Room): number {
    return this.roomCursors.get(user_id)?.get(room.room_id) ?? 0;
  }
}
