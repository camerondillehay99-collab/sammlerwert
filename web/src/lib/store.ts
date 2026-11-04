import type { Me } from "./api.ts";
import { api } from "./api.ts";

type Listener = () => void;
const listeners = new Set<Listener>();

export const state: { user: Me | null; theme: "light" | "dark"; ready: boolean } = {
  user: null,
  theme: (safeGet("sw-theme") as "light" | "dark" | null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  ready: false,
};

export function subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const l of listeners) l(); }

export function setUser(u: Me | null) { state.user = u; emit(); }
export function setTheme(t: "light" | "dark") { state.theme = t; safeSet("sw-theme", t); document.documentElement.dataset.theme = t; emit(); }

export async function loadUser() {
  try { state.user = (await api.me()).user; } catch { state.user = null; }
  state.ready = true; emit();
}

export function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
