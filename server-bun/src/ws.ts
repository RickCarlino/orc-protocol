import { db } from "./inmemory";
import { nowIso } from "./utils";

export interface ReadyFrame {
  type: "ready";
  heartbeat_ms: number;
  server_time: string;
  capabilities: string[];
}

export const HEARTBEAT_MS = 30_000;

export type WSData = { username: string; _hb?: Timer };

export const websocket: WebSocketHandler<WSData> = {
  open(ws) {
    const ready: ReadyFrame = {
      type: "ready",
      heartbeat_ms: HEARTBEAT_MS,
      server_time: nowIso(),
      capabilities: ["uploads", "search.basic", "push.poll"],
    };
    ws.send(JSON.stringify(ready));
    ws.data._hb = setInterval(() => {
      try { ws.send(JSON.stringify({ type: "ping", ts: nowIso() })); } catch {}
    }, HEARTBEAT_MS);
  },
  message(ws, msg) {
    try {
      const obj = JSON.parse(String(msg));
      if (obj?.type === "hello") return; // already sent ready
      if (obj?.type === "pong") return;
      if (obj?.type === "ack") return; // cursors ignored in demo
    } catch {}
  },
  close(ws) {
    if (ws.data._hb) clearInterval(ws.data._hb);
  },
};

export function extractTicket(req: Request): string | null {
  const url = new URL(req.url);
  const sub = req.headers.get("sec-websocket-protocol") || "";
  const ticketFromSub = sub.split(/\s*,\s*/).find((p) => p.startsWith("ticket."))?.slice("ticket.".length) || null;
  return ticketFromSub || url.searchParams.get("ticket");
}

