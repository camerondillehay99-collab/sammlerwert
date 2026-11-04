/**
 * Cardmarket public data: daily price guide + product catalogue (Pokémon = game id 6).
 *   {base}/priceGuide/price_guide_6.json · {base}/productList/products_singles_6.json · …/products_nonsingles_6.json
 *
 * Runtime-agnostic: callers hand over the parsed JSON (from a file in Bun, from fetch() in Workers).
 * The parser is tolerant about key naming (avg-holo / avgFoil / avg_holo …) so a format change can never
 * silently produce a zero-row import.
 */
import type { SqlDb, SqlValue } from "../db/adapter.ts";
import { bulkInsert, runBatches } from "../db/adapter.ts";
import { config } from "../config.ts";
import { getJson } from "./http.ts";
import { today } from "../db/index.ts";

export interface GuideRow {
  idProduct: number; idCategory: number | null;
  avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null;
  foilAvg: number | null; foilLow: number | null; foilTrend: number | null; foilAvg1: number | null; foilAvg7: number | null; foilAvg30: number | null;
}
export interface ProductRow {
  idProduct: number; name: string; idCategory: number | null; categoryName: string | null;
  idExpansion: number | null; idMetacard: number | null; dateAdded: string | null; isSingle: boolean;
}

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj) return obj[k];
  }
  // slow path: normalised comparison
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) map.set(normKey(k), v);
  for (const k of keys) { const v = map.get(normKey(k)); if (v !== undefined) return v; }
  return undefined;
}

export function parseGuideRow(raw: Record<string, unknown>): GuideRow | null {
  const idProduct = num(pick(raw, "idProduct", "productId", "id"));
  if (!idProduct) return null;
  const f = (base: string) => num(pick(raw, `${base}-holo`, `${base}-foil`, `${base}Holo`, `${base}Foil`, `${base}_holo`, `${base}_foil`, `holo${base}`, `foil${base}`));
  return {
    idProduct, idCategory: num(pick(raw, "idCategory", "categoryId")),
    avg: num(pick(raw, "avg", "average")), low: num(pick(raw, "low")), trend: num(pick(raw, "trend")),
    avg1: num(pick(raw, "avg1")), avg7: num(pick(raw, "avg7")), avg30: num(pick(raw, "avg30")),
    foilAvg: f("avg"), foilLow: f("low"), foilTrend: f("trend"), foilAvg1: f("avg1"), foilAvg7: f("avg7"), foilAvg30: f("avg30"),
  };
}

export function parseProductRow(raw: Record<string, unknown>, isSingle: boolean): ProductRow | null {
  const idProduct = num(pick(raw, "idProduct", "productId", "id"));
  const name = pick(raw, "name", "enName", "productName");
  if (!idProduct || typeof name !== "string") return null;
  return {
    idProduct, name, idCategory: num(pick(raw, "idCategory", "categoryId")), categoryName: (pick(raw, "categoryName") as string | undefined) ?? null,
    idExpansion: num(pick(raw, "idExpansion", "expansionId")), idMetacard: num(pick(raw, "idMetacard", "metacardId")),
    dateAdded: (pick(raw, "dateAdded", "releaseDate") as string | undefined) ?? null, isSingle,
  };
}

/** Accept `{priceGuides:[…]}`, `{products:[…]}`, `{data:[…]}` or a bare array. */
export function extractRows(json: unknown): { rows: Record<string, unknown>[]; createdAt: string | null } {
  if (Array.isArray(json)) return { rows: json as Record<string, unknown>[], createdAt: null };
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const createdAt = typeof o.createdAt === "string" ? o.createdAt : null;
    for (const k of ["priceGuides", "products", "data", "items", "rows"]) if (Array.isArray(o[k])) return { rows: o[k] as Record<string, unknown>[], createdAt };
    const firstArray = Object.values(o).find(Array.isArray) as Record<string, unknown>[] | undefined;
    if (firstArray) return { rows: firstArray, createdAt };
  }
  return { rows: [], createdAt: null };
}

export function cardmarketUrls() {
  const g = config.ingest.cardmarketGameId, b = config.ingest.cardmarketBase;
  return { guide: `${b}/priceGuide/price_guide_${g}.json`, singles: `${b}/productList/products_singles_${g}.json`, nonsingles: `${b}/productList/products_nonsingles_${g}.json` };
}

export const PRODUCT_COLS = ["id_product", "name", "id_category", "category_name", "id_expansion", "id_metacard", "date_added", "is_single"];
const PRODUCT_CONFLICT = `ON CONFLICT(id_product) DO UPDATE SET name = excluded.name, id_category = excluded.id_category, category_name = excluded.category_name,
  id_expansion = excluded.id_expansion, id_metacard = excluded.id_metacard, date_added = COALESCE(excluded.date_added, cm_products.date_added), is_single = excluded.is_single`;

/** Import a product catalogue file (singles or non-singles). Returns rows imported. */
export async function importProducts(db: SqlDb, json: unknown, isSingle: boolean): Promise<number> {
  const { rows } = extractRows(json);
  const values: SqlValue[][] = [];
  for (const raw of rows) {
    const r = parseProductRow(raw, isSingle);
    if (r) values.push([r.idProduct, r.name, r.idCategory, r.categoryName, r.idExpansion, r.idMetacard, r.dateAdded, r.isSingle ? 1 : 0]);
  }
  await runBatches(db, bulkInsert("cm_products", PRODUCT_COLS, values, PRODUCT_CONFLICT));
  return values.length;
}

export const GUIDE_COLS = ["id_product", "date", "avg", "low", "trend", "avg1", "avg7", "avg30", "foil_avg", "foil_low", "foil_trend", "foil_avg1", "foil_avg7", "foil_avg30"];
const GUIDE_CONFLICT = `ON CONFLICT(id_product, date) DO UPDATE SET avg = excluded.avg, low = excluded.low, trend = excluded.trend, avg1 = excluded.avg1, avg7 = excluded.avg7, avg30 = excluded.avg30,
  foil_avg = excluded.foil_avg, foil_low = excluded.foil_low, foil_trend = excluded.foil_trend, foil_avg1 = excluded.foil_avg1, foil_avg7 = excluded.foil_avg7, foil_avg30 = excluded.foil_avg30`;

export interface GuideImportStats { guideRows: number; guideDate: string; skipped: number; filtered: boolean }

/**
 * Import the daily price guide. With `onlyProducts` (set of Cardmarket ids) only those rows are stored –
 * on D1 every row is billed, and only products linked to a card are ever read.
 */
export async function importGuide(db: SqlDb, json: unknown, onlyProducts?: Set<number>): Promise<GuideImportStats> {
  const { rows, createdAt } = extractRows(json);
  const date = (createdAt ?? today()).slice(0, 10);
  const values: SqlValue[][] = [];
  let skipped = 0;
  for (const raw of rows) {
    const r = parseGuideRow(raw);
    if (!r) { skipped++; continue; }
    if (onlyProducts && !onlyProducts.has(r.idProduct)) continue;
    values.push([r.idProduct, date, r.avg, r.low, r.trend, r.avg1, r.avg7, r.avg30, r.foilAvg, r.foilLow, r.foilTrend, r.foilAvg1, r.foilAvg7, r.foilAvg30]);
  }
  await runBatches(db, bulkInsert("cm_price_guide", GUIDE_COLS, values, GUIDE_CONFLICT));
  await db.run("INSERT INTO meta(key, value) VALUES ('cm_guide_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [date]);
  return { guideRows: values.length, guideDate: date, skipped, filtered: !!onlyProducts };
}

/** Product ids currently linked to cards (what the guide import needs). */
export async function linkedProductIds(db: SqlDb): Promise<Set<number>> {
  const rows = await db.all<{ id: number }>("SELECT DISTINCT cm_product_id id FROM cards WHERE cm_product_id IS NOT NULL");
  return new Set(rows.map((r) => r.id));
}

/** Network variant used by the Worker and by `ingest --fetch`: downloads and imports in one go. */
export async function refreshCardmarketFromNetwork(db: SqlDb, opts: { products?: boolean; guideOnlyLinked?: boolean } = {}) {
  const urls = cardmarketUrls();
  const out: Record<string, unknown> = {};
  if (opts.products ?? true) {
    out.singles = await importProducts(db, await getJson(urls.singles), true);
    out.nonsingles = await importProducts(db, await getJson(urls.nonsingles).catch(() => []), false);
  }
  const only = (opts.guideOnlyLinked ?? true) ? await linkedProductIds(db) : undefined;
  out.guide = await importGuide(db, await getJson(urls.guide), only);
  return out;
}
