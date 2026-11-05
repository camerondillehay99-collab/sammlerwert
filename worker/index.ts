/**
 * Cloudflare Worker entry: D1 for data, R2 (optional) for uploads, Static Assets for the SPA, Cron Triggers for jobs.
 * wrangler.toml routes /api/* and /uploads/* here first; everything else is served from web/public with SPA fallback.
 */
import { applyEnv } from "../server/config.ts";
import { D1Db, type D1DatabaseLike } from "../server/db/d1.ts";
import { useDb } from "../server/db/index.ts";
import { handleApp } from "../server/app.ts";
import { runJob } from "../server/jobs/scheduler.ts";
import { r2Store, useBlobStore, type R2BucketLike } from "../server/storage.ts";
import { useScanProvider, workersAiProvider } from "../server/scan.ts";
import { useTextAi, warmTranslations } from "../server/i18n.ts";

export interface Env {
  DB: D1DatabaseLike;
  UPLOADS?: R2BucketLike;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  [key: string]: unknown;
}

interface ScheduledEvent { cron: string; scheduledTime: number }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }
interface CacheLike { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }

function setup(env: Env) {
  const vars: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  applyEnv({ NODE_ENV: "production", COOKIE_SECURE: "true", ...vars });
  const db = new D1Db(env.DB);
  useDb(db);
  useBlobStore(env.UPLOADS ? r2Store(env.UPLOADS) : null);
  useScanProvider(env.AI ? workersAiProvider(env.AI) : null);
  useTextAi(env.AI ?? null);
  return db;
}

/** Public, user-independent GET endpoints that may be served from the edge cache for a minute. */
const EDGE_CACHEABLE = /^\/api\/(sets(\/[^/]+)?|cards\/[^/]+(\/snapshot)?|search|market\/(movers|sales)|catalog\/facets|health|share\/[^/]+|i18n\/[^/]+)$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = setup(env);
    const url = new URL(request.url);
    const cacheable = request.method === "GET" && EDGE_CACHEABLE.test(url.pathname);
    const cache = cacheable && typeof caches !== "undefined" ? (caches as unknown as { default: CacheLike }).default : null;
    if (cache) { const hit = await cache.match(request); if (hit) return hit; }
    const res = await handleApp(request, db, console.log);
    if (!res) return env.ASSETS.fetch(request);
    if (cache && res.ok && !/no-store/.test(res.headers.get("cache-control") ?? "")) {
      const ttl = url.pathname === "/api/health" ? 60 : 120;
      res.headers.set("cache-control", `public, max-age=60, s-maxage=${ttl}`);
      ctx.waitUntil(cache.put(request, res.clone()));
    }
    return res;
  },

  /** Data jobs run in GitHub Actions (nightly.yml). The Worker cron only warms UI translations (needs the AI binding). */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = setup(env);
    if (event.cron === "23 3 * * *") { ctx.waitUntil(warmTranslations(db, console.log).catch((e) => console.error(e))); return; }
    ctx.waitUntil(runJob(db, event.cron === "*/10 * * * *" ? "catalog_completion" : "daily_refresh").catch((e) => console.error(e)));
  },
};
