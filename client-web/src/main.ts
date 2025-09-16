import { session } from "./state/session";
import { makeApi } from "./api/client";
import type { components } from "./api/types";
type Message = components['schemas']['Message'];
type Room = components['schemas']['Room'];
import { rtm } from "./lib/ws";

// Grabs elements
const el = {
  serverUrl: document.getElementById("serverUrl") as HTMLInputElement,
  username: document.getElementById("username") as HTMLInputElement,
  guestLogin: document.getElementById("guestLogin") as HTMLButtonElement,
  authState: document.getElementById("authState")!,
  caps: document.getElementById("caps")!,
  myRooms: document.getElementById("myRooms")!,
  discoverRooms: document.getElementById("discoverRooms")!,
  discoverQ: document.getElementById("discoverQ") as HTMLInputElement,
  discoverBtn: document.getElementById("discoverBtn") as HTMLButtonElement,
  createRoomName: document.getElementById("createRoomName") as HTMLInputElement,
  createRoomVisibility: document.getElementById("createRoomVisibility") as HTMLSelectElement,
  createRoomTopic: document.getElementById("createRoomTopic") as HTMLInputElement,
  createRoomBtn: document.getElementById("createRoomBtn") as HTMLButtonElement,
  createRoomMsg: document.getElementById("createRoomMsg")!,
  roomTitle: document.getElementById("roomTitle")!,
  messages: document.getElementById("messages")!,
  composerInput: document.getElementById("composerInput") as HTMLTextAreaElement,
  sendBtn: document.getElementById("sendBtn") as HTMLButtonElement,
  wsState: document.getElementById("wsState")!,
};

let api = makeApi();
let currentRoom: string | null = null;
let nextSeq: number | null = null;
// Map room_id -> room name for filtering WS events to the active room
const roomNameById = new Map<string, string>();

function setAuthState() {
  el.authState.textContent = session.isAuthed
    ? `Signed in as ${session.user?.display_name || session.user?.user_id}`
    : "Not signed in";
}

function setWsState() {
  el.wsState.textContent = `WS: ${rtm.status}`;
}

function renderRooms(container: HTMLElement, rooms: Room[], opts: { clickable?: boolean; activeName?: string } = {}) {
  container.innerHTML = "";
  for (const r of rooms) {
    const div = document.createElement("div");
    div.className = "room" + (opts.activeName === r.name ? " active" : "");
    div.textContent = r.name + (r.topic ? ` — ${r.topic}` : "");
    if (opts.clickable) {
      div.onclick = () => selectRoom(r.name);
    }
    container.appendChild(div);
  }
  if (!rooms.length) {
    const p = document.createElement("div");
    p.className = "muted small";
    p.textContent = "No rooms";
    container.appendChild(p);
  }
}

async function fetchCaps() {
  const data = await api.metaCapabilities().catch(() => ({ capabilities: [] }));
  const caps = data?.capabilities || [];
  el.caps.textContent = caps.join(", ") || "—";
}

async function fetchMyRooms() {
  const data = await api.roomsMine(50).catch(() => ({ rooms: [] as any[] }));
  const rooms = (data.rooms || []) as Room[];
  roomNameById.clear();
  for (const r of rooms) {
    if (r.room_id) roomNameById.set(r.room_id, r.name);
  }
  renderRooms(el.myRooms, rooms, { clickable: true, activeName: currentRoom || undefined });
}

async function discoverRooms() {
  const q = el.discoverQ.value.trim();
  const data = await api.directoryRooms(q, 50).catch(() => ({ rooms: [] as any[] }));
  const rooms = data.rooms || [];
  el.discoverRooms.innerHTML = "";
  if (!rooms.length) {
    el.discoverRooms.textContent = "No results";
    return;
  }
  for (const r of rooms) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("div");
    label.className = "grow";
    label.textContent = r.name + (r.topic ? ` — ${r.topic}` : "");
    const join = document.createElement("button");
    join.textContent = "Join";
    join.onclick = async () => {
      await api.joinRoom(r.name).catch(() => {});
      await fetchMyRooms();
      await selectRoom(r.name);
    };
    row.appendChild(label);
    row.appendChild(join);
    el.discoverRooms.appendChild(row);
  }
}

function renderMessage(m: Message) {
  const div = document.createElement("div");
  div.className = "msg";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${m.author_id} • ${new Date(m.ts).toLocaleString()} • #${m.seq}`;
  const text = document.createElement("div");
  text.innerText = m.text || ""; // keep it simple; could parse markdown later
  div.appendChild(meta);
  div.appendChild(text);
  return div;
}

async function loadRoomHistory(name: string) {
  el.messages.innerHTML = "";
  nextSeq = 0;
  const data = await api.roomMessages(name, 0, 100).catch(() => ({ messages: [] as any[], next_seq: 0 }));
  const messages = data.messages || [];
  for (const m of messages) el.messages.appendChild(renderMessage(m));
  nextSeq = (data as any)?.next_seq ?? null;
  el.messages.scrollTop = el.messages.scrollHeight;
}

async function selectRoom(name: string) {
  currentRoom = name;
  el.roomTitle.textContent = `Room: ${name}`;
  const mine = await api.roomsMine(50).catch(() => ({ rooms: [] as any[] }));
  renderRooms(el.myRooms, mine.rooms || [], { clickable: true, activeName: name });
  await loadRoomHistory(name);
}

async function sendMessage() {
  const text = el.composerInput.value.trim();
  if (!text || !currentRoom) return;
  el.composerInput.value = "";
  const msg = await api.postRoomMessage(currentRoom, text).catch(() => null);
  if (msg) {
    el.messages.appendChild(renderMessage(msg));
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

function wireEvents() {
  el.serverUrl.value = session.baseUrl;
  el.serverUrl.addEventListener("change", () => {
    session.baseUrl = el.serverUrl.value;
    api = makeApi();
    fetchCaps();
  });

  el.guestLogin.onclick = async () => {
    session.baseUrl = el.serverUrl.value.trim();
    api = makeApi();
    const username = el.username.value.trim();
    if (!username) return alert("Enter a guest username");
    const auth = await api.authGuest(username).catch(() => null);
    if (!auth) return alert("Login failed");
    session.setAuth({ access_token: auth.access_token, refresh_token: auth.refresh_token }, auth.user);
    setAuthState();
    await fetchCaps();
    await fetchMyRooms();
    setWsState();
    await rtm.connect();
  };

  el.discoverBtn.onclick = () => discoverRooms();
  el.sendBtn.onclick = () => sendMessage();

  el.createRoomBtn.onclick = async () => {
    if (!session.isAuthed) {
      el.createRoomMsg.textContent = "Sign in first";
      return;
    }
    const name = el.createRoomName.value.trim();
    const visibility = (el.createRoomVisibility.value as 'public' | 'private');
    const topic = el.createRoomTopic.value.trim();
    if (!name) {
      el.createRoomMsg.textContent = "Enter a room name";
      return;
    }
    el.createRoomMsg.textContent = "Creating...";
    const req = { name, visibility, ...(topic ? { topic } : {}) } as const;
    try {
      const room = await api.createRoom(req);
      el.createRoomMsg.textContent = `Created ${room.name}`;
      // Clear inputs
      el.createRoomName.value = "";
      el.createRoomTopic.value = "";
      await fetchMyRooms();
      await selectRoom(room.name);
    } catch (e: any) {
      el.createRoomMsg.textContent = e?.message || "Failed to create room";
    }
  };

  rtm.on((msg) => {
    setWsState();
    if (msg.type === "event.message.create") {
      const m = (msg as any).message as Message;
      if (!m) return;
      if (!currentRoom) return;
      // Append only if the event belongs to the active room
      const roomName = m.room_id ? roomNameById.get(m.room_id) : null;
      if (roomName && roomName === currentRoom) {
        el.messages.appendChild(renderMessage(m));
        el.messages.scrollTop = el.messages.scrollHeight;
      }
    }
  });
}

async function boot() {
  wireEvents();
  setAuthState();
  setWsState();
  if (session.baseUrl) {
    await fetchCaps();
  }
  if (session.isAuthed) {
    await fetchMyRooms();
    await rtm.connect();
  }
}

boot();
