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

export interface Env {
  DB: D1DatabaseLike;
  UPLOADS?: R2BucketLike;
  ASSETS: { fetch(req: Request): Promise<Response> };
  [key: string]: unknown;
}

interface ScheduledEvent { cron: string; scheduledTime: number }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }

function setup(env: Env) {
  const vars: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  applyEnv({ NODE_ENV: "production", COOKIE_SECURE: "true", ...vars });
  const db = new D1Db(env.DB);
  useDb(db);
  useBlobStore(env.UPLOADS ? r2Store(env.UPLOADS) : null);
  return db;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = setup(env);
    const res = await handleApp(request, db, console.log);
    if (res) return res;
    return env.ASSETS.fetch(request);
  },

  /** Cron is intentionally unused on the free tier (10 ms CPU); data jobs run in GitHub Actions. Kept for paid setups. */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = setup(env);
    ctx.waitUntil(runJob(db, event.cron === "*/10 * * * *" ? "catalog_completion" : "daily_refresh").catch((e) => console.error(e)));
  },
};
