import { newId128, nowTs } from "./utils";
import type {
  Id,
  Message,
  Room,
  UploadMeta,
  User,
  TokenRecord,
  MemberEntry,
  RoomRoleName,
  SessionInfo,
} from "./types";

// In-memory data store for demo purposes only

export const users = new Map<Id, User>();
export const tokens = new Map<string, TokenRecord>();
export const sessions = new Map<Id, SessionInfo>();

export const rooms = new Map<Id, Room>();
export const roomByName = new Map<string, Id>(); // normalized name -> room_id
export const roomMembers = new Map<Id, Map<Id, RoomRoleName>>(); // room_id -> user_id -> role
export const roomMessages = new Map<Id, Message[]>();
export const roomNextSeq = new Map<Id, number>();
export const roomCursors = new Map<Id, Map<Id, number>>(); // room_id -> user_id -> seq

export const dmPairs = new Map<string, Message[]>(); // pairKey -> messages
export const dmNextSeq = new Map<string, number>();
export const dmCursors = new Map<string, Map<Id, number>>(); // pairKey -> user_id -> seq

export const uploads = new Map<Id, UploadMeta>();
export interface TicketRec { user_id: Id; expires_at: number; used: boolean }
export const wsTickets = new Map<string, TicketRec>();

export function ensureUser(user?: User): User {
  if (user) return user;
  const uid = newId128();
  const u: User = { user_id: uid, display_name: `Guest ${uid.slice(0, 6)}` };
  users.set(uid, u);
  return u;
}

export function createGuestToken(): TokenRecord {
  const user = ensureUser();
  const access_token = newId128();
  const rec: TokenRecord = { access_token, user_id: user.user_id, created_at: nowTs() };
  tokens.set(access_token, rec);
  return rec;
}

export function createRoom(owner_id: Id, name: string, visibility: Room["visibility"], topic = ""): Room {
  const norm = normalizeRoomName(name);
  if (roomByName.has(norm)) {
    throw new Error("room_name_conflict");
  }
  const room_id = newId128();
  const room: Room = {
    room_id,
    name,
    topic,
    visibility,
    owner_id,
    created_at: nowTs(),
    counts: { members: 1 },
    pinned_message_ids: [],
  };
  rooms.set(room_id, room);
  roomByName.set(norm, room_id);
  roomMembers.set(room_id, new Map([[owner_id, "owner"]]));
  roomMessages.set(room_id, []);
  roomNextSeq.set(room_id, 1);
  roomCursors.set(room_id, new Map());
  return room;
}

export function addMember(room_id: Id, user_id: Id, role: RoomRoleName = "member"): void {
  let m = roomMembers.get(room_id);
  if (!m) {
    m = new Map();
    roomMembers.set(room_id, m);
  }
  if (!m.has(user_id)) {
    m.set(user_id, role);
    const r = rooms.get(room_id);
    if (r) r.counts.members += 1;
  }
}

export function removeMember(room_id: Id, user_id: Id): void {
  const m = roomMembers.get(room_id);
  if (m && m.delete(user_id)) {
    const r = rooms.get(room_id);
    if (r && r.counts.members > 0) r.counts.members -= 1;
  }
}

export function pairKey(a: Id, b: Id): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function ensureDmPair(a: Id, b: Id): string {
  const key = pairKey(a, b);
  if (!dmPairs.has(key)) {
    dmPairs.set(key, []);
    dmNextSeq.set(key, 1);
    dmCursors.set(key, new Map());
  }
  return key;
}

export function normalizeRoomName(name: string): string {
  return name.trim().toLowerCase();
}
