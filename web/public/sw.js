// Sammlerwert service worker.
//   app shell + hashed assets: cache-first (immutable)
//   catalogue API (sets, cards, search, market, i18n): stale-while-revalidate – instant from cache, refreshed in the background
//   everything else under /api: network-first with cache fallback when offline
//   card images: cache-first, capped
const VERSION = "sw-v3";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];
const CATALOG = /^\/api\/(sets(\/[^/]+)?|cards\/[^/]+|search|market\/movers|health|i18n\/[^/]+)/;
const IMG_LIMIT = 600;

self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![VERSION, "img-v2", "api-v2"].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isFresh = (res, maxAgeS) => { const d = res.headers.get("date"); return !d || Date.now() - new Date(d).getTime() < maxAgeS * 1000; };

async function staleWhileRevalidate(req, cacheName, maxAgeS) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const refresh = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  if (hit && isFresh(hit, maxAgeS)) { refresh.catch(() => {}); return hit; }
  return (await refresh) ?? hit ?? new Response(JSON.stringify({ error: "Offline" }), { status: 503, headers: { "content-type": "application/json" } });
}

async function networkFirst(req, cacheName) {
  try {
    const r = await fetch(req);
    if (r.ok) caches.open(cacheName).then((c) => c.put(req, r.clone()));
    return r;
  } catch {
    const m = await caches.match(req);
    return m ?? new Response(JSON.stringify({ error: "Offline" }), { status: 503, headers: { "content-type": "application/json" } });
  }
}

async function cacheFirst(req, cacheName, limit) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) { c.put(req, r.clone()); if (limit) trim(c, limit); }
  return r;
}
let trimming = false;
async function trim(c, limit) {
  if (trimming) return; trimming = true;
  try { const keys = await c.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await c.delete(k); } finally { trimming = false; }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/assets/")) { e.respondWith(cacheFirst(req, VERSION)); return; }
    if (url.pathname.startsWith("/api/")) {
      if (CATALOG.test(url.pathname)) e.respondWith(staleWhileRevalidate(req, "api-v2", 600));
      else if (!url.pathname.startsWith("/api/auth/")) e.respondWith(networkFirst(req, "api-v2"));
      return;
    }
    if (req.mode === "navigate") { e.respondWith(fetch(req).catch(() => caches.match("/"))); return; }
    return;
  }
  if (url.origin === "https://assets.tcgdex.net") { e.respondWith(cacheFirst(req, "img-v2", IMG_LIMIT)); }
});
