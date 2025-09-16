import type { components } from "~/api/types";

export type Tokens = { access_token: string; refresh_token?: string };
export type User = components["schemas"]["User"];

export class SessionState {
  private _baseUrl: string = localStorage.getItem("orcp.baseUrl") || "";
  private _tokens: Tokens | null = (() => {
    const raw = localStorage.getItem("orcp.tokens");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  })();
  private _user: User | null = (() => {
    const raw = localStorage.getItem("orcp.user");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  })();

  get baseUrl() { return this._baseUrl; }
  set baseUrl(url: string) {
    this._baseUrl = url.trim();
    localStorage.setItem("orcp.baseUrl", this._baseUrl);
  }

  get isAuthed() { return !!this._tokens?.access_token; }
  get tokens() { return this._tokens; }
  get user(): User | null { return this._user; }

  setAuth(tokens: Tokens, user: User) {
    this._tokens = tokens;
    this._user = user;
    localStorage.setItem("orcp.tokens", JSON.stringify(tokens));
    localStorage.setItem("orcp.user", JSON.stringify(user));
  }

  clearAuth() {
    this._tokens = null;
    this._user = null;
    localStorage.removeItem("orcp.tokens");
    localStorage.removeItem("orcp.user");
  }
}

export const session = new SessionState();
