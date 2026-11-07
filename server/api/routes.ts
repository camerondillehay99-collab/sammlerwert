import type { SqlDb } from "../db/adapter.ts";
import type { Condition, GradingCompany, Language, Variant } from "../../shared/types.ts";
import { config } from "../config.ts";
import { ApiError, badRequest, forbidden, json, notFound, num, oneOf, paymentRequired, readJson, str } from "../http.ts";
import { currentUser, planLimits, requireUser } from "../auth.ts";
import { catalogStats, catalogFacets, getCardDetail, getCardSnapshot, getSet, listSets, marketMovers, recentSales, searchCards, getCardSummaries } from "../services/catalog.ts";
import { applySubscriptionEvent, createCheckoutSession, createPortalSession, stripeConfigured, verifyWebhook } from "../billing/stripe.ts";
import { JOB_NAMES, runJob, type JobName } from "../jobs/scheduler.ts";
import { ebayConfigured } from "../ingest/ebay.ts";
import { blobStore } from "../storage.ts";
import { scanAvailable, scanImage } from "../scan.ts";
import { UI_LANGS, uiDictionary, i18nLastError } from "../i18n.ts";
import { getPopulations, refreshPsaPopulation, PopError } from "../services/population.ts";
import { resolveCert } from "../psa.ts";

import { add } from "./router.ts";
export { matchRoute, hasPath } from "./router.ts";
import { GRADERS, LANGS, VARIANTS, CONDITIONS, resolveVariant } from "./common.ts";
import { memo } from "../db/adapter.ts";
import "./auth-routes.ts";
import "./collection-routes.ts";
import "./import-routes.ts";

// ---------- meta ----------
add("GET", "/api/health", async (req, _p, db) => json({ ok: true, brand: config.brand.name, stats: await catalogStats(db), ebay: ebayConfigured(),
  ebayInsights: await memo(db, "ebay_insights", 300_000, async () => (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'ebay_insights'"))?.value ?? null),
  billing: stripeConfigured(), uploads: !!blobStore(), scan: scanAvailable(), edge: (req as Request & { cf?: { colo?: string } }).cf?.colo ?? null },
  200, { "cache-control": "public, max-age=60" }));

// ---------- UI translations (languages beyond de/en) ----------
add("GET", "/api/i18n/:lang", async (_r, p, db) => {
  const lang = String(p.lang ?? "").toLowerCase();
  if (!UI_LANGS[lang]) throw notFound("Sprache nicht verfügbar.");
  const r = await uiDictionary(db, lang);
  const error = !r.complete && !Object.keys(r.entries).length ? i18nLastError(lang) : null;
  return json({ lang, ...r, ...(error ? { error } : {}) }, 200, { "cache-control": r.complete ? "public, max-age=3600" : "no-store" });
});

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

// ---------- catalog ----------
add("GET", "/api/search", async (req, _p, db) => {
  const u = new URL(req.url);
  const q = u.searchParams.get("q") ?? "";
  const g = (k: string) => u.searchParams.get(k);
  const n = (k: string) => { const v = Number(g(k)); return g(k) != null && g(k) !== "" && Number.isFinite(v) ? v : null; };
  const ids = g("ids") ? g("ids")!.split(",").filter(Boolean).slice(0, 90) : null;
  const r = await searchCards(db, q, { setId: g("set"), limit: Number(g("limit") ?? 40), offset: Number(g("offset") ?? 0), sort: g("sort") ?? undefined,
    rarity: g("rarity"), category: g("category"), min: n("min"), max: n("max"), priced: g("priced") === "1", ids });
  return json(r, 200, { "cache-control": ids ? "private, no-store" : "public, max-age=60" });
});
add("GET", "/api/catalog/facets", async (_r, _p, db) => json(await catalogFacets(db), 200, { "cache-control": "public, max-age=3600" }));
add("GET", "/api/market/sales", async (req, _p, db) => {
  const u = new URL(req.url);
  const g = (k: string) => u.searchParams.get(k);
  const grade = g("grade") ? Number(g("grade")) : null;
  const r = await recentSales(db, { grader: g("grader"), grade: grade != null && Number.isFinite(grade) ? grade : null, condition: g("condition"), setId: g("set"), cardId: g("card"), language: g("lang"), source: g("source"), listingType: g("type"),
    graded: g("graded") === "1" ? true : g("graded") === "0" ? false : null, minPrice: g("min") ? Number(g("min")) : null, q: g("q"),
    sort: g("sort") === "price" ? "price" : "date", dir: g("dir") === "asc" ? "asc" : "desc", limit: Number(g("limit") ?? 50), offset: Number(g("offset") ?? 0) });
  return json(r, 200, { "cache-control": "public, max-age=120" });
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
add("GET", "/api/cards/:id/population", async (_r, p, db) => json({ items: await getPopulations(db, p.id!) }, 200, { "cache-control": "public, max-age=300" }));
/** Logged-in users may trigger a PSA population refresh for a card they can name a PSA cert for (one PSA call: cert → spec → pop). */
add("POST", "/api/cards/:id/population", async (req, p, db) => {
  await requireUser(db, req);
  const b = await readJson<Record<string, unknown>>(req);
  const card = (await getCardSummaries(db, [p.id!])).get(p.id!);
  if (!card) throw notFound("Karte nicht gefunden.");
  const existing = (await getPopulations(db, card.id)).find((x) => x.company === "PSA");
  const fresh = existing && Date.now() - Date.parse(existing.fetchedAt) < 86_400_000;
  if (fresh) return json({ items: await getPopulations(db, card.id), refreshed: false });
  let specId = existing?.specId ?? null;
  if (!specId && b.cert) {
    const r = await resolveCert(db, String(b.cert));
    if (!r.cert) throw badRequest("PSA kennt dieses Zertifikat nicht.");
    if (r.cert.specId == null) throw badRequest("PSA liefert für dieses Zertifikat keine Spec-ID.");
    specId = String(r.cert.specId);
    await db.run("UPDATE psa_certs SET card_id = ? WHERE cert_no = ?", [card.id, r.cert.certNo]).catch(() => {});
  }
  if (!specId) throw badRequest("Für diese Karte ist noch keine PSA-Spec bekannt – bitte eine PSA-Zertifikatsnummer der Karte angeben.");
  try { await refreshPsaPopulation(db, card.id, specId); }
  catch (e) { if (e instanceof PopError) throw new ApiError(e.status === 429 ? 429 : 502, e.message); throw e; }
  return json({ items: await getPopulations(db, card.id), refreshed: true });
});
add("GET", "/api/cards/:id/snapshot", async (_r, p, db) => {
  const snap = await getCardSnapshot(db, p.id!);
  if (!snap) throw notFound("Karte nicht gefunden.");
  return json(snap, 200, { "cache-control": "public, max-age=300" });
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
  // Where it sold and how (auction vs. Buy It Now) – the context every comp needs.
  const marketplace = oneOf(b.marketplace, ["ebay", "fanatics", "heritage", "alt", "cardmarket", "user"], "user");
  const listingType = oneOf(b.listingType, ["fixed_price", "auction", "best_offer", "unknown"], "unknown");
  await db.run(`INSERT INTO sales(card_id, language, variant, condition, grading_company, grade, price_eur, shipping_eur, sold_at, source, source_ref, listing_type, title, url, verified, reporter_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [card.id, oneOf(b.language, LANGS, "de"), await resolveVariant(db, card.id, oneOf(b.variant, VARIANTS, "normal")), b.condition ? oneOf(b.condition, CONDITIONS, "NM") : null,
    grader, grader ? num(b.grade) : null, price, num(b.shippingEur), soldAt, marketplace, `u${u.id}-${Date.now()}`, listingType, str(b.title, 200), str(b.url, 500), u.id]);
  return json(await getCardDetail(db, card.id), 201);
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
