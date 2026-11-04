import type { SqlDb } from "../db/adapter.ts";
import { bulkInsert, runBatches } from "../db/adapter.ts";
import type { Collection, CollectionItem, Condition, GradingCompany, Insight, Language, PortfolioSummary, PriceQuote, Variant } from "../../shared/types.ts";
import { CONDITION_MULT, GRADE_MULT, gradeMultiplier } from "../pricing/engine.ts";
import { getCardSummaries, quotesFor } from "./catalog.ts";
import { today } from "../db/index.ts";

interface ItemRow { id: number; collection_id: number; card_id: string; language: string; variant: string; condition: string; grading_company: string | null; grade: number | null; cert_no: string | null; quantity: number; purchase_price_eur: number | null; purchased_at: string | null; notes: string | null; image_path: string | null; created_at: string; source?: string | null }

export { GRADE_MULT };

export function unitValue(q: PriceQuote | null, item: { condition: string; gradingCompany: string | null; grade: number | null }): number | null {
  if (!q?.value) return null;
  if (item.gradingCompany && item.grade != null) {
    return Math.round(q.value * gradeMultiplier(item.gradingCompany, item.grade) * 100) / 100;
  }
  return Math.round(q.value * (CONDITION_MULT[item.condition] ?? 0.95) * 100) / 100;
}

export async function defaultCollectionId(db: SqlDb, userId: number): Promise<number> {
  const row = await db.first<{ id: number }>("SELECT id FROM collections WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1", [userId]);
  if (row) return row.id;
  return (await db.run("INSERT INTO collections(user_id, name, is_default) VALUES (?, 'Meine Sammlung', 1)", [userId])).lastInsertRowid;
}

interface CollectionRow { id: number; name: string; is_default: number; description: string | null; color: string | null; share_token: string | null; sort_order: number; created_at: string; item_count: number; quantity: number }
export async function listCollections(db: SqlDb, userId: number): Promise<Collection[]> {
  await defaultCollectionId(db, userId);
  return (await db.all<CollectionRow>(`SELECT c.*, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) item_count, (SELECT COALESCE(SUM(quantity),0) FROM collection_items i WHERE i.collection_id = c.id) quantity
    FROM collections c WHERE c.user_id = ? ORDER BY c.is_default DESC, c.sort_order, c.id`, [userId])).map((c) => ({
    id: c.id, name: c.name, isDefault: !!c.is_default, description: c.description, color: c.color, shareToken: c.share_token, sortOrder: c.sort_order, createdAt: c.created_at, itemCount: c.item_count, quantity: c.quantity,
  }));
}

export async function ownedCollection(db: SqlDb, userId: number, id: number): Promise<Collection | null> {
  if (!Number.isInteger(id)) return null;
  return (await listCollections(db, userId)).find((c) => c.id === id) ?? null;
}

export async function listItems(db: SqlDb, userId: number, collectionId?: number): Promise<CollectionItem[]> {
  const rows = collectionId
    ? await db.all<ItemRow>("SELECT i.* FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ? AND i.collection_id = ? ORDER BY i.created_at DESC", [userId, collectionId])
    : await db.all<ItemRow>("SELECT i.* FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ? ORDER BY i.created_at DESC", [userId]);
  return hydrate(db, rows);
}

export async function hydrate(db: SqlDb, rows: ItemRow[]): Promise<CollectionItem[]> {
  const cards = await getCardSummaries(db, rows.map((r) => r.card_id));
  const quotes = await quotesFor(db, rows.map((r) => r.card_id));
  return rows.map((r) => {
    const card = cards.get(r.card_id)!;
    // Fallback chain: exact language/variant → same language normal → English normal
    const quote = quotes.get(`${r.card_id}|${r.language}|${r.variant}`) ?? quotes.get(`${r.card_id}|${r.language}|*`) ?? quotes.get(`${r.card_id}|en|${r.variant}`) ?? quotes.get(`${r.card_id}|en|*`) ?? null;
    const base = { condition: r.condition, gradingCompany: r.grading_company, grade: r.grade };
    return {
      id: r.id, collectionId: r.collection_id, cardId: r.card_id, language: r.language as Language, variant: r.variant as Variant, condition: r.condition as Condition,
      gradingCompany: r.grading_company as GradingCompany | null, grade: r.grade, certNo: r.cert_no, quantity: r.quantity, purchasePriceEur: r.purchase_price_eur,
      purchasedAt: r.purchased_at, notes: r.notes, imagePath: r.image_path, createdAt: r.created_at, source: r.source ?? null, card, quote, currentValue: unitValue(quote, base),
    };
  });
}

export async function summary(db: SqlDb, userId: number): Promise<PortfolioSummary> {
  const items = await listItems(db, userId);
  let totalValue = 0, totalCost = 0, itemCount = 0;
  const byLang = new Map<string, { value: number; count: number }>();
  const bySet = new Map<string, { name: string; value: number; count: number }>();
  for (const it of items) {
    const v = (it.currentValue ?? 0) * it.quantity;
    totalValue += v; totalCost += (it.purchasePriceEur ?? 0) * it.quantity; itemCount += it.quantity;
    const l = byLang.get(it.language) ?? { value: 0, count: 0 }; l.value += v; l.count += it.quantity; byLang.set(it.language, l);
    const s = bySet.get(it.card.setId) ?? { name: it.card.setNameDe ?? it.card.setNameEn ?? it.card.setId, value: 0, count: 0 }; s.value += v; s.count += it.quantity; bySet.set(it.card.setId, s);
  }
  let history = (await db.all<{ date: string; total_value: number }>("SELECT date, total_value FROM portfolio_snapshots WHERE user_id = ? ORDER BY date", [userId]))
    .map((h) => ({ date: h.date, value: h.total_value }));
  // On-demand snapshot: one row per user and day (keeps the free-tier write budget tiny, no cron needed).
  const day = today();
  if (items.length && !history.some((h) => h.date === day)) {
    await db.run("INSERT INTO portfolio_snapshots(user_id, date, total_value, total_cost, item_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET total_value = excluded.total_value, total_cost = excluded.total_cost, item_count = excluded.item_count",
      [userId, day, r2(totalValue), r2(totalCost), itemCount]);
    history = [...history, { date: day, value: r2(totalValue) }];
  }
  const at = (daysAgo: number) => {
    const cutoff = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const pts = history.filter((h) => h.date <= cutoff);
    return pts.length ? pts[pts.length - 1]!.value : null;
  };
  const rel = (past: number | null) => (past && past > 0 ? totalValue / past - 1 : null);
  const topHoldings = [...items].sort((a, b) => (b.currentValue ?? 0) * b.quantity - (a.currentValue ?? 0) * a.quantity).slice(0, 8);
  const movers = items.filter((i) => i.quote?.trend30 != null && (i.currentValue ?? 0) >= 2)
    .map((item) => ({ item, change30: item.quote!.trend30! })).sort((a, b) => Math.abs(b.change30) - Math.abs(a.change30)).slice(0, 8);
  return {
    totalValue: r2(totalValue), totalCost: r2(totalCost), itemCount, cardCount: items.length,
    change24h: rel(at(1)), change7d: rel(at(7)), change30d: rel(at(30)),
    byLanguage: [...byLang].map(([language, v]) => ({ language: language as Language, value: r2(v.value), count: v.count })).sort((a, b) => b.value - a.value),
    bySet: [...bySet].map(([setId, v]) => ({ setId, setName: v.name, value: r2(v.value), count: v.count })).sort((a, b) => b.value - a.value).slice(0, 10),
    topHoldings, movers, history, insights: buildInsights(items, totalValue, totalCost, rel(at(30))),
  };
}

export function buildInsights(items: CollectionItem[], totalValue: number, totalCost: number, change30: number | null): Insight[] {
  const out: Insight[] = [];
  if (!items.length) { out.push({ kind: "info", title: "Leg los", text: "Füge deine erste Karte hinzu – Suche oben oder „Karte hinzufügen“." }); return out; }
  if (totalCost > 0) {
    const pnl = totalValue - totalCost;
    out.push({ kind: pnl >= 0 ? "up" : "down", title: pnl >= 0 ? "Im Plus" : "Im Minus", text: `Gesamtwert ${eur(totalValue)} gegenüber ${eur(totalCost)} Einstand (${pnl >= 0 ? "+" : ""}${eur(pnl)}).` });
  }
  if (change30 != null) out.push({ kind: change30 >= 0 ? "up" : "down", title: "30-Tage-Entwicklung", text: `${pct(change30)} seit vor 30 Tagen.` });
  const noPrice = items.filter((i) => i.currentValue == null);
  if (noPrice.length) out.push({ kind: "warn", title: `${noPrice.length} Karte${noPrice.length > 1 ? "n" : ""} ohne Marktwert`, text: "Für diese Karten liegen noch keine Verkaufsdaten vor. Melde einen Verkauf oder prüfe die Zuordnung.", cardId: noPrice[0]!.cardId });
  const lowConf = items.filter((i) => i.quote && i.quote.confidence < 0.4 && (i.currentValue ?? 0) > 20);
  if (lowConf.length) out.push({ kind: "warn", title: "Unsichere Bewertung bei wertvollen Karten", text: `${lowConf.length} Karte${lowConf.length > 1 ? "n" : ""} über 20 € basieren nur auf wenigen Datenpunkten.`, cardId: lowConf[0]!.cardId });
  const de = items.filter((i) => i.language === "de").reduce((s, i) => s + (i.currentValue ?? 0) * i.quantity, 0);
  if (totalValue > 0) out.push({ kind: "info", title: "Deutsch-Anteil", text: `${Math.round((de / totalValue) * 100)} % deines Portfoliowerts sind deutsche Karten.` });
  const best = [...items].filter((i) => i.quote?.trend30 != null).sort((a, b) => b.quote!.trend30! - a.quote!.trend30!)[0];
  if (best && best.quote!.trend30! > 0.1) out.push({ kind: "up", title: "Stärkster Aufsteiger", text: `${best.card.nameDe ?? best.card.nameEn} (${best.card.localId}) ${pct(best.quote!.trend30!)} in 30 Tagen.`, cardId: best.cardId });
  const worst = [...items].filter((i) => i.quote?.trend30 != null).sort((a, b) => a.quote!.trend30! - b.quote!.trend30!)[0];
  if (worst && worst.quote!.trend30! < -0.1) out.push({ kind: "down", title: "Größter Rückgang", text: `${worst.card.nameDe ?? worst.card.nameEn} (${worst.card.localId}) ${pct(worst.quote!.trend30!)} in 30 Tagen.`, cardId: worst.cardId });
  return out;
}

export async function snapshotAllPortfolios(db: SqlDb): Promise<number> {
  const users = await db.all<{ id: number }>("SELECT DISTINCT c.user_id id FROM collections c JOIN collection_items i ON i.collection_id = c.id");
  const day = today();
  const rows = [];
  for (const u of users) {
    const items = await listItems(db, u.id);
    if (!items.length) continue;
    const value = items.reduce((s, i) => s + (i.currentValue ?? 0) * i.quantity, 0);
    const cost = items.reduce((s, i) => s + (i.purchasePriceEur ?? 0) * i.quantity, 0);
    rows.push([u.id, day, r2(value), r2(cost), items.reduce((s, i) => s + i.quantity, 0)]);
  }
  await runBatches(db, bulkInsert("portfolio_snapshots", ["user_id", "date", "total_value", "total_cost", "item_count"], rows,
    "ON CONFLICT(user_id, date) DO UPDATE SET total_value = excluded.total_value, total_cost = excluded.total_cost, item_count = excluded.item_count"));
  return rows.length;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const eur = (n: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1).replace(".", ",")} %`;
