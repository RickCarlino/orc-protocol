import { apiResponse, json, notFound, parseJsonBody, withAuth } from "./util";
import type { Api } from "./routes";
import { log } from "./logger";

type RouteHandler = (req: Request, params: Record<string, string>, server: Server) => Promise<Response> | Response;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: RouteHandler };

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys };
}

export async function router(api: Api, req: Request, server: Server): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  const routes: Route[] = [
    { ...R("GET", "/meta/capabilities", api.meta.capabilities) },

    // Auth
    { ...R("POST", "/auth/guest", api.auth.guest) },

    // Users
    { ...R("GET", "/users/me", withAuth(api.users.me)) },
    { ...R("PATCH", "/users/me", withAuth(api.users.patchMe)) },

    // Rooms directory and CRUD
    { ...R("GET", "/directory/rooms", withAuth(api.rooms.directory)) },
    { ...R("GET", "/rooms", withAuth(api.rooms.mine)) },
    { ...R("POST", "/rooms", withAuth(api.rooms.create)) },
    { ...R("GET", "/rooms/:room_name", withAuth(api.rooms.get)) },
    { ...R("PATCH", "/rooms/:room_name", withAuth(api.rooms.patch)) },

    // Messages
    { ...R("GET", "/rooms/:room_name/messages", withAuth(api.messages.forward)) },
    { ...R("GET", "/rooms/:room_name/messages/backfill", withAuth(api.messages.backfill)) },
    { ...R("POST", "/rooms/:room_name/messages", withAuth(api.messages.post)) },
    { ...R("POST", "/rooms/:room_name/ack", withAuth(api.messages.ack)) },
    { ...R("GET", "/rooms/:room_name/cursor", withAuth(api.messages.cursor)) },

    // Real-time
    { ...R("POST", "/rtm/ticket", withAuth(api.rtm.ticket)) },

    // WebSocket endpoint handled by server.upgrade in util
  ];

  // WebSocket upgrade: /rtm
  if (pathname === "/rtm") {
    const upgraded = api.rtm.upgrade(req, server);
    if (upgraded) {
      log.info("rtm", "upgrade OK");
      return new Response(null, { status: 101 });
    }
    const hdrs = Object.fromEntries(Array.from(req.headers.entries()));
    log.warn("rtm", "upgrade failed", { url: req.url, headers: hdrs });
    return json(400, { error: { code: "bad_request", message: "upgrade failed" } });
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
    log.debug("route", `${method} ${pathname} -> handler`, { params });
    return r.handler(req, params, server);
  }

  log.warn("http", `not found ${method} ${pathname}`);
  return notFound();

  function R(method: string, path: string, handler: RouteHandler): Route {
    const { pattern, keys } = compile(path);
    return { method, pattern, keys, handler };
  }
}
