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
let cached: Token | null = null;

function apiBase() { return config.ebay.env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"; }

export function ebayConfigured() { return !!(config.ebay.clientId && config.ebay.clientSecret); }

export async function getAppToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const basic = btoa(`${config.ebay.clientId}:${config.ebay.clientSecret}`);
  const res = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  if (!res.ok) throw new Error(`eBay token failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.value;
}

async function ebayGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await getAppToken();
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
  if (res.status === 429) { await sleep(5000); throw new Error("eBay rate limited"); }
  if (!res.ok) throw new Error(`eBay ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

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
  });
  return json.itemSales ?? [];
}

export interface EbayRunStats { cards: number; listings: number; sales: number; skipped: number; errors: number }

interface CardRow { id: string; local_id: string; name_de: string | null; name_en: string | null; card_count_official: number | null }

/**
 * Refresh eBay data for a batch of cards. Prioritises cards that are in collections / watchlists and
 * whose data is oldest. Each call is bounded by config.ebay.maxCardsPerRun to respect rate limits.
 */
export async function runEbayIngest(db: SqlDb, cardIds?: string[], log: (m: string) => void = () => {}): Promise<EbayRunStats> {
  const stats: EbayRunStats = { cards: 0, listings: 0, sales: 0, skipped: 0, errors: 0 };
  if (!ebayConfigured()) { log("eBay: keine Zugangsdaten konfiguriert – übersprungen"); return stats; }

  const cards = cardIds?.length
    ? await db.all<CardRow>(`SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id IN (${cardIds.slice(0, 90).map(() => "?").join(",")})`, cardIds.slice(0, 90))
    : await db.all<CardRow>(`
        SELECT c.id, c.local_id, c.name_de, c.name_en, s.card_count_official FROM cards c JOIN sets s ON s.id = c.set_id
        WHERE c.id IN (SELECT card_id FROM collection_items UNION SELECT card_id FROM watchlist)
           OR c.cm_product_id IN (SELECT id_product FROM cm_price_guide WHERE date = (SELECT MAX(date) FROM cm_price_guide) AND COALESCE(trend, avg30, avg) >= 5)
        ORDER BY (SELECT MAX(seen_at) FROM listings l WHERE l.card_id = c.id) ASC NULLS FIRST
        LIMIT ?`, [config.ebay.maxCardsPerRun]);

  const seen = nowIso().slice(0, 13) + ":00:00Z"; // hourly bucket for listing dedupe
  const writes = [];
  for (const c of cards) {
    stats.cards++;
    const cardLike = { nameDe: c.name_de, nameEn: c.name_en, localId: c.local_id, setTotal: c.card_count_official };
    const q = buildQuery(cardLike);
    try {
      const active = await searchActive(q);
      for (const it of active) {
        const f = classifyListing(it.title, cardLike);
        if (!f.matchesCard || f.isLot || f.isJunk || !f.language || f.languageConfidence < 0.75 || f.gradingCompany) { stats.skipped++; continue; }
        const price = Number(it.price?.value);
        if (!Number.isFinite(price) || it.price?.currency !== "EUR") continue;
        writes.push(stmt(`INSERT OR IGNORE INTO listings(card_id, language, variant, condition, price_eur, seen_at, source, source_ref, title, url) VALUES (?, ?, ?, ?, ?, ?, 'ebay_de', ?, ?, ?)`,
          c.id, f.language, f.variant, mapCondition(it.condition), price, seen, it.itemId, it.title, it.itemWebUrl ?? null));
        stats.listings++;
      }
      if (config.ebay.insightsEnabled) {
        const sold = await searchSold(q);
        for (const it of sold) {
          const f = classifyListing(it.title, cardLike);
          if (!f.matchesCard || f.isLot || f.isJunk || !f.language || f.languageConfidence < 0.75) { stats.skipped++; continue; }
          const price = Number(it.lastSoldPrice?.value);
          if (!Number.isFinite(price) || it.lastSoldPrice?.currency !== "EUR" || !it.lastSoldDate) continue;
          writes.push(stmt(`INSERT OR IGNORE INTO sales(card_id, language, variant, condition, grading_company, grade, price_eur, shipping_eur, sold_at, source, source_ref, title, url, verified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ebay_de', ?, ?, ?, 1)`, c.id, f.language, f.variant, mapCondition(it.condition), f.gradingCompany, f.grade, price, null, it.lastSoldDate, `${it.itemId}:${it.lastSoldDate}`, it.title, it.itemWebUrl ?? null));
          stats.sales++;
        }
      }
    } catch (e) {
      stats.errors++;
      log(`eBay Fehler für ${c.id}: ${(e as Error).message}`);
      if (stats.errors > 10) break;
    }
    await sleep(250);
  }
  await runBatches(db, writes);
  return stats;
}

function mapCondition(c?: string): string | null {
  if (!c) return null;
  const s = c.toLowerCase();
  if (s.includes("neu") || s.includes("new") || s.includes("mint")) return "NM";
  if (s.includes("gebraucht") || s.includes("used") || s.includes("good")) return "GD";
  return null;
}
