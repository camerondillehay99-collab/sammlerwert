/**
 * eBay.de adapter – the primary source for *German-language* sales.
 *
 *  - Browse API (item_summary/search): active listings. Available to every eBay developer account
 *    with production keys (free). We store these as `listings` (floor signal).
 *  - Marketplace Insights API (item_sales/search): sold items of the last 90 days. Limited release –
 *    apply at developer.ebay.com → "Application Growth Check" / API access request. When enabled
 *    (EBAY_INSIGHTS_ENABLED=1) we store these as `sales`, the strongest signal we have.
 *
 * All credentials come from env (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET). Without them, the adapter is a no-op
 * and the pricing engine falls back to Cardmarket guide + user-reported sales.
 */
import type { SqlDb } from "../db/adapter.ts";
import { runBatches, stmt } from "../db/adapter.ts";
import { config } from "../config.ts";
import { classifyListing } from "./listing-classifier.ts";
import { sleep } from "./http.ts";
import { nowIso } from "../db/index.ts";

const CATEGORY_CCG_SINGLES = "183454"; // Sammelkartenspiele > Einzelkarten (same id across marketplaces)

interface Token { value: string; expiresAt: number }
const cached = new Map<string, Token>();
export const SCOPE_BASE = "https://api.ebay.com/oauth/api_scope";
export const SCOPE_INSIGHTS = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

function apiBase() { return config.ebay.env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"; }

export function ebayConfigured() { return !!(config.ebay.clientId && config.ebay.clientSecret); }

export async function getAppToken(scope = SCOPE_BASE): Promise<string> {
  const hit = cached.get(scope);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
  const basic = btoa(`${config.ebay.clientId}:${config.ebay.clientSecret}`);
  const res = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!res.ok) throw new Error(`eBay token failed (${scope.split("/").pop()}): ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached.set(scope, { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

/** Marketplace Insights (sold items) is a limited-release API: the token request tells us whether eBay has enabled it for this keyset. */
export async function insightsAvailable(): Promise<{ ok: boolean; reason: string }> {
  if (config.ebay.insightsEnabled === false) return { ok: false, reason: "EBAY_INSIGHTS_ENABLED=0" };
  try { await getAppToken(SCOPE_INSIGHTS); return { ok: true, reason: "freigeschaltet" }; }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
}

async function ebayGet<T>(path: string, params: Record<string, string>, scope = SCOPE_BASE): Promise<T> {
  const token = await getAppToken(scope);
  const url = `${apiBase()}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplace,
      "Accept-Language": "de-DE",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) { await sleep(5000); throw new EbayError(429, "eBay rate limited"); }
  if (!res.ok) throw new EbayError(res.status, `eBay ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export class EbayError extends Error { constructor(public status: number, message: string) { super(message); } }

export interface EbayItemSummary {
  itemId: string; title: string; itemWebUrl?: string; condition?: string; conditionId?: string;
  price?: { value: string; currency: string }; shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
  buyingOptions?: string[]; itemEndDate?: string; itemCreationDate?: string;
}
export interface EbayItemSale {
  itemId: string; title: string; itemWebUrl?: string; condition?: string;
  lastSoldPrice?: { value: string; currency: string }; lastSoldDate?: string; totalSoldQuantity?: number;
}

export function buildQuery(card: { nameDe: string | null; nameEn: string | null; localId: string }): string {
  // German name first (it is the language signal), number without leading zeros; eBay tokenizes "199/165" fine.
  const name = card.nameDe || card.nameEn || "";
  return `${name} ${card.localId.replace(/^0+/, "")} pokemon`.trim();
}

export async function searchActive(q: string, limit = 50): Promise<EbayItemSummary[]> {
  const json = await ebayGet<{ itemSummaries?: EbayItemSummary[] }>("/buy/browse/v1/item_summary/search", {
    q, category_ids: CATEGORY_CCG_SINGLES, limit: String(limit), sort: "price",
    filter: "buyingOptions:{FIXED_PRICE|AUCTION},priceCurrency:EUR,itemLocationCountry:DE",
  });
  return json.itemSummaries ?? [];
}

export async function searchSold(q: string, limit = 50): Promise<EbayItemSale[]> {
  const json = await ebayGet<{ itemSales?: EbayItemSale[] }>("/buy/marketplace_insights/v1_beta/item_sales/search", {
    q, category_ids: CATEGORY_CCG_SINGLES, limit: String(limit), filter: "priceCurrency:EUR",
  }, SCOPE_INSIGHTS);
  return json.itemSales ?? [];
}

export interface EbayRunStats { cards: number; listings: number; sales: number; skipped: number; errors: number; insights: boolean; insightsReason: string; pruned: number }

interface CardRow { id: string; local_id: string; name_de: string | null; name_en: string | null; card_count_official: number | null; interval_days: number; value: number }

/**
 * Picks the cards whose eBay data is due. Every card gets a refresh interval from its value and whether a
 * user holds/watches it (portfolio & watchlist daily, ≥ 50 € every 3 days, ≥ 10 € weekly, ≥ 2 € fortnightly,
 * the rest monthly). Never-fetched cards come first, most valuable first, so the catalogue fills top-down.
 */
export async function dueCards(db: SqlDb, limit: number): Promise<CardRow[]> {
  return db.all<CardRow>(`
    WITH guide AS (SELECT id_product, COALESCE(trend, avg7, avg30, avg) AS v FROM cm_price_guide WHERE date = (SELECT value FROM meta WHERE key = 'cm_guide_date')),
         held AS (SELECT card_id FROM collection_items UNION SELECT card_id FROM watchlist),
         due AS (
           SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official, r.last_at, COALESCE(g.v, 0) AS value,
                  CASE WHEN h.card_id IS NOT NULL THEN 1 WHEN g.v >= 50 THEN 3 WHEN g.v >= 10 THEN 7 WHEN g.v >= 2 THEN 14 ELSE 30 END AS interval_days
           FROM cards c JOIN sets s ON s.id = c.set_id
           LEFT JOIN ebay_refresh r ON r.card_id = c.id
           LEFT JOIN guide g ON g.id_product = c.cm_product_id
           LEFT JOIN held h ON h.card_id = c.id)
    SELECT id, local_id, name_de, name_en, card_count_official, interval_days, value FROM due
    WHERE last_at IS NULL OR julianday('now') - julianday(last_at) >= interval_days
    ORDER BY (last_at IS NULL) DESC, value DESC, (julianday('now') - julianday(last_at)) / interval_days DESC
    LIMIT ?`, [limit]);
}

/**
 * Refresh eBay data for the cards that are due (see dueCards). Bounded by config.ebay.maxCardsPerRun so a night
 * stays inside eBay's default 5 000 calls/day and D1's free write budget. Sold items are stored individually
 * (`sales`, verified) – they are the backbone of the German market value; active listings only act as a floor.
 */
export async function runEbayIngest(db: SqlDb, cardIds?: string[], log: (m: string) => void = () => {}): Promise<EbayRunStats> {
  const stats: EbayRunStats = { cards: 0, listings: 0, sales: 0, skipped: 0, errors: 0, insights: false, insightsReason: "", pruned: 0 };
  if (!ebayConfigured()) { log("eBay: keine Zugangsdaten konfiguriert – übersprungen"); return stats; }
  await getAppToken(); // fail fast on bad credentials
  const ins = await insightsAvailable();
  stats.insights = ins.ok; stats.insightsReason = ins.reason;
  log(`eBay: Verkaufsdaten (Marketplace Insights) ${ins.ok ? "freigeschaltet" : `nicht verfügbar – ${ins.reason}`}`);
  await db.run("INSERT INTO meta(key, value) VALUES ('ebay_insights', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [ins.ok ? "ok" : `denied: ${ins.reason.slice(0, 160)}`]);

  const cards = cardIds?.length
    ? await db.all<CardRow>(`SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official, 1 AS interval_days, 0 AS value FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id IN (${cardIds.slice(0, 90).map(() => "?").join(",")})`, cardIds.slice(0, 90))
    : await dueCards(db, config.ebay.maxCardsPerRun);
  log(`eBay: ${cards.length} Karten fällig`);

  const seen = nowIso().slice(0, 13) + ":00:00Z"; // hourly bucket for listing dedupe
  let writes = [];
  let insightsOk = ins.ok;
  let consecutiveErrors = 0;
  for (const c of cards) {
    stats.cards++;
    const cardLike = { nameDe: c.name_de, nameEn: c.name_en, localId: c.local_id, setTotal: c.card_count_official };
    const q = buildQuery(cardLike);
    let nL = 0, nS = 0, err: string | null = null;
    try {
      const active = await searchActive(q, 40);
      const matched = [];
      for (const it of active) {
        const f = classifyListing(it.title, cardLike);
        if (!f.matchesCard || f.isLot || f.isJunk || !f.language || f.languageConfidence < 0.75 || f.gradingCompany) { stats.skipped++; continue; }
        const price = Number(it.price?.value);
        if (!Number.isFinite(price) || it.price?.currency !== "EUR") continue;
        matched.push({ it, f, price });
      }
      // The engine only uses the lower quartile of listings as a floor: keep the 10 cheapest per language.
      const byLang = new Map<string, typeof matched>();
      for (const m of matched.sort((a, b) => a.price - b.price)) { const arr = byLang.get(m.f.language!) ?? []; if (arr.length < 10) { arr.push(m); byLang.set(m.f.language!, arr); } }
      for (const arr of byLang.values()) for (const { it, f, price } of arr) {
        writes.push(stmt(`INSERT OR IGNORE INTO listings(card_id, language, variant, condition, price_eur, seen_at, source, source_ref, title, url) VALUES (?, ?, ?, ?, ?, ?, 'ebay_de', ?, ?, ?)`,
          c.id, f.language, f.variant, mapCondition(it.condition), price, seen, it.itemId, it.title, it.itemWebUrl ?? null));
        nL++;
      }
      if (insightsOk) {
        try {
          const sold = await searchSold(q, 50);
          for (const it of sold) {
            const f = classifyListing(it.title, cardLike);
            if (!f.matchesCard || f.isLot || f.isJunk || !f.language || f.languageConfidence < 0.75) { stats.skipped++; continue; }
            const price = Number(it.lastSoldPrice?.value);
            if (!Number.isFinite(price) || it.lastSoldPrice?.currency !== "EUR" || !it.lastSoldDate) continue;
            writes.push(stmt(`INSERT OR IGNORE INTO sales(card_id, language, variant, condition, grading_company, grade, price_eur, shipping_eur, sold_at, source, source_ref, title, url, verified)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ebay_de', ?, ?, ?, 1)`, c.id, f.language, f.variant, mapCondition(it.condition), f.gradingCompany, f.grade, price, null, it.lastSoldDate, `${it.itemId}:${it.lastSoldDate}`, it.title, it.itemWebUrl ?? null));
            nS++;
          }
        } catch (e) {
          if (e instanceof EbayError && (e.status === 403 || e.status === 401)) { insightsOk = false; stats.insightsReason = e.message; log(`eBay: Verkaufsdaten-API abgelehnt (${e.status}) – nur Angebote für den Rest des Laufs`); }
          else throw e;
        }
      }
      consecutiveErrors = 0;
    } catch (e) {
      stats.errors++; consecutiveErrors++;
      err = (e as Error).message.slice(0, 200);
      log(`eBay Fehler für ${c.id}: ${err}`);
      if (e instanceof EbayError && e.status === 429) { log("eBay: Tageslimit/Rate-Limit erreicht – Lauf beendet"); break; }
      if (consecutiveErrors >= 8) { log("eBay: zu viele Fehler in Folge – Lauf beendet"); break; }
    }
    writes.push(stmt("INSERT INTO ebay_refresh(card_id, last_at, listings, sales, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET last_at = excluded.last_at, listings = excluded.listings, sales = excluded.sales, error = excluded.error",
      c.id, nowIso(), nL, nS, err));
    stats.listings += nL; stats.sales += nS;
    if (writes.length >= 300) { await runBatches(db, writes); writes = []; }
    await sleep(config.ingest.requestDelayMs);
  }
  await runBatches(db, writes);
  // Listings are a short-lived floor signal; sales are kept forever.
  stats.pruned = (await db.run("DELETE FROM listings WHERE source = 'ebay_de' AND seen_at < datetime('now', '-21 days')")).changes;
  return stats;
}

function mapCondition(c?: string): string | null {
  if (!c) return null;
  const s = c.toLowerCase();
  if (s.includes("neu") || s.includes("new") || s.includes("mint")) return "NM";
  if (s.includes("gebraucht") || s.includes("used") || s.includes("good")) return "GD";
  return null;
}
