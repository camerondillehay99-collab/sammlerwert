import type { AuthResponse, CardDetail, CardSummary, Collection, CollectionItem, PortfolioSummary, ScanResultPublic, SetSummary, User } from "../../../shared/types.ts";

export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new HttpError(res.status, data?.error ?? `Fehler ${res.status}`, data?.code);
  }
  return data as T;
}
let onUnauthorized: (() => void) | null = null;
/** Called once when any request answers 401 (session expired while the UI still showed a user). */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

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
export type AuthResult = Omit<AuthResponse, "user"> & { user: Me | null };

export interface ImportRowPublic {
  line: number; input: Record<string, string | undefined>;
  parsed: { language: string; variant: string; condition: string; gradingCompany: string | null; grade: number | null; certNo: string | null; quantity: number; purchasePriceEur: number | null; purchasedAt: string | null; notes: string | null; collectionName: string | null };
  match: { card: CardSummary; confidence: number; reasons: string[] } | null; alternatives: CardSummary[]; status: "ok" | "unsure" | "none" | "skip"; problem?: string;
}
export interface ImportPreviewPublic { source: string; delimiter: string; columns: Record<string, string>; rows: ImportRowPublic[]; stats: { total: number; ok: number; unsure: number; none: number; skip: number }; psaLookups: number }
export interface PsaCertPublic { certNo: string; year: string | null; brand: string | null; cardNumber: string | null; subject: string | null; variety: string | null; grade: number | null; gradeText: string | null; totalPopulation: number | null; populationHigher: number | null }
export interface SharedCollection { collection: { name: string; description: string | null; owner: string }; items: Array<{ id: number; cardId: string; card: CardSummary; language: string; variant: string; condition: string; gradingCompany: string | null; grade: number | null; quantity: number; currentValue: number | null; trend30: number | null }>; totalValue: number; cardCount: number }

export const api = {
  health: () => cached<{ ok: boolean; stats: Record<string, number | string | null>; ebay: boolean; billing: boolean }>("/api/health", 60_000),
  me: () => call<AuthResult>("GET", "/api/auth/me"),
  register: (email: string, password: string, name: string) => call<AuthResult>("POST", "/api/auth/register", { email, password, name }),
  login: (email: string, password: string) => call<AuthResult>("POST", "/api/auth/login", { email, password }),
  mfaSetup: (code?: string) => call<{ secret: string; otpauth: string; email: string }>("POST", "/api/auth/2fa/setup", { code }),
  mfaEnable: (code: string) => call<{ user: Me; recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code }),
  mfaVerify: (code: string) => call<{ user: Me; usedRecovery?: boolean; recoveryCodesLeft?: number | null }>("POST", "/api/auth/2fa/verify", { code }),
  mfaRecovery: (code: string) => call<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/recovery", { code }),
  mfaStatus: () => call<{ enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }>("GET", "/api/auth/2fa/status"),
  sessions: () => call<{ sessions: Array<{ id: string; created_at: string; expires_at: string; user_agent: string | null }> }>("GET", "/api/auth/sessions"),
  revokeOtherSessions: () => call<{ ok: true }>("POST", "/api/auth/sessions/revoke-others"),
  collections: () => call<{ items: Collection[] }>("GET", "/api/collections"),
  createCollection: (body: { name: string; description?: string | null; color?: string | null }) => call<{ collection: Collection }>("POST", "/api/collections", body),
  updateCollection: (id: number, body: Record<string, unknown>) => call<{ collection: Collection }>("PATCH", `/api/collections/${id}`, body),
  deleteCollection: (id: number, withItems = false) => call<{ ok: true }>("DELETE", `/api/collections/${id}${withItems ? "?withItems=1" : ""}`),
  shareCollection: (id: number) => call<{ token: string; url: string }>("POST", `/api/collections/${id}/share`),
  unshareCollection: (id: number) => call<{ ok: true }>("DELETE", `/api/collections/${id}/share`),
  shared: (token: string) => call<SharedCollection>("GET", `/api/share/${encodeURIComponent(token)}`),
  bulkItems: (body: { action: "delete" | "move" | "update"; ids: number[]; collectionId?: number; patch?: Record<string, unknown> }) => call<{ ok: true; affected: number }>("POST", "/api/items/bulk", body),
  importCapabilities: () => cached<{ psa: boolean; sources: string[]; maxRows: number }>("/api/import/capabilities", 300_000),
  importPreview: (text: string, source?: string, defaultLanguage?: string) => call<ImportPreviewPublic>("POST", "/api/import/preview", { text, source, defaultLanguage }),
  importCommit: (body: { rows: Record<string, unknown>[]; collectionId?: number; merge?: boolean; source?: string }) => call<{ ok: true; imported: number; merged: number; skipped: number; collectionId: number }>("POST", "/api/import/commit", body),
  psaCert: (cert: string) => call<{ cert: PsaCertPublic; facts: Record<string, unknown>; best: { card: CardSummary; score: number; reasons: string[] } | null; alternatives: Array<{ card: CardSummary }> }>("POST", "/api/psa/cert", { cert }),
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
  scan: async (image: Blob): Promise<ScanResultPublic> => {
    const res = await fetch("/api/scan", { method: "POST", credentials: "same-origin", headers: { "content-type": image.type || "image/jpeg" }, body: image });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, data?.error ?? `Fehler ${res.status}`, data?.code);
    return data as ScanResultPublic;
  },
  movers: (lang = "de") => cached<{ up: Movers[]; down: Movers[] }>(`/api/market/movers?lang=${lang}`, 120_000),
  reportSale: (cardId: string, body: Record<string, unknown>) => call<CardDetail>("POST", `/api/cards/${encodeURIComponent(cardId)}/sales`, body),
  portfolio: () => call<PortfolioSummary>("GET", "/api/portfolio"),
  items: (collectionId?: number | null) => call<{ items: CollectionItem[] }>("GET", `/api/items${collectionId ? `?collection=${collectionId}` : ""}`),
  addItem: (body: Record<string, unknown>) => call<{ item: CollectionItem }>("POST", "/api/items", body),
  addItems: (body: { items: Array<Record<string, unknown>>; collectionId?: number; source?: string; merge?: boolean }) => call<{ created: number; merged: number; collectionId: number; quantity: number }>("POST", "/api/items/many", body),
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
