/**
 * CompsAPI adapter – real eBay *sold* items (eBay.de and eBay.com, up to three years back) via compsapi.com.
 *
 * eBay's own sold-items API (Marketplace Insights) is closed network-wide for trading cards, so this is how
 * individual sales – title, date, price, auction / Buy It Now / Best Offer – reach the Sales page. Every sale is
 * stored once in `sales` (source ebay_de / ebay, source_ref = eBay item id + sale date), exactly as eBay's own
 * feed would be, and the comps model (profile = raw rung / grade, Sammlerwert-Wert = median of 180 days) is unchanged.
 *
 * Budget: plans are priced per request (one request = one page of up to 240 sales, 120 requests/min). A run spends
 * at most `budget` requests: first the backfill (cards never swept: full history, most valuable first), then the
 * refresh rotation (held/watched cards every 2 days, ≥ 50 € weekly, ≥ 10 € fortnightly, ≥ 2 € monthly, rest every
 * 60 days). A refresh only asks for the days since the last sweep.
 *
 * Credentials: COMPSAPI_KEY – GitHub Actions secret for the sweeps; optionally also a Worker secret for the on-demand
 * refresh from the card page. Without a key the adapter is a no-op.
 */
import type { SqlDb } from "../db/adapter.ts";
import { runBatches, stmt } from "../db/adapter.ts";
import { config } from "../config.ts";
import { nowIso } from "../db/index.ts";
import { classifyListing, type CardLike } from "./listing-classifier.ts";
import { sleep } from "./http.ts";
import { loadFx, type Point } from "../pricing/history.ts";

export const COMPS_BASE = "https://api.compsapi.com";
export const PAGE_SIZE = 240;
export type CompsSite = "US" | "UK" | "DE" | "FR" | "IT" | "ES" | "CA" | "AU";

export interface CompsItem {
  item_id: string | number; title: string; url?: string | null; image?: string | null;
  last_sold: string; price: number; units_sold?: number; native_price?: number | null; native_currency?: string | null;
  format?: "FIXED_PRICE" | "AUCTION" | string; bids?: number | null; best_offer?: boolean | null; shipping_cost?: number | null;
  us_sale?: boolean; condition?: string | null;
  card?: { graded?: boolean; grader?: string | null; grade?: number | string | null; grade_label?: string | null; card_number?: string | null; year?: number | null; language?: string | null; first_edition?: boolean | null; flags?: string[]; condition?: string | null } | null;
  flags?: string[];
}
export interface CompsResponse {
  ok: boolean; query: string; page: number; count: number; count_before_filters?: number; no_results?: boolean; next_page?: number | null;
  days?: number; size?: number; cached?: boolean; plan_limit?: { days_requested: number; days_served: number; plan: string }; items: CompsItem[];
  error?: string;
}

export class CompsError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export function compsConfigured() { return !!config.comps.apiKey; }

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>;

export interface SoldQuery { q: string; site: CompsSite; days?: number; start?: string; end?: string; page?: number; size?: number }

/** One page of sold items. 429 with Retry-After is waited out once; 503 retried once; quota_reached and auth errors throw. */
export async function fetchSold(p: SoldQuery, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<CompsResponse> {
  const qs = new URLSearchParams({ q: p.q, site: p.site, size: String(p.size ?? PAGE_SIZE), page: String(p.page ?? 1), native_price: "1", cards: "1", exclude: "junk,sealed" });
  if (p.start) { qs.set("start", p.start); if (p.end) qs.set("end", p.end); } else qs.set("days", String(Math.max(1, Math.min(1095, p.days ?? 90))));
  const url = `${COMPS_BASE}/v1/sold?${qs}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { "x-api-key": config.comps.apiKey, "user-agent": config.ingest.userAgent, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 200) {
      const json = (await res.json()) as CompsResponse;
      if (json.ok === false) throw new CompsError(200, "api_error", `CompsAPI: ${json.error ?? "unknown error"}`);
      return json;
    }
    const body = await res.text();
    let code = `http_${res.status}`;
    try { const e = (JSON.parse(body) as { error?: string; code?: string }); code = e.code ?? (typeof e.error === "string" ? e.error.toLowerCase().replace(/\W+/g, "_").slice(0, 40) : code); } catch { /* plain text */ }
    const quota = res.status === 429 && /quota/i.test(body);
    if (res.status === 429 && !quota && attempt === 0) { await sleep(Math.min(65_000, (Number(res.headers.get("retry-after")) || 15) * 1000)); continue; }
    if (res.status === 503 && attempt === 0) { await sleep(3000); continue; }
    throw new CompsError(res.status, quota ? "quota_reached" : code, `CompsAPI ${res.status} ${code}: ${body.slice(0, 200)}`);
  }
}

/**
 * Search texts per site. German collectors trade German, English and Japanese copies alike, so eBay.de is asked for
 * the German *and* the English name (Japanese copies are listed under the English name with "japanese/japanisch" –
 * the title classifier tags them jp); eBay.com for the English name. The number with the set total pins the card.
 */
export function compsQueries(card: CardLike, site: CompsSite): string[] {
  const num = card.localId.replace(/^0+/, "");
  const number = card.setTotal && /^\d+$/.test(num) ? `${num}/${card.setTotal}` : num;
  const names = site === "DE" ? [card.nameDe, card.nameEn] : [card.nameEn, card.nameDe];
  const out: string[] = [];
  for (const name of names) { const q = `${name ?? ""} ${number}`.trim().slice(0, 300); if (name && !out.includes(q)) out.push(q); }
  return out.length ? out : [number];
}
/** First (primary) query for a site – kept for callers that need one string. */
export function buildCompsQuery(card: CardLike, site: CompsSite): string { return compsQueries(card, site)[0]!; }

export interface SaleRowInput {
  language: string; variant: string; condition: string | null; gradingCompany: string | null; grade: number | null;
  priceEur: number; shippingEur: number | null; soldAt: string; source: "ebay_de" | "ebay"; sourceRef: string;
  listingType: "fixed_price" | "auction" | "best_offer"; title: string; url: string | null;
}

/** Sale type as shown in comps: auction, Buy It Now, or an accepted Best Offer (price = the accepted offer). */
export function compsListingType(it: Pick<CompsItem, "format" | "best_offer" | "bids">): SaleRowInput["listingType"] {
  if (it.format === "AUCTION" || (it.format == null && (it.bids ?? 0) > 0)) return "auction";
  return it.best_offer ? "best_offer" : "fixed_price";
}

const DROP_FLAGS = new Set(["lot", "mystery", "sealed", "accessory", "replica", "keyword_stuffing", "title_missing", "not_graded_claim"]);
const GRADERS = new Set(["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "GSG", "AP", "GRAAD"]);
const LANGS: Record<string, string> = { en: "en", de: "de", ja: "jp", jp: "jp", fr: "other", it: "other", es: "other", pt: "other", ko: "other", zh: "other" };
const CONDS: Record<string, string> = { nm: "NM", lp: "LP", mp: "MP", hp: "HP", dmg: "DMG" };

/** Convert one sold item into a `sales` row, or null when it is not a clean single-card sale of this card. */
export function toSaleRow(it: CompsItem, card: CardLike, site: CompsSite, fx: Point[]): SaleRowInput | null {
  const flags = [...(it.flags ?? []), ...(it.card?.flags ?? [])];
  if (flags.some((f) => DROP_FLAGS.has(f))) return null;
  const f = classifyListing(it.title ?? "", card);
  if (!f.matchesCard || f.isLot || f.isJunk) return null;
  // Language: CompsAPI's card parser first, then our title classifier, then the site's market language.
  let language: string | null = LANGS[(it.card?.language ?? "").toLowerCase()] ?? null;
  if (!language) { language = f.language; if (!language || f.languageConfidence < 0.75) language = site === "DE" ? "de" : site === "US" || site === "UK" || site === "CA" || site === "AU" ? "en" : "other"; }
  const soldAt = String(it.last_sold ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(soldAt)) return null;
  // Price: the native EUR amount for eBay.de, otherwise USD at the day's ECB rate.
  let priceEur: number | null = null, rate = 1;
  if (it.native_currency === "EUR" && typeof it.native_price === "number" && it.native_price > 0) priceEur = it.native_price;
  else if (typeof it.price === "number" && it.price > 0) { const r = fxAt(fx, soldAt); if (r == null) return null; rate = r; priceEur = it.price * r; }
  if (priceEur == null) return null;
  const grader = it.card?.graded && it.card.grader && GRADERS.has(it.card.grader.toUpperCase()) ? it.card.grader.toUpperCase() : f.gradingCompany;
  const grade = grader ? (it.card?.grade != null && Number.isFinite(Number(it.card.grade)) ? Number(it.card.grade) : f.grade) : null;
  const condition = grader ? null : CONDS[(it.card?.condition ?? "").toLowerCase()] ?? mapCondition(it.condition);
  const ship = it.shipping_cost;
  return {
    language, variant: it.card?.first_edition ? "firstEdition" : f.variant, condition, gradingCompany: grader, grade: grader ? grade : null,
    priceEur: round2(priceEur), shippingEur: typeof ship === "number" && ship >= 0 ? round2(ship * rate) : null, soldAt,
    source: site === "DE" ? "ebay_de" : "ebay", sourceRef: `${it.item_id}:${soldAt}`,
    listingType: compsListingType(it), title: String(it.title).slice(0, 200), url: it.url ?? null,
  };
}

/** USD→EUR at the sale date (last known rate on or before it; the ECB series has no weekend points). */
export function fxAt(fx: Point[], date: string): number | null {
  let best: number | null = null;
  for (const [d, v] of fx) { if (d <= date) best = v; else break; }
  return best;
}

function round2(n: number) { return Math.round(n * 100) / 100; }
function mapCondition(c?: string | null): string | null {
  if (!c) return null;
  const s = c.toLowerCase();
  if (s.includes("neu") || s.includes("new") || s.includes("mint")) return "NM";
  if (s.includes("gebraucht") || s.includes("used") || s.includes("pre-owned") || s.includes("good")) return "GD";
  return null;
}

export function saleInsert(cardId: string, r: SaleRowInput) {
  return stmt(`INSERT OR IGNORE INTO sales(card_id, language, variant, condition, grading_company, grade, price_eur, shipping_eur, sold_at, source, source_ref, listing_type, title, url, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, cardId, r.language, r.variant, r.condition, r.gradingCompany, r.grade, r.priceEur, r.shippingEur, r.soldAt, r.source, r.sourceRef, r.listingType, r.title, r.url);
}

export interface CompsCard { id: string; local_id: string; name_de: string | null; name_en: string | null; card_count_official: number | null; held: number; value: number; last_at: string | null; backfilled: number }

/**
 * Cards whose sold comps are due, most important first: never-swept cards (full history) ordered by held, then
 * value; then refreshes by priority (held/watched every 2 days, ≥ 50 € weekly, ≥ 10 € fortnightly, ≥ 2 € monthly,
 * the rest every 60 days).
 */
export async function dueCompsCards(db: SqlDb, limit: number): Promise<CompsCard[]> {
  return db.all<CompsCard>(`
    WITH guide AS (SELECT id_product, COALESCE(trend, avg7, avg30, avg) AS v FROM cm_price_guide WHERE date = (SELECT value FROM meta WHERE key = 'cm_guide_date')),
         held AS (SELECT card_id FROM collection_items UNION SELECT card_id FROM watchlist),
         due AS (
           SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official, r.last_at, COALESCE(r.backfilled, 0) AS backfilled, COALESCE(g.v, 0) AS value, (h.card_id IS NOT NULL) AS held,
                  CASE WHEN h.card_id IS NOT NULL THEN 2 WHEN g.v >= 50 THEN 7 WHEN g.v >= 10 THEN 14 WHEN g.v >= 2 THEN 30 ELSE 60 END AS interval_days,
                  s.release_date
           FROM cards c JOIN sets s ON s.id = c.set_id
           LEFT JOIN comps_refresh r ON r.card_id = c.id
           LEFT JOIN guide g ON g.id_product = c.cm_product_id
           LEFT JOIN held h ON h.card_id = c.id)
    SELECT id, local_id, name_de, name_en, card_count_official, held, value, last_at, backfilled FROM due
    WHERE backfilled = 0 OR julianday('now') - julianday(last_at) >= interval_days
    ORDER BY (backfilled = 0) DESC, held DESC, value DESC, release_date DESC, (julianday('now') - julianday(COALESCE(last_at, '2000-01-01'))) / interval_days DESC
    LIMIT ?`, [limit]);
}

export interface CompsRunStats { cards: number; requests: number; sales: number; skipped: number; backfilled: number; errors: number; stopped: string | null; planDays: number | null }

/**
 * Sweep: due cards (or the given ids) → per site one or more pages → `sales` rows. A never-swept card gets its full
 * history (all pages, newest first); a swept card only the days since its last sweep. Stops at the request budget,
 * the time budget, a quota/auth error or after repeated failures. Writes `comps_status` to meta for /api/health.
 */
export async function runCompsIngest(db: SqlDb, opts: { budget?: number; budgetMs?: number; cardIds?: string[]; fetchImpl?: FetchLike; sites?: CompsSite[] } = {}, log: (m: string) => void = () => {}): Promise<CompsRunStats> {
  const stats: CompsRunStats = { cards: 0, requests: 0, sales: 0, skipped: 0, backfilled: 0, errors: 0, stopped: null, planDays: null };
  if (!compsConfigured()) { log("Verkäufe (CompsAPI): kein API-Key – übersprungen"); return stats; }
  const budget = opts.budget ?? config.comps.dailyRequests;
  const deadline = Date.now() + (opts.budgetMs ?? 6 * 3_600_000);
  const sites = (opts.sites ?? config.comps.sites) as CompsSite[];
  const fx = await loadFx(db);
  const cards = opts.cardIds?.length
    ? await db.all<CompsCard>(`SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official, 1 AS held, 0 AS value, r.last_at, COALESCE(r.backfilled, 0) AS backfilled FROM cards c JOIN sets s ON s.id = c.set_id LEFT JOIN comps_refresh r ON r.card_id = c.id WHERE c.id IN (${opts.cardIds.slice(0, 50).map(() => "?").join(",")})`, opts.cardIds.slice(0, 50))
    : await dueCompsCards(db, Math.max(1, Math.ceil(budget / (sites.length + 1))));
  log(`Verkäufe (CompsAPI): ${cards.length} Karten fällig, Budget ${budget} Requests, Sites ${sites.join("+")}`);
  let writes = [];
  let consecutiveErrors = 0;
  const today = nowIso().slice(0, 10);
  for (const c of cards) {
    if (stats.requests + sites.length + 1 > budget) { stats.stopped = "budget"; break; }
    if (Date.now() > deadline) { stats.stopped = "time"; break; }
    const cardLike: CardLike = { nameDe: c.name_de, nameEn: c.name_en, localId: c.local_id, setTotal: c.card_count_official };
    const full = !c.backfilled;
    // Refresh window: days since the last sweep plus slack (eBay's sold date lags a little); full history for the backfill.
    const days = full ? config.comps.historyDays : Math.max(3, Math.min(1095, Math.ceil((Date.now() - Date.parse(c.last_at ?? "")) / 86_400_000) + 2));
    let n = 0, err: string | null = null, complete = true;
    stats.cards++;
    try {
      sweep: for (const site of sites) {
        for (const q of compsQueries(cardLike, site)) {
          for (let page = 1; page <= 200; page++) {
            if (stats.requests >= budget) { complete = false; stats.stopped = "budget"; break sweep; }
            const res = await fetchSold({ q, site, days, page }, opts.fetchImpl);
            stats.requests++;
            if (res.plan_limit?.days_served) stats.planDays = res.plan_limit.days_served;
            for (const it of res.items ?? []) {
              const row = toSaleRow(it, cardLike, site, fx);
              if (!row) { stats.skipped++; continue; }
              writes.push(saleInsert(c.id, row)); n++;
            }
            if (!res.next_page || !(res.items?.length)) break;
            await sleep(config.ingest.requestDelayMs);
          }
          await sleep(config.ingest.requestDelayMs);
        }
      }
      consecutiveErrors = 0;
    } catch (e) {
      stats.errors++; consecutiveErrors++; complete = false;
      err = (e as Error).message.slice(0, 200);
      log(`Verkäufe Fehler für ${c.id}: ${err}`);
      if (e instanceof CompsError && (e.code === "quota_reached" || e.status === 401 || e.status === 403)) { stats.stopped = e.code; }
      else if (e instanceof CompsError && e.status === 429) stats.stopped = "rate_limited";
      else if (consecutiveErrors >= 5) stats.stopped = "errors";
    }
    const backfilled = c.backfilled || (full && complete) ? 1 : 0;
    if (full && complete) stats.backfilled++;
    // A partial sweep keeps the old last_at so the next run repeats the window; a complete one moves it to now.
    if (complete || !c.last_at) writes.push(stmt("INSERT INTO comps_refresh(card_id, last_at, sales, error, backfilled) VALUES (?, ?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET last_at = excluded.last_at, sales = excluded.sales, error = excluded.error, backfilled = MAX(comps_refresh.backfilled, excluded.backfilled)",
      c.id, complete ? nowIso() : c.last_at ?? `${today}T00:00:00Z`, n, err, backfilled));
    else writes.push(stmt("UPDATE comps_refresh SET error = ? WHERE card_id = ?", err, c.id));
    stats.sales += n;
    if (writes.length >= 300) { await runBatches(db, writes); writes = []; }
    if (stats.stopped) break;
  }
  await runBatches(db, writes);
  await db.run("INSERT INTO meta(key, value) VALUES ('comps_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ at: nowIso(), ...stats })]).catch(() => {});
  return stats;
}

/** How many cards still await their first (full-history) sweep. */
export async function compsBacklog(db: SqlDb): Promise<number> {
  return (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards c LEFT JOIN comps_refresh r ON r.card_id = c.id WHERE COALESCE(r.backfilled, 0) = 0"))?.n ?? 0;
}

/** Card page: refresh one card's comps now (logged-in users), rate-limited per card (2 days) and per day (requests). */
export async function refreshCardComps(db: SqlDb, cardId: string, log?: (m: string) => void): Promise<{ refreshed: boolean; reason?: string; sales?: number }> {
  if (!compsConfigured()) return { refreshed: false, reason: "not_configured" };
  const last = await db.first<{ last_at: string; backfilled: number }>("SELECT last_at, backfilled FROM comps_refresh WHERE card_id = ?", [cardId]);
  if (last?.backfilled && Date.now() - Date.parse(last.last_at) < 2 * 86_400_000) return { refreshed: false, reason: "fresh" };
  const key = `comps_ondemand_${nowIso().slice(0, 10)}`;
  const used = Number((await db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? 0);
  const worst = (config.comps.sites.length + 1) * 3; // up to three queries, three pages each, for a never-swept chase card
  if (used + worst > config.comps.onDemandDailyRequests) return { refreshed: false, reason: "budget" };
  const s = await runCompsIngest(db, { cardIds: [cardId], budget: worst, budgetMs: 25_000 }, log);
  await db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(used + Math.max(s.requests, 1))]).catch(() => {});
  if (s.stopped && s.stopped !== "budget" && s.stopped !== "time") return { refreshed: false, reason: s.stopped };
  return { refreshed: true, sales: s.sales };
}
