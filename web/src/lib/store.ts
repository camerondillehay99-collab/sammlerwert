import type { Me } from "./api.ts";
import { api } from "./api.ts";

type Listener = () => void;
const listeners = new Set<Listener>();

export const state: { user: Me | null; mfa: { step: "setup" | "verify"; email: string } | null; theme: "light" | "dark"; ready: boolean } = {
  user: null,
  mfa: null,
  theme: (safeGet("sw-theme") as "light" | "dark" | null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  ready: false,
};

export function subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const l of listeners) l(); }

export function setUser(u: Me | null) { state.user = u; if (u) state.mfa = null; emit(); }
export function setMfa(m: { step: "setup" | "verify"; email: string } | null) { state.mfa = m; emit(); }
export function setTheme(t: "light" | "dark") { state.theme = t; safeSet("sw-theme", t); document.documentElement.dataset.theme = t; emit(); }

export async function loadUser() {
  try { const r = await api.me(); state.user = r.user; state.mfa = r.mfa ? { step: r.mfa, email: r.email ?? "" } : null; } catch { state.user = null; state.mfa = null; }
  state.ready = true; emit();
}

export function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
