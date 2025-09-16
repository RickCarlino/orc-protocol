import { session } from "../state/session";
import { makeApi } from "../api/client";
import type { components } from "../api/types";

export type WSStatus = "idle" | "connecting" | "open" | "error" | "closed";

type WSReady = components["schemas"]["WSReady"];
type WSEventMessageCreate = components["schemas"]["WSEventMessageCreate"];
type WSEventMessageEdit = components["schemas"]["WSEventMessageEdit"];
type WSEventMessageDelete = components["schemas"]["WSEventMessageDelete"];
type WSEventReactionAdd = components["schemas"]["WSEventReactionAdd"];
type WSEventTyping = components["schemas"]["WSEventTyping"];
type WSError = components["schemas"]["WSError"];

type WSPing = { type: "ping"; ts: string };
type WSPong = { type: "pong"; ts: string };

export type WSEvent =
  | WSEventMessageCreate
  | WSEventMessageEdit
  | WSEventMessageDelete
  | WSEventReactionAdd
  | WSEventTyping
  | WSReady
  | WSError
  | WSPing
  | WSPong;

export class RTM {
  private ws: WebSocket | null = null;
  status: WSStatus = "idle";
  private listeners: Set<(ev: WSEvent) => void> = new Set();
  private hbTimer: number | null = null;

  on(fn: (ev: WSEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: WSEvent) {
    for (const l of this.listeners) l(ev);
  }

  async connect(): Promise<void> {
    if (!session.tokens?.access_token || !session.user) return;
    this.status = "connecting";
    let ticket: string | null = null;
    try {
      const api = makeApi();
      const res = await api.mintRtmTicket();
      ticket = res.ticket;
    } catch {
      // If ticket minting fails, we fail rather than misuse access tokens.
      this.status = "error";
      return;
    }

    // Prefer subprotocol authentication (recommended for browsers).
    const url = new URL("/rtm", session.baseUrl);
    const protocols = ["orcp", `ticket.${ticket}`];
    try {
      this.ws = new WebSocket(url.toString(), protocols);
    } catch (e) {
      // Fallback: query parameter (still a ticket, not an access token)
      url.searchParams.set("ticket", ticket!);
      try {
        this.ws = new WebSocket(url.toString());
      } catch {
        this.status = "error";
        return;
      }
    }

    this.ws.onopen = () => {
      this.status = "open";
      const hello = {
        type: "hello",
        client: { name: "orcp-client-web", version: "0.1" },
        cursors: {},
        want: ["reactions", "typing", "presence"],
      };
      this.ws!.send(JSON.stringify(hello));
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WSEvent;
        if (data.type === "ping") {
          const pong: WSPong = { type: "pong", ts: data.ts };
          this.ws?.send(JSON.stringify(pong));
        }
        this.emit(data);
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onerror = () => {
      this.status = "error";
    };

    this.ws.onclose = () => {
      this.status = "closed";
      if (this.hbTimer !== null) clearInterval(this.hbTimer);
      this.hbTimer = null;
    };
  }

  close() {
    this.ws?.close();
  }
}

export const rtm = new RTM();
