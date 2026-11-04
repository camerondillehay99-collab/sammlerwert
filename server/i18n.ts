/**
 * UI translations for languages beyond German and English.
 * Source strings live in shared/i18n-keys.json (German). Each target language is translated once with a
 * Workers AI text model and cached in D1 (ui_translations) plus the isolate memo; the client caches it too.
 * Placeholders like {n} and product names must survive – anything that breaks that rule falls back to English.
 */
import type { SqlDb } from "./db/adapter.ts";
import { memo, memoClear, readMany, stmt } from "./db/adapter.ts";
import KEYS from "../shared/i18n-keys.json";

export interface TextAi { run(model: string, input: Record<string, unknown>): Promise<unknown> }
let ai: TextAi | null = null;
export function useTextAi(a: TextAi | null) { ai = a; }
export function textAiAvailable() { return ai != null; }

export const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const UI_LANGS: Record<string, string> = { fr: "French", es: "Spanish", it: "Italian", nl: "Dutch", pt: "European Portuguese", pl: "Polish", cs: "Czech", sv: "Swedish", da: "Danish", tr: "Turkish", ja: "Japanese", ko: "Korean", zh: "Simplified Chinese" };
const BATCH = 40;
const KEEP = ["Sammlerwert", "Cardmarket", "Collectr", "Card Ladder", "TCGplayer", "PSA", "CGC", "BGS", "eBay", "Pokémon"];

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join("|");

function prompt(lang: string, items: string[]): string {
  return `You translate user-interface strings of a trading-card collection app from German to ${lang}.
Rules: keep every placeholder in curly braces exactly as it is (e.g. {n}, {BRAND}); keep product names unchanged (${KEEP.join(", ")}); keep punctuation style, arrows and the "·" separators; use the informal register where the language has one; keep translations short like UI labels; "Sammlung" is the user's card collection, "Set" is a card expansion, "Karte" is a trading card, "Note" means a grade.
Answer with ONLY a JSON array of ${items.length} strings in the same order, no commentary.
${JSON.stringify(items)}`;
}

async function translateBatch(lang: string, items: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ai) return out;
  const res = await ai.run(TEXT_MODEL, { messages: [{ role: "user", content: prompt(lang, items) }], max_tokens: 4000, temperature: 0.1 }) as { response?: string } | string;
  const text = typeof res === "string" ? res : res?.response ?? "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr) || arr.length !== items.length) return out;
  items.forEach((src, i) => {
    const t = arr[i];
    if (typeof t !== "string" || !t.trim()) return;
    if (placeholders(src) !== placeholders(t)) return; // a lost placeholder would break the UI – keep English instead
    out.set(src, t.trim());
  });
  return out;
}

export async function ensureI18nTable(db: SqlDb) {
  await db.exec("CREATE TABLE IF NOT EXISTS ui_translations (lang TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (lang, key))");
}

/** Cached dictionary for a language; missing strings are translated now (parallel batches) when an AI model is available. */
export async function uiDictionary(db: SqlDb, lang: string, opts: { translate?: boolean; maxBatches?: number } = {}): Promise<{ entries: Record<string, string>; complete: boolean }> {
  const name = UI_LANGS[lang];
  if (!name) return { entries: {}, complete: true };
  const cached = await memo(db, `i18n:${lang}`, 600_000, async () => {
    const rows = await db.all<{ key: string; text: string }>("SELECT key, text FROM ui_translations WHERE lang = ?", [lang]).catch(() => [] as Array<{ key: string; text: string }>);
    return Object.fromEntries(rows.map((r) => [r.key, r.text])) as Record<string, string>;
  });
  const keys = KEYS as string[];
  const missing = keys.filter((k) => !(k in cached));
  if (!missing.length) return { entries: cached, complete: true };
  if (opts.translate === false || !ai) return { entries: cached, complete: false };
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
  const todo = batches.slice(0, opts.maxBatches ?? 20);
  const results = await Promise.all(todo.map((b) => translateBatch(name, b).catch(() => new Map<string, string>())));
  const fresh = new Map<string, string>();
  for (const r of results) for (const [k, v] of r) fresh.set(k, v);
  if (fresh.size) {
    const rows = [...fresh];
    for (let i = 0; i < rows.length; i += 30) await db.batch(rows.slice(i, i + 30).map(([k, v]) => stmt("INSERT OR REPLACE INTO ui_translations(lang, key, text) VALUES (?, ?, ?)", lang, k, v)));
    memoClear(db, `i18n:${lang}`);
  }
  const entries = { ...cached, ...Object.fromEntries(fresh) };
  return { entries, complete: keys.every((k) => k in entries) };
}

/** Nightly warm-up: translate whatever is still missing for every language (budgeted). */
export async function warmTranslations(db: SqlDb, log: (m: string) => void = () => {}): Promise<void> {
  if (!ai) return;
  await ensureI18nTable(db);
  for (const lang of Object.keys(UI_LANGS)) {
    const r = await uiDictionary(db, lang, { maxBatches: 15 });
    log(`i18n ${lang}: ${Object.keys(r.entries).length} strings${r.complete ? "" : " (unvollständig)"}`);
  }
}

/** For tests: how many keys the client ships. */
export const uiKeyCount = () => (KEYS as string[]).length;
export { readMany };
