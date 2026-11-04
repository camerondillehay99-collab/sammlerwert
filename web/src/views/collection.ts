/**
 * Collection management: folders ("Sammlungen"), filters, sorting, inline quantity, delete without dialogs,
 * multi-select with bulk actions, share links and CSV export. Works one-handed on the phone.
 */
import type { Collection, CollectionItem } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, debounce, imgOr, toast } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { addToCollection, confidenceBadge, empty, field, modal, placeholder, select, trendPill, upgradePrompt, COND_OPTIONS, LANG_OPTIONS } from "../components/ui.ts";
import { landing } from "./landing.ts";
import { navigate } from "../lib/router.ts";

type SortKey = "newest" | "value" | "name" | "trend" | "pnl" | "set" | "number" | "qty" | "bought";
const SORTS: Array<[SortKey, string]> = [["newest", "Zuletzt hinzugefügt"], ["value", "Wert ↓"], ["pnl", "Gewinn/Verlust ↓"], ["trend", "Trend 30 T. ↓"], ["name", "Name A–Z"], ["set", "Set · Nummer"], ["number", "Nummer"], ["qty", "Anzahl ↓"], ["bought", "Kaufdatum ↓"]];

export async function collection(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  if (!state.user) return landing();
  let collections = (await api.collections()).items;
  let items = (await api.items()).items;
  let current: number | null = query.get("c") ? Number(query.get("c")) : null;
  if (current && !collections.some((c) => c.id === current)) current = null;
  const selected = new Set<number>();
  let selectMode = false;

  const root = h("div", { class: "page collection-page" });
  const tabs = h("div", { class: "coll-tabs", role: "tablist" });
  const list = h("div", { class: "items" });
  const input = h("input", { type: "search", class: "search-input", placeholder: "In der Sammlung suchen …", autocomplete: "off" });
  const sort = h("select", { "aria-label": "Sortierung" }, ...SORTS.map(([v, t]) => h("option", { value: v }, t)));
  const lang = h("select", { "aria-label": "Sprache" }, h("option", { value: "" }, "Alle Sprachen"), ...LANG_OPTIONS.map(([v, t]) => h("option", { value: v }, t)));
  const kind = h("select", { "aria-label": "Art" }, h("option", { value: "" }, "Alle Karten"), h("option", { value: "raw" }, "Ungraded"), h("option", { value: "graded" }, "Graded"), h("option", { value: "nocost" }, "Ohne Kaufpreis"), h("option", { value: "noprice" }, "Ohne Marktwert"), h("option", { value: "multi" }, "Mehrfach (≥ 2)"));
  const setSel = h("select", { "aria-label": "Set" }, h("option", { value: "" }, "Alle Sets"));
  const view = h("div", { class: "seg" }, h("button", { class: "active", dataset: { v: "list" }, "aria-label": "Liste" }, svg(icons.sets, 18)), h("button", { dataset: { v: "grid" }, "aria-label": "Raster" }, svg(icons.cards, 18)));
  const selectBtn = h("button", { class: "btn ghost sm", onClick: () => toggleSelect() }, svg(icons.check2, 16), " Auswählen");
  const total = h("div", { class: "stats compact" });
  const bulkBar = h("div", { class: "bulk-bar", hidden: true });
  if (query.get("lang")) lang.value = query.get("lang")!;
  if (query.get("sort")) sort.value = query.get("sort")!;

  const inScope = () => (current ? items.filter((i) => i.collectionId === current) : items);
  const val = (i: CollectionItem) => (i.currentValue ?? 0) * i.quantity;
  const pnl = (i: CollectionItem) => i.purchasePriceEur != null && i.currentValue != null ? (i.currentValue - i.purchasePriceEur) * i.quantity : -Infinity;

  function drawTabs() {
    clear(tabs);
    const sumOf = (id: number | null) => (id ? items.filter((i) => i.collectionId === id) : items).reduce((s, i) => s + val(i), 0);
    const tab = (id: number | null, name: string, n: number, c?: Collection) => h("button", { class: `coll-tab${current === id ? " active" : ""}`, role: "tab", "aria-selected": current === id ? "true" : "false", onClick: () => { current = id; drawTabs(); drawSets(); draw(); history.replaceState(null, "", id ? `/sammlung?c=${id}` : "/sammlung"); } },
      c?.color ? h("i", { class: "dot", style: { background: c.color } }) : null, h("span", null, name), h("small", null, `${n} · ${fmt.eurCompact(sumOf(id))}`));
    tabs.append(tab(null, "Alle", items.reduce((s, i) => s + i.quantity, 0)));
    for (const c of collections) tabs.append(tab(c.id, c.name, c.quantity, c));
    tabs.append(h("button", { class: "coll-tab add", "aria-label": "Neue Sammlung", onClick: () => editCollection(null) }, svg(icons.plus, 16), h("span", null, "Neu")));
  }

  function drawSets() {
    const cur = setSel.value;
    const sets = new Map<string, string>();
    for (const i of inScope()) sets.set(i.card.setId, i.card.setNameDe ?? i.card.setNameEn ?? i.card.setId);
    setSel.replaceChildren(h("option", { value: "" }, "Alle Sets"), ...[...sets].sort((a, b) => a[1].localeCompare(b[1], "de")).map(([id, name]) => h("option", { value: id, selected: id === cur }, name)));
  }

  function filtered(): CollectionItem[] {
    const q = input.value.trim().toLowerCase();
    let rows = inScope().filter((i) => (!q || `${i.card.nameDe} ${i.card.nameEn} ${i.card.localId} ${i.card.setNameDe} ${i.notes ?? ""} ${i.certNo ?? ""}`.toLowerCase().includes(q)) && (!lang.value || i.language === lang.value) && (!setSel.value || i.card.setId === setSel.value));
    rows = rows.filter((i) => ({ "": true, raw: !i.gradingCompany, graded: !!i.gradingCompany, nocost: i.purchasePriceEur == null, noprice: i.currentValue == null, multi: i.quantity >= 2 } as Record<string, boolean>)[kind.value]);
    const cmp: Record<SortKey, (a: CollectionItem, b: CollectionItem) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt), value: (a, b) => val(b) - val(a), pnl: (a, b) => pnl(b) - pnl(a),
      trend: (a, b) => (b.quote?.trend30 ?? -9) - (a.quote?.trend30 ?? -9), name: (a, b) => cardName(a.card).localeCompare(cardName(b.card), "de"),
      set: (a, b) => (a.card.setNameDe ?? "").localeCompare(b.card.setNameDe ?? "", "de") || numCmp(a, b), number: numCmp, qty: (a, b) => b.quantity - a.quantity,
      bought: (a, b) => (b.purchasedAt ?? "").localeCompare(a.purchasedAt ?? ""),
    };
    return rows.sort(cmp[sort.value as SortKey]);
  }
  const numCmp = (a: CollectionItem, b: CollectionItem) => (parseInt(a.card.localId, 10) || 0) - (parseInt(b.card.localId, 10) || 0) || a.card.localId.localeCompare(b.card.localId);

  function draw() {
    clear(list);
    const rows = filtered();
    const sum = rows.reduce((s, i) => s + val(i), 0), cost = rows.reduce((s, i) => s + (i.purchasePriceEur ?? 0) * i.quantity, 0);
    clear(total).append(h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Wert"), h("strong", { class: "stat-value" }, fmt.eurCompact(sum))),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Einstand"), h("strong", { class: "stat-value" }, cost ? fmt.eurCompact(cost) : "–")),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Gewinn/Verlust"), h("strong", { class: `stat-value ${sum - cost >= 0 ? "up" : "down"}` }, cost ? `${sum - cost >= 0 ? "+" : ""}${fmt.eurCompact(sum - cost)}` : "–")),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Karten"), h("strong", { class: "stat-value" }, `${rows.reduce((s, i) => s + i.quantity, 0)}`, h("small", { class: "muted" }, ` · ${rows.length} Pos.`))));
    if (!rows.length) {
      list.appendChild(items.length ? empty("Keine Treffer", "Passe Suche oder Filter an.")
        : empty("Noch keine Karten", "Scanne eine Karte mit dem Handy, suche sie – oder bring deine Sammlung von Collectr / Card Ladder mit.",
          h("div", { class: "actions-row center" }, h("a", { class: "btn primary", href: "/suche" }, svg(icons.search, 16), " Karte suchen"), h("a", { class: "btn ghost", href: "/import" }, svg(icons.download, 16), " Importieren"))));
      return;
    }
    const grid = view.querySelector(".active")!.getAttribute("data-v") === "grid";
    list.className = grid ? "tiles" : "items";
    for (const it of rows) list.appendChild(grid ? gridItem(it) : row(it));
    drawBulk();
  }

  // ---------- item actions ----------
  const refresh = async () => { [collections, items] = [(await api.collections()).items, (await api.items()).items]; selected.clear(); drawTabs(); drawSets(); draw(); };
  const changeQty = async (it: CollectionItem, delta: number, el: HTMLElement) => {
    const q = it.quantity + delta;
    if (q < 1) return removeItem(it, el);
    try { const r = await api.updateItem(it.id, { quantity: q }); Object.assign(it, r.item); invalidate(); draw(); drawTabs(); }
    catch (e) { if (e instanceof HttpError && e.status === 402) upgradePrompt(e.message); else toast((e as Error).message, "error"); }
  };
  /** Two taps, no dialog: the trash button turns into "Entfernen?" for 4 seconds. */
  const removeItem = (it: CollectionItem, host: HTMLElement) => {
    const confirmBtn = h("button", { class: "btn danger sm", onClick: async () => { try { await api.deleteItem(it.id); items = items.filter((x) => x.id !== it.id); invalidate(); toast("Entfernt.", "ok", { label: "Rückgängig", onClick: () => restore(it) }); draw(); drawTabs(); } catch (e) { toast((e as Error).message, "error"); } } }, "Entfernen?");
    const cancel = h("button", { class: "icon-btn", "aria-label": "Abbrechen", onClick: () => draw() }, svg(icons.close, 16));
    const box = h("span", { class: "confirm-inline" }, confirmBtn, cancel);
    host.replaceWith(box);
    setTimeout(() => { if (box.isConnected) draw(); }, 4000);
  };
  const restore = async (it: CollectionItem) => {
    try {
      await api.addItem({ cardId: it.cardId, collectionId: it.collectionId, language: it.language, variant: it.variant, condition: it.condition, gradingCompany: it.gradingCompany, grade: it.grade, certNo: it.certNo, quantity: it.quantity, purchasePriceEur: it.purchasePriceEur, purchasedAt: it.purchasedAt, notes: it.notes, source: it.source ?? "manual" });
      await refresh(); toast("Wiederhergestellt.");
    } catch (e) { toast((e as Error).message, "error"); }
  };
  document.addEventListener("collection:changed", refresh);

  function qtyStepper(it: CollectionItem): HTMLElement {
    const box = h("span", { class: "qty-step" });
    box.append(h("button", { "aria-label": it.quantity > 1 ? "Eins weniger" : "Entfernen", onClick: () => changeQty(it, -1, box) }, svg(it.quantity > 1 ? icons.minus : icons.trash, 14)), h("b", null, `${it.quantity}`), h("button", { "aria-label": "Eins mehr", onClick: () => changeQty(it, 1, box) }, svg(icons.plus, 14)));
    return box;
  }
  function checkbox(it: CollectionItem): HTMLElement | null {
    if (!selectMode) return null;
    const cb = h("input", { type: "checkbox", class: "sel", checked: selected.has(it.id), "aria-label": "Auswählen" }) as HTMLInputElement;
    cb.addEventListener("change", () => { if (cb.checked) selected.add(it.id); else selected.delete(it.id); drawBulk(); });
    return cb;
  }

  function row(it: CollectionItem): HTMLElement {
    const img = cardImage(it.card);
    const p = it.purchasePriceEur != null && it.currentValue != null ? (it.currentValue - it.purchasePriceEur) * it.quantity : null;
    const coll = !current && collections.length > 1 ? collections.find((c) => c.id === it.collectionId) : null;
    const trash = h("button", { class: "icon-btn danger", "aria-label": "Entfernen", onClick: (e: Event) => removeItem(it, e.currentTarget as HTMLElement) }, svg(icons.trash, 18));
    return h("div", { class: `item${selected.has(it.id) ? " selected" : ""}` },
      checkbox(it),
      h("a", { class: "item-img", href: `/karte/${encodeURIComponent(it.cardId)}` }, imgOr(img, () => placeholder(it.card))),
      h("div", { class: "item-body" },
        h("a", { class: "item-title", href: `/karte/${encodeURIComponent(it.cardId)}` }, h("strong", null, cardName(it.card)), h("span", { class: "num" }, `#${it.card.localId}`)),
        h("div", { class: "muted small" }, `${it.card.setNameDe ?? it.card.setNameEn ?? ""} · ${label.language(it.language)} · ${label.variant(it.variant)} · ${it.gradingCompany ? `${it.gradingCompany} ${it.grade ?? ""}${it.certNo ? ` · #${it.certNo}` : ""}` : label.condition(it.condition)}`),
        h("div", { class: "item-badges" }, confidenceBadge(it.quote?.confidence), coll ? h("span", { class: "chip ghost" }, svg(icons.folder, 12), ` ${coll.name}`) : null, it.notes ? h("span", { class: "chip ghost", title: it.notes }, "Notiz") : null, it.source === "scan" ? h("span", { class: "chip ghost", title: "Per Scanner hinzugefügt" }, svg(icons.camera, 12)) : null)),
      h("div", { class: "item-values" },
        h("b", null, fmt.eur(it.currentValue != null ? it.currentValue * it.quantity : null)),
        h("div", { class: "small" }, trendPill(it.quote?.trend30)),
        p != null ? h("div", { class: `small trend ${p >= 0 ? "up" : "down"}` }, `${p >= 0 ? "+" : ""}${fmt.eur(p)}`) : h("div", { class: "small muted" }, it.purchasePriceEur != null ? "" : "kein Kaufpreis")),
      h("div", { class: "item-actions" }, qtyStepper(it), h("button", { class: "icon-btn", "aria-label": "Bearbeiten", onClick: () => addToCollection(it.card, it, { collections }) }, svg(icons.edit, 18)), trash),
    );
  }

  function gridItem(it: CollectionItem): HTMLElement {
    const img = cardImage(it.card);
    return h("div", { class: `tile${selected.has(it.id) ? " selected" : ""}` },
      checkbox(it),
      h("a", { class: "tile-img", href: `/karte/${encodeURIComponent(it.cardId)}` }, imgOr(img, () => placeholder(it.card)), it.quantity > 1 ? h("span", { class: "qty" }, `${it.quantity}×`) : null, it.gradingCompany ? h("span", { class: "grade-tag" }, `${it.gradingCompany} ${it.grade ?? ""}`) : null),
      h("div", { class: "tile-body" }, h("div", { class: "tile-title" }, h("strong", null, cardName(it.card)), h("span", { class: "num" }, `#${it.card.localId}`)),
        h("div", { class: "tile-sub" }, `${label.language(it.language)} · ${it.gradingCompany ? `${it.gradingCompany} ${it.grade ?? ""}` : label.condition(it.condition)}`),
        h("div", { class: "tile-price" }, h("b", null, fmt.eur(it.currentValue != null ? it.currentValue * it.quantity : null)), trendPill(it.quote?.trend30))),
      h("div", { class: "tile-tools" }, h("button", { class: "icon-btn", "aria-label": "Bearbeiten", onClick: () => addToCollection(it.card, it, { collections }) }, svg(icons.edit, 16)), h("button", { class: "icon-btn danger", "aria-label": "Entfernen", onClick: (e: Event) => removeItem(it, (e.currentTarget as HTMLElement).parentElement!) }, svg(icons.trash, 16))),
    );
  }

  // ---------- multi-select ----------
  function toggleSelect(on = !selectMode) {
    selectMode = on; selected.clear();
    selectBtn.classList.toggle("active", on); selectBtn.replaceChildren(svg(on ? icons.close : icons.check2, 16), on ? " Abbrechen" : " Auswählen");
    draw();
  }
  function drawBulk() {
    bulkBar.hidden = !selectMode;
    if (!selectMode) return;
    const n = selected.size;
    const visible = filtered();
    const all = h("button", { class: "btn ghost sm", onClick: () => { if (selected.size === visible.length) selected.clear(); else visible.forEach((i) => selected.add(i.id)); draw(); } }, selected.size === visible.length ? "Keine" : `Alle (${visible.length})`);
    const move = h("button", { class: "btn ghost sm", disabled: !n, onClick: () => bulkMove() }, svg(icons.folder, 14), " Verschieben");
    const cond = h("button", { class: "btn ghost sm", disabled: !n, onClick: () => bulkCondition() }, svg(icons.edit, 14), " Zustand");
    const del = h("button", { class: "btn danger sm", disabled: !n, onClick: () => bulkDelete() }, svg(icons.trash, 14), ` Löschen${n ? ` (${n})` : ""}`);
    bulkBar.replaceChildren(h("span", { class: "bulk-count" }, `${n} ausgewählt`), all, move, cond, del);
  }
  const afterBulk = async (msg: string) => { invalidate(); await refresh(); toggleSelect(false); toast(msg); };
  function bulkMove() {
    const sel = select("collection", collections.filter((c) => c.id !== current).map((c) => [String(c.id), c.name]));
    const btn = h("button", { class: "btn primary", onClick: async () => { try { const r = await api.bulkItems({ action: "move", ids: [...selected], collectionId: Number(sel.value) }); close(); afterBulk(`${r.affected} Karten verschoben.`); } catch (e) { toast((e as Error).message, "error"); } } }, "Verschieben");
    const close = modal(`${selected.size} Karten verschieben`, h("div", { class: "form" }, collections.length > 1 ? field("In Sammlung", sel) : h("p", { class: "muted" }, "Lege zuerst eine zweite Sammlung an."), h("div", { class: "actions" }, h("button", { class: "btn ghost", onClick: () => { close(); editCollection(null); } }, svg(icons.plus, 14), " Neue Sammlung"), collections.length > 1 ? btn : null)));
  }
  function bulkCondition() {
    const sel = select("condition", COND_OPTIONS, "NM");
    const btn = h("button", { class: "btn primary", onClick: async () => { try { const r = await api.bulkItems({ action: "update", ids: [...selected], patch: { condition: sel.value } }); close(); afterBulk(`Zustand bei ${r.affected} Karten gesetzt.`); } catch (e) { toast((e as Error).message, "error"); } } }, "Übernehmen");
    const close = modal("Zustand setzen", h("div", { class: "form" }, field("Zustand", sel), h("div", { class: "actions" }, btn)));
  }
  function bulkDelete() {
    const n = selected.size;
    const btn = h("button", { class: "btn danger", onClick: async () => { try { const r = await api.bulkItems({ action: "delete", ids: [...selected] }); close(); afterBulk(`${r.affected} Karten entfernt.`); } catch (e) { toast((e as Error).message, "error"); } } }, `${n} Karten entfernen`);
    const close = modal("Wirklich entfernen?", h("div", { class: "form" }, h("p", null, `${n} Positionen werden aus der Sammlung gelöscht. Das lässt sich nicht rückgängig machen.`), h("div", { class: "actions" }, h("button", { class: "btn ghost", onClick: () => close() }, "Abbrechen"), btn)));
  }

  // ---------- collection management ----------
  function editCollection(c: Collection | null) {
    const name = h("input", { value: c?.name ?? "", placeholder: "z. B. Binder 151, Verkauf, Graded", maxlength: 60, required: true });
    const desc = h("input", { value: c?.description ?? "", placeholder: "Optional: wofür ist diese Sammlung?", maxlength: 300 });
    const colors = ["#e11d48", "#f97316", "#eab308", "#22c55e", "#0ea5e9", "#8b5cf6", "#64748b"];
    let color = c?.color ?? null;
    const sw = h("div", { class: "swatches" }, ...colors.map((cl) => h("button", { type: "button", class: `swatch${color === cl ? " active" : ""}`, style: { background: cl }, "aria-label": cl, onClick: (e: Event) => { color = color === cl ? null : cl; sw.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b === e.currentTarget && color === cl)); } })));
    const submit = h("button", { class: "btn primary", type: "submit" }, c ? "Speichern" : "Anlegen");
    const form = h("form", { class: "form" }, field("Name", name), field("Beschreibung", desc), field("Farbe", sw), h("div", { class: "actions" }, submit));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); submit.disabled = true;
      try {
        if (c) await api.updateCollection(c.id, { name: name.value, description: desc.value || null, color });
        else { const r = await api.createCollection({ name: name.value, description: desc.value || null, color }); current = r.collection.id; history.replaceState(null, "", `/sammlung?c=${current}`); }
        close(); await refresh(); toast(c ? "Gespeichert." : "Sammlung angelegt.");
      } catch (err) { submit.disabled = false; if (err instanceof HttpError && err.status === 402) { close(); upgradePrompt(err.message); } else toast((err as Error).message, "error"); }
    });
    const close = modal(c ? "Sammlung bearbeiten" : "Neue Sammlung", form);
    setTimeout(() => name.focus(), 60);
  }

  function manageMenu() {
    const c = collections.find((x) => x.id === current);
    const body = h("div", { class: "menu-list" });
    const item = (icon: string, text: string, fn: () => void, danger = false) => h("button", { class: `menu-item${danger ? " danger" : ""}`, onClick: () => { close(); fn(); } }, svg(icon, 18), h("span", null, text));
    body.append(...[
      c ? item(icons.edit, "Umbenennen / Farbe", () => editCollection(c)) : item(icons.plus, "Neue Sammlung", () => editCollection(null)),
      c ? item(icons.share, c.shareToken ? "Link teilen · aktiv" : "Per Link teilen", () => shareDialog(c)) : null,
      item(icons.download, `CSV exportieren${c ? ` (${c.name})` : ""}`, () => { location.href = `/api/export.csv${c ? `?collection=${c.id}` : ""}`; }),
      item(icons.upload, "Karten importieren", () => navigate(`/import${c ? `?c=${c.id}` : ""}`)),
      c && !c.isDefault ? item(icons.star, "Als Standard-Sammlung", async () => { await api.updateCollection(c.id, { isDefault: true }); await refresh(); toast("Standard gesetzt."); }) : null,
      c ? item(icons.trash, "Sammlung löschen", () => deleteCollection(c), true) : null,
    ].filter(Boolean) as HTMLElement[]);
    const close = modal(c ? c.name : "Alle Karten", body);
  }
  function shareDialog(c: Collection) {
    const body = h("div", { class: "form" });
    const draw = (token: string | null) => {
      const url = token ? `${location.origin}/s/${token}` : null;
      body.replaceChildren(h("div", { class: "form" },
        h("p", null, "Wer den Link hat, sieht die Karten und Marktwerte dieser Sammlung – keine Kaufpreise, keine Notizen, keine E-Mail."),
        url ? h("div", { class: "share-box" }, h("input", { value: url, readonly: true, onClick: (e: Event) => (e.currentTarget as HTMLInputElement).select() }),
          h("button", { class: "btn primary sm", onClick: async () => { try { await navigator.clipboard.writeText(url); toast("Link kopiert."); } catch { toast("Bitte Link markieren und kopieren.", "error"); } } }, svg(icons.copy, 14), " Kopieren"),
          typeof navigator.share === "function" ? h("button", { class: "btn ghost sm", onClick: () => navigator.share({ title: `${c.name} – Sammlerwert`, url }).catch(() => {}) }, svg(icons.share, 14), " Teilen") : null) : null,
        h("div", { class: "actions" },
          url ? h("button", { class: "btn ghost danger", onClick: async () => { await api.unshareCollection(c.id); c.shareToken = null; draw(null); toast("Link deaktiviert."); } }, "Link deaktivieren")
            : h("button", { class: "btn primary", onClick: async () => { const r = await api.shareCollection(c.id); c.shareToken = r.token; draw(r.token); } }, svg(icons.share, 14), " Link erstellen"),
          url ? h("a", { class: "btn ghost", href: url, target: "_blank", rel: "noopener" }, "Ansehen") : null),
      ));
    };
    draw(c.shareToken);
    modal("Sammlung teilen", body);
  }
  function deleteCollection(c: Collection) {
    const keep = h("button", { class: "btn primary", onClick: async () => { try { await api.deleteCollection(c.id, false); close(); current = null; history.replaceState(null, "", "/sammlung"); await refresh(); toast("Sammlung gelöscht, Karten behalten."); } catch (e) { toast((e as Error).message, "error"); } } }, "Löschen, Karten behalten");
    const all = h("button", { class: "btn danger ghost", onClick: async () => { try { await api.deleteCollection(c.id, true); close(); current = null; history.replaceState(null, "", "/sammlung"); await refresh(); toast("Sammlung samt Karten gelöscht."); } catch (e) { toast((e as Error).message, "error"); } } }, `Mit ${c.quantity} Karten löschen`);
    const close = modal(`„${c.name}“ löschen?`, h("div", { class: "form" }, h("p", null, "Die Karten können in deine Standard-Sammlung wandern oder mit gelöscht werden."), h("div", { class: "actions" }, h("button", { class: "btn ghost", onClick: () => close() }, "Abbrechen"), keep, c.quantity ? all : null)));
  }

  // ---------- wiring ----------
  input.addEventListener("input", debounce(draw, 120));
  for (const el of [sort, lang, kind, setSel]) el.addEventListener("change", draw);
  view.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest("button"); if (!b) return; view.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); draw(); });

  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Sammlung"), h("h1", null, "Meine Karten")),
      h("div", { class: "head-actions" }, h("button", { class: "btn ghost", "aria-label": "Sammlung verwalten", onClick: manageMenu }, svg(icons.more, 18), h("span", { class: "hide-sm" }, " Verwalten")), h("a", { class: "btn primary", href: "/suche" }, svg(icons.plus, 18), " Hinzufügen"))),
    tabs, total,
    h("div", { class: "search-bar" }, h("div", { class: "search-wrap" }, svg(icons.search, 20), input), lang, kind, setSel, sort, view, selectBtn),
    bulkBar, list,
  );
  drawTabs(); drawSets(); draw();
  return root;
}
