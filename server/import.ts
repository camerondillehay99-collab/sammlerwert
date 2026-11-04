/**
 * Collection import from CSV/TSV exports (Collectr, Card Ladder, TCGplayer, PSA set-registry lists, our own export, any spreadsheet).
 * Nobody publishes a stable column spec, so columns are recognised by header aliases, delimiters are sniffed and every row is matched
 * against the catalogue the same way a scan is (number + set + name). The user sees a preview with confidence before anything is saved.
 */
import type { SqlDb } from "./db/adapter.ts";
import type { CardSummary, Condition, Language, Variant } from "../shared/types.ts";
import { findCandidates, numberKey, parseNumber, type ScanFacts } from "./scan.ts";
import { getCardSummaries } from "./services/catalog.ts";
import { lookupCert, certToFacts, psaConfigured } from "./psa.ts";

export type ImportSource = "collectr" | "cardladder" | "tcgplayer" | "sammlerwert" | "psa" | "generic";

export interface ImportRowInput { name?: string; set?: string; setCode?: string; number?: string; cardId?: string; quantity?: string; condition?: string; language?: string; variant?: string; grader?: string; grade?: string; cert?: string; price?: string; currency?: string; date?: string; notes?: string; collection?: string }

export interface ImportRow {
  line: number;
  input: ImportRowInput;
  parsed: { language: Language; variant: Variant; condition: Condition; gradingCompany: string | null; grade: number | null; certNo: string | null; quantity: number; purchasePriceEur: number | null; purchasedAt: string | null; notes: string | null; collectionName: string | null };
  match: { card: CardSummary; confidence: number; reasons: string[] } | null;
  alternatives: CardSummary[];
  status: "ok" | "unsure" | "none" | "skip";
  problem?: string;
}

export interface ImportPreview { source: ImportSource; delimiter: string; columns: Record<string, string>; rows: ImportRow[]; stats: { total: number; ok: number; unsure: number; none: number; skip: number }; psaLookups: number }

// ---------- CSV ----------
export function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: (head.match(new RegExp(`\\${d}`, "g")) ?? []).length }));
  return counts.sort((a, b) => b.n - a.n)[0]!.n ? counts.sort((a, b) => b.n - a.n)[0]!.d : ",";
}

export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------- header recognition ----------
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9#]+/g, " ").trim();
const ALIASES: Record<keyof ImportRowInput, string[]> = {
  cardId: ["karten id", "card id", "tcgdex id", "tcgdex", "id"],
  name: ["karte", "name", "card name", "cardname", "card", "title", "product name", "product", "item", "kartenname", "pokemon", "subject", "description"],
  set: ["set", "set name", "setname", "expansion", "edition", "series", "erweiterung", "set en", "brand"],
  setCode: ["set code", "setcode", "set id", "abbreviation", "abbr", "set abbreviation", "code"],
  number: ["nummer", "number", "card number", "cardnumber", "no", "nr", "#", "card #", "collector number", "collector no", "card no", "num"],
  quantity: ["anzahl", "quantity", "qty", "count", "amount", "owned", "menge", "quantity owned", "qty owned"],
  condition: ["zustand", "condition", "cond", "card condition"],
  language: ["sprache", "language", "lang"],
  variant: ["variante", "variant", "finish", "printing", "foil", "holo", "print", "edition type", "rarity"],
  grader: ["grading", "grading company", "grader", "company", "grade company", "certification company", "graded by", "service"],
  grade: ["note", "grade", "grading grade", "psa grade", "card grade"],
  cert: ["zertifikat", "cert", "cert #", "cert number", "certification number", "cert no", "serial", "psa cert", "certificate", "cert id"],
  price: ["kaufpreis", "purchase price", "price paid", "paid", "cost", "buy price", "acquisition price", "purchase", "cost basis", "price", "einkaufspreis"],
  currency: ["wahrung", "currency"],
  date: ["gekauft am", "kaufdatum", "purchase date", "date purchased", "date acquired", "acquired", "date added", "added", "date"],
  notes: ["notizen", "notes", "note text", "comment", "comments", "bemerkung"],
  collection: ["sammlung", "collection", "folder", "binder", "list", "portfolio"],
};
const PRIORITY: Array<keyof ImportRowInput> = ["cardId", "cert", "setCode", "number", "name", "set", "quantity", "condition", "language", "variant", "grader", "grade", "price", "currency", "date", "notes", "collection"];

export function mapColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const used = new Set<number>();
  for (const key of PRIORITY) {
    const aliases = ALIASES[key];
    let best = -1, bestRank = Infinity;
    headers.forEach((hd, i) => {
      if (used.has(i)) return;
      const n = norm(hd);
      const rank = aliases.indexOf(n);
      if (rank >= 0 && rank < bestRank) { best = i; bestRank = rank; }
    });
    if (best >= 0) { map[key] = best; used.add(best); }
  }
  // "Grade" column holding "PSA 10" covers grader too; "Number" holding "199/165" covers total.
  return map;
}

export function detectSource(headers: string[]): ImportSource {
  const h = headers.map(norm);
  if (h.includes("karten id") || (h.includes("karte") && h.includes("nummer"))) return "sammlerwert";
  if (h.some((x) => x.includes("cert")) && !h.includes("set")) return "psa";
  if (h.includes("product name") || h.includes("product line") || h.includes("printing")) return "tcgplayer";
  if (h.includes("card name") && h.includes("card number")) return "collectr";
  if (h.includes("grading company") || h.includes("purchase price")) return "cardladder";
  return "generic";
}

// ---------- field normalisation ----------
const LANG_MAP: Record<string, Language> = { de: "de", deutsch: "de", german: "de", ger: "de", en: "en", english: "en", englisch: "en", eng: "en", jp: "jp", ja: "jp", japanese: "jp", japanisch: "jp", jap: "jp", fr: "fr", french: "fr", franzosisch: "fr", it: "it", italian: "it", italienisch: "it", es: "es", spanish: "es", spanisch: "es", pt: "pt", portuguese: "pt", ko: "other", korean: "other", zh: "other", chinese: "other" };
export function parseLanguage(s: string | undefined, fallback: Language): Language { const k = norm(s ?? ""); return k ? LANG_MAP[k] ?? (k.includes("german") || k.includes("deutsch") ? "de" : fallback) : fallback; }

export function parseCondition(s: string | undefined): Condition {
  const k = norm(s ?? "");
  if (!k) return "NM";
  if (/^(mt|mint|gem mint|m)$/.test(k)) return "MT";
  if (/near mint|^nm|^nm mt|nm mint/.test(k)) return "NM";
  if (/^ex|excellent|^lp$|lightly played|light played/.test(k)) return "EX";
  if (/^gd|good|^vg|very good|^mp$|moderately played/.test(k)) return "GD";
  if (/^lp/.test(k)) return "LP";
  if (/^pl$|played|^hp$|heavily played|^hp /.test(k)) return "PL";
  if (/^po|poor|damaged|^dmg/.test(k)) return "PO";
  return "NM";
}

export function parseVariant(s: string | undefined): Variant {
  const k = norm(s ?? "");
  if (/reverse/.test(k)) return "reverse";
  if (/1st|first ed|1 edition|erste/.test(k)) return "firstEdition";
  if (/holo|foil|shiny|glanz/.test(k) && !/non|unholo|no foil/.test(k)) return "holo";
  if (/promo/.test(k)) return "promo";
  return "normal";
}

export function parseGrading(grader: string | undefined, grade: string | undefined): { company: string | null; grade: number | null } {
  const both = `${grader ?? ""} ${grade ?? ""}`.toUpperCase();
  const c = both.match(/\b(PSA|BGS|CGC|GSG|AP|TAG|ACE|SGC)\b/)?.[1] ?? null;
  const g = (grade ?? both).match(/(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?!\d)/)?.[1];
  if (!c && !g) return { company: null, grade: null };
  if (g && !c) return /raw|ungraded|none/i.test(both) ? { company: null, grade: null } : { company: "OTHER", grade: Number(g) };
  return { company: c === "SGC" ? "OTHER" : c, grade: g ? Number(g) : null };
}

const RATES: Record<string, number> = { EUR: 1, USD: 0.92, GBP: 1.17, CHF: 1.06, JPY: 0.0061, CAD: 0.67, AUD: 0.6 };
export function parsePrice(s: string | undefined, currency: string | undefined): { eur: number | null; original: string | null } {
  const raw = (s ?? "").trim();
  if (!raw) return { eur: null, original: null };
  const cur = (currency ?? "").toUpperCase().trim() || (raw.includes("$") ? "USD" : raw.includes("£") ? "GBP" : raw.includes("CHF") ? "CHF" : raw.includes("¥") ? "JPY" : "EUR");
  let n = raw.replace(/[^\d.,-]/g, "");
  if (n.includes(",") && n.includes(".")) n = n.lastIndexOf(",") > n.lastIndexOf(".") ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
  else if (n.includes(",")) n = /,\d{3}$/.test(n) && !/,\d{1,2}$/.test(n) ? n.replace(/,/g, "") : n.replace(",", ".");
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return { eur: null, original: raw };
  const rate = RATES[cur] ?? 1;
  return { eur: Math.round(v * rate * 100) / 100, original: cur !== "EUR" ? `${v} ${cur}` : null };
}

export function parseDate(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`; // US order (Collectr, Card Ladder)
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : new Date(d).toISOString().slice(0, 10);
}

// ---------- matching ----------
interface SetRef { id: string; name_de: string | null; name_en: string | null; abbreviation: string | null; card_count_official: number | null }
let setCache: { at: number; sets: SetRef[] } | null = null;
async function allSets(db: SqlDb): Promise<SetRef[]> {
  if (setCache && Date.now() - setCache.at < 300_000) return setCache.sets;
  const sets = await db.all<SetRef>("SELECT id, name_de, name_en, abbreviation, card_count_official FROM sets");
  setCache = { at: Date.now(), sets };
  return sets;
}

/** Sets whose name/abbreviation equals the hint (normalised); falls back to containment when nothing equals. */
export function matchSets(sets: SetRef[], hint: string | undefined, code: string | undefined): SetRef[] {
  const h = norm(hint ?? ""), c = norm(code ?? "");
  if (c) { const byCode = sets.filter((s) => norm(s.abbreviation ?? "") === c || s.id.toLowerCase() === c); if (byCode.length) return byCode; }
  if (!h) return [];
  const eq = sets.filter((s) => norm(s.name_en ?? "") === h || norm(s.name_de ?? "") === h || norm(s.abbreviation ?? "") === h || s.id.toLowerCase() === h);
  if (eq.length) return eq;
  const strip = (x: string) => x.replace(/\b(pokemon|tcg|sword shield|scarlet violet|sun moon|xy|sm|swsh|sv)\b/g, "").replace(/\s+/g, " ").trim();
  const hs = strip(h);
  if (!hs) return [];
  return sets.filter((s) => { const en = strip(norm(s.name_en ?? "")), de = strip(norm(s.name_de ?? "")); return (en && (en === hs || en.includes(hs) || hs.includes(en))) || (de && (de === hs || de.includes(hs) || hs.includes(de))); });
}

export interface ImportOptions { source?: ImportSource; defaultLanguage?: Language; maxPsaLookups?: number }

export async function previewImport(db: SqlDb, text: string, opts: ImportOptions = {}): Promise<ImportPreview> {
  const delimiter = sniffDelimiter(text);
  const table = parseCsv(text, delimiter);
  if (table.length < 2) return { source: opts.source ?? "generic", delimiter, columns: {}, rows: [], stats: { total: 0, ok: 0, unsure: 0, none: 0, skip: 0 }, psaLookups: 0 };
  const headers = table[0]!.map((x) => x.trim());
  const cols = mapColumns(headers);
  const source = opts.source ?? detectSource(headers);
  const defaultLanguage: Language = opts.defaultLanguage ?? (source === "sammlerwert" || source === "generic" ? "de" : "en");
  const sets = await allSets(db);
  const rows: ImportRow[] = [];
  let psaLookups = 0;
  const maxPsa = opts.maxPsaLookups ?? 40;
  for (let li = 1; li < Math.min(table.length, 2001); li++) {
    const r = table[li]!;
    const cell = (k: keyof ImportRowInput) => (cols[k] != null ? (r[cols[k]!] ?? "").trim() : "");
    const input: ImportRowInput = {};
    for (const k of Object.keys(ALIASES) as Array<keyof ImportRowInput>) { const v = cell(k); if (v) input[k] = v; }
    const grading = parseGrading(input.grader, input.grade);
    const price = parsePrice(input.price, input.currency);
    const qty = Math.max(1, Math.min(999, Math.round(Number((input.quantity ?? "1").replace(",", ".")) || 1)));
    const notesParts = [input.notes, price.original ? `Kaufpreis importiert: ${price.original}` : null].filter(Boolean);
    const parsed: ImportRow["parsed"] = {
      language: parseLanguage(input.language, defaultLanguage), variant: parseVariant(input.variant), condition: parseCondition(input.condition),
      gradingCompany: grading.company, grade: grading.grade, certNo: input.cert ? input.cert.replace(/\s+/g, "") : null, quantity: qty,
      purchasePriceEur: price.eur, purchasedAt: parseDate(input.date), notes: notesParts.length ? notesParts.join(" · ") : null, collectionName: input.collection ?? null,
    };
    const row: ImportRow = { line: li + 1, input, parsed, match: null, alternatives: [], status: "none" };
    rows.push(row);
    // 1) exact catalogue id (our own export)
    if (input.cardId && /^[a-z0-9.]+-[A-Za-z0-9]+$/i.test(input.cardId)) {
      const c = (await getCardSummaries(db, [input.cardId])).get(input.cardId);
      if (c) { row.match = { card: c, confidence: 1, reasons: ["Karten-ID"] }; row.status = "ok"; continue; }
    }
    // 2) PSA certificate (fills name/number/set/grade when the list only has cert numbers)
    let facts: ScanFacts | null = null;
    if (parsed.certNo && (grading.company === "PSA" || source === "psa" || !input.name) && psaConfigured() && psaLookups < maxPsa) {
      try {
        psaLookups++;
        const cert = await lookupCert(db, parsed.certNo);
        if (cert) { facts = certToFacts(cert); parsed.gradingCompany = "PSA"; parsed.grade = cert.grade ?? parsed.grade; if (!input.name) input.name = facts.name ?? undefined; if (!input.set) input.set = facts.setHint ?? undefined; if (!input.number) input.number = facts.number ?? undefined; }
        else row.problem = "PSA kennt dieses Zertifikat nicht.";
      } catch (e) { row.problem = (e as Error).message; }
    }
    if (!input.name && !input.number) { row.status = "skip"; row.problem ??= "Weder Name noch Nummer."; continue; }
    const num = parseNumber(input.number);
    if (!facts) facts = { name: input.name ?? null, number: num.number, total: num.total, language: parsed.language, finish: parsed.variant === "holo" || parsed.variant === "reverse" ? parsed.variant : null, gradingCompany: parsed.gradingCompany, grade: parsed.grade, setHint: input.set ?? null, raw: "" };
    else { facts.number = num.number ?? facts.number; facts.total = num.total ?? facts.total; if (input.name) facts.name = input.name; }
    // 3) set known + number known → direct hit
    const setHits = matchSets(sets, input.set ?? facts.setHint ?? undefined, input.setCode);
    if (setHits.length && facts.number) {
      const key = numberKey(facts.number);
      const ph = setHits.map(() => "?").join(",");
      const cands = await db.all<{ id: string; local_id: string }>(`SELECT id, local_id FROM cards WHERE set_id IN (${ph})`, setHits.map((s) => s.id));
      const hit = cands.filter((c) => numberKey(c.local_id) === key);
      if (hit.length === 1) {
        const c = (await getCardSummaries(db, [hit[0]!.id])).get(hit[0]!.id);
        if (c) {
          const nameOk = !facts.name || sameName(facts.name, c);
          row.match = { card: c, confidence: nameOk ? 0.98 : 0.7, reasons: nameOk ? ["Set", "Nummer", "Name"] : ["Set", "Nummer"] }; row.status = nameOk ? "ok" : "unsure";
          if (!nameOk) row.alternatives = (await findCandidates(db, facts, 4, { setWeight: 4 })).map((x) => x.card).filter((x) => x.id !== c.id).slice(0, 3);
          continue;
        }
      }
    }
    // 4) general matcher (scanner scoring with a strong set weight)
    const cands = await findCandidates(db, facts, 5, { setWeight: input.set || facts.setHint ? 4 : 1.5 });
    if (!cands.length) { row.status = "none"; row.problem ??= "Keine passende Karte gefunden."; continue; }
    const best = cands[0]!, gap = best.score - (cands[1]?.score ?? 0);
    const confidence = Math.max(0, Math.min(1, best.score / 12)) * (gap >= 2 ? 1 : 0.7 + 0.15 * gap);
    row.match = { card: best.card, confidence: Math.round(confidence * 100) / 100, reasons: best.reasons };
    row.alternatives = cands.slice(1, 4).map((c) => c.card);
    row.status = confidence >= 0.75 ? "ok" : confidence >= 0.35 ? "unsure" : "none";
    if (row.status === "none") row.problem ??= "Unsicher – bitte Karte wählen.";
  }
  const stats = { total: rows.length, ok: 0, unsure: 0, none: 0, skip: 0 };
  for (const r of rows) stats[r.status]++;
  const columns: Record<string, string> = {};
  for (const [k, i] of Object.entries(cols)) columns[k] = headers[i]!;
  return { source, delimiter, columns, rows, stats, psaLookups };
}

function sameName(name: string, c: CardSummary): boolean {
  const n = norm(name).replace(/\b(ex|gx|v|vmax|vstar|star)\b/g, "").trim();
  const de = norm(c.nameDe ?? "").replace(/\b(ex|gx|v|vmax|vstar)\b/g, "").trim(), en = norm(c.nameEn ?? "").replace(/\b(ex|gx|v|vmax|vstar)\b/g, "").trim();
  if (!n) return true;
  return n === de || n === en || de.includes(n) || en.includes(n) || n.includes(en && en.length > 3 ? en : "\u0000") || n.includes(de && de.length > 3 ? de : "\u0000");
}
