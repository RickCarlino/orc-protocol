import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../util/api';
import { useApiConfig } from '../util/config';
import { RoomPane } from './RoomPane';

type User = { username: string; display_name?: string };
type Room = {
  room_id: string;
  name: string;
  topic?: string;
  visibility: 'public' | 'private';
  owner: string;
  counts: { members: number };
  pinned_message_ids: string[];
};

export function App() {
  const { baseUrl, setBaseUrl } = useApiConfig();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [myRooms, setMyRooms] = useState<Room[]>([]);
  const [directory, setDirectory] = useState<Room[]>([]);
  const [selected, setSelected] = useState<Room | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authedApi = useMemo(() => (token ? api(baseUrl, token) : api(baseUrl)), [baseUrl, token]);

  const loginGuest = useCallback(async (username: string) => {
    setBusy(true); setError(null);
    try {
      const res = await authedApi.post('/auth/guest', { username });
      setToken(res.access_token);
      setUser(res.user);
    } catch (e: any) {
      setError(e?.message || 'Login failed');
    } finally { setBusy(false); }
  }, [authedApi]);

  const refreshLists = useCallback(async () => {
    if (!token) return;
    try {
      const mine = await authedApi.get('/rooms', { mine: true, limit: 100 });
      setMyRooms(mine.rooms ?? []);
      const dir = await authedApi.get('/directory/rooms', { limit: 100 });
      setDirectory(dir.rooms ?? []);
    } catch (e) {
      console.warn(e);
    }
  }, [authedApi, token]);

  useEffect(() => { if (token) void refreshLists(); }, [token, refreshLists]);

  const onCreateRoom = useCallback(async (name: string, visibility: 'public'|'private', topic?: string) => {
    if (!token) return;
    setBusy(true); setError(null);
    try {
      const room = await authedApi.post('/rooms', { name, visibility, topic });
      await refreshLists();
      setSelected(room);
    } catch (e: any) { setError(e?.message || 'Failed to create room'); }
    finally { setBusy(false); }
  }, [authedApi, token, refreshLists]);

  const onJoinRoom = useCallback(async (room: Room) => {
    if (!token) return;
    setBusy(true); setError(null);
    try {
      await authedApi.post(`/rooms/${encodeURIComponent(room.name)}/join`, {});
      await refreshLists();
      setSelected(room);
    } catch (e: any) { setError(e?.message || 'Failed to join'); }
    finally { setBusy(false); }
  }, [authedApi, token, refreshLists]);

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100vh' }}>
      <Header baseUrl={baseUrl} setBaseUrl={setBaseUrl} user={user} />
      {!token ? (
        <LoginView onLogin={loginGuest} busy={busy} error={error} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', minHeight: 0 }}>
          <Sidebar
            myRooms={myRooms}
            directory={directory}
            selected={selected?.name || ''}
            onSelect={(name) => setSelected([...myRooms, ...directory].find(r => r.name === name) || null)}
            onCreate={onCreateRoom}
            onJoin={onJoinRoom}
            refreshing={busy}
          />
          <main style={{ minWidth: 0, minHeight: 0 }}>
            {selected ? (
              <RoomPane api={authedApi} room={selected} user={user!} />
            ) : (
              <div style={{ padding: 16 }}>Select or create a room to start chatting.</div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function Header({ baseUrl, setBaseUrl, user }: { baseUrl: string; setBaseUrl: (v: string)=>void; user: User | null }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid #4444' }}>
      <strong>ORCP</strong>
      <span style={{ opacity: 0.7 }}>Web Client (Demo)</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>API Base</label>
        <input value={baseUrl} onChange={(e)=>setBaseUrl(e.target.value)} placeholder="http://localhost:3000" style={{ width: 260 }} />
        {user && <div style={{ opacity: 0.8 }}>Signed in: <strong>{user.username}</strong></div>}
      </div>
    </header>
  );
}

function LoginView({ onLogin, busy, error }: { onLogin: (username: string)=>void; busy: boolean; error: string | null }) {
  const [username, setUsername] = useState('guest-' + Math.random().toString(36).slice(2,6));
  return (
    <div style={{ display: 'grid', placeItems: 'center' }}>
      <form onSubmit={(e)=>{ e.preventDefault(); onLogin(username.trim()); }} style={{ display:'grid', gap: 8, width: 320, marginTop: 64 }}>
        <h2>Guest Login</h2>
        <input value={username} onChange={(e)=>setUsername(e.target.value)} placeholder="username" />
        <button disabled={busy || !username.trim()}>{busy ? 'Signing in...' : 'Sign in'}</button>
        {error && <div style={{ color: 'tomato' }}>{error}</div>}
      </form>
    </div>
  );
}

function Sidebar(props: {
  myRooms: Room[];
  directory: Room[];
  selected: string;
  onSelect: (name: string)=>void;
  onCreate: (name: string, visibility: 'public'|'private', topic?: string)=>void;
  onJoin: (room: Room)=>void;
  refreshing: boolean;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [visibility, setVisibility] = useState<'public'|'private'>('public');
  return (
    <aside style={{ borderRight: '1px solid #4444', padding: 12, display: 'grid', gridTemplateRows: 'auto auto 1fr', rowGap: 12, minWidth: 0 }}>
      <section>
        <h3 style={{ margin: '4px 0' }}>My Rooms</h3>
        {props.myRooms.length === 0 && <div style={{ opacity: 0.7 }}>None</div>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {props.myRooms.map(r => (
            <li key={r.room_id}>
              <button
                style={{ width: '100%', textAlign: 'left', background: props.selected===r.name? '#3a3a3a': undefined }}
                onClick={()=>props.onSelect(r.name)}>{r.name}</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 style={{ margin: '4px 0' }}>Create Room</h3>
        <form onSubmit={(e)=>{ e.preventDefault(); if (name.trim()) props.onCreate(name.trim(), visibility, topic.trim()||undefined); }} style={{ display: 'grid', gap: 6 }}>
          <input placeholder="name" value={name} onChange={(e)=>setName(e.target.value)} />
          <input placeholder="topic (optional)" value={topic} onChange={(e)=>setTopic(e.target.value)} />
          <label style={{ fontSize: 12 }}>
            <input type="radio" name="vis" checked={visibility==='public'} onChange={()=>setVisibility('public')} /> public
            <input type="radio" name="vis" checked={visibility==='private'} onChange={()=>setVisibility('private')} style={{ marginLeft: 12 }} /> private
          </label>
          <button disabled={!name.trim() || props.refreshing}>Create</button>
        </form>
      </section>
      <section style={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto 1fr' }}>
        <h3 style={{ margin: '4px 0' }}>Directory</h3>
        <div style={{ overflow: 'auto', minHeight: 0 }}>
          {props.directory.map(r => (
            <div key={r.room_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <button style={{ flex: 1, textAlign: 'left' }} onClick={()=>props.onSelect(r.name)}>{r.name}</button>
              <button onClick={()=>props.onJoin(r)}>Join</button>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

