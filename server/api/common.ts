// Shared validation helpers for the API modules.
import type { SqlDb } from "../db/adapter.ts";
import type { Condition, GradingCompany, Language, Variant } from "../../shared/types.ts";

/** "normal" on a card that only exists as holo (modern illustration rares, vintage holos) means the holo print. */
export async function resolveVariant(db: SqlDb, cardId: string, requested: Variant): Promise<Variant> {
  const row = await db.first<{ variants: string | null }>("SELECT variants FROM cards WHERE id = ?", [cardId]);
  const v = row?.variants ? (JSON.parse(row.variants) as Record<string, boolean>) : {};
  if (requested === "normal" && v.normal === false && v.holo) return "holo";
  if (requested === "holo" && !v.holo && v.normal !== false) return "normal";
  return requested;
}

export const LANGS: readonly Language[] = ["de", "en", "jp", "fr", "it", "es", "pt", "other"];
export const VARIANTS: readonly Variant[] = ["normal", "reverse", "holo", "firstEdition", "promo"];
export const CONDITIONS: readonly Condition[] = ["MT", "NM", "EX", "GD", "LP", "PL", "PO"];
export const GRADERS: readonly GradingCompany[] = ["PSA", "BGS", "CGC", "GSG", "AP", "TAG", "ACE", "OTHER"];

