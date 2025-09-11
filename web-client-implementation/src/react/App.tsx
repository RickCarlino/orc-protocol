import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiClient } from '../api';
import { WSClient } from '../ws';
import { loadSession, saveSession, type StoredSession } from '../settings';
import type { Message, Room, WSFrame } from '../types';

type WSState = 'idle' | 'connected' | 'error';

export function App() {
  // Session state
  const [serverUrl, setServerUrl] = useState<string>('http://localhost:8080');
  const [accessToken, setAccessToken] = useState<string | undefined>();
  const [refreshToken, setRefreshToken] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | undefined>();

  // Data state
  const [serverReady, setServerReady] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [wsState, setWSState] = useState<WSState>('idle');

  // Clients
  const api = useMemo(() => new ApiClient({ baseUrl: serverUrl || '', accessToken }), [serverUrl, accessToken]);
  const wsRef = useRef<WSClient | null>(null);

  // Load persisted session
  useEffect(() => {
    const s = (loadSession() ?? {}) as StoredSession;
    if (s.serverUrl) setServerUrl(s.serverUrl);
    if (s.accessToken) setAccessToken(s.accessToken);
    if (s.refreshToken) setRefreshToken(s.refreshToken);
    if (s.sessionId) setSessionId(s.sessionId);
  }, []);

  // Persist session whenever core fields change
  useEffect(() => {
    const s: StoredSession = { serverUrl, accessToken, refreshToken, sessionId };
    saveSession(s);
  }, [serverUrl, accessToken, refreshToken, sessionId]);

  // Check server capabilities on serverUrl change
  useEffect(() => {
    let cancelled = false;
    if (!serverUrl) {
      setServerReady(false);
      return;
    }
    api
      .capabilities()
      .then(() => !cancelled && setServerReady(true))
      .catch(() => !cancelled && setServerReady(false));
    return () => {
      cancelled = true;
    };
  }, [api, serverUrl]);

  // WebSocket connect on room/token change
  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    // Reconnect on currentRoom or accessToken changes
    wsRef.current?.close();
    setWSState('idle');

    const subs: string[] = currentRoom ? [currentRoom.room_id] : [];
    const hello = {
      type: 'hello',
      client: { name: 'web', version: '0.1' },
      subscriptions: { rooms: subs, dms: false },
      cursors: {},
    };

    // Try to obtain a WS ticket; fall back to no-ticket if unsupported
    (async () => {
      let ticket: string | undefined;
      try {
        const t = await api.rtmTicket();
        ticket = t.ticket;
      } catch {
        // no-op fallback; server may not support ticket yet
      }
      if (cancelled) return;
      const ws = new WSClient({
        baseUrl: serverUrl,
        accessToken,
        ticket,
        onOpen: () => setWSState('connected'),
        onClose: () => setWSState('idle'),
        onError: () => setWSState('error'),
        onFrame: onWSFrame,
      });
      wsRef.current = ws;
      ws.connect(hello);
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, accessToken, currentRoom?.room_id]);

  const onWSFrame = useCallback(
    (f: WSFrame) => {
      if (f.type === 'ready') {
        setSessionId(f.session_id);
        return;
      }
      if (f.type === 'event.message.create') {
        if (!currentRoom) return;
        if (f.message.room_id === currentRoom.room_id) {
          setMessages((prev: Message[]) => [...prev, f.message]);
        }
        return;
      }
    },
    [currentRoom]
  );

  // Actions
  const saveServer = useCallback(async () => {
    if (!serverUrl) return;
    try {
      await api.capabilities();
      setServerReady(true);
    } catch (e) {
      alert('Server check failed: ' + (e as Error).message);
      setServerReady(false);
    }
  }, [api, serverUrl]);

  const clearServerAction = useCallback(() => {
    setServerUrl('');
    setServerReady(false);
    setRooms([]);
    setCurrentRoom(undefined);
    setMessages([]);
    wsRef.current?.close();
    setWSState('idle');
  }, []);

  const guestLogin = useCallback(async () => {
    if (!serverUrl) return alert('Set server URL first');
    try {
      const res = await api.authGuest();
      setAccessToken(res.access_token);
      await refreshRooms();
    } catch (e) {
      alert('Guest login failed: ' + (e as Error).message);
    }
  }, [api, serverUrl]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {}
    setAccessToken(undefined);
    setRefreshToken(undefined);
    setSessionId(undefined);
    wsRef.current?.close();
    setWSState('idle');
  }, [api]);

  const refreshRooms = useCallback(async () => {
    if (!serverUrl) return alert('Set server URL first');
    try {
      const res = await api.myRooms();
      // Be defensive: some early servers may omit `rooms` key
      const list = Array.isArray((res as any).rooms) ? (res as any).rooms : [];
      setRooms(list);
    } catch (e) {
      alert('Fetch rooms failed: ' + (e as Error).message);
    }
  }, [api, serverUrl]);

  const createRoom = useCallback(
    async (name: string) => {
      if (!serverUrl) return alert('Set server URL first');
      try {
        const { room } = await api.createRoom(name, 'public');
        await refreshRooms();
        selectRoom(room.room_id);
      } catch (e) {
        alert('Create room failed: ' + (e as Error).message);
      }
    },
    [api, serverUrl, refreshRooms]
  );

  const selectRoom = useCallback(
    async (room_id: string) => {
      const r = rooms.find((x: Room) => x.room_id === room_id);
      if (!r) return;
      setCurrentRoom(r);
      await loadRecentMessages(r.name);
    },
    [rooms]
  );

  const joinRoomByName = useCallback(
    async (name: string) => {
      if (!serverUrl) return alert('Set server URL first');
      try {
        await api.joinRoom(name);
        await refreshRooms();
        // select by name
        const latest = await api.myRooms();
        const list = Array.isArray((latest as any).rooms) ? (latest as any).rooms : [];
        const r = list.find((x: Room) => x.name === name);
        if (r) await selectRoom(r.room_id);
      } catch (e) {
        alert('Join failed: ' + (e as Error).message);
      }
    },
    [api, serverUrl, refreshRooms, selectRoom]
  );

  const loadRecentMessages = useCallback(
    async (roomName: string) => {
      try {
        const BIG = Number.MAX_SAFE_INTEGER;
        const res = await api.roomMessagesBackfill(roomName, BIG, 50);
        setMessages(res.messages.slice().reverse());
      } catch (e) {
        try {
          const res2 = await api.roomMessages(roomName, 1, 50);
          setMessages(res2.messages);
        } catch (e2) {
          alert('Load messages failed: ' + (e2 as Error).message);
        }
      }
    },
    [api]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!currentRoom) return;
      try {
        const res = await api.sendRoomMessage(currentRoom.name, text);
        // Optimistically append; WS will confirm too
        const msg = (res as any).message ?? res;
        setMessages((prev) => [...prev, msg]);
      } catch (e) {
        alert('Send failed: ' + (e as Error).message);
      }
    },
    [api, currentRoom]
  );

  // UI sub-components
  const tokenPreview = accessToken ? accessToken.slice(0, 10) + '…' : '—';

  return (
    <div className="grid grid-cols-[280px_1fr] grid-rows-[auto_1fr] h-full">
      <header className="col-span-2 border-b bg-white/70 backdrop-blur px-4 py-2 flex items-center gap-3">
        <h1 className="font-semibold text-lg">Open Rooms</h1>
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 text-slate-500">
            <span className={`w-2 h-2 rounded-full ${serverReady ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <span>{serverReady ? 'ready' : 'disconnected'}</span>
          </span>
          <span className="text-slate-300">•</span>
          <span className="inline-flex items-center gap-1 text-slate-500">
            <span
              className={`w-2 h-2 rounded-full ${wsState === 'connected' ? 'bg-emerald-500' : wsState === 'error' ? 'bg-red-500' : 'bg-slate-300'}`}
            />
            <span>{wsState === 'connected' ? 'ws connected' : wsState === 'error' ? 'ws error' : 'ws idle'}</span>
          </span>
        </div>
        <div className="ml-auto text-xs text-slate-500 flex items-center gap-2">
          {currentRoom ? (
            <>
              <span>room:</span>
              <code className="px-1.5 py-0.5 rounded bg-slate-100">{currentRoom.name}</code>
            </>
          ) : null}
        </div>
      </header>

      <aside className="border-r bg-white overflow-y-auto">
        <div className="p-3 border-b space-y-2">
          <label className="block text-xs font-medium text-slate-500">Server URL</label>
          <input
            placeholder="https://api.example.com"
            className="w-full text-sm rounded border px-2 py-1"
            value={serverUrl}
            onChange={(e: any) => setServerUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <button onClick={saveServer} className="px-2 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
              Save
            </button>
            <button onClick={clearServerAction} className="px-2 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
              Clear
            </button>
          </div>
        </div>

        <div className="p-3 border-b space-y-2">
          <div className="flex gap-2">
            <button onClick={guestLogin} className="px-2 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700">
              Guest Login
            </button>
            <button onClick={logout} className="px-2 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
              Logout
            </button>
          </div>
          <div className="text-xs text-slate-500 truncate">token: {tokenPreview}</div>
        </div>

        <RoomsPanel
          rooms={rooms}
          onRefresh={refreshRooms}
          onCreate={createRoom}
          onSelect={(rid) => selectRoom(rid)}
          onJoin={joinRoomByName}
          currentId={currentRoom?.room_id}
        />
      </aside>

      <main className="bg-slate-50 flex flex-col">
        <div className="border-b px-4 py-2 bg-white">
          <div className="text-sm text-slate-600">{currentRoom ? `# ${currentRoom.name} — ${currentRoom.topic ?? ''}` : 'No room selected'}</div>
        </div>

        <MessagesList messages={messages} />

        <Composer onSend={sendMessage} disabled={!currentRoom} />
      </main>
    </div>
  );
}

function RoomsPanel({
  rooms,
  currentId,
  onRefresh,
  onCreate,
  onSelect,
  onJoin,
}: {
  rooms: Room[];
  currentId?: string;
  onRefresh: () => void;
  onCreate: (name: string) => void;
  onSelect: (room_id: string) => void;
  onJoin: (name: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [joinId, setJoinId] = useState('');
  return (
    <div className="p-3 border-b space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Rooms</h2>
        <button onClick={onRefresh} className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">
          Refresh
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e: any) => setNewName(e.target.value)}
          placeholder="new-room"
          className="flex-1 text-sm rounded border px-2 py-1"
        />
        <button
          onClick={() => newName.trim() && (onCreate(newName.trim()), setNewName(''))}
          className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200"
        >
          Create
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={joinId}
          onChange={(e: any) => setJoinId(e.target.value)}
          placeholder="join room name"
          className="flex-1 text-sm rounded border px-2 py-1"
        />
        <button
          onClick={() => joinId.trim() && (onJoin(joinId.trim()), setJoinId(''))}
          className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200"
        >
          Join
        </button>
      </div>
      <nav className="space-y-1 text-sm">
        {rooms.map((r) => (
          <button
            key={r.room_id}
            onClick={() => onSelect(r.room_id)}
            className={`w-full text-left px-2 py-1 rounded hover:bg-slate-100 ${currentId === r.room_id ? 'bg-slate-100' : ''}`}
          >
            # {r.name}
          </button>
        ))}
      </nav>
    </div>
  );
}

function MessagesList({ messages }: { messages: Message[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-2">
      {messages.map((m) => (
        <MessageRow key={`${m.seq}:${m.message_id}`} msg={m} />
      ))}
    </div>
  );
}

function MessageRow(props: { msg: Message } & Record<string, any>) {
  const { msg } = props;
  const time = formatTime(msg.ts);
  const avatar = (msg.author_id ?? '?').slice(0, 2);
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs">{avatar}</div>
      <div className="flex-1">
        <div className="text-xs text-slate-500">{msg.author_id?.slice(0, 6)} • {time}</div>
        <div className={`text-sm whitespace-pre-wrap ${msg.tombstone ? 'italic text-slate-400' : ''}`}>{msg.tombstone ? '⟂ message removed' : msg.text ?? ''}</div>
      </div>
    </div>
  );
}

function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="border-t bg-white p-3">
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <textarea
          rows={2}
          placeholder="Write a message..."
          className="flex-1 rounded border px-3 py-2 text-sm"
          value={text}
          onChange={(e: any) => setText(e.target.value)}
          disabled={disabled}
        />
        <button disabled={disabled} className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}

function formatTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
