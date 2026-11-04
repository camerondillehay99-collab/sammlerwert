import type { SqlDb } from "../db/adapter.ts";
import type { Condition, GradingCompany, Language, Variant } from "../../shared/types.ts";
import { config } from "../config.ts";
import { ApiError, badRequest, forbidden, json, notFound, num, oneOf, paymentRequired, readJson, str } from "../http.ts";
import { createSession, currentUser, destroySession, login, planLimits, register, requireUser } from "../auth.ts";
import { catalogStats, getCardDetail, getSet, listSets, marketMovers, searchCards, getCardSummaries } from "../services/catalog.ts";
import { defaultCollectionId, hydrate, listItems, summary } from "../services/portfolio.ts";
import { applySubscriptionEvent, createCheckoutSession, createPortalSession, stripeConfigured, verifyWebhook } from "../billing/stripe.ts";
import { JOB_NAMES, runJob, type JobName } from "../jobs/scheduler.ts";
import { ebayConfigured } from "../ingest/ebay.ts";
import { blobStore } from "../storage.ts";
import { scanAvailable, scanImage } from "../scan.ts";

type Handler = (req: Request, params: Record<string, string>, db: SqlDb) => Promise<Response> | Response;
export interface Route { method: string; pattern: string; handler: Handler; keys: string[]; re: RegExp }

const routes: Route[] = [];
function add(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^\\/]+)"; }) + "\\/?$");
  routes.push({ method, pattern, handler, keys, re });
}

/** "normal" on a card that only exists as holo (modern illustration rares, vintage holos) means the holo print. */
async function resolveVariant(db: SqlDb, cardId: string, requested: Variant): Promise<Variant> {
  const row = await db.first<{ variants: string | null }>("SELECT variants FROM cards WHERE id = ?", [cardId]);
  const v = row?.variants ? (JSON.parse(row.variants) as Record<string, boolean>) : {};
  if (requested === "normal" && v.normal === false && v.holo) return "holo";
  if (requested === "holo" && !v.holo && v.normal !== false) return "normal";
  return requested;
}

const LANGS: readonly Language[] = ["de", "en", "jp", "fr", "it", "es", "pt", "other"];
const VARIANTS: readonly Variant[] = ["normal", "reverse", "holo", "firstEdition", "promo"];
const CONDITIONS: readonly Condition[] = ["MT", "NM", "EX", "GD", "LP", "PL", "PO"];
const GRADERS: readonly GradingCompany[] = ["PSA", "BGS", "CGC", "GSG", "AP", "TAG", "ACE", "OTHER"];

// ---------- meta ----------
add("GET", "/api/health", async (_r, _p, db) => json({ ok: true, brand: config.brand.name, stats: await catalogStats(db), ebay: ebayConfigured(),
  ebayInsights: (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'ebay_insights'"))?.value ?? null, billing: stripeConfigured(), uploads: !!blobStore(), scan: scanAvailable() }));

// ---------- scanner ----------
const SCAN_MAX_BYTES = 3_000_000;
add("POST", "/api/scan", async (req, _p, db) => {
  if (!scanAvailable()) throw new ApiError(503, "Der Scanner ist in dieser Umgebung nicht aktiviert.", "scan_unavailable");
  const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw badRequest("Bitte ein JPEG-, PNG- oder WebP-Bild senden.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw badRequest("Leeres Bild.");
  if (buf.length > SCAN_MAX_BYTES) throw badRequest("Bild zu groß (max. 3 MB).");
  const user = await currentUser(db, req);
  if (user) {
    const today = new Date().toISOString().slice(0, 10);
    const n = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM scans WHERE user_id = ? AND created_at >= ?", [user.id, today]))?.n ?? 0;
    const limit = planLimits(user.plan).scansPerDay;
    if (n >= limit) throw paymentRequired(`Tageslimit von ${limit} Scans erreicht – mit Sammler oder Pro scannst du unbegrenzt.`);
  }
  try { return json(await scanImage(db, buf, mime, user?.id ?? null)); }
  catch (e) {
    // The vision model is an external dependency: surface its reason (never a stack) so a user sees why and we can fix it.
    const msg = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
    throw new ApiError(502, `Erkennung fehlgeschlagen: ${msg}`, "scan_failed");
  }
});

// ---------- auth ----------
add("POST", "/api/auth/register", async (req, _p, db) => {
  const b = await readJson<{ email?: string; password?: string; name?: string }>(req);
  const user = await register(db, String(b.email ?? ""), String(b.password ?? ""), str(b.name, 80));
  const s = await createSession(db, user.id, req.headers.get("user-agent"));
  return json({ user }, 201, { "set-cookie": s.setCookie });
});
add("POST", "/api/auth/login", async (req, _p, db) => {
  const b = await readJson<{ email?: string; password?: string }>(req);
  const user = await login(db, String(b.email ?? ""), String(b.password ?? ""));
  const s = await createSession(db, user.id, req.headers.get("user-agent"));
  return json({ user }, 200, { "set-cookie": s.setCookie });
});
add("POST", "/api/auth/logout", async (req, _p, db) => json({ ok: true }, 200, { "set-cookie": await destroySession(db, req) }));
add("GET", "/api/auth/me", async (req, _p, db) => json({ user: await currentUser(db, req) }));
add("PATCH", "/api/auth/me", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ name?: string; locale?: string }>(req);
  await db.run("UPDATE users SET name = COALESCE(?, name), locale = COALESCE(?, locale) WHERE id = ?", [str(b.name, 80), b.locale === "en" || b.locale === "de" ? b.locale : null, u.id]);
  return json({ user: await currentUser(db, req) });
});

// ---------- catalog ----------
add("GET", "/api/search", async (req, _p, db) => {
  const u = new URL(req.url);
  const q = u.searchParams.get("q") ?? "";
  const r = await searchCards(db, q, { setId: u.searchParams.get("set"), limit: Number(u.searchParams.get("limit") ?? 40), offset: Number(u.searchParams.get("offset") ?? 0), sort: u.searchParams.get("sort") ?? undefined });
  return json(r, 200, { "cache-control": "public, max-age=60" });
});
add("GET", "/api/sets", async (_r, _p, db) => json({ items: await listSets(db) }, 200, { "cache-control": "public, max-age=300" }));
add("GET", "/api/sets/:id", async (req, p, db) => {
  const set = await getSet(db, p.id!);
  if (!set) throw notFound("Set nicht gefunden.");
  const u = new URL(req.url);
  const cards = await searchCards(db, "", { setId: set.id, limit: 400, sort: u.searchParams.get("sort") ?? "number" });
  return json({ set, cards: cards.items }, 200, { "cache-control": "public, max-age=120" });
});
add("GET", "/api/cards/:id", async (_r, p, db) => {
  const card = await getCardDetail(db, p.id!);
  if (!card) throw notFound("Karte nicht gefunden.");
  return json(card, 200, { "cache-control": "public, max-age=60" });
});
add("GET", "/api/market/movers", async (req, _p, db) => {
  const u = new URL(req.url);
  const lang = oneOf(u.searchParams.get("lang"), LANGS, "de");
  return json({ up: await marketMovers(db, { language: lang, direction: "up" }), down: await marketMovers(db, { language: lang, direction: "down" }) }, 200, { "cache-control": "public, max-age=300" });
});

// ---------- sales (community reports) ----------
add("POST", "/api/cards/:id/sales", async (req, p, db) => {
  const u = await requireUser(db, req);
  const card = (await getCardSummaries(db, [p.id!])).get(p.id!);
  if (!card) throw notFound("Karte nicht gefunden.");
  const b = await readJson<Record<string, unknown>>(req);
  const price = num(b.priceEur);
  if (!price || price <= 0 || price > 1_000_000) throw badRequest("Bitte einen gültigen Verkaufspreis angeben.");
  const soldAt = str(b.soldAt, 30) ?? new Date().toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(soldAt)) || Date.parse(soldAt) > Date.now() + 86_400_000) throw badRequest("Ungültiges Datum.");
  const grader = b.gradingCompany ? oneOf(b.gradingCompany, GRADERS, "OTHER") : null;
  await db.run(`INSERT INTO sales(card_id, language, variant, condition, grading_company, grade, price_eur, shipping_eur, sold_at, source, source_ref, title, url, verified, reporter_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, 0, ?)`,
    [card.id, oneOf(b.language, LANGS, "de"), await resolveVariant(db, card.id, oneOf(b.variant, VARIANTS, "normal")), b.condition ? oneOf(b.condition, CONDITIONS, "NM") : null,
    grader, grader ? num(b.grade) : null, price, num(b.shippingEur), soldAt, `u${u.id}-${Date.now()}`, str(b.title, 200), str(b.url, 500), u.id]);
  return json(await getCardDetail(db, card.id), 201);
});

// ---------- collection ----------
add("GET", "/api/portfolio", async (req, _p, db) => json(await summary(db, (await requireUser(db, req)).id)));
add("GET", "/api/items", async (req, _p, db) => json({ items: await listItems(db, (await requireUser(db, req)).id) }));
add("POST", "/api/items", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<Record<string, unknown>>(req);
  const cardId = str(b.cardId, 40);
  if (!cardId || !(await getCardSummaries(db, [cardId])).has(cardId)) throw badRequest("Unbekannte Karte.");
  const limits = planLimits(u.plan);
  const count = (await db.first<{ n: number }>("SELECT COALESCE(SUM(i.quantity),0) n FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ?", [u.id]))!.n;
  const qty = Math.max(1, Math.min(999, Math.round(num(b.quantity) ?? 1)));
  if (count + qty > limits.items) throw paymentRequired(`Dein Tarif umfasst ${limits.items} Karten. Upgrade auf Sammler oder Pro für mehr.`);
  const grader = b.gradingCompany ? oneOf(b.gradingCompany, GRADERS, "OTHER") : null;
  const res = await db.run(`INSERT INTO collection_items(collection_id, card_id, language, variant, condition, grading_company, grade, cert_no, quantity, purchase_price_eur, purchased_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await defaultCollectionId(db, u.id), cardId, oneOf(b.language, LANGS, "de"), await resolveVariant(db, cardId, oneOf(b.variant, VARIANTS, "normal")), oneOf(b.condition, CONDITIONS, "NM"),
    grader, grader ? num(b.grade) : null, grader ? str(b.certNo, 40) : null, qty, num(b.purchasePriceEur), str(b.purchasedAt, 30), str(b.notes, 1000)]);
  const item = (await hydrate(db, [(await db.first("SELECT * FROM collection_items WHERE id = ?", [res.lastInsertRowid])) as never]))[0];
  return json({ item }, 201);
});
add("PATCH", "/api/items/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const row = await db.first<{ id: number; card_id: string }>("SELECT i.id, i.card_id FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.user_id = ?", [Number(p.id), u.id]);
  if (!row) throw notFound();
  const b = await readJson<Record<string, unknown>>(req);
  const grader = b.gradingCompany === null ? null : b.gradingCompany ? oneOf(b.gradingCompany, GRADERS, "OTHER") : undefined;
  const fields: Record<string, unknown> = {
    language: b.language !== undefined ? oneOf(b.language, LANGS, "de") : undefined,
    variant: b.variant !== undefined ? await resolveVariant(db, row.card_id, oneOf(b.variant, VARIANTS, "normal")) : undefined,
    condition: b.condition !== undefined ? oneOf(b.condition, CONDITIONS, "NM") : undefined,
    grading_company: grader, grade: grader === null ? null : b.grade !== undefined ? num(b.grade) : undefined,
    cert_no: grader === null ? null : b.certNo !== undefined ? str(b.certNo, 40) : undefined,
    quantity: b.quantity !== undefined ? Math.max(1, Math.min(999, Math.round(num(b.quantity) ?? 1))) : undefined,
    purchase_price_eur: b.purchasePriceEur !== undefined ? num(b.purchasePriceEur) : undefined,
    purchased_at: b.purchasedAt !== undefined ? str(b.purchasedAt, 30) : undefined,
    notes: b.notes !== undefined ? str(b.notes, 1000) : undefined,
  };
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (sets.length) await db.run(`UPDATE collection_items SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...sets.map(([, v]) => v as never), new Date().toISOString(), row.id]);
  return json({ item: (await hydrate(db, [(await db.first("SELECT * FROM collection_items WHERE id = ?", [row.id])) as never]))[0] });
});
add("DELETE", "/api/items/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const r = await db.run("DELETE FROM collection_items WHERE id = ? AND collection_id IN (SELECT id FROM collections WHERE user_id = ?)", [Number(p.id), u.id]);
  if (!r.changes) throw notFound();
  return json({ ok: true });
});
add("POST", "/api/items/:id/image", async (req, p, db) => {
  const u = await requireUser(db, req);
  const store = blobStore();
  if (!store) throw new ApiError(503, "Bilder-Upload ist in dieser Installation noch nicht aktiviert.", "uploads_disabled");
  const row = await db.first<{ id: number }>("SELECT i.id FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.user_id = ?", [Number(p.id), u.id]);
  if (!row) throw notFound();
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof Blob) || !file.type.startsWith("image/") || file.size > 12 * 1024 * 1024) throw badRequest("Bitte ein Bild bis 12 MB hochladen.");
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const rel = `${u.id}/${row.id}-${Date.now()}.${ext}`;
  await store.put(rel, file, file.type);
  await db.run("UPDATE collection_items SET image_path = ? WHERE id = ?", [rel, row.id]);
  return json({ imagePath: rel });
});
add("GET", "/api/export.csv", async (req, _p, db) => {
  const u = await requireUser(db, req);
  if (!planLimits(u.plan).exports) throw paymentRequired("CSV-Export ist ab dem Sammler-Tarif verfügbar.");
  const items = await listItems(db, u.id);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Karte", "Englisch", "Nummer", "Set", "Sprache", "Variante", "Zustand", "Grading", "Note", "Anzahl", "Kaufpreis", "Marktwert", "Gesamtwert", "Konfidenz", "Notizen"];
  const rows = items.map((i) => [i.card.nameDe, i.card.nameEn, i.card.localId, i.card.setNameDe, i.language, i.variant, i.condition, i.gradingCompany, i.grade, i.quantity, i.purchasePriceEur, i.currentValue, i.currentValue != null ? i.currentValue * i.quantity : null, i.quote?.confidence, i.notes].map(esc).join(";"));
  return new Response("﻿" + [head.join(";"), ...rows].join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sammlerwert-export.csv"` } });
});

// ---------- watchlist ----------
add("GET", "/api/watchlist", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const rows = await db.all<{ id: number; card_id: string; language: string; target_price: number | null }>("SELECT id, card_id, language, target_price FROM watchlist WHERE user_id = ? ORDER BY created_at DESC", [u.id]);
  const cards = await getCardSummaries(db, rows.map((r) => r.card_id));
  return json({ items: rows.map((r) => ({ id: r.id, cardId: r.card_id, language: r.language, targetPrice: r.target_price, card: cards.get(r.card_id) })) });
});
add("POST", "/api/watchlist", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<Record<string, unknown>>(req);
  const cardId = str(b.cardId, 40);
  if (!cardId || !(await getCardSummaries(db, [cardId])).has(cardId)) throw badRequest("Unbekannte Karte.");
  await db.run("INSERT INTO watchlist(user_id, card_id, language, target_price) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, card_id, language) DO UPDATE SET target_price = excluded.target_price", [u.id, cardId, oneOf(b.language, LANGS, "de"), num(b.targetPrice)]);
  return json({ ok: true }, 201);
});
add("DELETE", "/api/watchlist/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  await db.run("DELETE FROM watchlist WHERE id = ? AND user_id = ?", [Number(p.id), u.id]);
  return json({ ok: true });
});

// ---------- billing ----------
add("POST", "/api/billing/checkout", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ plan?: string }>(req);
  const plan = b.plan === "pro" ? "pro" : "sammler";
  return json({ url: await createCheckoutSession(db, u, plan) });
});
add("POST", "/api/billing/portal", async (req, _p, db) => json({ url: await createPortalSession(db, (await requireUser(db, req)).id) }));
add("POST", "/api/billing/webhook", async (req, _p, db) => {
  const payload = await req.text();
  if (!(await verifyWebhook(payload, req.headers.get("stripe-signature")))) throw new ApiError(400, "Ungültige Signatur.");
  const event = JSON.parse(payload) as { type: string; data: { object: never } };
  if (event.type.startsWith("customer.subscription.")) await applySubscriptionEvent(db, event.type, event.data.object);
  return json({ received: true });
});

// ---------- admin ----------
add("POST", "/api/admin/jobs/:job", async (req, p, db) => {
  const u = await requireUser(db, req);
  if (!u.isAdmin) throw forbidden();
  const job = p.job as JobName;
  if (!JOB_NAMES.includes(job)) throw badRequest("Unbekannter Job.");
  const detail = await runJob(db, job);
  return json({ job, detail });
});
add("GET", "/api/admin/jobs", async (req, _p, db) => {
  const u = await requireUser(db, req);
  if (!u.isAdmin) throw forbidden();
  return json({ runs: await db.all("SELECT * FROM job_runs ORDER BY id DESC LIMIT 50"), stats: await catalogStats(db) });
});

export function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { route: r, params };
  }
  return null;
}

export function hasPath(pathname: string) { return routes.some((r) => r.re.test(pathname)); }
