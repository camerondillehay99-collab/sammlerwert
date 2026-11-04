/**
 * Portfolio routes: collections (folders), items, bulk actions, public share links, CSV export, item photos.
 * Everything is scoped to the session user; a collection id in a request is always re-checked against user_id.
 */
import { add } from "./router.ts";
import { ApiError, badRequest, json, notFound, num, oneOf, paymentRequired, readJson, str } from "../http.ts";
import { planLimits, requireUser } from "../auth.ts";
import { getCardSummaries } from "../services/catalog.ts";
import { defaultCollectionId, hydrate, listCollections, listItems, ownedCollection, summary } from "../services/portfolio.ts";
import { blobStore } from "../storage.ts";
import { CONDITIONS, GRADERS, LANGS, VARIANTS, resolveVariant } from "./common.ts";
import type { SqlDb } from "../db/adapter.ts";
import type { CollectionItem } from "../../shared/types.ts";

const ITEM_SOURCES = ["manual", "scan", "psa"] as const;
function sourceOf(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  return (ITEM_SOURCES as readonly string[]).includes(s) || /^import:[a-z0-9_-]{1,20}$/.test(s) ? s : null;
}

async function itemById(db: SqlDb, id: number): Promise<CollectionItem> {
  return (await hydrate(db, [(await db.first("SELECT * FROM collection_items WHERE id = ?", [id])) as never]))[0]!;
}

async function assertItemBudget(db: SqlDb, userId: number, plan: Parameters<typeof planLimits>[0], adding: number) {
  const limits = planLimits(plan);
  const count = (await db.first<{ n: number }>("SELECT COALESCE(SUM(i.quantity),0) n FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ?", [userId]))!.n;
  if (count + adding > limits.items) throw paymentRequired(`Dein Tarif umfasst ${limits.items} Karten – du hast ${count}. Upgrade auf Sammler oder Pro für mehr.`);
}

add("GET", "/api/portfolio", async (req, _p, db) => json(await summary(db, (await requireUser(db, req)).id)));

// ---------- collections ----------
add("GET", "/api/collections", async (req, _p, db) => json({ items: await listCollections(db, (await requireUser(db, req)).id) }));

add("POST", "/api/collections", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<Record<string, unknown>>(req);
  const name = str(b.name, 60)?.trim();
  if (!name) throw badRequest("Bitte einen Namen angeben.");
  const n = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM collections WHERE user_id = ?", [u.id]))!.n;
  const limit = planLimits(u.plan).collections;
  if (n >= limit) throw paymentRequired(`Dein Tarif umfasst ${limit} Sammlungen. Mit Sammler oder Pro legst du mehr an.`);
  await defaultCollectionId(db, u.id);
  const res = await db.run("INSERT INTO collections(user_id, name, is_default, description, color, sort_order) VALUES (?, ?, 0, ?, ?, ?)", [u.id, name, str(b.description, 300), str(b.color, 20), n]);
  return json({ collection: (await listCollections(db, u.id)).find((c) => c.id === res.lastInsertRowid) }, 201);
});

add("PATCH", "/api/collections/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const c = await ownedCollection(db, u.id, Number(p.id));
  if (!c) throw notFound();
  const b = await readJson<Record<string, unknown>>(req);
  const fields: Record<string, unknown> = {
    name: b.name !== undefined ? str(b.name, 60)?.trim() || c.name : undefined,
    description: b.description !== undefined ? str(b.description, 300) : undefined,
    color: b.color !== undefined ? str(b.color, 20) : undefined,
    sort_order: b.sortOrder !== undefined ? Math.round(num(b.sortOrder) ?? 0) : undefined,
  };
  if (b.isDefault === true) { await db.run("UPDATE collections SET is_default = 0 WHERE user_id = ?", [u.id]); fields.is_default = 1; }
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (sets.length) await db.run(`UPDATE collections SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, [...sets.map(([, v]) => v as never), c.id]);
  return json({ collection: (await listCollections(db, u.id)).find((x) => x.id === c.id) });
});

/** Delete a collection; its cards move to the default collection unless ?withItems=1. */
add("DELETE", "/api/collections/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const c = await ownedCollection(db, u.id, Number(p.id));
  if (!c) throw notFound();
  const withItems = new URL(req.url).searchParams.get("withItems") === "1";
  const others = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM collections WHERE user_id = ? AND id <> ?", [u.id, c.id]))!.n;
  if (!others && !withItems) throw badRequest("Die letzte Sammlung kann nicht gelöscht werden – lösche stattdessen die Karten.");
  if (withItems) await db.run("DELETE FROM collection_items WHERE collection_id = ?", [c.id]);
  else {
    const target = await db.first<{ id: number }>("SELECT id FROM collections WHERE user_id = ? AND id <> ? ORDER BY is_default DESC, id LIMIT 1", [u.id, c.id]);
    await db.run("UPDATE collection_items SET collection_id = ? WHERE collection_id = ?", [target!.id, c.id]);
  }
  await db.run("DELETE FROM collections WHERE id = ?", [c.id]);
  if (c.isDefault) await db.run("UPDATE collections SET is_default = 1 WHERE id = (SELECT id FROM collections WHERE user_id = ? ORDER BY id LIMIT 1)", [u.id]);
  return json({ ok: true });
});

/** Public link: POST creates/returns the token, DELETE revokes it. */
add("POST", "/api/collections/:id/share", async (req, p, db) => {
  const u = await requireUser(db, req);
  const c = await ownedCollection(db, u.id, Number(p.id));
  if (!c) throw notFound();
  let token = c.shareToken;
  if (!token) { token = crypto.randomUUID().replace(/-/g, "").slice(0, 20); await db.run("UPDATE collections SET share_token = ? WHERE id = ?", [token, c.id]); }
  return json({ token, url: `/s/${token}` });
});
add("DELETE", "/api/collections/:id/share", async (req, p, db) => {
  const u = await requireUser(db, req);
  const c = await ownedCollection(db, u.id, Number(p.id));
  if (!c) throw notFound();
  await db.run("UPDATE collections SET share_token = NULL WHERE id = ?", [c.id]);
  return json({ ok: true });
});

/** Read-only public view of a shared collection: no purchase prices, no notes, no e-mail. */
add("GET", "/api/share/:token", async (_req, p, db) => {
  const c = await db.first<{ id: number; user_id: number; name: string; description: string | null; owner: string | null }>(
    "SELECT c.id, c.user_id, c.name, c.description, u.name AS owner FROM collections c JOIN users u ON u.id = c.user_id WHERE c.share_token = ?", [p.token!]);
  if (!c) throw notFound("Diese geteilte Sammlung gibt es nicht (mehr).");
  const items = (await listItems(db, c.user_id, c.id)).map((i) => ({
    id: i.id, cardId: i.cardId, card: i.card, language: i.language, variant: i.variant, condition: i.condition, gradingCompany: i.gradingCompany, grade: i.grade,
    quantity: i.quantity, currentValue: i.currentValue, trend30: i.quote?.trend30 ?? null,
  }));
  const totalValue = Math.round(items.reduce((s, i) => s + (i.currentValue ?? 0) * i.quantity, 0) * 100) / 100;
  return json({ collection: { name: c.name, description: c.description, owner: c.owner ?? "Ein Sammler" }, items, totalValue, cardCount: items.reduce((s, i) => s + i.quantity, 0) }, 200, { "cache-control": "public, max-age=120" });
});

// ---------- items ----------
add("GET", "/api/items", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const cid = new URL(req.url).searchParams.get("collection");
  return json({ items: await listItems(db, u.id, cid ? Number(cid) : undefined) });
});

add("POST", "/api/items", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<Record<string, unknown>>(req);
  const cardId = str(b.cardId, 40);
  if (!cardId || !(await getCardSummaries(db, [cardId])).has(cardId)) throw badRequest("Unbekannte Karte.");
  const qty = Math.max(1, Math.min(999, Math.round(num(b.quantity) ?? 1)));
  await assertItemBudget(db, u.id, u.plan, qty);
  const grader = b.gradingCompany ? oneOf(b.gradingCompany, GRADERS, "OTHER") : null;
  const collectionId = b.collectionId != null && (await ownedCollection(db, u.id, Number(b.collectionId))) ? Number(b.collectionId) : await defaultCollectionId(db, u.id);
  const res = await db.run(`INSERT INTO collection_items(collection_id, card_id, language, variant, condition, grading_company, grade, cert_no, quantity, purchase_price_eur, purchased_at, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [collectionId, cardId, oneOf(b.language, LANGS, "de"), await resolveVariant(db, cardId, oneOf(b.variant, VARIANTS, "normal")), oneOf(b.condition, CONDITIONS, "NM"),
    grader, grader ? num(b.grade) : null, grader ? str(b.certNo, 40) : null, qty, num(b.purchasePriceEur), str(b.purchasedAt, 30), str(b.notes, 1000), sourceOf(b.source) ?? "manual"]);
  return json({ item: await itemById(db, res.lastInsertRowid) }, 201);
});

add("PATCH", "/api/items/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const row = await db.first<{ id: number; card_id: string; quantity: number }>("SELECT i.id, i.card_id, i.quantity FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.user_id = ?", [Number(p.id), u.id]);
  if (!row) throw notFound();
  const b = await readJson<Record<string, unknown>>(req);
  const grader = b.gradingCompany === null ? null : b.gradingCompany ? oneOf(b.gradingCompany, GRADERS, "OTHER") : undefined;
  const quantity = b.quantity !== undefined ? Math.max(1, Math.min(999, Math.round(num(b.quantity) ?? 1))) : undefined;
  if (quantity !== undefined && quantity > row.quantity) await assertItemBudget(db, u.id, u.plan, quantity - row.quantity);
  const fields: Record<string, unknown> = {
    language: b.language !== undefined ? oneOf(b.language, LANGS, "de") : undefined,
    variant: b.variant !== undefined ? await resolveVariant(db, row.card_id, oneOf(b.variant, VARIANTS, "normal")) : undefined,
    condition: b.condition !== undefined ? oneOf(b.condition, CONDITIONS, "NM") : undefined,
    grading_company: grader, grade: grader === null ? null : b.grade !== undefined ? num(b.grade) : undefined,
    cert_no: grader === null ? null : b.certNo !== undefined ? str(b.certNo, 40) : undefined,
    quantity,
    purchase_price_eur: b.purchasePriceEur !== undefined ? num(b.purchasePriceEur) : undefined,
    purchased_at: b.purchasedAt !== undefined ? str(b.purchasedAt, 30) : undefined,
    notes: b.notes !== undefined ? str(b.notes, 1000) : undefined,
    collection_id: b.collectionId !== undefined && (await ownedCollection(db, u.id, Number(b.collectionId))) ? Number(b.collectionId) : undefined,
  };
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (sets.length) await db.run(`UPDATE collection_items SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...sets.map(([, v]) => v as never), new Date().toISOString(), row.id]);
  return json({ item: await itemById(db, row.id) });
});

add("DELETE", "/api/items/:id", async (req, p, db) => {
  const u = await requireUser(db, req);
  const r = await db.run("DELETE FROM collection_items WHERE id = ? AND collection_id IN (SELECT id FROM collections WHERE user_id = ?)", [Number(p.id), u.id]);
  if (!r.changes) throw notFound();
  return json({ ok: true });
});

/** Bulk: { action: "delete" | "move" | "update", ids: number[], collectionId?, patch?: { condition?, language?, ... } } */
add("POST", "/api/items/bulk", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ action?: string; ids?: unknown; collectionId?: unknown; patch?: Record<string, unknown> }>(req);
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
  if (!ids.length) throw badRequest("Keine Karten ausgewählt.");
  const ph = ids.map(() => "?").join(",");
  const owned = (await db.all<{ id: number }>(`SELECT i.id FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.user_id = ? AND i.id IN (${ph})`, [u.id, ...ids])).map((r) => r.id);
  if (!owned.length) throw notFound();
  const oph = owned.map(() => "?").join(",");
  if (b.action === "delete") { await db.run(`DELETE FROM collection_items WHERE id IN (${oph})`, owned); return json({ ok: true, affected: owned.length }); }
  if (b.action === "move") {
    const target = await ownedCollection(db, u.id, Number(b.collectionId));
    if (!target) throw badRequest("Zielsammlung nicht gefunden.");
    await db.run(`UPDATE collection_items SET collection_id = ?, updated_at = ? WHERE id IN (${oph})`, [target.id, new Date().toISOString(), ...owned]);
    return json({ ok: true, affected: owned.length });
  }
  if (b.action === "update") {
    const p = b.patch ?? {};
    const fields: Record<string, unknown> = {
      condition: p.condition !== undefined ? oneOf(p.condition, CONDITIONS, "NM") : undefined,
      language: p.language !== undefined ? oneOf(p.language, LANGS, "de") : undefined,
      purchase_price_eur: p.purchasePriceEur !== undefined ? num(p.purchasePriceEur) : undefined,
      purchased_at: p.purchasedAt !== undefined ? str(p.purchasedAt, 30) : undefined,
    };
    const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (!sets.length) throw badRequest("Nichts zu ändern.");
    await db.run(`UPDATE collection_items SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id IN (${oph})`, [...sets.map(([, v]) => v as never), new Date().toISOString(), ...owned]);
    return json({ ok: true, affected: owned.length });
  }
  throw badRequest("Unbekannte Aktion.");
});

add("POST", "/api/items/:id/image", async (req, p, db) => {
  const u = await requireUser(db, req);
  const store = blobStore();
  if (!store) throw new ApiError(503, "Bilder-Upload ist in dieser Installation noch nicht aktiviert.", "uploads_disabled");
  const row = await db.first<{ id: number }>("SELECT i.id FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.user_id = ?", [Number(p.id), u.id]);
  if (!row) throw notFound();
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof Blob) || !file.type.startsWith("image/") || file.size > 12 * 1024 * 1024) throw badRequest("Bitte ein Bild bis 12 MB hochladen.");
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const rel = `${u.id}/${row.id}-${Date.now()}.${ext}`;
  await store.put(rel, file, file.type);
  await db.run("UPDATE collection_items SET image_path = ? WHERE id = ?", [rel, row.id]);
  return json({ imagePath: rel });
});

/** CSV export (Excel-friendly: BOM + semicolons) – also the format our own importer reads back. */
add("GET", "/api/export.csv", async (req, _p, db) => {
  const u = await requireUser(db, req);
  if (!planLimits(u.plan).exports) throw paymentRequired("CSV-Export ist ab dem Sammler-Tarif verfügbar.");
  const cid = new URL(req.url).searchParams.get("collection");
  const items = await listItems(db, u.id, cid ? Number(cid) : undefined);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Karte", "Englisch", "Nummer", "Set", "Set (EN)", "Set-ID", "Karten-ID", "Sprache", "Variante", "Zustand", "Grading", "Note", "Zertifikat", "Anzahl", "Kaufpreis", "Gekauft am", "Marktwert", "Gesamtwert", "Konfidenz", "Sammlung", "Notizen"];
  const names = new Map((await listCollections(db, u.id)).map((c) => [c.id, c.name]));
  const rows = items.map((i) => [i.card.nameDe, i.card.nameEn, i.card.localId, i.card.setNameDe, i.card.setNameEn, i.card.setId, i.cardId, i.language, i.variant, i.condition, i.gradingCompany, i.grade, i.certNo, i.quantity, i.purchasePriceEur, i.purchasedAt, i.currentValue, i.currentValue != null ? i.currentValue * i.quantity : null, i.quote?.confidence, names.get(i.collectionId), i.notes].map(esc).join(";"));
  return new Response(String.fromCharCode(0xfeff) + [head.join(";"), ...rows].join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sammlerwert-export.csv"` } });
});
