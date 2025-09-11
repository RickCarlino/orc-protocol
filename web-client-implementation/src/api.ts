import { type AuthGuestResponse, type CapabilitiesResponse, type PaginatedMessages, type Room, type RtmTicketResponse } from './types';

export type ApiConfig = {
  baseUrl: string; // e.g., https://api.example.com
  accessToken?: string;
};

export class ApiClient {
  private cfg: ApiConfig;

  constructor(cfg: ApiConfig) {
    this.cfg = cfg;
  }

  setAccessToken(token?: string) {
    this.cfg.accessToken = token;
  }

  setBaseUrl(url: string) {
    this.cfg.baseUrl = url.replace(/\/$/, '');
  }

  private headers(extra?: Record<string, string>) {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.cfg.accessToken) {
      h['Authorization'] = `Bearer ${this.cfg.accessToken}`;
    }
    return h;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const url = this.cfg.baseUrl.replace(/\/$/, '') + path;
    const res = await fetch(url, init);
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error?.message) msg = body.error.message;
      } catch {}
      throw new Error(`HTTP ${msg}`);
    }
    return res.json() as Promise<T>;
  }

  // Meta
  capabilities() {
    return this.json<CapabilitiesResponse>('/meta/capabilities', {
      headers: this.headers(),
    });
  }

  // Auth
  authGuest(username: string) {
    return this.json<AuthGuestResponse>('/auth/guest', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ username }),
    });
  }

  logout() {
    return fetch(this.cfg.baseUrl + '/auth/logout', {
      method: 'POST',
      headers: this.headers(),
    });
  }

  // Realtime
  rtmTicket() {
    // Requires Authorization header; returns short-lived ticket for WS auth
    return this.json<RtmTicketResponse>('/rtm/ticket', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({}),
    });
  }

  // Rooms
  myRooms(limit = 100, cursor?: string) {
    const qs = new URLSearchParams({ mine: 'true', limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    return this.json<{ rooms: Room[]; next_cursor?: string }>(`/rooms?${qs.toString()}`, {
      headers: this.headers(),
    });
  }

  directoryRooms(q = '', limit = 50, cursor?: string) {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    return this.json<{ rooms: Room[]; next_cursor?: string }>(`/directory/rooms?${qs.toString()}`, {
      headers: this.headers(),
    });
  }

  createRoom(name: string, visibility: 'public' | 'private' = 'public', topic?: string) {
    return this.json<{ room: Room }>('/rooms', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, visibility, topic }),
    });
  }

  joinRoom(name: string) {
    return fetch(this.cfg.baseUrl + `/rooms/${encodeURIComponent(name)}/join`, {
      method: 'POST',
      headers: this.headers(),
    });
  }

  roomCursor(name: string) {
    return this.json<{ seq: number }>(`/rooms/${encodeURIComponent(name)}/cursor`, {
      headers: this.headers(),
    });
  }

  ackRoom(name: string, seq: number) {
    return fetch(this.cfg.baseUrl + `/rooms/${encodeURIComponent(name)}/ack`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ seq }),
    });
  }

  // Messages (rooms)
  roomMessages(name: string, from_seq?: number, limit = 50) {
    const qs = new URLSearchParams();
    if (from_seq != null) qs.set('from_seq', String(from_seq));
    if (limit != null) qs.set('limit', String(limit));
    return this.json<PaginatedMessages>(`/rooms/${encodeURIComponent(name)}/messages?${qs.toString()}`, {
      headers: this.headers(),
    });
  }

  roomMessagesBackfill(name: string, before_seq?: number, limit = 50) {
    const qs = new URLSearchParams();
    if (before_seq != null) qs.set('before_seq', String(before_seq));
    if (limit != null) qs.set('limit', String(limit));
    return this.json<PaginatedMessages>(`/rooms/${encodeURIComponent(name)}/messages/backfill?${qs.toString()}`, {
      headers: this.headers(),
    });
  }

  sendRoomMessage(name: string, text: string) {
    return this.json<{ message: unknown }>(`/rooms/${encodeURIComponent(name)}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text }),
    });
  }
}
