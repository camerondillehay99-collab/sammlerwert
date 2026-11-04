/**
 * Import (Collectr, Card Ladder, TCGplayer, PSA lists, CSV) and PSA certificate routes.
 * preview = parse + match, nothing saved; commit = the rows the user confirmed, with plan limits and optional merging.
 */
import { add } from "./router.ts";
import { ApiError, badRequest, json, num, oneOf, readJson, str } from "../http.ts";
import { planLimits, requireUser } from "../auth.ts";
import { previewImport, type ImportSource } from "../import.ts";
import { getCardSummaries } from "../services/catalog.ts";
import { defaultCollectionId, listItems, ownedCollection } from "../services/portfolio.ts";
import { PsaError, psaConfigured, resolveCert } from "../psa.ts";
import { CONDITIONS, GRADERS, LANGS, VARIANTS, resolveVariant } from "./common.ts";
import { bulkInsert, runBatches } from "../db/adapter.ts";

const SOURCES: readonly ImportSource[] = ["collectr", "cardladder", "tcgplayer", "sammlerwert", "psa", "generic"];
const MAX_TEXT = 3_000_000;

add("GET", "/api/import/capabilities", async () => json({ psa: psaConfigured(), sources: SOURCES, maxRows: 2000 }));

add("POST", "/api/import/preview", async (req, _p, db) => {
  await requireUser(db, req);
  const b = await readJson<{ text?: string; source?: string; defaultLanguage?: string }>(req);
  const text = String(b.text ?? "");
  if (!text.trim()) throw badRequest("Die Datei ist leer.");
  if (text.length > MAX_TEXT) throw badRequest("Datei zu groß (max. 3 MB). Teile sie auf.");
  const source = b.source ? oneOf(b.source, SOURCES, "generic") : undefined;
  const preview = await previewImport(db, text, { source, defaultLanguage: b.defaultLanguage ? oneOf(b.defaultLanguage, LANGS, "de") : undefined });
  if (!preview.rows.length) throw badRequest("Keine Zeilen erkannt – die erste Zeile muss die Spaltennamen enthalten (z. B. Name, Set, Nummer).", "no_rows");
  return json(preview);
});

interface CommitRow { cardId?: unknown; language?: unknown; variant?: unknown; condition?: unknown; gradingCompany?: unknown; grade?: unknown; certNo?: unknown; quantity?: unknown; purchasePriceEur?: unknown; purchasedAt?: unknown; notes?: unknown }

add("POST", "/api/import/commit", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ rows?: CommitRow[]; collectionId?: unknown; merge?: unknown; source?: unknown }>(req);
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
  if (!rows.length) throw badRequest("Keine Zeilen zum Importieren.");
  const source = `import:${oneOf(b.source, SOURCES, "generic")}`;
  const collectionId = b.collectionId != null && (await ownedCollection(db, u.id, Number(b.collectionId))) ? Number(b.collectionId) : await defaultCollectionId(db, u.id);
  const ids = [...new Set(rows.map((r) => str(r.cardId, 40)).filter((x): x is string => !!x))];
  const cards = await getCardSummaries(db, ids);
  const adding = rows.reduce((s, r) => s + Math.max(1, Math.min(999, Math.round(num(r.quantity) ?? 1))), 0);
  const limits = planLimits(u.plan);
  const have = (await db.first<{ n: number }>("SELECT COALESCE(SUM(i.quantity),0) n FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ?", [u.id]))!.n;
  if (have + adding > limits.items) throw new ApiError(402, `Der Import umfasst ${adding} Karten, dein Tarif erlaubt ${limits.items} (du hast ${have}). Upgrade auf Sammler oder Pro – oder importiere weniger.`, "upgrade_required");
  const merge = b.merge !== false;
  const existing = merge ? await listItems(db, u.id, collectionId) : [];
  const keyOf = (x: { cardId: string; language: string; variant: string; condition: string; gradingCompany: string | null; grade: number | null; certNo: string | null }) => [x.cardId, x.language, x.variant, x.condition, x.gradingCompany ?? "", x.grade ?? "", x.certNo ?? ""].join("|");
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const inserts: (string | number | null)[][] = [];
  const updates = new Map<number, number>();
  let imported = 0, merged = 0, skipped = 0;
  for (const r of rows) {
    const cardId = str(r.cardId, 40);
    if (!cardId || !cards.has(cardId)) { skipped++; continue; }
    const grader = r.gradingCompany ? oneOf(r.gradingCompany, GRADERS, "OTHER") : null;
    const row = {
      cardId, language: oneOf(r.language, LANGS, "de"), variant: await resolveVariant(db, cardId, oneOf(r.variant, VARIANTS, "normal")), condition: oneOf(r.condition, CONDITIONS, "NM"),
      gradingCompany: grader, grade: grader ? num(r.grade) : null, certNo: grader ? str(r.certNo, 40) : null,
      quantity: Math.max(1, Math.min(999, Math.round(num(r.quantity) ?? 1))), purchasePriceEur: num(r.purchasePriceEur), purchasedAt: str(r.purchasedAt, 30), notes: str(r.notes, 1000),
    };
    const k = keyOf(row);
    const ex = byKey.get(k);
    if (ex && !row.certNo) { updates.set(ex.id, (updates.get(ex.id) ?? ex.quantity) + row.quantity); merged += row.quantity; continue; }
    inserts.push([collectionId, row.cardId, row.language, row.variant, row.condition, row.gradingCompany, row.grade, row.certNo, row.quantity, row.purchasePriceEur, row.purchasedAt, row.notes, source]);
    imported += row.quantity;
  }
  const statements = [
    ...bulkInsert("collection_items", ["collection_id", "card_id", "language", "variant", "condition", "grading_company", "grade", "cert_no", "quantity", "purchase_price_eur", "purchased_at", "notes", "source"], inserts),
    ...[...updates].map(([id, q]) => ({ sql: "UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?", params: [q, new Date().toISOString(), id] })),
  ];
  if (statements.length) await runBatches(db, statements);
  return json({ ok: true, imported, merged, skipped, collectionId }, 201);
});

// ---------- PSA ----------
add("GET", "/api/psa/status", async () => json({ configured: psaConfigured() }));

/** Certificate → card + grade (+ catalogue candidates). Signed-in only (PSA rate limits are per token). */
add("POST", "/api/psa/cert", async (req, _p, db) => {
  await requireUser(db, req);
  const b = await readJson<{ cert?: string }>(req);
  try {
    const r = await resolveCert(db, String(b.cert ?? ""));
    if (!r.cert) throw new ApiError(404, "PSA kennt dieses Zertifikat nicht.", "cert_unknown");
    return json({ cert: r.cert, facts: r.facts, best: r.candidates[0] ?? null, alternatives: r.candidates.slice(1) });
  } catch (e) {
    if (e instanceof PsaError) throw new ApiError(e.status === 400 ? 400 : e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.message, e.status === 503 ? "psa_unavailable" : "psa_error");
    throw e;
  }
});
