// Core protocol types (subset used by the client)

export type ID = string;

export interface Limits {
  max_message_bytes: number;
  max_upload_bytes: number;
  max_reactions_per_message: number;
  cursor_idle_timeout_ms: number;
  rate_limits?: { burst: number; per_minute: number };
}

export interface CapabilitiesResponse {
  capabilities: string[];
  limits: Limits;
  server: { name: string; description?: string; contact?: string };
}

export interface User {
  user_id: ID;
  display_name: string;
  photo_cid?: string | null;
  bio?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
}

export interface Room {
  room_id: ID;
  name: string;
  topic?: string | null;
  visibility: 'public' | 'private';
  owner_id: ID;
  created_at: string; // RFC3339
  counts: { members: number };
  pinned_message_ids: ID[];
}

export interface Attachment {
  cid: string;
  name: string;
  bytes: number;
  mime: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  me?: boolean;
}

export interface Message {
  message_id: ID;
  room_id: ID | null;
  dm_peer_id: ID | null;
  author_id: ID;
  seq: number;
  ts: string;
  parent_id: ID | null;
  content_type?: string | null;
  text?: string;
  attachments?: Attachment[];
  reactions?: Reaction[];
  tombstone: boolean;
  edited_at?: string | null;
  moderation_reason?: string | null;
}

export interface PaginatedMessages {
  messages: Message[];
  next_seq?: number;
  prev_seq?: number;
}

export interface AuthGuestResponse {
  access_token: string;
  refresh_token?: string;
  user: User;
}

export interface RtmTicketResponse {
  ticket: string;
  expires_in_ms: number;
}

export type WSFrame =
  | { type: 'ready'; session_id: string; heartbeat_ms: number; server_time: string; capabilities: string[] }
  | { type: 'ping'; ts: string }
  | { type: 'pong'; ts: string }
  | { type: 'event.message.create'; message: Message }
  | { type: 'event.message.edit'; message: Message }
  | { type: 'event.message.delete'; message_id: ID; room_id?: ID | null; dm_peer_id?: ID | null; ts: string }
  | { type: 'event.reaction.add' | 'event.reaction.remove'; message_id: ID; emoji: string; counts: { emoji: string; count: number }[] }
  | { type: 'error'; error: { code: string; message: string } };
