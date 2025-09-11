export type Id = string; // Base32 (lowercase, no padding)
export type Timestamp = string; // RFC3339 UTC Z

export interface ErrorBody {
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "unsupported_capability"
      | "rate_limited"
      | "conflict"
      | "history_pruned"
      | "internal"
      | "otp_required";
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface User {
  user_id: Id;
  display_name: string;
  photo_cid?: Id;
  bio?: string;
  status_text?: string;
  status_emoji?: string;
}

export type PresenceState = "online" | "away" | "dnd";

export interface RoomCounts {
  members: number;
}

export interface Room {
  room_id: Id;
  name: string;
  topic: string;
  visibility: "public" | "private";
  owner_id: Id;
  created_at: Timestamp;
  counts: RoomCounts;
  pinned_message_ids: Id[];
}

export interface Attachment {
  cid: Id;
  name: string;
  bytes: number;
  mime: string;
}

export interface ReactionEntry {
  emoji: string;
  count: number;
  me?: boolean;
}

export interface Entities {
  mentions?: { user_id: Id; range: [number, number] }[];
  links?: { url: string; range: [number, number] }[];
}

export interface Message {
  message_id: Id;
  room_id: Id | null;
  dm_peer_id: Id | null;
  author_id: Id;
  seq: number; // uint64 in spec; JS number for demo
  ts: Timestamp;
  parent_id: Id | null;
  content_type: string; // e.g. text/markdown
  text: string;
  entities?: Entities;
  attachments?: Attachment[];
  reactions?: ReactionEntry[];
  tombstone: boolean;
  edited_at?: Timestamp | null;
  moderation_reason?: string | null;
}

export interface UploadMeta {
  cid: Id;
  bytes: number;
  mime: string;
  sha256: string; // hex
  data: Uint8Array; // in-memory only; DO NOT in production
}

export interface SessionInfo {
  session_id: Id;
  user_id: Id;
  created_at: Timestamp;
  last_seen_at?: Timestamp;
  device?: string;
}

export interface TokenRecord {
  access_token: string;
  refresh_token?: string;
  user_id: Id;
  created_at: Timestamp;
}

export interface MemberEntry { user_id: Id; role: RoomRoleName };
export type RoomRoleName = "owner" | "admin" | "moderator" | "member" | "guest";

export interface Limits {
  max_message_bytes: number;
  max_upload_bytes: number;
  max_reactions_per_message: number;
  cursor_idle_timeout_ms: number;
  rate_limits: { burst: number; per_minute: number };
}

export interface CapabilityResponse {
  capabilities: string[];
  limits: Limits;
  server: { name: string; description?: string; contact?: string };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

