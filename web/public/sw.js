// Sammlerwert service worker: app shell cached, API network-first with offline fallback to cache.
const VERSION = "sw-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/assets/")) { e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(e.request)) ?? fetch(e.request).then((r) => { c.put(e.request, r.clone()); return r; }))); return; }
  if (url.origin === "https://assets.tcgdex.net") { e.respondWith(caches.open("img-v1").then(async (c) => (await c.match(e.request)) ?? fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }))); return; }
  if (url.pathname.startsWith("/api/")) { e.respondWith(fetch(e.request).then((r) => { if (r.ok && !url.pathname.includes("/auth/")) caches.open("api-v1").then((c) => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request).then((m) => m ?? new Response(JSON.stringify({ error: "Offline" }), { status: 503, headers: { "content-type": "application/json" } })))); return; }
  if (e.request.mode === "navigate") { e.respondWith(fetch(e.request).catch(() => caches.match("/"))); }
});
