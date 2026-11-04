/**
 * UI language. German text is the source (and the key); English is hand-translated and bundled;
 * every other language comes from /api/i18n/:lang (machine-translated once, cached on the server).
 *   t("Zur Sammlung")                → "To collection"
 *   t("{n} Karten importieren", {n}) → "Import 12 cards"
 */
import { EN } from "../../../shared/i18n-en.ts";
import { safeGet, safeSet } from "./store.ts";

export interface UiLanguage { code: string; name: string; native: string; locale: string; machine?: boolean }
/** The list offered in settings. de/en are hand-written; the rest are machine-translated (marked in the picker). */
export const UI_LANGUAGES: UiLanguage[] = [
  { code: "de", name: "German", native: "Deutsch", locale: "de-DE" },
  { code: "en", name: "English", native: "English", locale: "en-GB" },
  { code: "fr", name: "French", native: "Français", locale: "fr-FR", machine: true },
  { code: "es", name: "Spanish", native: "Español", locale: "es-ES", machine: true },
  { code: "it", name: "Italian", native: "Italiano", locale: "it-IT", machine: true },
  { code: "nl", name: "Dutch", native: "Nederlands", locale: "nl-NL", machine: true },
  { code: "pt", name: "Portuguese", native: "Português", locale: "pt-PT", machine: true },
  { code: "pl", name: "Polish", native: "Polski", locale: "pl-PL", machine: true },
  { code: "cs", name: "Czech", native: "Čeština", locale: "cs-CZ", machine: true },
  { code: "sv", name: "Swedish", native: "Svenska", locale: "sv-SE", machine: true },
  { code: "da", name: "Danish", native: "Dansk", locale: "da-DK", machine: true },
  { code: "tr", name: "Turkish", native: "Türkçe", locale: "tr-TR", machine: true },
  { code: "ja", name: "Japanese", native: "日本語", locale: "ja-JP", machine: true },
  { code: "ko", name: "Korean", native: "한국어", locale: "ko-KR", machine: true },
  { code: "zh", name: "Chinese", native: "中文", locale: "zh-CN", machine: true },
];

let lang = "de";
let dict: Record<string, string> = {};
const listeners = new Set<() => void>();

function detect(): string {
  const saved = safeGet("sw-lang");
  if (saved && UI_LANGUAGES.some((l) => l.code === saved)) return saved;
  const nav = (navigator.language || "de").slice(0, 2).toLowerCase();
  return UI_LANGUAGES.some((l) => l.code === nav) ? nav : "en";
}

export function getLang(): string { return lang; }
export function locale(): string { return UI_LANGUAGES.find((l) => l.code === lang)?.locale ?? "de-DE"; }
export function onLangChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Translate a German source string; `{name}` placeholders are filled from vars. */
export function t(de: string, vars?: Record<string, string | number | null | undefined>): string {
  let s = de;
  if (lang !== "de") {
    // keys are stored trimmed; leading/trailing whitespace (icon spacing) is kept from the source
    const key = de.trim(), hit = dict[key];
    if (hit) s = de.slice(0, de.length - de.trimStart().length) + hit + de.slice(de.trimEnd().length);
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v == null ? "" : String(v));
  return s;
}

async function loadDict(code: string): Promise<Record<string, string>> {
  if (code === "de") return {};
  if (code === "en") return EN;
  const cacheKey = `sw-dict-${code}`;
  try { const c = safeGet(cacheKey); if (c) { const o = JSON.parse(c) as { at: number; entries: Record<string, string> }; if (Date.now() - o.at < 7 * 86_400_000) { refresh(code, cacheKey); return o.entries; } } } catch { /* ignore */ }
  const r = await fetch(`/api/i18n/${code}`).then((x) => (x.ok ? (x.json() as Promise<{ entries: Record<string, string> }>) : null)).catch(() => null);
  const entries = r?.entries ?? {};
  safeSet(cacheKey, JSON.stringify({ at: Date.now(), entries }));
  return { ...EN, ...entries }; // English fills anything the machine translation missed
}
function refresh(code: string, cacheKey: string) {
  fetch(`/api/i18n/${code}`).then((x) => (x.ok ? x.json() : null)).then((r) => { if (r?.entries) safeSet(cacheKey, JSON.stringify({ at: Date.now(), entries: r.entries })); }).catch(() => {});
}

/** Initialise before the first render. Resolves quickly for de/en; other languages wait for the dictionary once. */
export async function initI18n(preferred?: string | null): Promise<void> {
  lang = preferred && UI_LANGUAGES.some((l) => l.code === preferred) ? preferred : detect();
  dict = await loadDict(lang);
  document.documentElement.lang = lang;
}

export async function setLang(code: string): Promise<void> {
  if (!UI_LANGUAGES.some((l) => l.code === code) || code === lang) return;
  dict = await loadDict(code);
  lang = code; safeSet("sw-lang", code);
  document.documentElement.lang = code;
  for (const fn of listeners) fn();
}

/** Alias used throughout the views (`t` collides with common loop variables). */
export const tr = t;

// ---- card edition (German vs. English printing): the default used by market pages and card prices ----
export type Edition = "de" | "en";
export function getEdition(): Edition { return safeGet("sw-edition") === "en" ? "en" : "de"; }
export function setEdition(e: Edition) { safeSet("sw-edition", e); for (const fn of listeners) fn(); }
