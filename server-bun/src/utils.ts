export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function b32Random(len = 26): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[(Math.random() * alphabet.length) | 0];
  return out;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "600",
} as const;

export function json<T>(data: T, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers || {}) },
    status: init.status,
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

export function error(code: number, err: { code: string; message: string; details?: Record<string, unknown> } | string): Response {
  const payload = typeof err === "string" ? { code: "bad_request", message: err } : err;
  return json({ error: payload }, { status: code });
}

export function getBearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export function parseUrl(req: Request): URL {
  return new URL(req.url);
}

export function preflight(): Response {
  // Permissive preflight response for dev/demo
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS },
  });
}
