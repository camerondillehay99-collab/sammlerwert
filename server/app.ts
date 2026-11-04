// Runtime-agnostic HTTP handling: API dispatch, private uploads, security headers.
import type { SqlDb } from "./db/adapter.ts";
import { ApiError, json } from "./http.ts";
import { hasPath, matchRoute } from "./api/routes.ts";
import { currentUser } from "./auth.ts";
import { blobStore } from "./storage.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), geolocation=()",
};

export function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  // Response headers may be immutable (static assets) – copy when needed.
  let out = res;
  try { res.headers.set("x-sw", "1"); res.headers.delete("x-sw"); } catch { out = new Response(res.body, res); }
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

/** Handle /api/* and /uploads/*. Returns null for anything else (static assets / SPA). */
export async function handleApp(req: Request, db: SqlDb, log: (m: string) => void = () => {}): Promise<Response | null> {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith("/api/")) {
      const m = matchRoute(req.method, url.pathname);
      if (!m) return withHeaders(json({ error: hasPath(url.pathname) ? "Methode nicht erlaubt." : "Nicht gefunden." }, hasPath(url.pathname) ? 405 : 404));
      return withHeaders(await m.route.handler(req, m.params, db));
    }
    if (url.pathname.startsWith("/uploads/")) return withHeaders(await serveUpload(url.pathname, req, db));
    return null;
  } catch (e) {
    if (e instanceof ApiError) return withHeaders(json({ error: e.message, code: e.code }, e.status));
    log(`ERROR ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
    return withHeaders(json({ error: "Interner Fehler." }, 500));
  }
}

async function serveUpload(pathname: string, req: Request, db: SqlDb): Promise<Response> {
  const user = await currentUser(db, req);
  const m = pathname.match(/^\/uploads\/(\d+)\/([\w.-]+)$/);
  if (!m || !user || Number(m[1]) !== user.id) return new Response("Not found", { status: 404 });
  const store = blobStore();
  const obj = store ? await store.get(`${m[1]}/${m[2]}`) : null;
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body as BodyInit, { headers: { "content-type": obj.contentType, "cache-control": "private, max-age=86400" } });
}
