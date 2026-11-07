/**
 * Population reports – how many copies of a card each grading company has graded, per grade.
 *
 *  - PSA: public API `/pop/GetPSASpecPopulation/{specID}`. PSA keys populations by its own spec id, which we learn from
 *    any PSA certificate of the card (cert lookups store SpecID + the matched card). Once a spec is known the report is
 *    fetched and refreshed nightly within PSA's daily quota (100 calls/day on the free tier, shared with cert lookups).
 *  - CGC / BGS / SGC / TAG publish no API; rows for them only arrive through imports and are shown as-is.
 */
import type { SqlDb } from "../db/adapter.ts";
import { config } from "../config.ts";
import { nowIso } from "../db/index.ts";
import { psaConfigured, PsaError } from "../psa.ts";
import type { Population } from "../../shared/types.ts";

const GRADE_ORDER = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"];

interface PopRow { card_id: string; company: string; spec_id: string | null; description: string | null; total: number; grades: string; fetched_at: string }

export function rowToPopulation(r: PopRow): Population {
  const g = JSON.parse(r.grades || "{}") as Record<string, number>;
  const grades: Array<[string, number]> = GRADE_ORDER.filter((k) => g[k]).map((k) => [k, g[k]!]);
  if (g.auth) grades.push(["auth", g.auth]);
  const gems = g["10"] ?? 0;
  return { company: r.company as Population["company"], specId: r.spec_id, description: r.description, total: r.total, gems, gemRate: r.total ? gems / r.total : null, grades, fetchedAt: r.fetched_at };
}

export async function getPopulations(db: SqlDb, cardId: string): Promise<Population[]> {
  const rows = await db.all<PopRow>("SELECT * FROM populations WHERE card_id = ? ORDER BY company", [cardId]);
  const order = ["PSA", "CGC", "BGS", "SGC", "TAG"];
  return rows.map(rowToPopulation).sort((a, b) => order.indexOf(a.company) - order.indexOf(b.company));
}

/** PSA's per-grade model (`Grade10`, `Grade8_5`, `Grade9Q`, `Auth`, `Total`) → our compact {"10": n, "8.5": n, "q": n, "auth": n}. */
export function parsePsaPop(j: Record<string, unknown>): { description: string | null; total: number; grades: Record<string, number> } {
  const pop = ((j.PSAPop ?? j.psaPop ?? j) as Record<string, unknown>) ?? {};
  const n = (k: string) => { const v = Number(pop[k]); return Number.isFinite(v) ? v : 0; };
  const grades: Record<string, number> = {};
  let q = 0;
  for (const g of GRADE_ORDER) {
    const key = `Grade${g.replace(".", "_")}`;
    const v = n(key); if (v) grades[g] = v;
    const qv = n(`${key}Q`); if (qv) q += qv;
  }
  if (n("Auth")) grades.auth = n("Auth");
  if (q) grades.q = q;
  const total = n("Total") || Object.values(grades).reduce((s, v) => s + v, 0);
  return { description: j.Description == null ? null : String(j.Description), total, grades };
}

export class PopError extends Error { constructor(message: string, public status: number) { super(message); } }

/** Fetch and store PSA's population for a spec, linked to a card. Throws PopError on quota/auth problems so callers can stop a batch. */
export async function refreshPsaPopulation(db: SqlDb, cardId: string, specId: string): Promise<Population> {
  if (!psaConfigured()) throw new PopError("PSA-Abfragen sind nicht aktiviert (PSA_API_TOKEN fehlt).", 503);
  const res = await fetch(`${config.psa.base}/pop/GetPSASpecPopulation/${encodeURIComponent(specId)}`, { headers: { authorization: `bearer ${config.psa.token}`, accept: "application/json" } });
  if (res.status === 429) throw new PopError("PSA-Tageslimit erreicht.", 429);
  if (res.status === 401 || res.status === 403) throw new PopError(`PSA hat den API-Token abgelehnt (HTTP ${res.status}).`, 502);
  if (!res.ok) throw new PopError(`PSA antwortet mit HTTP ${res.status}.`, 502);
  const j = (await res.json()) as Record<string, unknown>;
  const parsed = parsePsaPop(j);
  const row: PopRow = { card_id: cardId, company: "PSA", spec_id: specId, description: parsed.description, total: parsed.total, grades: JSON.stringify(parsed.grades), fetched_at: nowIso() };
  await db.run(`INSERT INTO populations(card_id, company, spec_id, description, total, grades, fetched_at) VALUES (?, 'PSA', ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, company) DO UPDATE SET spec_id = excluded.spec_id, description = excluded.description, total = excluded.total, grades = excluded.grades, fetched_at = excluded.fetched_at`,
    [cardId, specId, row.description, row.total, row.grades, row.fetched_at]);
  return rowToPopulation(row);
}

/** PSA specs we know (from cert lookups) that have no population yet or are older than `maxAgeDays`. */
export async function duePsaSpecs(db: SqlDb, limit: number, maxAgeDays = 7): Promise<Array<{ cardId: string; specId: string }>> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const rows = await db.all<{ card_id: string; spec_id: string }>(`
    WITH specs AS (
      SELECT DISTINCT c.card_id, json_extract(c.payload, '$.specId') AS spec_id
      FROM psa_certs c WHERE c.card_id IS NOT NULL AND c.payload != 'null' AND json_extract(c.payload, '$.specId') IS NOT NULL)
    SELECT s.card_id, CAST(s.spec_id AS TEXT) spec_id FROM specs s
    LEFT JOIN populations p ON p.card_id = s.card_id AND p.company = 'PSA'
    WHERE p.card_id IS NULL OR p.fetched_at < ?
    ORDER BY (p.card_id IS NULL) DESC, p.fetched_at ASC LIMIT ?`, [cutoff, limit]);
  return rows.map((r) => ({ cardId: r.card_id, specId: r.spec_id }));
}

/** Nightly: refresh due PSA populations within the daily budget; stops at the first quota/auth error. */
export async function refreshPsaPopulations(db: SqlDb, budget = 60, log: (m: string) => void = () => {}): Promise<{ due: number; refreshed: number; stopped: string | null }> {
  if (!psaConfigured()) { log("PSA-Populationen: kein Token – übersprungen"); return { due: 0, refreshed: 0, stopped: "no token" }; }
  const due = await duePsaSpecs(db, budget);
  let refreshed = 0, stopped: string | null = null;
  for (const d of due) {
    try { await refreshPsaPopulation(db, d.cardId, d.specId); refreshed++; }
    catch (e) {
      if (e instanceof PopError && (e.status === 429 || e.status === 502 || e.status === 503)) { stopped = e.message; log(`PSA-Populationen: ${e.message} – Lauf beendet`); break; }
      log(`PSA-Population ${d.cardId} (spec ${d.specId}): ${(e as Error).message}`);
    }
  }
  log(`PSA-Populationen: ${refreshed}/${due.length} aktualisiert`);
  return { due: due.length, refreshed, stopped };
}

/** After a cert lookup resolved a card: fetch its population right away if we have none yet (one call, best effort). */
export async function populationFromCert(db: SqlDb, cardId: string, specId: number | string | null): Promise<void> {
  if (specId == null) return;
  const have = await db.first<{ card_id: string }>("SELECT card_id FROM populations WHERE card_id = ? AND company = 'PSA'", [cardId]);
  if (have) return;
  try { await refreshPsaPopulation(db, cardId, String(specId)); } catch (e) { if (!(e instanceof PopError || e instanceof PsaError)) throw e; }
}
