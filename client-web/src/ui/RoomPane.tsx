import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OrcpApi } from '../util/api';

type User = { username: string; display_name?: string };
type Room = { room_id: string; name: string };
type Message = {
  message_id: string;
  room_id: string | null;
  dm_peer: string | null;
  author: string;
  seq: number;
  ts: string;
  content_type: string;
  text: string;
  tombstone: boolean;
};

export function RoomPane({ api, room, user }: { api: OrcpApi; room: Room; user: User }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const loadInitial = useCallback(async () => {
    const res = await api.get(`/rooms/${encodeURIComponent(room.name)}/messages`, { from_seq: 0, limit: 100 });
    setMessages(res.messages ?? []);
  }, [api, room.name]);

  useEffect(() => { setMessages([]); void loadInitial(); }, [room.room_id]);

  const connectWS = useCallback(async () => {
    try {
      const t = await api.post('/rtm/ticket', {});
      const ticket: string = t.ticket;
      const base = api.baseUrl.replace(/\/$/, '');
      const wsUrl = base.replace(/^http/, 'ws') + `/rtm`;
      const ws = new WebSocket(wsUrl, ['orcp', `ticket.${ticket}`]);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', client: { name: 'orcp-web', version: '0.1' }, cursors: {} }));
      };
      ws.onmessage = (ev) => {
        try {
          const obj = JSON.parse(String(ev.data));
          if (obj?.type === 'event.message.create') {
            const m = obj.message as Message;
            if (m.room_id === room.room_id) setMessages(prev => [...prev, m]);
          }
        } catch {}
      };
      ws.onclose = () => setConnected(false);
      ws.onerror = () => setConnected(false);
    } catch (e) {
      console.warn('WS connect failed', e);
    }
  }, [api, room.room_id]);

  useEffect(() => {
    void connectWS();
    return () => { try { wsRef.current?.close(); } catch {} };
  }, [room.room_id]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    const m = await api.post(`/rooms/${encodeURIComponent(room.name)}/messages`, { text, content_type: 'text/markdown' });
    // optimistic append in case WS is not wired
    setMessages(prev => [...prev, m]);
  }, [api, room.name, input]);

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #4444' }}>
        <strong>#{room.name}</strong>
        <span style={{ marginLeft: 8, opacity: 0.7 }}>{connected ? 'connected' : 'offline'}</span>
      </div>
      <div style={{ overflow: 'auto', padding: 12 }}>
        {messages.map((m) => (
          <div key={m.message_id} style={{ margin: '8px 0' }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{m.author} · {new Date(m.ts).toLocaleTimeString()}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.tombstone ? '— deleted —' : m.text}</div>
          </div>
        ))}
      </div>
      <form onSubmit={(e)=>{ e.preventDefault(); void send(); }} style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #4444' }}>
        <input value={input} onChange={(e)=>setInput(e.target.value)} placeholder="Message #room" style={{ flex: 1 }} />
        <button>Send</button>
      </form>
    </div>
  );
}

