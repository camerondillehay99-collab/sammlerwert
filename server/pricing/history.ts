/**
 * Price history – the backbone collectors compare against.
 *
 * Storage: one packed row per (card, source, variant) in `price_series`:
 *   points = "YYYYMMDD:price;YYYYMMDD:price;…"  (ascending, one point per day, source currency)
 * A card page therefore reads 1–3 rows instead of a thousand, and the nightly append is a single
 * string concatenation per row (no read-modify-write). Cardmarket's own daily guide stays in
 * cm_price_guide (14 columns we need elsewhere); it is turned into series on read.
 *
 * Sources
 *   tcgplayer   – TCGplayer market price (English cards, USD) from TCGCSV's daily archives since 2024-02-08
 *   cardmarket  – Cardmarket trend (all languages, EUR), from our own daily guide import
 *   sammlerwert – our German market value: Cardmarket trend × learned language factor (EUR)
 */
import type { SqlDb } from "../db/adapter.ts";
import { memo } from "../db/adapter.ts";
import type { Language, PriceSeries, Variant } from "../../shared/types.ts";
import { guideAnchor, primaryVariant } from "./engine.ts";
import { guideForVariant, loadFactors, variantsOf, type CardForQuote, type GuideRow } from "./quotes.ts";

export type Point = [date: string, value: number]; // date = YYYY-MM-DD

const compact = (date: string) => date.replace(/-/g, "").slice(0, 8);
const expand = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fmtPrice = (v: number) => (Math.round(v * 100) / 100).toString();

/** "20240208:12.5;20240209:12.7" → [["2024-02-08", 12.5], …] (invalid pieces are skipped). */
export function parsePacked(s: string | null | undefined): Point[] {
  if (!s) return [];
  const out: Point[] = [];
  for (const part of s.split(";")) {
    const i = part.indexOf(":");
    if (i !== 8) continue;
    const v = Number(part.slice(i + 1));
    if (!Number.isFinite(v)) continue;
    out.push([expand(part.slice(0, 8)), v]);
  }
  return out;
}

/** Sorted, de-duplicated (last value per day wins) packed string. */
export function packPoints(points: Iterable<Point>): string {
  const byDay = new Map<string, number>();
  for (const [d, v] of points) if (Number.isFinite(v) && v > 0) byDay.set(compact(d), v);
  return [...byDay].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([d, v]) => `${d}:${fmtPrice(v)}`).join(";");
}

export function mergePacked(existing: string | null | undefined, incoming: string | null | undefined): string {
  if (!existing) return incoming ?? "";
  if (!incoming) return existing;
  return packPoints([...parsePacked(existing), ...parsePacked(incoming)]);
}

export const packedPoint = (date: string, value: number) => `${compact(date)}:${fmtPrice(value)}`;
export const lastDateOf = (packed: string) => { const i = packed.lastIndexOf(";"); return packed ? expand(packed.slice(i + 1, i + 9)) : null; };

/** Keep at most `max` points, always including the first and last one. */
export function downsample(points: Point[], max: number): Point[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/** Points on/after a date. */
export const since = (points: Point[], date: string) => points.filter((p) => p[0] >= date);

/** Latest rate at or before a date (ECB publishes on business days only). */
export function fxLookup(rates: Point[]): (date: string) => number | null {
  const sorted = [...rates].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return (date: string) => {
    let lo = 0, hi = sorted.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid]![0] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 ? sorted[best]![1] : sorted[0]?.[1] ?? null;
  };
}

export function convert(points: Point[], rate: (date: string) => number | null): Point[] {
  const out: Point[] = [];
  for (const [d, v] of points) { const r = rate(d); if (r) out.push([d, Math.round(v * r * 100) / 100]); }
  return out;
}

// ---------------------------------------------------------------------------------------------

export const FX_KEY = "fx_usd_eur"; // meta: packed "YYYYMMDD:rate"

/** USD→EUR daily rates from meta (memoised; the nightly job refreshes them). */
export async function loadFx(db: SqlDb): Promise<Point[]> {
  return memo(db, "fx_usd_eur", 3_600_000, async () => parsePacked((await db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [FX_KEY]))?.value));
}

export interface SeriesRow { source: string; variant: string; currency: string; points: string }

export function tcgVariantLabel(v: Variant): string {
  return ({ normal: "Normal", reverse: "Reverse Holo", holo: "Holo", firstEdition: "1. Edition", promo: "Promo" } as Record<string, string>)[v] ?? v;
}

/**
 * Every series we can draw for a card, all in EUR:
 *   sammlerwert|de|<primary>  · cardmarket|all|<normal/reverse> · tcgplayer|en|<variant>
 */
export async function cardSeries(db: SqlDb, card: CardForQuote, language: Language = "de"): Promise<PriceSeries[]> {
  const out: PriceSeries[] = [];
  const primary = primaryVariant(variantsOf(card));
  const [rows, guide, fx, factors] = await Promise.all([
    db.all<SeriesRow>("SELECT source, variant, currency, points FROM price_series WHERE card_id = ?", [card.id]).catch(() => [] as SeriesRow[]),
    card.cm_product_id != null ? db.all<GuideRow>("SELECT * FROM cm_price_guide WHERE id_product = ? ORDER BY date", [card.cm_product_id]) : Promise.resolve([] as GuideRow[]),
    loadFx(db),
    loadFactors(db, [card.set_id]),
  ]);
  const factor = factors.get(`${card.set_id}|${language}`)?.value ?? factors.get(`*|${language}`)?.value ?? 1;

  if (guide.length) {
    for (const variant of ["normal", "reverse"] as Variant[]) {
      const pts: Point[] = [];
      for (const g of guide) { const v = guideAnchor(guideForVariant(g, variant)); if (v != null && v > 0) pts.push([g.date, v]); }
      if (!pts.length) continue;
      const v = variant === "normal" ? primary : variant;
      if (v === primary) out.push({ key: `sammlerwert|de|${v}`, source: "sammlerwert", label: "Marktwert Deutsch", language: "de", variant: v, currency: "EUR", points: pts.map(([d, x]) => [d, Math.round(x * factor * 100) / 100]) });
      out.push({ key: `cardmarket|all|${v}`, source: "cardmarket", label: `Cardmarket Trend · ${tcgVariantLabel(v)}`, language: "all", variant: v, currency: "EUR", points: pts });
    }
  }
  const rate = fxLookup(fx);
  for (const r of rows) {
    if (r.source !== "tcgplayer") continue;
    const raw = parsePacked(r.points);
    const pts = r.currency === "USD" ? convert(raw, rate) : raw;
    if (pts.length) out.push({ key: `tcgplayer|en|${r.variant}`, source: "tcgplayer", label: `TCGplayer Marktpreis · ${tcgVariantLabel(r.variant as Variant)} (EN)`, language: "en", variant: r.variant as Variant, currency: "EUR", points: pts });
  }
  return out;
}

export interface Snapshot {
  cardId: string; source: PriceSeries["source"]; label: string; currency: "EUR";
  value: number | null; prev: number | null; change: number | null;           // last point, the one before, relative change
  change30: number | null; change1y: number | null;
  low1y: number | null; high1y: number | null; n: number; first: string | null; last: string | null;
  spark: Point[];                                                             // ≤ 60 points, last 12 months
  recent: Array<{ date: string; value: number; source: string }>;             // newest first
}

/** The hover-card summary: one series (the richest), compressed. */
export function snapshotFrom(cardId: string, series: PriceSeries[]): Snapshot {
  const pick = [...series].sort((a, b) => rank(a) - rank(b) || b.points.length - a.points.length)[0];
  const empty: Snapshot = { cardId, source: "sammlerwert", label: "", currency: "EUR", value: null, prev: null, change: null, change30: null, change1y: null, low1y: null, high1y: null, n: 0, first: null, last: null, spark: [], recent: [] };
  if (!pick || !pick.points.length) return empty;
  const pts = pick.points;
  const last = pts[pts.length - 1]!, prev = pts[pts.length - 2] ?? null;
  const yearAgo = shift(last[0], -365), monthAgo = shift(last[0], -30);
  const year = since(pts, yearAgo);
  const at = (date: string) => { let v: number | null = null; for (const p of pts) { if (p[0] <= date) v = p[1]; else break; } return v; };
  const v30 = at(monthAgo), v1y = at(yearAgo);
  const vals = year.map((p) => p[1]);
  return {
    cardId, source: pick.source, label: pick.label, currency: "EUR",
    value: last[1], prev: prev?.[1] ?? null, change: prev && prev[1] ? last[1] / prev[1] - 1 : null,
    change30: v30 ? last[1] / v30 - 1 : null, change1y: v1y ? last[1] / v1y - 1 : null,
    low1y: vals.length ? Math.min(...vals) : null, high1y: vals.length ? Math.max(...vals) : null,
    n: pts.length, first: pts[0]![0], last: last[0],
    spark: downsample(year.length >= 2 ? year : pts, 60),
    recent: pts.slice(-5).reverse().map(([date, value]) => ({ date, value, source: pick.source })),
  };
}
const rank = (s: PriceSeries) => (s.source === "tcgplayer" && s.points.length >= 30 ? 0 : s.source === "sammlerwert" ? 1 : s.source === "tcgplayer" ? 2 : 3);
function shift(date: string, days: number): string { return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10); }
