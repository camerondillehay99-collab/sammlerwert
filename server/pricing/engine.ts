/**
 * Pricing engine: computes a per-card, per-language, per-variant market value ("Marktwert") with a
 * confidence score and full provenance.
 *
 * Signals, strongest first
 *   1. verified sales in that language (eBay.de sold, verified user reports)         – `sales`
 *   2. unverified user-reported sales (lower weight)                                   – `sales`
 *   3. active German listings (floor; capped influence)                                – `listings`
 *   4. Cardmarket price guide (all languages mixed) × learned language factor per set   – `cm_price_guide`
 *
 * Everything is condition-normalised to Near Mint and time-decayed (half-life ≈ 21 days).
 * The pure functions (`computeQuote`, `learnFactor`) are unit-tested; quotes.ts gathers inputs on read, `recomputeFactors` is the only writer.
 */
import type { SqlDb, SqlValue } from "../db/adapter.ts";
import { bulkInsert, runBatches } from "../db/adapter.ts";
import type { Language, PriceQuote, Variant } from "../../shared/types.ts";
import { nowIso, today } from "../db/index.ts";
import { round2, sumWeights, trimOutliers, weightedQuantile, weightedMedian, type WPoint } from "./stats.ts";

export const CONDITION_MULT: Record<string, number> = { MT: 1.05, NM: 1, EX: 0.85, GD: 0.7, LP: 0.6, PL: 0.45, PO: 0.3 };
const HALF_LIFE_DAYS = 21;
const SALES_SATURATION = 3;        // n_eff at which sales and guide weigh equally
const LISTING_MAX_WEIGHT = 0.25;   // active listings can never dominate
const FACTOR_SHRINK_K = 5;         // pseudo-observations pulling a set factor toward the global one

export interface SaleInput { price: number; soldAt: string; condition: string | null; verified: boolean; source: string }
export interface ListingInput { price: number; seenAt: string; condition: string | null }
export interface GuideInput { trend: number | null; avg: number | null; avg1: number | null; avg7: number | null; avg30: number | null; low: number | null }

export interface QuoteInput {
  cardId: string; language: Language; variant: Variant;
  sales: SaleInput[]; listings: ListingInput[]; guide: GuideInput | null;
  /** language factor for this set/language and how many observations support it */
  factor: { value: number; n: number };
  /** value 7 / 30 days ago from our own history, if any */
  past7: number | null; past30: number | null;
  now?: string;
}

export function decayWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

export function normalizeToNm(price: number, condition: string | null): number {
  return price / (CONDITION_MULT[condition ?? ""] ?? 0.95);
}

export function guideAnchor(g: GuideInput | null): number | null {
  if (!g) return null;
  // trend is Cardmarket's own smoothed estimate; fall back through averages.
  return g.trend ?? g.avg7 ?? g.avg30 ?? g.avg ?? g.avg1 ?? null;
}

export function computeQuote(input: QuoteInput): PriceQuote {
  const now = input.now ?? nowIso();
  const nowMs = new Date(now).getTime();
  const age = (iso: string) => (nowMs - new Date(iso).getTime()) / 86_400_000;

  const salePts: WPoint[] = input.sales
    .filter((s) => s.price > 0 && age(s.soldAt) <= 120)
    .map((s) => ({ v: normalizeToNm(s.price, s.condition), w: decayWeight(age(s.soldAt)) * (s.verified ? 1 : 0.5) }));
  const trimmed = trimOutliers(salePts);
  const nEff = sumWeights(trimmed);
  const salesMedian = weightedMedian(trimmed);
  const n30 = input.sales.filter((s) => age(s.soldAt) <= 30).length;
  const n90 = input.sales.filter((s) => age(s.soldAt) <= 90).length;

  const anchor = guideAnchor(input.guide);
  const guideValue = anchor != null ? anchor * input.factor.value : null;

  // Listings: only recent (≤ 14 days), use the lower quartile as a floor hint.
  const listPts: WPoint[] = input.listings
    .filter((l) => l.price > 0 && age(l.seenAt) <= 14)
    .map((l) => ({ v: normalizeToNm(l.price, l.condition), w: decayWeight(age(l.seenAt) * 2) }));
  const listingFloor = listPts.length >= 2 ? weightedQuantile(trimOutliers(listPts), 0.25) : null;

  const sources: Record<string, number> = {};
  let value: number | null = null;
  let method = "none";
  const wSales = nEff > 0 && salesMedian != null ? nEff / (nEff + SALES_SATURATION) : 0;

  if (salesMedian != null && guideValue != null) {
    value = wSales * salesMedian + (1 - wSales) * guideValue;
    sources.sales = wSales; sources.cardmarket_guide = 1 - wSales;
    method = "sales+guide";
  } else if (salesMedian != null) {
    value = salesMedian; sources.sales = 1; method = "sales_only";
  } else if (guideValue != null) {
    value = guideValue; sources.cardmarket_guide = 1;
    method = input.factor.n > 0 ? "guide×language_factor" : "guide_only";
  }

  if (value != null && listingFloor != null) {
    // Pull toward the floor a little when the market is clearly below our estimate.
    const wl = Math.min(LISTING_MAX_WEIGHT, listPts.length / 20);
    if (listingFloor < value) {
      value = (1 - wl) * value + wl * listingFloor;
      sources.listings = wl;
      for (const k of Object.keys(sources)) if (k !== "listings") sources[k] = sources[k]! * (1 - wl);
      method += "+listings";
    }
  } else if (value == null && listingFloor != null) {
    value = listingFloor; sources.listings = 1; method = "listings_only";
  }

  // Range
  let low: number | null = null, high: number | null = null;
  if (trimmed.length >= 3) {
    low = weightedQuantile(trimmed, 0.25); high = weightedQuantile(trimmed, 0.75);
  } else if (value != null && input.guide) {
    const spread = input.guide.low != null && anchor ? Math.min(0.5, Math.abs(anchor - input.guide.low) / anchor) : 0.2;
    low = value * (1 - spread); high = value * (1 + spread);
  } else if (value != null) {
    low = value * 0.8; high = value * 1.2;
  }

  // Confidence
  let confidence = 0;
  if (value != null) {
    const salesPart = 1 - Math.exp(-nEff / 4);             // 0 → ~0.9 with many recent sales
    // Guide quality: Cardmarket's trend is a real market aggregate; avg7 present ⇒ the card trades regularly.
    // A learned language factor turns the mixed-language guide into a language-specific estimate.
    const liquid = input.guide?.avg7 != null;
    const base = guideValue != null ? (input.factor.n >= 3 ? 0.62 : liquid ? 0.5 : 0.3) : 0;
    let agreement = 0.5;
    if (salesMedian != null && guideValue != null) agreement = 1 - Math.min(1, Math.abs(salesMedian / guideValue - 1));
    confidence = base + (0.95 - base) * salesPart * (0.5 + 0.5 * agreement);
    if (method === "listings_only") confidence = Math.min(confidence, 0.25);
    if (method === "sales_only" && n90 < 2) confidence = Math.min(confidence, 0.3);
  }

  // Trends: prefer own history; fall back to guide dynamics.
  let trend7: number | null = null, trend30: number | null = null;
  if (value != null) {
    if (input.past7) trend7 = value / input.past7 - 1;
    if (input.past30) trend30 = value / input.past30 - 1;
    if (trend7 == null && input.guide?.avg7 && input.guide.trend) trend7 = input.guide.trend / input.guide.avg7 - 1;
    if (trend30 == null && input.guide?.avg30 && input.guide.trend) trend30 = input.guide.trend / input.guide.avg30 - 1;
  }

  return {
    cardId: input.cardId, language: input.language, variant: input.variant,
    value: round2(value), low: round2(low), high: round2(high),
    confidence: Math.round(confidence * 100) / 100, nSales30d: n30, nSales90d: n90,
    trend7: trend7 == null ? null : Math.round(trend7 * 1000) / 1000,
    trend30: trend30 == null ? null : Math.round(trend30 * 1000) / 1000,
    sources, method, computedAt: now,
  };
}

/** Learn language factor = median(sale_NM / guide_anchor), shrunk toward `global`. */
export function learnFactor(ratios: number[], global: number): { value: number; n: number } {
  const clean = ratios.filter((r) => Number.isFinite(r) && r > 0.1 && r < 10);
  if (!clean.length) return { value: global, n: 0 };
  const med = weightedMedian(clean.map((v) => ({ v, w: 1 })))!;
  const n = clean.length;
  return { value: (n * med + FACTOR_SHRINK_K * global) / (n + FACTOR_SHRINK_K), n };
}

// ---------------------------------------------------------------------------------------------
// Database wiring – the only thing pricing writes is the (small) language_factors table.
// Quotes themselves are computed on read (see quotes.ts).
// ---------------------------------------------------------------------------------------------

export function primaryVariant(variants: Set<Variant>): Variant {
  for (const v of ["normal", "holo", "reverse", "firstEdition", "promo"] as Variant[]) if (variants.has(v)) return v;
  return "normal";
}

export interface FactorStats { sets: number; languages: string[]; sales: number; ms: number }

/** Learn language factor = median(sale_NM / guide anchor) per set and language, shrunk toward a global factor ("*"). */
export async function recomputeFactors(db: SqlDb, languages: Language[] = ["de", "en"]): Promise<FactorStats> {
  const t0 = Date.now();
  type SRow = { card_id: string; set_id: string; cm_product_id: number | null; language: string; variant: string; price_eur: number; condition: string | null };
  const sales = await db.all<SRow>(`SELECT s.card_id, c.set_id, c.cm_product_id, s.language, s.variant, s.price_eur, s.condition
    FROM sales s JOIN cards c ON c.id = s.card_id WHERE s.verified = 1 AND s.grade IS NULL AND s.sold_at >= date('now', '-120 days') AND c.cm_product_id IS NOT NULL`);
  const guideDate = (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'cm_guide_date'"))?.value;
  const ratiosBySetLang = new Map<string, number[]>();
  const globalRatios = new Map<string, number[]>();
  if (guideDate && sales.length) {
    const ids = [...new Set(sales.map((s) => s.cm_product_id!))];
    const guide = new Map<number, Record<string, number | null>>();
    for (let i = 0; i < ids.length; i += 95) {
      const ch = ids.slice(i, i + 95);
      for (const g of await db.all<Record<string, number | null> & { id_product: number }>(`SELECT * FROM cm_price_guide WHERE date = ? AND id_product IN (${ch.map(() => "?").join(",")})`, [guideDate, ...ch])) guide.set(g.id_product, g);
    }
    for (const s of sales) {
      const g = guide.get(s.cm_product_id!);
      if (!g) continue;
      const anchor = s.variant === "reverse" ? g.foil_trend ?? g.foil_avg7 ?? g.foil_avg30 ?? g.foil_avg : g.trend ?? g.avg7 ?? g.avg30 ?? g.avg;
      if (!anchor) continue;
      const r = normalizeToNm(s.price_eur, s.condition) / anchor;
      const k = `${s.set_id}|${s.language}`;
      (ratiosBySetLang.get(k) ?? ratiosBySetLang.set(k, []).get(k)!).push(r);
      (globalRatios.get(s.language) ?? globalRatios.set(s.language, []).get(s.language)!).push(r);
    }
  }
  const now = nowIso();
  const rows: SqlValue[][] = [];
  const langs = new Set<string>([...languages, ...globalRatios.keys()]);
  const globalFactor = new Map<string, number>();
  for (const lang of langs) { const f = learnFactor(globalRatios.get(lang) ?? [], 1); globalFactor.set(lang, f.value); rows.push(["*", lang, f.value, f.n, now]); }
  for (const [k, ratios] of ratiosBySetLang) {
    const [setId, lang] = k.split("|") as [string, string];
    const f = learnFactor(ratios, globalFactor.get(lang) ?? 1);
    rows.push([setId, lang, f.value, f.n, now]);
  }
  await runBatches(db, bulkInsert("language_factors", ["set_id", "language", "factor", "n", "computed_at"], rows,
    "ON CONFLICT(set_id, language) DO UPDATE SET factor = excluded.factor, n = excluded.n, computed_at = excluded.computed_at"));
  return { sets: ratiosBySetLang.size, languages: [...langs], sales: sales.length, ms: Date.now() - t0 };
}

export { today };
