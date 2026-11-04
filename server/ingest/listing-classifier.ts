/**
 * Turns a marketplace listing title into structured facts: language, variant, grading, lot/junk flags.
 * This is the heart of "German-language pricing": most German card names differ from English ones
 * (Glurak ≠ Charizard), and sellers on eBay.de also tag "deutsch"/"DE"/"german".
 */
import type { GradingCompany, Language, Variant } from "../../shared/types.ts";
import { normalizeName } from "./matcher.ts";

export interface ListingFacts {
  language: Language | null;
  languageConfidence: number; // 0..1
  variant: Variant;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  isLot: boolean;
  isJunk: boolean;      // proxy, custom, metal, digital code …
  matchesCard: boolean; // card name and number present
}

const DE_TOKENS = /\b(deutsch(e|es|er)?|german|ger|dt\.?|de)\b/i;
const EN_TOKENS = /\b(english|englisch(e)?|eng|en|us)\b/i;
const JP_TOKENS = /\b(japanese|japanisch(e)?|jap|jp|jpn)\b/i;
const OTHER_LANG = /\b(french|français|französisch|italian|italiano|italienisch|spanish|español|spanisch|portugu[eê]s|korean|koreanisch|chinese|chinesisch)\b/i;
const LOT_RE = /\b(lot|sammlung|konvolut|bundle|set\s+von|\d+\s*x\b|\bx\s*\d+|karten\s*paket|booster|display|etb|elite\s+trainer|tin|blister|sleeved|mystery)\b/i;
const JUNK_RE = /\b(proxy|custom|fan\s*art|metal|metall|gold\s*plated|vergoldet|replica|repro|orica|digital|code\s*card|online\s*code|sticker|aufkleber|poster|figur)\b/i;
const GRADE_RE = /\b(PSA|BGS|CGC|GSG|AP|TAG|ACE|SGC|GRAAD)\s*[-:]?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?!\d)/i;
const REVERSE_RE = /\b(reverse|rev\.?|reverse\s*holo|rh)\b/i;
const HOLO_RE = /\b(holo|holographic|holofoil|foil)\b/i;
const FIRST_ED_RE = /\b(1st\s*ed(ition)?|1\.\s*edition|first\s*edition|erstauflage|1st)\b/i;
const PROMO_RE = /\bpromo\b/i;

export interface CardLike { nameDe: string | null; nameEn: string | null; localId: string; setTotal?: number | null }

export function classifyListing(title: string, card: CardLike): ListingFacts {
  const t = title.replace(/\s+/g, " ").trim();
  const nt = normalizeName(t);
  const de = normalizeName(card.nameDe), en = normalizeName(card.nameEn);
  const sameName = !!de && de === en;
  const hasDe = !!de && nt.includes(de);
  const hasEn = !!en && nt.includes(en);
  const tagDe = DE_TOKENS.test(t), tagEn = EN_TOKENS.test(t), tagJp = JP_TOKENS.test(t), tagOther = OTHER_LANG.test(t);

  let language: Language | null = null;
  let conf = 0;
  if (tagJp) { language = "jp"; conf = 0.9; }
  else if (tagOther) { language = "other"; conf = 0.8; }
  else if (hasDe && !sameName && !tagEn) { language = "de"; conf = tagDe ? 0.98 : 0.85; }
  else if (tagDe && !tagEn) { language = "de"; conf = sameName ? 0.85 : 0.9; }
  else if (hasEn && !hasDe && !tagDe) { language = "en"; conf = tagEn ? 0.95 : 0.75; }
  else if (tagEn) { language = "en"; conf = 0.85; }
  else if (hasDe && sameName) { language = null; conf = 0; } // "Pikachu 25/102" – undecidable without tags

  let variant: Variant = "normal";
  if (FIRST_ED_RE.test(t)) variant = "firstEdition";
  else if (REVERSE_RE.test(t)) variant = "reverse";
  else if (PROMO_RE.test(t)) variant = "promo";
  else if (HOLO_RE.test(t)) variant = "holo";

  const g = t.match(GRADE_RE);
  const gradingCompany = g ? (g[1]!.toUpperCase() as GradingCompany) : null;
  const grade = g ? Number(g[2]) : null;

  const num = card.localId.replace(/^0+/, "");
  const numRe = new RegExp(`(^|[^0-9])0*${escapeRe(num)}(\\s*/\\s*0*${card.setTotal ?? "\\d+"})?([^0-9]|$)`, "i");
  const matchesCard = (hasDe || hasEn) && numRe.test(t);

  return {
    language, languageConfidence: conf, variant, gradingCompany, grade,
    isLot: LOT_RE.test(t) && !/\b1\s*x\b/i.test(t),
    isJunk: JUNK_RE.test(t),
    matchesCard,
  };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
