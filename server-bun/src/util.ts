import type { components } from "./api/types";

export type JsonValue = any;

export function json(status: number, body: JsonValue, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function notFound(): Response {
  return json(404, { error: { code: "not_found", message: "Not found" } });
}

export async function parseJsonBody<T = any>(req: Request): Promise<T | undefined> {
  try {
    const text = await req.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function apiResponse<T>(data: T): Response {
  return json(200, data);
}

export type ErrorCode = components["schemas"]["ErrorResponse"]["error"]["code"]; // from OAD

export function error(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>): Response {
  return json(status, { error: { code, message, details } });
}

export type AuthedHandler = (ctx: { req: Request; params: Record<string, string>; userId: string }) => Promise<Response> | Response;
export type Handler = (req: Request, params: Record<string, string>, server: Server) => Promise<Response> | Response;

export function withAuth(fn: AuthedHandler): Handler {
  return async (req, params) => {
    const token = bearer(req.headers.get("authorization"));
    const userId = token ? authTokens.get(token) : undefined;
    if (!userId) return error(401, "unauthorized", "Missing or invalid token");
    return fn({ req, params, userId });
  };
}

// Simple in-proc token registry shared via module import (populated by store)
const authTokens = new Map<string, string>();
export const AuthRegistry = {
  set(token: string, userId: string) { authTokens.set(token, userId); },
  del(token: string) { authTokens.delete(token); },
  get(token: string) { return authTokens.get(token); },
};

export function bearer(h?: string | null): string | undefined {
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1];
}

// ID helpers (Base32 lower, RFC 4648 alphabet in lowercase)
const ALPH = "abcdefghijklmnopqrstuvwxyz234567";
export function newId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base32(buf);
}

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 31];
  return out;
}

export function nowIso(): string { return new Date().toISOString(); }

// --- CORS helpers (permissive for development) ---
const CORS_HEADERS_BASE = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "false",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-max-age": "86400",
} as const;

export function withCors(res: Response): Response {
  const hdrs = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS_BASE)) hdrs.set(k, v);
  return new Response(res.body, { status: res.status, headers: hdrs });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS_BASE });
}
