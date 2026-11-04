/**
 * Compute-on-read pricing. Nothing is pre-stored per card; a quote is built from
 *   cm_price_guide (daily snapshots, only products linked to cards) · sales · listings · language_factors
 * for exactly the cards a request needs. Pure math lives in engine.ts; this file only gathers inputs.
 * Designed for D1's free tier: reads are cheap (5M rows/day), writes are scarce (100k rows/day).
 */
import type { SqlDb } from "../db/adapter.ts";
import { chunks, placeholders } from "../db/adapter.ts";
import type { Language, PriceQuote, PricePoint, Variant } from "../../shared/types.ts";
import { computeQuote, guideAnchor, primaryVariant, type GuideInput, type ListingInput, type SaleInput } from "./engine.ts";
import { nowIso } from "../db/index.ts";

export interface CardForQuote { id: string; set_id: string; cm_product_id: number | null; variants: string | null }
export interface GuideRow { id_product: number; date: string; trend: number | null; avg: number | null; avg1: number | null; avg7: number | null; avg30: number | null; low: number | null;
  foil_trend: number | null; foil_avg: number | null; foil_avg1: number | null; foil_avg7: number | null; foil_avg30: number | null; foil_low: number | null }

export function guideForVariant(g: GuideRow | undefined, variant: Variant): GuideInput | null {
  if (!g) return null;
  if (variant === "reverse") {
    if (g.foil_trend == null && g.foil_avg == null && g.foil_avg7 == null && g.foil_avg30 == null) return null;
    return { trend: g.foil_trend, avg: g.foil_avg, avg1: g.foil_avg1, avg7: g.foil_avg7, avg30: g.foil_avg30, low: g.foil_low };
  }
  if (variant === "firstEdition" || variant === "promo") return null;
  return { trend: g.trend, avg: g.avg, avg1: g.avg1, avg7: g.avg7, avg30: g.avg30, low: g.low };
}

export function variantsOf(c: CardForQuote): Set<Variant> {
  const v = c.variants ? (JSON.parse(c.variants) as Record<string, boolean>) : {};
  const out = new Set<Variant>(["normal"]);
  if (v.reverse) out.add("reverse");
  if (v.holo && !v.normal) { out.delete("normal"); out.add("holo"); }
  if (v.firstEdition) out.add("firstEdition");
  return out;
}

export type QuoteMap = Map<string, PriceQuote>; // key: cardId|language|variant, plus cardId|language|* for the primary variant

export interface QuoteBundle { quotes: QuoteMap; guideByProduct: Map<number, GuideRow>; guideDate: string | null }

/** Build quotes for a set of cards (all variants, given languages + any language with sales). */
export async function quoteCards(db: SqlDb, cards: CardForQuote[], languages: Language[] = ["de", "en"]): Promise<QuoteBundle> {
  const quotes: QuoteMap = new Map();
  const guideByProduct = new Map<number, GuideRow>();
  if (!cards.length) return { quotes, guideByProduct, guideDate: null };
  const guideDate = (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'cm_guide_date'"))?.value ?? null;
  const productIds = [...new Set(cards.map((c) => c.cm_product_id).filter((p): p is number => p != null))];
  const ids = cards.map((c) => c.id);

  // Latest guide rows + the rows from ~7 and ~30 days ago (for trends), in one query per chunk.
  const past7 = new Map<number, GuideRow>(), past30 = new Map<number, GuideRow>();
  if (guideDate && productIds.length) {
    for (const ch of chunks(productIds, 90)) {
      const rows: GuideRow[] = await db.all<GuideRow>(`SELECT * FROM cm_price_guide WHERE id_product IN (${placeholders(ch.length)}) AND date IN (
          ?, (SELECT MAX(date) FROM cm_price_guide WHERE date <= date(?, '-7 days')), (SELECT MAX(date) FROM cm_price_guide WHERE date <= date(?, '-30 days')))`,
        [...ch, guideDate, guideDate, guideDate]);
      for (const r of rows) {
        if (r.date === guideDate) guideByProduct.set(r.id_product, r);
        else { const d = daysBetween(r.date, guideDate); if (d >= 25) past30.set(r.id_product, r); else if (d >= 5) past7.set(r.id_product, r); }
      }
    }
  }
  type SRow = { card_id: string; language: string; variant: string; price_eur: number; sold_at: string; condition: string | null; verified: number; source: string };
  const salesBy = new Map<string, SaleInput[]>();
  type LRow = { card_id: string; language: string; variant: string; price_eur: number; seen_at: string; condition: string | null };
  const listingsBy = new Map<string, ListingInput[]>();
  for (const ch of chunks(ids, 90)) {
    for (const s of await db.all<SRow>(`SELECT card_id, language, variant, price_eur, sold_at, condition, verified, source FROM sales WHERE grade IS NULL AND sold_at >= date('now', '-120 days') AND card_id IN (${placeholders(ch.length)})`, ch)) {
      const k = `${s.card_id}|${s.language}|${s.variant}`;
      (salesBy.get(k) ?? salesBy.set(k, []).get(k)!).push({ price: s.price_eur, soldAt: s.sold_at, condition: s.condition, verified: !!s.verified, source: s.source });
    }
    for (const l of await db.all<LRow>(`SELECT card_id, language, variant, price_eur, seen_at, condition FROM listings WHERE seen_at >= date('now', '-14 days') AND card_id IN (${placeholders(ch.length)})`, ch)) {
      const k = `${l.card_id}|${l.language}|${l.variant}`;
      (listingsBy.get(k) ?? listingsBy.set(k, []).get(k)!).push({ price: l.price_eur, seenAt: l.seen_at, condition: l.condition });
    }
  }
  const factors = await loadFactors(db, [...new Set(cards.map((c) => c.set_id))]);

  const now = nowIso();
  for (const c of cards) {
    const variants = variantsOf(c);
    const langs = new Set<string>(languages);
    for (const k of [...salesBy.keys(), ...listingsBy.keys()]) if (k.startsWith(c.id + "|")) { const [, l, v] = k.split("|"); langs.add(l!); variants.add(v as Variant); }
    const g = c.cm_product_id != null ? guideByProduct.get(c.cm_product_id) : undefined;
    const primary = primaryVariant(variants);
    for (const lang of langs) {
      const f = factors.get(`${c.set_id}|${lang}`) ?? factors.get(`*|${lang}`) ?? { value: 1, n: 0 };
      for (const variant of variants) {
        const key = `${c.id}|${lang}|${variant}`;
        const gi = guideForVariant(g, variant);
        const sales = salesBy.get(key) ?? [], listings = listingsBy.get(key) ?? [];
        if (!gi && !sales.length && !listings.length) continue;
        const p7 = guideAnchor(guideForVariant(c.cm_product_id != null ? past7.get(c.cm_product_id) : undefined, variant));
        const p30 = guideAnchor(guideForVariant(c.cm_product_id != null ? past30.get(c.cm_product_id) : undefined, variant));
        const q = computeQuote({ cardId: c.id, language: lang as Language, variant, sales, listings, guide: gi, factor: f, past7: p7 != null ? p7 * f.value : null, past30: p30 != null ? p30 * f.value : null, now });
        if (q.value == null) continue;
        quotes.set(key, q);
        if (variant === primary) quotes.set(`${c.id}|${lang}|*`, q);
      }
    }
  }
  return { quotes, guideByProduct, guideDate };
}

export async function loadFactors(db: SqlDb, setIds: string[]): Promise<Map<string, { value: number; n: number }>> {
  const out = new Map<string, { value: number; n: number }>();
  const want = [...new Set([...setIds, "*"])];
  for (const ch of chunks(want, 95)) {
    for (const r of await db.all<{ set_id: string; language: string; factor: number; n: number }>(`SELECT set_id, language, factor, n FROM language_factors WHERE set_id IN (${placeholders(ch.length)})`, ch)) {
      out.set(`${r.set_id}|${r.language}`, { value: r.factor, n: r.n });
    }
  }
  return out;
}

/** Price history for one card: guide snapshots × language factor (DE) plus the raw guide reference line. */
export async function cardHistory(db: SqlDb, card: CardForQuote, language: Language = "de"): Promise<PricePoint[]> {
  if (card.cm_product_id == null) return [];
  const rows = await db.all<GuideRow>("SELECT * FROM cm_price_guide WHERE id_product = ? ORDER BY date", [card.cm_product_id]);
  const f = (await loadFactors(db, [card.set_id])).get(`${card.set_id}|${language}`)?.value ?? 1;
  const variant = primaryVariant(variantsOf(card));
  const out: PricePoint[] = [];
  for (const r of rows) {
    const v = guideAnchor(guideForVariant(r, variant));
    if (v == null) continue;
    out.push({ date: r.date, value: Math.round(v * f * 100) / 100, language, variant });
    out.push({ date: r.date, value: v, source: "cardmarket" });
  }
  return out;
}

function daysBetween(a: string, b: string) { return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000); }
