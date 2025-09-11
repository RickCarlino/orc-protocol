import type { WSFrame } from './types';

export type WSConfig = {
  baseUrl: string; // same as API base, we will append /rtm
  accessToken?: string;
  ticket?: string; // short-lived ticket for WS auth
  onFrame: (f: WSFrame) => void;
  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
};

export class WSClient {
  private cfg: WSConfig;
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;

  constructor(cfg: WSConfig) {
    this.cfg = cfg;
  }

  connect(hello: object) {
    this.close();
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + '/rtm');
    const wsUrl = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.protocol = wsUrl;
    if (this.cfg.ticket) {
      url.searchParams.set('ticket', this.cfg.ticket);
    }

    const protocols: string[] = [];
    // Prefer explicit subprotocols for browser auth
    if (this.cfg.ticket) {
      protocols.push('orcp', `ticket.${this.cfg.ticket}`);
    } else if (this.cfg.accessToken) {
      // Some servers accept bearer in subprotocol
      protocols.push('orcp', `bearer.${this.cfg.accessToken}`);
    }
    this.socket = new WebSocket(url.toString(), protocols);
    this.socket.addEventListener('open', () => {
      // Send Authorization as per spec via header; browsers can't set headers here.
      // Many servers allow a token frame immediately after open; otherwise they may use cookies.
      // Ticket-based auth: server authenticates the connection from the ticket in the URL.
      // We send hello with desired fields after open.
      // If server requires header-only auth, this won't work in browser. For dev, CORS + cookies can be used.
      this.send(hello);
      this.cfg.onOpen?.();
    });
    this.socket.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as WSFrame;
        if (data.type === 'ping') {
          this.send({ type: 'pong', ts: data.ts });
        }
        if (data.type === 'ready') {
          // Setup heartbeat safety (server also pings)
          if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = window.setInterval(() => {
            // noop; server is authoritative for pings
          }, Math.max(1000, data.heartbeat_ms));
        }
        this.cfg.onFrame(data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('WS message parse error', e);
      }
    });
    this.socket.addEventListener('close', (ev) => {
      if (this.heartbeatTimer) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cfg.onClose?.(ev);
    });
    this.socket.addEventListener('error', (ev) => this.cfg.onError?.(ev));
  }

  send(obj: unknown) {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    s.send(JSON.stringify(obj));
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
