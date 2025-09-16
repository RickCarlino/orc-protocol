import { serve } from "bun";
import { router } from "./router";
import { InMemoryStore } from "./store";
import { createApi } from "./routes";
import { corsPreflight, withCors } from "./util";
import { log } from "./logger";

// Simple, clean Bun server to demonstrate the spec.
// Everything is in-memory. No external runtime deps.

const store = new InMemoryStore();
const api = createApi(store);

const server = serve<{ userId?: string; token?: string; heartbeat?: any }>({
  port: Number((process.env?.PORT as string | undefined) ?? 3000),
  fetch: async (req, server) => {
    const { method } = req;
    const u = new URL(req.url);
    log.info("http", `${method} ${u.pathname}${u.search}`);
    // CORS preflight
    if (req.method.toUpperCase() === "OPTIONS") {
      log.debug("http", "OPTIONS preflight");
      return corsPreflight();
    }
    // Route HTTP requests
    const res = await router(api, req, server);
    return withCors(res);
  },
  websocket: {
    open(ws) {
      log.info("ws", `open user=${ws.data?.userId ?? "?"}`);
      api.ws.onOpen(ws);
    },
    message(ws, message) {
      log.debug("ws", `message from=${ws.data?.userId ?? "?"}`);
      api.ws.onMessage(ws, message);
    },
    close(ws) {
      log.info("ws", `close user=${ws.data?.userId ?? "?"}`);
      api.ws.onClose(ws);
    },
  },
});

console.log(`ORC demo server (Bun) listening on http://localhost:${server.port}`);
