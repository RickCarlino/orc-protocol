import { session } from '../state/session';
import type { components } from './types';

type CapabilityResponse = components['schemas']['CapabilityResponse'];
type LoginResponse = components['schemas']['LoginResponse'];
type Room = components['schemas']['Room'];
type Message = components['schemas']['Message'];
type RtmTicketResponse = { ticket: string; expires_in_ms: number };
type CreateRoomRequest = components['schemas']['CreateRoomRequest'];

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

export class ApiClient {
  constructor(private baseUrl: string) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (session.tokens?.access_token) h['Authorization'] = `Bearer ${session.tokens.access_token}`;
    return h;
  }

  async metaCapabilities() {
    const r = await fetch(new URL('/meta/capabilities', this.baseUrl), { headers: this.headers() });
    return json<CapabilityResponse>(r);
  }

  async authGuest(username: string) {
    const r = await fetch(new URL('/auth/guest', this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ username }),
    });
    return json<LoginResponse>(r);
  }

  async mintRtmTicket(): Promise<RtmTicketResponse> {
    const r = await fetch(new URL('/rtm/ticket', this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
    });
    return json<RtmTicketResponse>(r);
  }

  async roomsMine(limit = 50) {
    const u = new URL('/rooms', this.baseUrl);
    u.searchParams.set('mine', 'true');
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u, { headers: this.headers() });
    return json<{ rooms: Room[] }>(r);
  }

  async directoryRooms(q = '', limit = 50) {
    const u = new URL('/directory/rooms', this.baseUrl);
    if (q) u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u, { headers: this.headers() });
    return json<{ rooms: Room[] }>(r);
  }

  async createRoom(req: CreateRoomRequest): Promise<Room> {
    const r = await fetch(new URL('/rooms', this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    return json<Room>(r);
  }

  async joinRoom(room_name: string) {
    const r = await fetch(new URL(`/rooms/${encodeURIComponent(room_name)}/join`, this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
    });
    if (!r.ok && r.status !== 204) throw new Error('join failed');
  }

  async roomMessages(room_name: string, from_seq = 0, limit = 100) {
    const u = new URL(`/rooms/${encodeURIComponent(room_name)}/messages`, this.baseUrl);
    u.searchParams.set('from_seq', String(from_seq));
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u, { headers: this.headers() });
    return json<{ messages: Message[]; next_seq: number }>(r);
  }

  async postRoomMessage(room_name: string, text: string) {
    const r = await fetch(new URL(`/rooms/${encodeURIComponent(room_name)}/messages`, this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text, content_type: 'text/markdown' }),
    });
    return json<Message>(r);
  }
}

export function makeApi(baseUrl = session.baseUrl) { return new ApiClient(baseUrl); }
