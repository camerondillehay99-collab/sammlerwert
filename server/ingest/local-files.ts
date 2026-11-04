/**
 * Bun-only: read a raw data snapshot from disk (layout produced by the PowerShell bootstrap script
 * or by `fetchRawToDisk`) and feed the runtime-agnostic importers. Never imported by the Worker.
 */
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SqlDb } from "../db/adapter.ts";
import { config } from "../config.ts";
import { getJson, NotFound, sleep } from "./http.ts";
import { importCatalog, importCardDetails, rebuildFts, matchesDetailPattern, type Brief, type CardFull, type SetBrief, type SetDetail } from "./tcgdex.ts";
import { cardmarketUrls, importGuide, importProducts, linkedProductIds } from "./cardmarket.ts";

const readJson = async <T>(path: string): Promise<T | null> => (existsSync(path) ? (JSON.parse(await Bun.file(path).text()) as T) : null);

export async function importTcgdexFromDisk(db: SqlDb, rawDir = config.rawDir) {
  const dir = join(rawDir, "tcgdex");
  const setsDe = (await readJson<SetBrief[]>(join(dir, "sets-de.json"))) ?? [];
  const setDetails = new Map<string, SetDetail | null>();
  for (const s of setsDe) setDetails.set(s.id, await readJson<SetDetail>(join(dir, "sets-de", `${s.id}.json`)));
  const stats = await importCatalog(db, {
    seriesDe: (await readJson(join(dir, "series-de.json"))) ?? [], setsDe, setsEn: (await readJson<SetBrief[]>(join(dir, "sets-en.json"))) ?? [],
    cardsDe: (await readJson<Brief[]>(join(dir, "cards-de.json"))) ?? [], cardsEn: (await readJson<Brief[]>(join(dir, "cards-en.json"))) ?? [], setDetails,
  });
  let detailed = 0;
  const cardsDir = join(dir, "cards-de");
  if (existsSync(cardsDir)) {
    for (const f of readdirSync(cardsDir).filter((x) => x.endsWith(".json"))) detailed += await importCardDetails(db, (await readJson<CardFull[]>(join(cardsDir, f))) ?? []);
  }
  await rebuildFts(db);
  return { ...stats, detailed };
}

export async function importCardmarketFromDisk(db: SqlDb, rawDir = config.rawDir, onlyLinked = false) {
  const g = config.ingest.cardmarketGameId, dir = join(rawDir, "cardmarket");
  const out: Record<string, unknown> = {};
  const singles = await readJson(join(dir, `products_singles_${g}.json`));
  if (singles) out.singles = await importProducts(db, singles, true);
  const non = await readJson(join(dir, `products_nonsingles_${g}.json`));
  if (non) out.nonsingles = await importProducts(db, non, false);
  const guide = await readJson(join(dir, `price_guide_${g}.json`));
  if (guide) out.guide = await importGuide(db, guide, onlyLinked ? await linkedProductIds(db) : undefined);
  return out;
}

/** Download everything into rawDir (same layout as the PowerShell script), then import from disk. */
export async function fetchRawToDisk(rawDir = config.rawDir, log: (m: string) => void = () => {}, detailSets?: string[] | "all" | "none") {
  const save = async (url: string, rel: string, force = false) => {
    const path = join(rawDir, rel);
    if (!force && existsSync(path) && Bun.file(path).size > 2) return JSON.parse(await Bun.file(path).text());
    mkdirSync(dirname(path), { recursive: true });
    const json = await getJson(url);
    await Bun.write(path, JSON.stringify(json));
    await sleep(config.ingest.requestDelayMs);
    return json;
  };
  const u = cardmarketUrls(), g = config.ingest.cardmarketGameId;
  await save(u.guide, `cardmarket/price_guide_${g}.json`, true);
  await save(u.singles, `cardmarket/products_singles_${g}.json`, true);
  await save(u.nonsingles, `cardmarket/products_nonsingles_${g}.json`, true).catch(() => null);
  const base = config.ingest.tcgdexBase;
  const setsDe = (await save(`${base}/de/sets`, "tcgdex/sets-de.json", true)) as SetBrief[];
  await save(`${base}/en/sets`, "tcgdex/sets-en.json", true);
  await save(`${base}/de/series`, "tcgdex/series-de.json", true);
  await save(`${base}/de/cards`, "tcgdex/cards-de.json", true);
  await save(`${base}/en/cards`, "tcgdex/cards-en.json", true);
  for (const s of setsDe) { try { await save(`${base}/de/sets/${s.id}`, `tcgdex/sets-de/${s.id}.json`); } catch (e) { if (!(e instanceof NotFound)) throw e; } }
  log(`sets: ${setsDe.length}`);
  const wanted = detailSets === "none" ? [] : setsDe.filter((s) => detailSets === "all" || matchesDetailPattern(s.id, Array.isArray(detailSets) ? detailSets : undefined));
  for (const s of wanted) {
    const target = join(rawDir, "tcgdex", "cards-de", `${s.id}.json`);
    if (existsSync(target) && Bun.file(target).size > 2) continue;
    const detail = await readJson<SetDetail>(join(rawDir, "tcgdex", "sets-de", `${s.id}.json`));
    const cards: CardFull[] = [];
    for (const c of detail?.cards ?? []) {
      try { cards.push(await getJson<CardFull>(`${base}/de/cards/${c.id}`)); } catch (e) { if (!(e instanceof NotFound)) throw e; }
      await sleep(config.ingest.requestDelayMs);
    }
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, JSON.stringify(cards));
    log(`cards ${s.id}: ${cards.length}`);
  }
}
