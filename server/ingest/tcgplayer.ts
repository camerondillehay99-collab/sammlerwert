/**
 * TCGplayer prices via TCGCSV (https://tcgcsv.com – free daily mirror of TCGplayer's catalogue and prices).
 *   groups:   {base}/tcgplayer/3/groups                 (Pokémon = category 3)
 *   products: {base}/tcgplayer/3/{groupId}/products     (productId, name, cleanName, extendedData[Number, Rarity …])
 *   prices:   {base}/tcgplayer/3/{groupId}/prices       (productId, subTypeName, marketPrice …, USD)
 *   archive:  {base}/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z  → YYYY-MM-DD/3/{groupId}/prices  (since 2024-02-08)
 * House rules we follow: custom User-Agent, ≥ 100 ms between requests, every archive downloaded once, no browser calls.
 *
 * Matching: set → group(s) (curated table + unique abbreviation/name), card → product by collector number
 * inside those groups ("199/165" ↔ local_id "199", "TG01/TG30" ↔ "TG01", "SV1/SV94" ↔ "SV1").
 */
import type { SqlDb, SqlValue } from "../db/adapter.ts";
import { bulkInsert, chunks, placeholders, runBatches, stmt } from "../db/adapter.ts";
import { getJson, sleep } from "./http.ts";
import { normalizeName } from "./matcher.ts";
import { packedPoint } from "../pricing/history.ts";

export const TCGCSV_BASE = "https://tcgcsv.com";
export const TCGP_CATEGORY = 3;
export const TCGCSV_FIRST_ARCHIVE = "2024-02-08";
const PACE_MS = 120;

export interface TcgpGroup { groupId: number; name: string; abbreviation: string | null; publishedOn: string | null }
export interface TcgpProduct { productId: number; name: string; cleanName: string | null; number: string | null }
export interface TcgpPrice { productId: number; subTypeName: string; marketPrice: number | null; lowPrice: number | null; midPrice: number | null }

/** Our set id → TCGplayer group ids. Curated once; new sets fall back to abbreviation/name matching. */
export const SET_GROUPS: Record<string, number[]> = {
  base1: [604], base2: [635], base3: [630], base5: [1373], basep: [1418], neo1: [1396], neo2: [1434], neo3: [1389], neo4: [1444],
  ecard1: [1375], ecard2: [1397], ecard3: [1372],
  ex1: [1393], ex2: [1392], ex3: [1376], ex4: [1377], ex6: [1419], ex8: [1404], ex9: [1410], ex10: [1398], exu: [1398], ex11: [1429], ex12: [1378], ex13: [1379], ex14: [1395], ex15: [1411], ex16: [1383],
  dp1: [1430], dp2: [1368], dp3: [1380], dp4: [1405], dp5: [1390], dp6: [1417], dp7: [1369], dpp: [1421], pl1: [1406], pl2: [1367], pl3: [1384], pl4: [1391],
  hgss1: [1402], hgss2: [1399], hgss3: [1403], hgss4: [1381], hgssp: [1453], col1: [1415],
  bw1: [1400], bw2: [1424], bw3: [1385], bw4: [1412], bw5: [1386], bw6: [1394], bw7: [1408], bw8: [1413], bw9: [1382], bw10: [1370], bwp: [1407], dv1: [1426],
  xy0: [1522], xy1: [1387], xy2: [1464], xy3: [1481], xy4: [1494], xy5: [1509], xy6: [1534], xy7: [1576], xy8: [1661], xy9: [1701], xy10: [1780], xy11: [1815], xy12: [1842], xyp: [1451], g1: [1728, 1729],
  sm1: [1863], sm2: [1919], sm3: [1957], "sm3.5": [2054], sm4: [2071], sm5: [2178], sm6: [2209], sm7: [2278], "sm7.5": [2295], sm8: [2328], sm9: [2377], sm10: [2420], sm11: [2464], sm115: [2480], sma: [2594], sm12: [2534], smp: [1861], det1: [2409],
  swsh1: [2585], swsh2: [2626], swsh3: [2675], "swsh3.5": [2685], swsh4: [2701], "swsh4.5": [2754], "swsh4.5sv": [2781], swsh5: [2765], swsh6: [2807], swsh7: [2848], swsh8: [2906], swsh9: [2948], swsh9tg: [3020],
  swsh10: [3040], swsh10tg: [3068], "swsh10.5": [3064], swsh11: [3118], swsh11tg: [3172], swsh12: [3170], swsh12tg: [17674], "swsh12.5": [17688], "swsh12.5gg": [17689], swshp: [2545], cel25: [2867], cel25cc: [2931],
  sv01: [22873], sv02: [23120], sv03: [23228], "sv03.5": [23237], sv04: [23286], "sv04.5": [23353], sv05: [23381], sv06: [23473], "sv06.5": [23529], sv07: [23537], sv08: [23651], "sv08.5": [23821], sv09: [24073], sv10: [24269], "sv10.5b": [24325], "sv10.5w": [24326], svp: [22872], sve: [24382],
  me01: [24380], me02: [24448], "me02.5": [24541], me03: [24587], me04: [24655], me05: [24688], mee: [24461], mep: [24451], "30th": [24722], "30th-c": [24837],
};

export interface SetLite { id: string; abbreviation: string | null; name_en: string | null }

const normAbbr = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/** "SV03: Obsidian Flames" → "obsidian flames", "SM - Team Up" → "team up", "SWSH: Crown Zenith" → "crown zenith" */
export function groupBaseName(name: string): string {
  return normalizeName(name.replace(/^(SV|SWSH|SM|XY|ME|BW|DP|HS|EX|S)\d*\s*[:\-–]\s*/i, "").replace(/^(SV|SWSH|SM|XY|ME|EX)\s*[:\-–]\s*/i, "").replace(/\bbase set\b/i, "").replace(/^ex\s+/i, ""));
}

/** set id → group ids: curated map first, then unique abbreviation, then unique base name. */
export function matchGroups(sets: SetLite[], groups: TcgpGroup[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const known = new Set(groups.map((g) => g.groupId));
  const byAbbr = new Map<string, TcgpGroup[]>(), byName = new Map<string, TcgpGroup[]>();
  for (const g of groups) {
    const a = normAbbr(g.abbreviation); if (a) (byAbbr.get(a) ?? byAbbr.set(a, []).get(a)!).push(g);
    const n = groupBaseName(g.name); if (n) (byName.get(n) ?? byName.set(n, []).get(n)!).push(g);
  }
  for (const s of sets) {
    const curated = SET_GROUPS[s.id]?.filter((id) => known.has(id) || !groups.length);
    if (curated?.length) { out.set(s.id, curated); continue; }
    const a = byAbbr.get(normAbbr(s.abbreviation));
    if (a?.length === 1) { out.set(s.id, [a[0]!.groupId]); continue; }
    const n = byName.get(normalizeName(s.name_en));
    if (n?.length === 1) out.set(s.id, [n[0]!.groupId]);
  }
  return out;
}

/** "TG01/TG30" → "TG1", "001/165" → "1", "SV045" → "SV45", "28a" → "28A", "RC1" → "RC1". */
export function normNumber(s: string | null | undefined): string {
  if (!s) return "";
  const head = s.split("/")[0]!.trim().toUpperCase().replace(/\s+/g, "");
  return head.replace(/^([A-Z]*)0*(\d+)([A-Z]*)$/, "$1$2$3");
}

export interface CardLite { id: string; local_id: string; name_en: string | null }
const SKIP_PRODUCT = /\b(code card|booster|box|pack|tin|bundle|deck|collection|case|binder|sleeves|playmat|coin|jumbo)\b/i;

/** card id → productId by collector number; ties resolved by English name, else by the plainest product name. */
export function matchProducts(cards: CardLite[], products: TcgpProduct[]): Map<string, number> {
  const byNumber = new Map<string, TcgpProduct[]>();
  for (const p of products) {
    const n = normNumber(p.number);
    if (!n || SKIP_PRODUCT.test(p.name)) continue;
    (byNumber.get(n) ?? byNumber.set(n, []).get(n)!).push(p);
  }
  const out = new Map<string, number>();
  for (const c of cards) {
    const cands = byNumber.get(normNumber(c.local_id));
    if (!cands?.length) continue;
    if (cands.length === 1) { out.set(c.id, cands[0]!.productId); continue; }
    const want = normalizeName(c.name_en);
    const exact = cands.filter((p) => normalizeName(p.name.replace(/\s*[(\[].*?[)\]]\s*$/, "")) === want);
    const pick = exact[0] ?? [...cands].sort((a, b) => a.name.length - b.name.length)[0]!;
    out.set(c.id, pick.productId);
  }
  return out;
}

/** TCGplayer finish → our variant (null = not a card printing we track). */
export function variantOfSubType(subType: string | null | undefined): "normal" | "holo" | "reverse" | "firstEdition" | null {
  const s = (subType ?? "").toLowerCase();
  if (!s || s === "normal" || s === "unlimited") return "normal";
  if (s.includes("1st edition")) return "firstEdition";
  if (s.includes("reverse")) return "reverse";
  if (s.includes("holofoil") || s === "holo") return "holo";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Network + database
// ---------------------------------------------------------------------------------------------

interface Envelope<T> { results?: T[] }
async function tcg<T>(path: string): Promise<T[]> {
  const j = await getJson<Envelope<T> | T[]>(`${TCGCSV_BASE}${path}`, { timeoutMs: 60_000 });
  await sleep(PACE_MS);
  return Array.isArray(j) ? j : j.results ?? [];
}

export function toProduct(raw: Record<string, unknown>): TcgpProduct {
  const ext = Array.isArray(raw.extendedData) ? (raw.extendedData as Array<{ name?: string; value?: string }>) : [];
  return { productId: Number(raw.productId), name: String(raw.name ?? ""), cleanName: (raw.cleanName as string) ?? null, number: ext.find((e) => e.name === "Number")?.value ?? null };
}
export function toPrice(raw: Record<string, unknown>): TcgpPrice {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { productId: Number(raw.productId), subTypeName: String(raw.subTypeName ?? ""), marketPrice: n(raw.marketPrice), lowPrice: n(raw.lowPrice), midPrice: n(raw.midPrice) };
}

export async function ensureTcgpTables(db: SqlDb) {
  await db.exec(`CREATE TABLE IF NOT EXISTS tcgp_groups (group_id INTEGER PRIMARY KEY, set_id TEXT, name TEXT, abbreviation TEXT, published_on TEXT, products INTEGER, matched INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS price_series (card_id TEXT NOT NULL, source TEXT NOT NULL, variant TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', points TEXT NOT NULL DEFAULT '', first_date TEXT, last_date TEXT, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (card_id, source, variant));`);
}

export interface TcgpMatchStats { groups: number; setsMatched: number; productsSeen: number; cardsMatched: number; cardsTotal: number; ms: number }

/** Sync groups and link cards to products (weekly is plenty; new sets appear as TCGdex adds them). */
export async function matchCardsToTcgplayer(db: SqlDb, log: (m: string) => void = () => {}, opts: { onlyUnmatchedSets?: boolean } = {}): Promise<TcgpMatchStats> {
  const t0 = Date.now();
  await ensureTcgpTables(db);
  const groups = (await tcg<Record<string, unknown>>(`/tcgplayer/${TCGP_CATEGORY}/groups`)).map((g) => ({ groupId: Number(g.groupId), name: String(g.name ?? ""), abbreviation: (g.abbreviation as string) || null, publishedOn: (g.publishedOn as string) ?? null }));
  const sets = await db.all<SetLite>("SELECT id, abbreviation, name_en FROM sets");
  const mapping = matchGroups(sets, groups);
  const groupSet = new Map<number, string>();
  for (const [setId, ids] of mapping) for (const id of ids) groupSet.set(id, setId);
  const now = new Date().toISOString();
  await runBatches(db, bulkInsert("tcgp_groups", ["group_id", "set_id", "name", "abbreviation", "published_on", "updated_at"],
    groups.map((g) => [g.groupId, groupSet.get(g.groupId) ?? null, g.name, g.abbreviation, g.publishedOn, now] as SqlValue[]),
    "ON CONFLICT(group_id) DO UPDATE SET set_id = excluded.set_id, name = excluded.name, abbreviation = excluded.abbreviation, published_on = excluded.published_on, updated_at = excluded.updated_at"));
  const stats: TcgpMatchStats = { groups: groups.length, setsMatched: mapping.size, productsSeen: 0, cardsMatched: 0, cardsTotal: 0, ms: 0 };

  const alreadyDone = new Set<string>();
  if (opts.onlyUnmatchedSets) for (const r of await db.all<{ set_id: string }>("SELECT DISTINCT set_id FROM cards WHERE tcgp_product_id IS NOT NULL")) alreadyDone.add(r.set_id);
  const updates = [];
  for (const [setId, groupIds] of mapping) {
    if (alreadyDone.has(setId)) continue;
    const cards = await db.all<CardLite>("SELECT id, local_id, name_en FROM cards WHERE set_id = ?", [setId]);
    if (!cards.length) continue;
    stats.cardsTotal += cards.length;
    const products: TcgpProduct[] = [];
    for (const gid of groupIds) {
      try { products.push(...(await tcg<Record<string, unknown>>(`/tcgplayer/${TCGP_CATEGORY}/${gid}/products`)).map(toProduct)); }
      catch (e) { log(`TCGplayer ${setId}/${gid}: ${(e as Error).message}`); }
    }
    stats.productsSeen += products.length;
    const m = matchProducts(cards, products);
    stats.cardsMatched += m.size;
    for (const [cardId, pid] of m) updates.push(stmt("UPDATE cards SET tcgp_product_id = ? WHERE id = ? AND (tcgp_product_id IS NULL OR tcgp_product_id != ?)", pid, cardId, pid));
    updates.push(stmt("UPDATE tcgp_groups SET products = ?, matched = ? WHERE group_id = ?", products.length, m.size, groupIds[0]!));
  }
  await runBatches(db, updates);
  stats.ms = Date.now() - t0;
  return stats;
}

/** productId → [cardId] (several cards can share a product only through our own mismatches; keep them all). */
export async function productIndex(db: SqlDb): Promise<Map<number, string[]>> {
  const idx = new Map<number, string[]>();
  for (const r of await db.all<{ id: string; tcgp_product_id: number }>("SELECT id, tcgp_product_id FROM cards WHERE tcgp_product_id IS NOT NULL")) (idx.get(r.tcgp_product_id) ?? idx.set(r.tcgp_product_id, []).get(r.tcgp_product_id)!).push(r.id);
  return idx;
}
export async function matchedGroupIds(db: SqlDb): Promise<number[]> {
  return (await db.all<{ group_id: number }>("SELECT group_id FROM tcgp_groups WHERE set_id IS NOT NULL ORDER BY group_id")).map((r) => r.group_id);
}

/** Price date for a live fetch: TCGCSV publishes ~20:00 UTC, so an early-morning fetch carries yesterday's figures. */
export function priceDateFor(now = new Date()): string { return new Date(now.getTime() - 6 * 3_600_000).toISOString().slice(0, 10); }

/**
 * Append one day of points without reading rows back: INSERT … ON CONFLICT appends to the packed string
 * only when the day is newer than the row's last date (re-runs are idempotent).
 */
export async function appendDailyPoints(db: SqlDb, date: string, points: Array<{ cardId: string; variant: string; price: number }>, source = "tcgplayer", currency = "USD"): Promise<number> {
  if (!points.length) return 0;
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const rows: SqlValue[][] = [];
  for (const p of points) {
    const k = `${p.cardId}|${p.variant}`;
    if (seen.has(k)) continue; seen.add(k);
    rows.push([p.cardId, source, p.variant, currency, packedPoint(date, p.price), date, date, 1, now]);
  }
  await runBatches(db, bulkInsert("price_series", ["card_id", "source", "variant", "currency", "points", "first_date", "last_date", "n", "updated_at"], rows, `ON CONFLICT(card_id, source, variant) DO UPDATE SET
    points = CASE WHEN price_series.last_date IS NULL OR price_series.last_date < excluded.last_date THEN CASE WHEN price_series.points = '' THEN excluded.points ELSE price_series.points || ';' || excluded.points END ELSE price_series.points END,
    n = CASE WHEN price_series.last_date IS NULL OR price_series.last_date < excluded.last_date THEN price_series.n + 1 ELSE price_series.n END,
    last_date = MAX(COALESCE(price_series.last_date, ''), excluded.last_date), first_date = COALESCE(price_series.first_date, excluded.first_date), updated_at = excluded.updated_at`), 60);
  return rows.length;
}

/** Turn one group's price list into points for our cards. */
export function pointsFromPrices(prices: TcgpPrice[], index: Map<number, string[]>): Array<{ cardId: string; variant: string; price: number }> {
  const out: Array<{ cardId: string; variant: string; price: number }> = [];
  for (const p of prices) {
    const ids = index.get(p.productId);
    if (!ids || p.marketPrice == null || p.marketPrice <= 0) continue;
    const variant = variantOfSubType(p.subTypeName);
    if (!variant) continue;
    for (const cardId of ids) out.push({ cardId, variant, price: p.marketPrice });
  }
  return out;
}

export interface TcgpDailyStats { date: string; groups: number; points: number; errors: number; ms: number }

/** Nightly: today's market price for every matched group → one appended point per (card, variant). */
export async function refreshTcgplayerDaily(db: SqlDb, log: (m: string) => void = () => {}): Promise<TcgpDailyStats> {
  const t0 = Date.now();
  await ensureTcgpTables(db);
  const date = priceDateFor();
  const index = await productIndex(db);
  const groupIds = await matchedGroupIds(db);
  const stats: TcgpDailyStats = { date, groups: groupIds.length, points: 0, errors: 0, ms: 0 };
  let pending: Array<{ cardId: string; variant: string; price: number }> = [];
  for (const gid of groupIds) {
    try { pending.push(...pointsFromPrices((await tcg<Record<string, unknown>>(`/tcgplayer/${TCGP_CATEGORY}/${gid}/prices`)).map(toPrice), index)); }
    catch (e) { stats.errors++; log(`TCGplayer prices ${gid}: ${(e as Error).message}`); }
    if (pending.length >= 2000) { stats.points += await appendDailyPoints(db, date, pending); pending = []; }
  }
  stats.points += await appendDailyPoints(db, date, pending);
  stats.ms = Date.now() - t0;
  return stats;
}

/** Latest TCGplayer point per card (for list views): card id → { variant, price USD, date }. */
export async function latestTcgpPrices(db: SqlDb, cardIds: string[]): Promise<Map<string, { variant: string; price: number; date: string }>> {
  const out = new Map<string, { variant: string; price: number; date: string }>();
  for (const ch of chunks(cardIds, 90)) {
    for (const r of await db.all<{ card_id: string; variant: string; points: string; last_date: string }>(`SELECT card_id, variant, substr(points, -40) points, last_date FROM price_series WHERE source = 'tcgplayer' AND card_id IN (${placeholders(ch.length)})`, ch)) {
      const last = r.points.split(";").pop() ?? ""; const v = Number(last.slice(9));
      if (Number.isFinite(v) && !out.has(r.card_id)) out.set(r.card_id, { variant: r.variant, price: v, date: r.last_date });
    }
  }
  return out;
}
