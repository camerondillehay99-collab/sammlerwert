/**
 * Links TCGdex cards to Cardmarket products.
 *   1. `tcgdex` – id provided by TCGdex (confidence 1.0), applied during detail import.
 *   2. set → Cardmarket expansion by majority vote over those matches.
 *   3. `expansion+name` – brief-only cards matched by unique English name inside that expansion (0.6).
 *      Alternate arts share names, so they stay unmatched rather than guessed wrong.
 */
import type { SqlDb } from "../db/adapter.ts";
import { runBatches, stmt } from "../db/adapter.ts";

export function productBaseName(name: string): string { return name.replace(/\s*\[.*?\]\s*$/, "").trim(); }

export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export interface MatchStats { cards: number; direct: number; byName: number; unmatched: number; expansionsMapped: number }

export async function matchCardsToCardmarket(db: SqlDb): Promise<MatchStats> {
  const stats: MatchStats = { cards: 0, direct: 0, byName: 0, unmatched: 0, expansionsMapped: 0 };
  stats.cards = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards"))!.n;
  stats.direct = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE cm_match_method = 'tcgdex'"))!.n;

  const votes = await db.all<{ set_id: string; id_expansion: number; n: number }>(`
    SELECT c.set_id, p.id_expansion, COUNT(*) n FROM cards c JOIN cm_products p ON p.id_product = c.cm_product_id
    WHERE c.cm_match_method = 'tcgdex' AND p.id_expansion IS NOT NULL GROUP BY c.set_id, p.id_expansion ORDER BY n DESC`);
  const setExpansion = new Map<string, number>();
  for (const v of votes) if (!setExpansion.has(v.set_id)) setExpansion.set(v.set_id, v.id_expansion);
  await runBatches(db, [...setExpansion].map(([setId, exp]) => stmt("INSERT INTO cm_expansions(id_expansion, set_id) VALUES (?, ?) ON CONFLICT(id_expansion) DO UPDATE SET set_id = excluded.set_id", exp, setId)));
  stats.expansionsMapped = setExpansion.size;

  const taken = new Set((await db.all<{ id: number }>("SELECT cm_product_id id FROM cards WHERE cm_product_id IS NOT NULL")).map((r) => r.id));
  const unmatched = await db.all<{ id: string; set_id: string; name_en: string | null }>("SELECT id, set_id, name_en FROM cards WHERE cm_product_id IS NULL");
  const productsByExp = new Map<number, Map<string, number[]>>();
  const updates = [];
  for (const c of unmatched) {
    const exp = setExpansion.get(c.set_id);
    const key = normalizeName(c.name_en);
    if (!exp || !key) { stats.unmatched++; continue; }
    let idx = productsByExp.get(exp);
    if (!idx) {
      idx = new Map();
      for (const p of await db.all<{ id_product: number; name: string }>("SELECT id_product, name FROM cm_products WHERE id_expansion = ? AND is_single = 1", [exp])) {
        const k = normalizeName(productBaseName(p.name));
        (idx.get(k) ?? idx.set(k, []).get(k)!).push(p.id_product);
      }
      productsByExp.set(exp, idx);
    }
    const cands = (idx.get(key) ?? []).filter((id) => !taken.has(id));
    if (cands.length === 1) { updates.push(stmt("UPDATE cards SET cm_product_id = ?, cm_match_method = 'expansion+name', cm_match_confidence = 0.6 WHERE id = ?", cands[0]!, c.id)); taken.add(cands[0]!); stats.byName++; }
    else stats.unmatched++;
  }
  await runBatches(db, updates);
  return stats;
}
