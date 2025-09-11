import { type ErrorBody, type Id, type Timestamp } from "./types";

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // rfc4648 lowercase

export function nowTs(): Timestamp {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function base32(bytes: Uint8Array): Id {
  // RFC4648 without padding, lower case
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

export function newId128(): Id {
  return base32(randomBytes(16));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const arr = new Uint8Array(digest);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cidFor(data: Uint8Array): Promise<Id> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base32(new Uint8Array(digest));
}

export function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(obj);
  return withCors(new Response(body, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  }));
}

export function error(code: ErrorBody["error"]["code"], message: string, status = 400, details?: Record<string, unknown>): Response {
  const err: ErrorBody["error"] = { code, message } as ErrorBody["error"];
  if (details) (err as any).details = details;
  const body: ErrorBody = { error: err };
  return jsonResponse(body, { status });
}

export function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { ...res, headers: h });
}

export function noContent(status = 204): Response {
  return withCors(new Response(null, { status }));
}

export function ok<T extends object>(obj: T, status = 200): Response {
  return jsonResponse(obj, { status });
}

export function parseUrl(req: Request): URL {
  // Bun passes absolute URL
  return new URL(req.url);
}

export async function readJson<T>(req: Request): Promise<T | undefined> {
  if (!req.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    return (await req.json()) as T;
  } catch {
    return undefined;
  }
}

export function matchPath(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}
