// LocalStorage-backed settings and session persistence

export type StoredSession = {
  serverUrl: string;
  accessToken?: string;
  refreshToken?: string;
  sessionId?: string; // WS session resume token
};

const KEY = 'orc_web_client_session_v1';

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredSession;
    return data;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

