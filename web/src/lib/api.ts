import type { CardDetail, CardSummary, CollectionItem, PortfolioSummary, SetSummary, User } from "../../../shared/types.ts";

export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new HttpError(res.status, data?.error ?? `Fehler ${res.status}`, data?.code);
  return data as T;
}

const cache = new Map<string, { t: number; v: unknown }>();
async function cached<T>(path: string, ttlMs = 30_000): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  const v = await call<T>("GET", path);
  cache.set(path, { t: Date.now(), v });
  return v;
}
export function invalidate(prefix = "") { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); }

export interface Movers { card: CardSummary; value: number; trend: number; nSales: number }
export type Me = User & { isAdmin?: boolean };

export const api = {
  health: () => cached<{ ok: boolean; stats: Record<string, number | string | null>; ebay: boolean; billing: boolean }>("/api/health", 60_000),
  me: () => call<{ user: Me | null }>("GET", "/api/auth/me"),
  register: (email: string, password: string, name: string) => call<{ user: Me }>("POST", "/api/auth/register", { email, password, name }),
  login: (email: string, password: string) => call<{ user: Me }>("POST", "/api/auth/login", { email, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  updateMe: (patch: { name?: string; locale?: string }) => call<{ user: Me }>("PATCH", "/api/auth/me", patch),
  search: (q: string, opts: { set?: string | null; sort?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.set) p.set("set", opts.set); if (opts.sort) p.set("sort", opts.sort); if (opts.limit) p.set("limit", String(opts.limit)); if (opts.offset) p.set("offset", String(opts.offset));
    return cached<{ items: CardSummary[]; total: number }>(`/api/search?${p}`);
  },
  sets: () => cached<{ items: SetSummary[] }>("/api/sets", 300_000),
  set: (id: string, sort = "number") => cached<{ set: SetSummary; cards: CardSummary[] }>(`/api/sets/${encodeURIComponent(id)}?sort=${sort}`, 120_000),
  card: (id: string) => cached<CardDetail>(`/api/cards/${encodeURIComponent(id)}`, 20_000),
  movers: (lang = "de") => cached<{ up: Movers[]; down: Movers[] }>(`/api/market/movers?lang=${lang}`, 120_000),
  reportSale: (cardId: string, body: Record<string, unknown>) => call<CardDetail>("POST", `/api/cards/${encodeURIComponent(cardId)}/sales`, body),
  portfolio: () => call<PortfolioSummary>("GET", "/api/portfolio"),
  items: () => call<{ items: CollectionItem[] }>("GET", "/api/items"),
  addItem: (body: Record<string, unknown>) => call<{ item: CollectionItem }>("POST", "/api/items", body),
  updateItem: (id: number, body: Record<string, unknown>) => call<{ item: CollectionItem }>("PATCH", `/api/items/${id}`, body),
  deleteItem: (id: number) => call<{ ok: true }>("DELETE", `/api/items/${id}`),
  uploadImage: (id: number, file: File) => { const fd = new FormData(); fd.append("image", file); return call<{ imagePath: string }>("POST", `/api/items/${id}/image`, fd); },
  watchlist: () => call<{ items: Array<{ id: number; cardId: string; language: string; targetPrice: number | null; card: CardSummary }> }>("GET", "/api/watchlist"),
  watch: (cardId: string, language = "de", targetPrice: number | null = null) => call<{ ok: true }>("POST", "/api/watchlist", { cardId, language, targetPrice }),
  unwatch: (id: number) => call<{ ok: true }>("DELETE", `/api/watchlist/${id}`),
  checkout: (plan: "sammler" | "pro") => call<{ url: string }>("POST", "/api/billing/checkout", { plan }),
  portal: () => call<{ url: string }>("POST", "/api/billing/portal"),
  runJob: (job: string) => call<{ job: string; detail: string }>("POST", `/api/admin/jobs/${job}`),
  jobs: () => call<{ runs: Array<Record<string, string | number | null>>; stats: Record<string, number | string | null> }>("GET", "/api/admin/jobs"),
};
