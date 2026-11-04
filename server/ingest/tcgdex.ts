/**
 * TCGdex catalogue (open data, German + English names, images, rarities, variants, Cardmarket product ids).
 * Runtime-agnostic importers; `ingest/local-files.ts` feeds them from disk (Bun), `refreshTcgdexFromNetwork` from the API.
 */
import type { SqlDb, SqlValue } from "../db/adapter.ts";
import { bulkInsert, runBatches, stmt } from "../db/adapter.ts";
import { config } from "../config.ts";
import { getJson, NotFound, sleep } from "./http.ts";
import { nowIso } from "../db/index.ts";

export type Brief = { id: string; localId?: string | number; name?: string; image?: string };
export type SetBrief = { id: string; name?: string; logo?: string; symbol?: string; cardCount?: { total?: number; official?: number } };
export type SetDetail = SetBrief & { serie?: { id: string; name?: string }; releaseDate?: string; abbreviation?: { official?: string; localized?: string } | string; cards?: Brief[] };
export type CardFull = Brief & {
  category?: string; rarity?: string; hp?: number; types?: string[]; dexId?: number[]; illustrator?: string;
  variants?: Record<string, boolean>; set?: { id: string; name?: string };
  pricing?: { cardmarket?: { idProduct?: number } & Record<string, unknown> };
  thirdParty?: { cardmarket?: number | null; tcgplayer?: number | null } | null;
};

/** Cardmarket product id as exposed by TCGdex (pricing block first, legacy thirdParty second). */
export function cardmarketIdOf(c: CardFull): number | null {
  const a = c.pricing?.cardmarket?.idProduct;
  if (typeof a === "number" && a > 0) return a;
  const b = c.thirdParty?.cardmarket;
  return typeof b === "number" && b > 0 ? b : null;
}

export function matchesDetailPattern(setId: string, patterns = config.ingest.detailSets): boolean {
  return patterns.some((p) => p === "*" || (p.endsWith("*") ? setId.startsWith(p.slice(0, -1)) : setId === p));
}

export interface CatalogInput {
  seriesDe: Array<{ id: string; name?: string; logo?: string }>;
  setsDe: SetBrief[];
  setsEn: SetBrief[];
  cardsDe: Brief[];
  cardsEn: Brief[];
  setDetails: Map<string, SetDetail | null>;
}

export interface TcgdexImportStats { series: number; sets: number; cards: number; newCards?: number }

const SET_COLS = ["id", "series_id", "name_de", "name_en", "abbreviation", "release_date", "card_count_official", "card_count_total", "logo", "symbol", "updated_at"];
const SET_CONFLICT = `ON CONFLICT(id) DO UPDATE SET series_id = COALESCE(excluded.series_id, sets.series_id), name_de = COALESCE(excluded.name_de, sets.name_de),
  name_en = COALESCE(excluded.name_en, sets.name_en), abbreviation = COALESCE(excluded.abbreviation, sets.abbreviation), release_date = COALESCE(excluded.release_date, sets.release_date),
  card_count_official = COALESCE(excluded.card_count_official, sets.card_count_official), card_count_total = COALESCE(excluded.card_count_total, sets.card_count_total),
  logo = COALESCE(excluded.logo, sets.logo), symbol = COALESCE(excluded.symbol, sets.symbol), updated_at = excluded.updated_at`;
const CARD_COLS = ["id", "set_id", "local_id", "name_de", "name_en", "image", "image_en", "updated_at"];
const CARD_CONFLICT = `ON CONFLICT(id) DO UPDATE SET name_de = COALESCE(excluded.name_de, cards.name_de), name_en = COALESCE(excluded.name_en, cards.name_en),
  image = COALESCE(excluded.image, cards.image), image_en = COALESCE(excluded.image_en, cards.image_en), updated_at = excluded.updated_at`;

/**
 * Series that are not part of the physical trading card game and must never show up in search, sets or the scanner.
 * Pokémon TCG Pocket (series "tcgp", sets A1, A2a, B1 …) is a mobile game with its own cards and no Cardmarket prices.
 */
export const EXCLUDED_SERIES: ReadonlySet<string> = new Set(["tcgp"]);
const POCKET_SET_ID = /^(?:[AB]\d+[a-z]?|P-[A-Z])$/;
export function isExcludedSet(setId: string, seriesId: string | null | undefined): boolean {
  return (seriesId != null && EXCLUDED_SERIES.has(seriesId)) || POCKET_SET_ID.test(setId);
}

/** Remove excluded series from an existing database (catalogue, FTS, portfolio rows stay – they reference cards that no longer exist and are skipped). */
export async function purgeExcludedSeries(db: SqlDb): Promise<number> {
  const ids = (await db.all<{ id: string; series_id: string | null }>("SELECT id, series_id FROM sets")).filter((r) => isExcludedSet(r.id, r.series_id)).map((r) => r.id);
  if (!ids.length) return 0;
  const inList = ids.map(() => "?").join(",");
  await db.batch([
    stmt(`DELETE FROM cards_fts WHERE card_id IN (SELECT id FROM cards WHERE set_id IN (${inList}))`, ...ids),
    stmt(`DELETE FROM cards WHERE set_id IN (${inList})`, ...ids),
    stmt(`DELETE FROM sets WHERE id IN (${inList})`, ...ids),
    stmt("DELETE FROM series WHERE id IN ('tcgp')"),
  ]);
  return ids.length;
}

/**
 * Import series, sets and brief cards. Idempotent.
 * With `onlyNewCards`, existing cards are left untouched and only new ones are inserted (+ their FTS rows) –
 * the mode the nightly job uses against D1, where every written row counts.
 */
export async function importCatalog(db: SqlDb, input: CatalogInput, onlyNewCards = false): Promise<TcgdexImportStats> {
  const now = nowIso();
  const enSet = new Map(input.setsEn.map((s) => [s.id, s]));
  const enSetName = new Map(input.setsEn.map((s) => [s.id, s.name ?? null]));
  const enCard = new Map(input.cardsEn.map((c) => [c.id, c]));
  const deCard = new Map(input.cardsDe.map((c) => [c.id, c]));

  const seriesRows: SqlValue[][] = input.seriesDe.filter((s) => !EXCLUDED_SERIES.has(s.id)).map((s) => [s.id, s.name ?? null, s.logo ?? null]);
  const setRows: SqlValue[][] = [];
  const cardRows = new Map<string, SqlValue[]>();
  const excludedSets = new Set<string>();
  for (const brief of input.setsDe) {
    const d = input.setDetails.get(brief.id) ?? null;
    if (isExcludedSet(brief.id, d?.serie?.id)) { excludedSets.add(brief.id); continue; }
    if (d?.serie?.id && !seriesRows.some((r) => r[0] === d.serie!.id)) seriesRows.push([d.serie.id, d.serie.name ?? null, null]);
    const abbr = typeof d?.abbreviation === "string" ? d.abbreviation : d?.abbreviation?.official ?? null;
    setRows.push([brief.id, d?.serie?.id ?? null, brief.name ?? d?.name ?? null, enSetName.get(brief.id) ?? null, abbr, d?.releaseDate ?? null,
      d?.cardCount?.official ?? brief.cardCount?.official ?? null, d?.cardCount?.total ?? brief.cardCount?.total ?? null, brief.logo ?? d?.logo ?? enSet.get(brief.id)?.logo ?? null, brief.symbol ?? d?.symbol ?? enSet.get(brief.id)?.symbol ?? null, now]);
    for (const c of d?.cards ?? []) {
      const de = deCard.get(c.id), en = enCard.get(c.id);
      cardRows.set(c.id, [c.id, brief.id, String(c.localId ?? c.id.split("-").pop()), c.name ?? de?.name ?? null, en?.name ?? null, c.image ?? de?.image ?? null, en?.image ?? null, now]);
    }
  }
  const setIds = new Set(input.setsDe.map((s) => s.id).filter((id) => !excludedSets.has(id)));
  for (const c of input.cardsDe) {
    if (cardRows.has(c.id)) continue;
    const setId = c.id.slice(0, c.id.lastIndexOf("-"));
    if (!setIds.has(setId)) continue;
    const en = enCard.get(c.id);
    cardRows.set(c.id, [c.id, setId, String(c.localId ?? c.id.split("-").pop()), c.name ?? null, en?.name ?? null, c.image ?? null, en?.image ?? null, now]);
  }
  await runBatches(db, [
    ...bulkInsert("series", ["id", "name_de", "logo"], seriesRows, "ON CONFLICT(id) DO UPDATE SET name_de = COALESCE(excluded.name_de, series.name_de), logo = COALESCE(excluded.logo, series.logo)"),
    ...bulkInsert("sets", SET_COLS, setRows, SET_CONFLICT),
  ]);
  if (onlyNewCards) {
    const existing = new Set((await db.all<{ id: string }>("SELECT id FROM cards")).map((r) => r.id));
    const fresh = [...cardRows.values()].filter((r) => !existing.has(r[0] as string));
    await runBatches(db, bulkInsert("cards", CARD_COLS, fresh, CARD_CONFLICT));
    const setName = new Map(setRows.map((r) => [r[0] as string, { de: r[2] as string | null, en: r[3] as string | null }]));
    await runBatches(db, bulkInsert("cards_fts", ["card_id", "name_de", "name_en", "set_name_de", "set_name_en", "local_id"],
      fresh.map((r) => [r[0], r[3], r[4], setName.get(r[1] as string)?.de ?? null, setName.get(r[1] as string)?.en ?? null, r[2]])));
    return { series: seriesRows.length, sets: setRows.length, cards: cardRows.size, newCards: fresh.length };
  }
  await runBatches(db, bulkInsert("cards", CARD_COLS, [...cardRows.values()], CARD_CONFLICT));
  return { series: seriesRows.length, sets: setRows.length, cards: cardRows.size };
}

/** Apply full card objects: rarity, variants, Cardmarket id … Returns number updated. */
export async function importCardDetails(db: SqlDb, cards: CardFull[]): Promise<number> {
  const now = nowIso();
  const statements = cards.filter((c) => c?.id).map((c) => {
    const cmId = cardmarketIdOf(c);
    return stmt(`UPDATE cards SET category = ?, rarity = ?, hp = ?, types = ?, dex_ids = ?, illustrator = ?, variants = ?, detail_loaded = 1, updated_at = ?,
      cm_product_id = COALESCE(?, cm_product_id), cm_match_method = CASE WHEN ? IS NOT NULL THEN 'tcgdex' ELSE cm_match_method END,
      cm_match_confidence = CASE WHEN ? IS NOT NULL THEN 1.0 ELSE cm_match_confidence END WHERE id = ?`,
      c.category ?? null, c.rarity ?? null, c.hp ?? null, JSON.stringify(c.types ?? []), JSON.stringify(c.dexId ?? []), c.illustrator ?? null, JSON.stringify(c.variants ?? {}), now, cmId, cmId, cmId, c.id);
  });
  await runBatches(db, statements);
  return statements.length;
}

export async function rebuildFts(db: SqlDb) {
  await db.batch([
    stmt("DELETE FROM cards_fts"),
    stmt(`INSERT INTO cards_fts(card_id, name_de, name_en, set_name_de, set_name_en, local_id)
      SELECT c.id, c.name_de, c.name_en, s.name_de, s.name_en, c.local_id FROM cards c JOIN sets s ON s.id = c.set_id`),
  ]);
}

/** Fetch lists + every set detail from api.tcgdex.net and import (≈ 160 requests). */
export async function refreshTcgdexFromNetwork(db: SqlDb, log: (m: string) => void = () => {}, onlyNewCards = false): Promise<TcgdexImportStats> {
  const base = config.ingest.tcgdexBase;
  const [setsDe, setsEn, seriesDe, cardsDe, cardsEn] = await Promise.all([
    getJson<SetBrief[]>(`${base}/de/sets`), getJson<SetBrief[]>(`${base}/en/sets`), getJson<CatalogInput["seriesDe"]>(`${base}/de/series`),
    getJson<Brief[]>(`${base}/de/cards`), getJson<Brief[]>(`${base}/en/cards`),
  ]);
  const setDetails = new Map<string, SetDetail | null>();
  for (const s of setsDe) {
    try { setDetails.set(s.id, await getJson<SetDetail>(`${base}/de/sets/${s.id}`)); } catch (e) { if (!(e instanceof NotFound)) throw e; setDetails.set(s.id, null); }
    await sleep(config.ingest.requestDelayMs);
  }
  const stats = await importCatalog(db, { setsDe, setsEn, seriesDe, cardsDe, cardsEn, setDetails }, onlyNewCards);
  if (!onlyNewCards) await rebuildFts(db);
  log(`tcgdex: ${JSON.stringify(stats)}`);
  return stats;
}

/** Fetch full details for up to `limit` cards that only have brief data (newest sets first). */
export async function completeCardDetails(db: SqlDb, limit = config.ingest.completionBatch): Promise<{ fetched: number; missing: number; remaining: number }> {
  const batch = await db.all<{ id: string }>(`SELECT c.id FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.detail_loaded = 0
    ORDER BY s.release_date DESC NULLS LAST, CAST(c.local_id AS INTEGER) LIMIT ?`, [limit]);
  const cards: CardFull[] = [];
  const missing: string[] = [];
  for (const { id } of batch) {
    try { cards.push(await getJson<CardFull>(`${config.ingest.tcgdexBase}/de/cards/${id}`)); }
    catch (e) { if (e instanceof NotFound) missing.push(id); else throw e; }
    await sleep(config.ingest.requestDelayMs);
  }
  await importCardDetails(db, cards);
  if (missing.length) await runBatches(db, missing.map((id) => stmt("UPDATE cards SET detail_loaded = 1 WHERE id = ?", id)));
  const remaining = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE detail_loaded = 0"))?.n ?? 0;
  return { fetched: cards.length, missing: missing.length, remaining };
}
