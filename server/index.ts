// Bun entry point: local development and self-hosting (SQLite + filesystem uploads + timer-based jobs).
import { existsSync, mkdirSync } from "node:fs";
import { join, normalize, dirname, resolve } from "node:path";
import { config } from "./config.ts";
import { useDb } from "./db/index.ts";
import { openBunDb } from "./db/bun-sqlite.ts";
import { handleApp, withHeaders } from "./app.ts";
import { startScheduler } from "./jobs/scheduler.ts";
import { useBlobStore, type BlobStore } from "./storage.ts";
import { useScanProvider } from "./scan.ts";

const WEB_DIR = resolve(config.webDir);
const UPLOADS_DIR = resolve(config.uploadsDir);
const database = await openBunDb(config.dbPath);
useDb(database);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

const fsStore: BlobStore = {
  async put(key, body) { const p = join(UPLOADS_DIR, key); mkdirSync(dirname(p), { recursive: true }); await Bun.write(p, body); },
  async get(key) {
    const p = join(UPLOADS_DIR, key);
    if (!p.startsWith(UPLOADS_DIR) || !existsSync(p)) return null;
    const f = Bun.file(p);
    return { body: await f.arrayBuffer(), contentType: f.type || "application/octet-stream" };
  },
};
useBlobStore(fsStore);
// Local development has no Workers AI; SCAN_FAKE='{"name":"Glurak-ex","number":"199/165",...}' lets the scanner UI be exercised.
if (process.env.SCAN_FAKE) useScanProvider({ readCard: async () => process.env.SCAN_FAKE! });

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};

async function serveStatic(pathname: string): Promise<Response | null> {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || !Bun.file(file).size) return null;
  const ext = file.slice(file.lastIndexOf("."));
  const immutable = /\/assets\/.*\.[a-z0-9]{8,}\./.test(file) || ext === ".woff2";
  return new Response(Bun.file(file), { headers: { "content-type": STATIC_TYPES[ext] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : ext === ".html" ? "no-cache" : "public, max-age=3600" } });
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  maxRequestBodySize: 16 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const t0 = performance.now();
    const api = await handleApp(req, database, log);
    if (api) {
      if (!config.isProd) log(`${req.method} ${url.pathname} ${(performance.now() - t0).toFixed(1)}ms`);
      return api;
    }
    const file = await serveStatic(url.pathname === "/" ? "/index.html" : url.pathname);
    if (file) return withHeaders(file);
    const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || ext in STATIC_TYPES) return withHeaders(new Response("Not found", { status: 404 }));
    const index = await serveStatic("/index.html");
    return index ? withHeaders(index) : new Response("Frontend nicht gebaut – bun run build:web", { status: 503 });
  },
});

log(`${config.brand.name} läuft auf http://${server.hostname}:${server.port} (${config.isProd ? "production" : "development"})`);
if (process.env.DISABLE_SCHEDULER !== "1") startScheduler(database, config.ingest.dailyHourUtc, log);

export { server };
