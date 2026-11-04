/**
 * Card scanner: a phone photo → the catalogue entry → value and sales.
 *
 * Recognition is two-stage and deliberately simple:
 *   1. A vision model (Workers AI, Llama 3.2 Vision) *reads* the card: name, collector number ("199/165"),
 *      language, finish, and a grading slab if present. Reading printed text is robust to glare, foil and
 *      skewed phone photos – far more than image hashing would be, and it needs no training data.
 *   2. The printed facts are matched against the catalogue: the number pins the card inside a set, the set
 *      size ("/165") narrows the set, the name confirms it. Candidates are scored and the best one is returned
 *      together with alternatives, so a wrong read is one tap away from the right card.
 * The provider is injected (Workers AI in production, nothing locally); the matching is pure and unit-tested.
 */
import type { SqlDb } from "./db/adapter.ts";
import type { CardSummary } from "../shared/types.ts";
import { normalizeName } from "./ingest/matcher.ts";
import { getCardSummaries, searchCards } from "./services/catalog.ts";
import { nowIso } from "./db/index.ts";

export interface ScanFacts {
  name: string | null;
  number: string | null;      // printed collector number without the set total, e.g. "199", "SV049", "TG12"
  total: number | null;       // printed set size after the slash, e.g. 165
  language: string | null;    // de | en | jp | fr | it | es | pt | other
  finish: "normal" | "holo" | "reverse" | null;
  gradingCompany: string | null;
  grade: number | null;
  setHint: string | null;     // set name / symbol text if the model saw one
  raw: string;                // model output, for debugging and later training
}

export interface ScanCandidate { card: CardSummary; score: number; reasons: string[] }
export interface ScanResult { facts: ScanFacts; best: ScanCandidate | null; alternatives: ScanCandidate[]; confidence: number; ms: number }

export interface ScanProvider { readCard(image: Uint8Array, mime: string): Promise<string> }

let provider: ScanProvider | null = null;
export function useScanProvider(p: ScanProvider | null) { provider = p; }
export function scanAvailable() { return provider != null; }

export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const READ_PROMPT = `You are reading a photo of a single Pokémon trading card. Extract exactly what is printed on it and answer with one JSON object only, no prose:
{"name": "<card name as printed, e.g. Glurak-ex or Charizard ex>",
 "number": "<collector number printed in a corner at the bottom, e.g. 199/165, 025/198, SV049/SV122, TG12/TG30, 4/102, 006>",
 "language": "<de|en|jp|fr|it|es|pt|other – language of the card text>",
 "finish": "<normal|holo|reverse – reverse means the frame outside the artwork is shiny>",
 "grading": "<null, or company and grade if the card sits in a graded slab, e.g. PSA 10, CGC 9.5, BGS 9>",
 "set": "<set name or symbol text if visible, else null>"}
If something is unreadable use null. Never guess a number you cannot read.`;

/** Workers AI binding → provider. Accepts the first-call Meta licence prompt automatically. */
export function workersAiProvider(ai: { run(model: string, input: Record<string, unknown>): Promise<unknown> }): ScanProvider {
  return {
    async readCard(image) {
      const input = { image: [...image], prompt: READ_PROMPT, max_tokens: 300, temperature: 0.1 };
      const call = async () => (await ai.run(VISION_MODEL, input)) as { response?: string } | string;
      let out: { response?: string } | string;
      try { out = await call(); }
      catch (e) {
        if (!/licen[cs]e|agree/i.test(String((e as Error).message))) throw e;
        await ai.run(VISION_MODEL, { prompt: "agree" });
        out = await call();
      }
      return typeof out === "string" ? out : out.response ?? "";
    },
  };
}

/** "199/165" → { number: "199", total: 165 }; "SV049/SV122" → { "SV049", 122 }; "006" → { "006", null }. */
export function parseNumber(s: string | null | undefined): { number: string | null; total: number | null } {
  if (!s) return { number: null, total: null };
  const t = s.toUpperCase().replace(/\s+/g, "").replace(/[OО]/g, "0").replace(/[^A-Z0-9\/]/g, "");
  const m = t.match(/^([A-Z]{0,4}\d{1,4}[A-Z]?)(?:\/([A-Z]{0,4})?(\d{1,4}))?$/);
  if (!m) return { number: null, total: null };
  return { number: m[1]!, total: m[3] ? Number(m[3]) : null };
}

/** Collector numbers compare without leading zeros and case: "006" ≡ "6", "sv049" ≡ "SV049". */
export function numberKey(s: string | null | undefined): string {
  if (!s) return "";
  const u = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = u.match(/^([A-Z]*)0*(\d+)([A-Z]*)$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : u;
}

export function parseFacts(raw: string): ScanFacts {
  const facts: ScanFacts = { name: null, number: null, total: null, language: null, finish: null, gradingCompany: null, grade: null, setHint: null, raw };
  const m = raw.match(/\{[\s\S]*\}/);
  let j: Record<string, unknown> = {};
  if (m) { try { j = JSON.parse(m[0].replace(/,\s*\}/g, "}")); } catch { j = {}; } }
  const str = (k: string) => { const v = j[k]; return typeof v === "string" && v.trim() && !/^(null|none|n\/a|unknown)$/i.test(v.trim()) ? v.trim() : null; };
  facts.name = str("name");
  const num = parseNumber(str("number") ?? raw.match(/\b([A-Z]{0,4}\d{1,4}\s*\/\s*[A-Z]{0,4}\d{1,4})\b/i)?.[1]);
  facts.number = num.number; facts.total = num.total;
  const lang = str("language")?.toLowerCase() ?? null;
  facts.language = lang ? ({ german: "de", deutsch: "de", english: "en", japanese: "jp", french: "fr", italian: "it", spanish: "es", portuguese: "pt" } as Record<string, string>)[lang] ?? (["de", "en", "jp", "fr", "it", "es", "pt"].includes(lang) ? lang : "other") : null;
  const fin = str("finish")?.toLowerCase() ?? null;
  facts.finish = fin ? (fin.includes("reverse") ? "reverse" : fin.includes("holo") || fin.includes("foil") ? "holo" : "normal") : null;
  const g = (str("grading") ?? "").match(/\b(PSA|BGS|CGC|GSG|AP|TAG|ACE|SGC)\s*[-:]?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?!\d)/i);
  if (g) { facts.gradingCompany = g[1]!.toUpperCase(); facts.grade = Number(g[2]); }
  facts.setHint = str("set");
  return facts;
}

interface CandRow { id: string; local_id: string; name_de: string | null; name_en: string | null; set_id: string; set_name_de: string | null; set_name_en: string | null; abbreviation: string | null; card_count_official: number | null; card_count_total: number | null; release_date: string | null }

/**
 * Score catalogue rows against the printed facts. The number inside a set is nearly unique, the set size
 * separates sets that reuse numbers, the name decides between the rest.
 */
export function scoreCandidate(row: CandRow, facts: ScanFacts): { score: number; reasons: string[] } {
  let score = 0; const reasons: string[] = [];
  if (facts.number && numberKey(row.local_id) === numberKey(facts.number)) { score += 4; reasons.push("Nummer"); }
  if (facts.total != null) {
    if (row.card_count_official === facts.total) { score += 3; reasons.push("Setgröße"); }
    else if (row.card_count_total === facts.total) { score += 2; reasons.push("Setgröße (gesamt)"); }
    else if (row.card_count_official != null && row.card_count_official !== facts.total) score -= 2;
  }
  const n = normalizeName(facts.name);
  if (n) {
    const de = normalizeName(row.name_de), en = normalizeName(row.name_en);
    if (n === de || n === en) { score += 4; reasons.push("Name"); }
    else {
      const toks = n.split(" ").filter((t) => t.length > 2);
      const hit = toks.filter((t) => de.includes(t) || en.includes(t)).length;
      if (hit && hit === toks.length) { score += 3; reasons.push("Name (Teil)"); }
      else if (hit) { score += 1.5; reasons.push("Name (ähnlich)"); }
      else score -= 1.5;
    }
    if (facts.language === "de" && n === de) score += 0.5;
    if (facts.language === "en" && n === en) score += 0.5;
  }
  const hint = normalizeName(facts.setHint);
  if (hint && (normalizeName(row.set_name_de).includes(hint) || normalizeName(row.set_name_en).includes(hint) || normalizeName(row.abbreviation) === hint)) { score += 1.5; reasons.push("Set"); }
  // Newer sets are what people scan most at shows; a tiny tie-breaker, never decisive.
  if (row.release_date) score += Math.min(0.4, Math.max(0, (Number(row.release_date.slice(0, 4)) - 1999) / 100));
  return { score, reasons };
}

const SELECT = `SELECT c.id, c.local_id, c.name_de, c.name_en, c.set_id, s.name_de AS set_name_de, s.name_en AS set_name_en, s.abbreviation, s.card_count_official, s.card_count_total, s.release_date
  FROM cards c JOIN sets s ON s.id = c.set_id`;

export async function findCandidates(db: SqlDb, facts: ScanFacts, limit = 6): Promise<ScanCandidate[]> {
  const rows = new Map<string, CandRow>();
  if (facts.number) {
    const key = numberKey(facts.number);
    const digits = key.match(/\d+/)?.[0] ?? "";
    // local_id variants: "199", "0199", "SV049"; compare on the stripped key in JS after a cheap LIKE prefilter.
    for (const r of await db.all<CandRow>(`${SELECT} WHERE c.local_id LIKE ? LIMIT 400`, [`%${digits}%`])) if (numberKey(r.local_id) === key) rows.set(r.id, r);
  }
  if (facts.name && rows.size < 3) {
    const found = await searchCards(db, facts.name, { limit: 40, withQuotes: false });
    const ids = found.items.map((c) => c.id).filter((id) => !rows.has(id));
    for (const chunk of [ids.slice(0, 90)]) if (chunk.length) for (const r of await db.all<CandRow>(`${SELECT} WHERE c.id IN (${chunk.map(() => "?").join(",")})`, chunk)) rows.set(r.id, r);
  }
  if (!rows.size) return [];
  const scored = [...rows.values()].map((r) => ({ id: r.id, ...scoreCandidate(r, facts) })).sort((a, b) => b.score - a.score).slice(0, limit);
  const summaries = await getCardSummaries(db, scored.map((s) => s.id));
  return scored.filter((s) => summaries.has(s.id)).map((s) => ({ card: summaries.get(s.id)!, score: Math.round(s.score * 10) / 10, reasons: s.reasons }));
}

export async function scanImage(db: SqlDb, image: Uint8Array, mime: string, userId: number | null): Promise<ScanResult> {
  if (!provider) throw new Error("Scanner nicht verfügbar");
  const t0 = Date.now();
  const raw = await provider.readCard(image, mime);
  const facts = parseFacts(raw);
  const cands = await findCandidates(db, facts);
  const best = cands[0] ?? null;
  const gap = best ? best.score - (cands[1]?.score ?? 0) : 0;
  // 11 = number + set size + name all agree; confidence saturates there.
  const confidence = best ? Math.max(0, Math.min(1, best.score / 11)) * (gap >= 2 ? 1 : 0.7 + 0.15 * gap) : 0;
  const result: ScanResult = { facts, best, alternatives: cands.slice(1), confidence: Math.round(confidence * 100) / 100, ms: Date.now() - t0 };
  await db.run("INSERT INTO scans(user_id, created_at, facts, card_id, confidence, ms) VALUES (?, ?, ?, ?, ?, ?)",
    [userId, nowIso(), JSON.stringify({ ...facts, raw: facts.raw.slice(0, 600) }), best?.card.id ?? null, result.confidence, result.ms]).catch(() => {});
  return result;
}
