// Minimal typed fetch helper. Types will be refined by generating src/types/orcp.ts
// via `npm run gen` which uses openapi-typescript against ../OAD.yaml.

export type OrcpApi = ReturnType<typeof api>;

export function api(baseUrl: string, token?: string) {
  baseUrl = baseUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: any, query?: Record<string, any>): Promise<T> {
    const url = new URL(baseUrl + path);
    if (query) Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      url.searchParams.set(k, String(v));
    });
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body && (method !== 'GET' && method !== 'HEAD') ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return undefined as unknown as T;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json() as T;
    return await res.text() as unknown as T;
  }

  return {
    baseUrl,
    get: <T=any>(path: string, query?: Record<string, any>) => request<T>('GET', path, undefined, query),
    post: <T=any>(path: string, body?: any, query?: Record<string, any>) => request<T>('POST', path, body, query),
    patch: <T=any>(path: string, body?: any, query?: Record<string, any>) => request<T>('PATCH', path, body, query),
    del: <T=any>(path: string, query?: Record<string, any>) => request<T>('DELETE', path, undefined, query),
  };
}

