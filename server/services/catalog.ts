import { gradedValues } from "../pricing/engine.ts";
import type { SqlDb } from "../db/adapter.ts";
import { chunks, placeholders } from "../db/adapter.ts";
import type { CardDetail, CardSummary, CardmarketGuidePoint, Language, PriceQuote, SaleRecord, SetSummary, Variant } from "../../shared/types.ts";
import { jsonOr } from "../db/index.ts";
import { cardHistory, quoteCards, type CardForQuote, type QuoteMap } from "../pricing/quotes.ts";

/**
 * List query: joins today's guide row (for SQL-side sorting by value/trend) and the German language factor.
 * Exact quotes (with sales, confidence …) are computed for the returned page via quoteCards().
 */
const CARD_SELECT = `
  SELECT c.id, c.set_id, s.name_de AS set_name_de, s.name_en AS set_name_en, c.local_id, c.name_de, c.name_en, c.rarity, c.category, c.image, c.image_en,
         c.cm_product_id, c.variants,
         COALESCE(g.trend, g.avg7, g.avg30, g.avg) * COALESCE(f.factor, fg.factor, 1) AS guide_value,
         CASE WHEN g.avg30 > 0 AND g.trend IS NOT NULL THEN g.trend / g.avg30 - 1 END AS guide_trend30
  FROM cards c
  JOIN sets s ON s.id = c.set_id
  LEFT JOIN cm_price_guide g ON g.id_product = c.cm_product_id AND g.date = (SELECT value FROM meta WHERE key = 'cm_guide_date')
  LEFT JOIN language_factors f ON f.set_id = c.set_id AND f.language = 'de'
  LEFT JOIN language_factors fg ON fg.set_id = '*' AND fg.language = 'de'`;

interface CardRow extends CardForQuote { set_name_de: string | null; set_name_en: string | null; local_id: string; name_de: string | null; name_en: string | null; rarity: string | null; category: string | null; image: string | null; image_en: string | null; guide_value: number | null; guide_trend30: number | null }

function rowToSummary(r: CardRow, quotes?: QuoteMap): CardSummary {
  const de = quotes?.get(`${r.id}|de|*`), en = quotes?.get(`${r.id}|en|*`);
  return {
    id: r.id, setId: r.set_id, setNameDe: r.set_name_de, setNameEn: r.set_name_en, localId: r.local_id, nameDe: r.name_de, nameEn: r.name_en,
    rarity: r.rarity, category: r.category, image: r.image, imageEn: r.image_en,
    valueDe: de?.value ?? (r.guide_value != null ? Math.round(r.guide_value * 100) / 100 : null), valueEn: en?.value ?? null,
    confidenceDe: de?.confidence ?? null, trend30: de?.trend30 ?? r.guide_trend30 ?? null,
  };
}

async function summaries(db: SqlDb, rows: CardRow[], withQuotes = true): Promise<CardSummary[]> {
  const { quotes } = withQuotes ? await quoteCards(db, rows) : { quotes: undefined };
  return rows.map((r) => rowToSummary(r, quotes));
}

let ftsReadyCache: { at: number; ready: boolean } | null = null;
async function ftsReady(db: SqlDb): Promise<boolean> {
  if (ftsReadyCache?.ready || (ftsReadyCache && Date.now() - ftsReadyCache.at < 60_000)) return ftsReadyCache.ready;
  const ready = ((await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards_fts"))?.n ?? 0) > 0;
  ftsReadyCache = { at: Date.now(), ready };
  return ready;
}

/** Build an FTS5 prefix query from free text: "glurak 199" → "glurak"* "199"* */
export function ftsQuery(q: string): string {
  const tokens = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"*`).join(" ");
}

export async function searchCards(db: SqlDb, q: string, opts: { setId?: string | null; limit?: number; offset?: number; sort?: string; withQuotes?: boolean } = {}): Promise<{ items: CardSummary[]; total: number }> {
  const limit = Math.min(opts.limit ?? 40, 400), offset = opts.offset ?? 0;
  const where: string[] = [], params: (string | number)[] = [];
  const fq = q.trim() ? ftsQuery(q) : "";
  const numMatch = q.trim().match(/^#?(\d{1,3})(?:\/\d{1,3})?$/);
  if (numMatch) { where.push("c.local_id = ?"); params.push(String(Number(numMatch[1]))); }
  else if (fq) {
    if (await ftsReady(db)) { where.push("c.id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)"); params.push(fq); }
    else { // bootstrap fallback (index not built yet): substring match on names
      const like = `%${q.trim().toLowerCase()}%`;
      where.push("(LOWER(c.name_de) LIKE ? OR LOWER(c.name_en) LIKE ?)"); params.push(like, like);
    }
  }
  if (opts.setId) { where.push("c.set_id = ?"); params.push(opts.setId); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = ({
    value: "guide_value DESC NULLS LAST", name: "c.name_de COLLATE NOCASE", number: "CAST(c.local_id AS INTEGER), c.local_id",
    newest: "s.release_date DESC, CAST(c.local_id AS INTEGER)", trend: "guide_trend30 DESC NULLS LAST",
    relevance: "(guide_value IS NULL), s.release_date DESC, CAST(c.local_id AS INTEGER)",
  } as Record<string, string>)[opts.sort ?? "relevance"] ?? "s.release_date DESC";
  const rows = await db.all<CardRow>(`${CARD_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const total = (await db.first<{ n: number }>(`SELECT COUNT(*) n FROM cards c ${whereSql}`, params))?.n ?? 0;
  return { items: await summaries(db, rows, opts.withQuotes ?? rows.length <= 60), total };
}

export async function getCardSummaries(db: SqlDb, ids: string[]): Promise<Map<string, CardSummary>> {
  const out = new Map<string, CardSummary>();
  const rows: CardRow[] = [];
  for (const chunk of chunks([...new Set(ids)], 90)) rows.push(...(await db.all<CardRow>(`${CARD_SELECT} WHERE c.id IN (${placeholders(chunk.length)})`, chunk)));
  for (const s of await summaries(db, rows)) out.set(s.id, s);
  return out;
}

/** Quotes for arbitrary card ids (used by portfolio). */
export async function quotesFor(db: SqlDb, ids: string[]): Promise<QuoteMap> {
  const rows: CardForQuote[] = [];
  for (const chunk of chunks([...new Set(ids)], 95)) rows.push(...(await db.all<CardForQuote>(`SELECT id, set_id, cm_product_id, variants FROM cards WHERE id IN (${placeholders(chunk.length)})`, chunk)));
  return (await quoteCards(db, rows)).quotes;
}

export async function getCardDetail(db: SqlDb, id: string): Promise<CardDetail | null> {
  const row = await db.first<CardRow>(`${CARD_SELECT} WHERE c.id = ?`, [id]);
  if (!row) return null;
  const extra = (await db.first<{ hp: number | null; types: string | null; dex_ids: string | null; illustrator: string | null; cm_match_method: string | null; cm_match_confidence: number | null }>(
    "SELECT hp, types, dex_ids, illustrator, cm_match_method, cm_match_confidence FROM cards WHERE id = ?", [id]))!;
  const { quotes, guideByProduct } = await quoteCards(db, [row]);
  const prices: PriceQuote[] = [...new Map([...quotes].filter(([k]) => !k.endsWith("|*")).map(([k, q]) => [k, q])).values()].sort((a, b) => a.language.localeCompare(b.language) || a.variant.localeCompare(b.variant));
  const g = row.cm_product_id != null ? guideByProduct.get(row.cm_product_id) : undefined;
  const guide: CardmarketGuidePoint | null = g ? { date: g.date, avg: g.avg, low: g.low, trend: g.trend, avg1: g.avg1, avg7: g.avg7, avg30: g.avg30,
    foilAvg: g.foil_avg, foilLow: g.foil_low, foilTrend: g.foil_trend, foilAvg1: g.foil_avg1, foilAvg7: g.foil_avg7, foilAvg30: g.foil_avg30 } : null;
  const base = rowToSummary(row, quotes);
  const sales = await getSales(db, id, 100);
  const raw = quotes.get(`${id}|de|*`)?.value ?? quotes.get(`${id}|en|*`)?.value ?? null;
  const graded = gradedValues(sales.filter((s) => s.gradingCompany && s.grade != null).map((s) => ({ price: s.priceEur, soldAt: s.soldAt, company: s.gradingCompany!, grade: s.grade!, verified: s.verified })), raw);
  return {
    ...base,
    hp: extra.hp, types: jsonOr(extra.types, []), dexIds: jsonOr(extra.dex_ids, []), illustrator: extra.illustrator, variants: jsonOr(row.variants, {}),
    cmProductId: row.cm_product_id, cmMatchMethod: extra.cm_match_method, cmMatchConfidence: extra.cm_match_confidence,
    cmUrl: row.cm_product_id != null ? cardmarketSearchUrl(base.nameEn ?? base.nameDe ?? "") : null,
    prices, guide, history: await cardHistory(db, row), sales, graded,
  };
}

/** Cardmarket does not expose product URLs in the public files; a search deep-link with the German language filter is the next best thing. */
export function cardmarketSearchUrl(name: string): string {
  return `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(name)}&language=3`;
}

interface SaleRow { id: number; card_id: string; language: string; variant: string; condition: string | null; grading_company: string | null; grade: number | null; price_eur: number; shipping_eur: number | null; sold_at: string; source: string; title: string | null; url: string | null; verified: number }
export async function getSales(db: SqlDb, cardId: string, limit = 50): Promise<SaleRecord[]> {
  return (await db.all<SaleRow>("SELECT * FROM sales WHERE card_id = ? ORDER BY sold_at DESC LIMIT ?", [cardId, limit])).map((s) => ({
    id: s.id, cardId: s.card_id, language: s.language as Language, variant: s.variant as Variant, condition: s.condition as SaleRecord["condition"],
    gradingCompany: s.grading_company as SaleRecord["gradingCompany"], grade: s.grade, priceEur: s.price_eur, shippingEur: s.shipping_eur, soldAt: s.sold_at,
    source: s.source as SaleRecord["source"], title: s.title, url: s.url, verified: !!s.verified,
  }));
}

interface SetRow { id: string; series_id: string | null; series_name: string | null; name_de: string | null; name_en: string | null; abbreviation: string | null; release_date: string | null; card_count_official: number | null; card_count_total: number | null; logo: string | null; symbol: string | null; cards_loaded: number }
export async function listSets(db: SqlDb): Promise<SetSummary[]> {
  return (await db.all<SetRow>(`SELECT s.*, se.name_de AS series_name, (SELECT COUNT(*) FROM cards c WHERE c.set_id = s.id) cards_loaded
    FROM sets s LEFT JOIN series se ON se.id = s.series_id ORDER BY s.release_date DESC NULLS LAST, s.id DESC`)).map((s) => ({
    id: s.id, seriesId: s.series_id, seriesName: s.series_name, nameDe: s.name_de, nameEn: s.name_en, abbreviation: s.abbreviation, releaseDate: s.release_date,
    cardCountOfficial: s.card_count_official, cardCountTotal: s.card_count_total, logo: s.logo, symbol: s.symbol, cardsLoaded: s.cards_loaded,
  }));
}

export async function getSet(db: SqlDb, id: string): Promise<SetSummary | null> {
  return (await listSets(db)).find((s) => s.id === id) ?? null;
}

export interface Mover { card: CardSummary; value: number; trend: number; nSales: number }
/** Movers straight from the guide (trend vs 30-day average); exact quotes are then computed for the dozen results. */
export async function marketMovers(db: SqlDb, opts: { language?: Language; direction: "up" | "down"; minValue?: number; limit?: number }): Promise<Mover[]> {
  const rows = await db.all<CardRow>(`${CARD_SELECT}
    WHERE guide_trend30 IS NOT NULL AND ABS(guide_trend30) <= 2 AND guide_value >= ? AND g.avg7 IS NOT NULL
    ORDER BY guide_trend30 ${opts.direction === "up" ? "DESC" : "ASC"} LIMIT ?`, [opts.minValue ?? 5, opts.limit ?? 12]);
  const lang = opts.language ?? "de";
  const { quotes } = await quoteCards(db, rows, [lang]);
  return rows.map((r) => { const q = quotes.get(`${r.id}|${lang}|*`); return { card: rowToSummary(r, quotes), value: q?.value ?? r.guide_value ?? 0, trend: q?.trend30 ?? r.guide_trend30 ?? 0, nSales: q?.nSales30d ?? 0 }; })
    .filter((m) => m.value > 0);
}

export async function catalogStats(db: SqlDb) {
  const r = (await db.first<Record<string, number | string | null>>(`SELECT
    (SELECT COUNT(*) FROM sets) sets, (SELECT COUNT(*) FROM cards) cards, (SELECT COUNT(*) FROM cards WHERE detail_loaded = 1) cardsDetailed,
    (SELECT COUNT(*) FROM cards WHERE cm_product_id IS NOT NULL) cardsMatched, (SELECT COUNT(*) FROM cm_products) cmProducts,
    (SELECT value FROM meta WHERE key = 'cm_guide_date') guideDate, (SELECT COUNT(DISTINCT date) FROM cm_price_guide) guideDays,
    (SELECT COUNT(*) FROM cards c WHERE EXISTS (SELECT 1 FROM cm_price_guide g WHERE g.id_product = c.cm_product_id)) quotes,
    (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM listings) listings, (SELECT COUNT(*) FROM users) users`))!;
  return r as { sets: number; cards: number; cardsDetailed: number; cardsMatched: number; cmProducts: number; guideDate: string | null; guideDays: number; quotes: number; sales: number; listings: number; users: number };
}
