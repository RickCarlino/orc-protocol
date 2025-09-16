// Minimal ambient Bun-type shims to compile without bun-types

interface Server {
  port?: number;
  upgrade(req: Request, options?: { data?: any }): boolean;
}

interface ServerWebSocket<T = any> {
  data: T & { heartbeat?: any };
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

declare module "bun" {
  function serve<T = any>(options: {
    port?: number;
    fetch: (req: Request, server: Server) => Response | Promise<Response>;
    websocket?: {
      open?: (ws: ServerWebSocket<T>) => void;
      message?: (ws: ServerWebSocket<T>, message: string | Uint8Array) => void;
      close?: (ws: ServerWebSocket<T>) => void;
    };
  }): Server;
  export { serve };
}

// Minimal Node-ish globals we reference without @types/node
declare const process: { env?: Record<string, string | undefined> };
