import { nowIso, b32Random } from "./utils";

// Minimal types for runtime logic; prefer generated API types for shapes
export type Username = string;
export type Id = string;

export interface User {
  username: Username;
  display_name: string;
  bio?: string;
  photo_cid?: Id;
  status_text?: string;
  status_emoji?: string;
}

export interface Session {
  session_id: Id;
  username: Username;
  access_token: string;
  created_at: string;
  last_seen_at: string;
  device?: string;
}

export interface Room {
  room_id: Id;
  name: string;
  topic?: string;
  visibility: "public" | "private";
  owner: Username;
  created_at: string;
  counts: { members: number };
  pinned_message_ids: Id[];
}

export interface RoomState {
  room: Room;
  members: Map<Username, { role: "owner" | "admin" | "moderator" | "member" | "guest" }>
  messages: Message[];
  nextSeq: number;
}

export interface Attachment { cid: Id; name: string; bytes: number; mime: string }

export interface Message {
  message_id: Id;
  room_id: Id | null;
  dm_peer: string | null;
  author: Username;
  seq: number;
  ts: string;
  parent_id: Id | null;
  content_type: "text/markdown";
  text: string;
  attachments: Attachment[];
  reactions: { emoji: string; count: number; me?: boolean }[];
  tombstone: boolean;
  edited_at: string | null;
  moderation_reason: string | null;
}

export interface Ticket { ticket: string; username: Username; expires_at: number; used?: boolean }

export class DB {
  users = new Map<Username, User>();
  sessionsByToken = new Map<string, Session>();
  roomsByName = new Map<string, RoomState>(); // key: lowercased name
  msgById = new Map<Id, Message>();
  tickets = new Map<string, Ticket>();

  constructor() {
    // bootstrap a demo user and room
    const u: User = { username: "alice", display_name: "Alice" };
    this.users.set(u.username, u);
    const room = this.createRoom("general", "public", u.username, "Welcome to ORCP demo");
    this.postMessageToRoom(room.room.name, u.username, { text: "hello **world**" });
  }

  now(): string { return nowIso(); }

  createGuest(username: string): User {
    if (!this.users.has(username)) {
      this.users.set(username, { username, display_name: username });
    }
    return this.users.get(username)!;
  }

  createSession(username: string, device?: string): Session {
    const session: Session = {
      session_id: b32Random(26),
      username,
      access_token: b32Random(52),
      created_at: this.now(),
      last_seen_at: this.now(),
      device,
    };
    this.sessionsByToken.set(session.access_token, session);
    return session;
  }

  revoke(accessToken: string): boolean {
    return this.sessionsByToken.delete(accessToken);
  }

  auth(accessToken: string | null): Session | null {
    if (!accessToken) return null;
    const s = this.sessionsByToken.get(accessToken);
    if (s) s.last_seen_at = this.now();
    return s ?? null;
  }

  createRoom(name: string, visibility: "public" | "private", owner: Username, topic?: string): RoomState {
    const lc = name.toLowerCase();
    if (this.roomsByName.has(lc)) throw new Error("conflict");
    const st: RoomState = {
      room: {
        room_id: b32Random(26),
        name,
        visibility,
        owner,
        created_at: this.now(),
        counts: { members: 1 },
        topic,
        pinned_message_ids: [],
      },
      members: new Map([[owner, { role: "owner" }]]),
      messages: [],
      nextSeq: 1,
    };
    this.roomsByName.set(lc, st);
    return st;
  }

  getRoomByName(name: string): RoomState | null {
    const lc = name.toLowerCase();
    return this.roomsByName.get(lc) ?? null;
  }

  postMessageToRoom(roomName: string, author: Username, input: { text: string; parent_id?: Id; attachments?: Attachment[] }): Message {
    const r = this.getRoomByName(roomName);
    if (!r) throw new Error("not_found");
    const msg: Message = {
      message_id: b32Random(26),
      room_id: r.room.room_id,
      dm_peer: null,
      author,
      seq: r.nextSeq++,
      ts: this.now(),
      parent_id: input.parent_id ?? null,
      content_type: "text/markdown",
      text: input.text,
      attachments: input.attachments ?? [],
      reactions: [],
      tombstone: false,
      edited_at: null,
      moderation_reason: null,
    };
    r.messages.push(msg);
    this.msgById.set(msg.message_id, msg);
    return msg;
  }

  editMessage(message_id: Id, editor: Username, patch: { text?: string; attachments?: Attachment[] }): Message | null {
    const m = this.msgById.get(message_id);
    if (!m) return null;
    if (m.author !== editor) throw new Error("forbidden");
    if (typeof patch.text === "string") m.text = patch.text;
    if (patch.attachments) m.attachments = patch.attachments;
    m.edited_at = this.now();
    return m;
  }

  deleteMessage(message_id: Id, by: Username): { message_id: Id; tombstone: true; ts: string } | null {
    const m = this.msgById.get(message_id);
    if (!m) return null;
    if (m.author !== by) throw new Error("forbidden");
    m.tombstone = true;
    m.ts = this.now();
    return { message_id, tombstone: true, ts: m.ts };
  }

  react(message_id: Id, by: Username, emoji: string, add: boolean): { message_id: Id; reactions: Message["reactions"] } | null {
    const m = this.msgById.get(message_id);
    if (!m) return null;
    let r = m.reactions.find((x) => x.emoji === emoji);
    if (!r && add) {
      r = { emoji, count: 0 };
      m.reactions.push(r);
    }
    if (!r) return { message_id, reactions: m.reactions };
    if (add) r.count = Math.max(1, r.count + 1);
    else r.count = Math.max(0, r.count - 1);
    return { message_id, reactions: m.reactions };
  }

  mintTicket(username: Username, ttlMs = 60_000): Ticket {
    const t: Ticket = { ticket: b32Random(40), username, expires_at: Date.now() + ttlMs };
    this.tickets.set(t.ticket, t);
    return t;
  }

  useTicket(ticket: string): Username | null {
    const t = this.tickets.get(ticket);
    if (!t) return null;
    if (t.used || Date.now() > t.expires_at) return null;
    t.used = true;
    return t.username;
  }
}

export const db = new DB();

