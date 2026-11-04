import type { CollectionItem } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, debounce, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { addToCollection, confidenceBadge, empty, placeholder, trendPill } from "../components/ui.ts";
import { landing } from "./landing.ts";

type SortKey = "newest" | "value" | "name" | "trend" | "pnl";

export async function collection(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  if (!state.user) return landing();
  let items = (await api.items()).items;
  const root = h("div", { class: "page" });
  const list = h("div", { class: "items" });
  const input = h("input", { type: "search", class: "search-input", placeholder: "In meiner Sammlung suchen …", autocomplete: "off" });
  const sort = h("select", { "aria-label": "Sortierung" }, ...([["newest", "Zuletzt hinzugefügt"], ["value", "Wert ↓"], ["pnl", "Gewinn/Verlust ↓"], ["trend", "Trend 30 T. ↓"], ["name", "Name A–Z"]] as [SortKey, string][]).map(([v, t]) => h("option", { value: v }, t)));
  const lang = h("select", { "aria-label": "Sprache" }, h("option", { value: "" }, "Alle Sprachen"), ...[["de", "Deutsch"], ["en", "Englisch"], ["jp", "Japanisch"], ["other", "Andere"]].map(([v, t]) => h("option", { value: v }, t)));
  const view = h("div", { class: "seg" }, h("button", { class: "active", dataset: { v: "list" }, "aria-label": "Liste" }, svg(icons.sets, 18)), h("button", { dataset: { v: "grid" }, "aria-label": "Raster" }, svg(icons.cards, 18)));
  const total = h("div", { class: "stats compact" });
  if (query.get("lang")) lang.value = query.get("lang")!;

  function draw() {
    clear(list);
    const q = input.value.trim().toLowerCase();
    let rows = items.filter((i) => (!q || `${i.card.nameDe} ${i.card.nameEn} ${i.card.localId} ${i.card.setNameDe} ${i.notes ?? ""}`.toLowerCase().includes(q)) && (!lang.value || i.language === lang.value));
    const val = (i: CollectionItem) => (i.currentValue ?? 0) * i.quantity;
    const pnl = (i: CollectionItem) => i.purchasePriceEur != null && i.currentValue != null ? (i.currentValue - i.purchasePriceEur) * i.quantity : -Infinity;
    rows = rows.sort((a, b) => ({ newest: () => b.createdAt.localeCompare(a.createdAt), value: () => val(b) - val(a), pnl: () => pnl(b) - pnl(a), trend: () => (b.quote?.trend30 ?? -9) - (a.quote?.trend30 ?? -9), name: () => cardName(a.card).localeCompare(cardName(b.card), "de") } as Record<SortKey, () => number>)[sort.value as SortKey]());
    const sum = rows.reduce((s, i) => s + val(i), 0), cost = rows.reduce((s, i) => s + (i.purchasePriceEur ?? 0) * i.quantity, 0);
    clear(total).append(h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Wert (Auswahl)"), h("strong", { class: "stat-value" }, fmt.eurCompact(sum))),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Einstand"), h("strong", { class: "stat-value" }, fmt.eurCompact(cost))),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Gewinn/Verlust"), h("strong", { class: `stat-value ${sum - cost >= 0 ? "up" : "down"}` }, cost ? `${sum - cost >= 0 ? "+" : ""}${fmt.eurCompact(sum - cost)}` : "–")),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, "Karten"), h("strong", { class: "stat-value" }, String(rows.reduce((s, i) => s + i.quantity, 0)))));
    if (!rows.length) { list.appendChild(items.length ? empty("Keine Treffer", "Passe Suche oder Filter an.") : empty("Noch keine Karten", "Füge Karten über die Suche hinzu.", h("a", { class: "btn primary", href: "/suche" }, "Zur Suche"))); return; }
    const grid = view.querySelector(".active")!.getAttribute("data-v") === "grid";
    list.className = grid ? "tiles" : "items";
    for (const it of rows) list.appendChild(grid ? gridItem(it) : row(it));
  }
  const refresh = async () => { items = (await api.items()).items; draw(); };
  document.addEventListener("collection:changed", refresh);
  input.addEventListener("input", debounce(draw, 120)); sort.addEventListener("change", draw); lang.addEventListener("change", draw);
  view.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest("button"); if (!b) return; view.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); draw(); });

  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Sammlung"), h("h1", null, "Meine Karten")),
      h("div", { class: "head-actions" }, h("a", { class: "btn ghost", href: "/api/export.csv", download: "sammlerwert-export.csv" }, svg(icons.download, 18), " CSV"), h("a", { class: "btn primary", href: "/suche" }, svg(icons.plus, 18), " Hinzufügen"))),
    total,
    h("div", { class: "search-bar" }, h("div", { class: "search-wrap" }, svg(icons.search, 20), input), lang, sort, view),
    list,
  );
  draw();
  return root;
}

function row(it: CollectionItem): HTMLElement {
  const img = cardImage(it.card);
  const pnl = it.purchasePriceEur != null && it.currentValue != null ? (it.currentValue - it.purchasePriceEur) * it.quantity : null;
  return h("div", { class: "item" },
    h("a", { class: "item-img", href: `/karte/${encodeURIComponent(it.cardId)}` }, imgOr(img, () => placeholder(it.card))),
    h("div", { class: "item-body" },
      h("a", { class: "item-title", href: `/karte/${encodeURIComponent(it.cardId)}` }, h("strong", null, cardName(it.card)), h("span", { class: "num" }, `#${it.card.localId}`)),
      h("div", { class: "muted small" }, `${it.card.setNameDe ?? it.card.setNameEn ?? ""} · ${label.language(it.language)} · ${label.variant(it.variant)} · ${it.gradingCompany ? `${it.gradingCompany} ${it.grade}` : label.condition(it.condition)}${it.quantity > 1 ? ` · ${it.quantity}×` : ""}`),
      h("div", { class: "item-badges" }, confidenceBadge(it.quote?.confidence), it.notes ? h("span", { class: "chip ghost", title: it.notes }, "Notiz") : null)),
    h("div", { class: "item-values" },
      h("b", null, fmt.eur(it.currentValue != null ? it.currentValue * it.quantity : null)),
      h("div", { class: "small" }, trendPill(it.quote?.trend30)),
      pnl != null ? h("div", { class: `small trend ${pnl >= 0 ? "up" : "down"}` }, `${pnl >= 0 ? "+" : ""}${fmt.eur(pnl)}`) : h("div", { class: "small muted" }, it.purchasePriceEur != null ? "" : "kein Kaufpreis")),
    h("button", { class: "icon-btn", "aria-label": "Bearbeiten", onClick: () => addToCollection(it.card, it) }, svg(icons.edit, 18)),
  );
}

function gridItem(it: CollectionItem): HTMLElement {
  const img = cardImage(it.card);
  return h("div", { class: "tile" },
    h("a", { class: "tile-img", href: `/karte/${encodeURIComponent(it.cardId)}` }, imgOr(img, () => placeholder(it.card)), it.quantity > 1 ? h("span", { class: "qty" }, `${it.quantity}×`) : null),
    h("div", { class: "tile-body" }, h("div", { class: "tile-title" }, h("strong", null, cardName(it.card)), h("span", { class: "num" }, `#${it.card.localId}`)),
      h("div", { class: "tile-sub" }, `${label.language(it.language)} · ${it.gradingCompany ? `${it.gradingCompany} ${it.grade}` : label.condition(it.condition)}`),
      h("div", { class: "tile-price" }, h("b", null, fmt.eur(it.currentValue != null ? it.currentValue * it.quantity : null)), trendPill(it.quote?.trend30))),
    h("button", { class: "icon-btn tile-edit", "aria-label": "Bearbeiten", onClick: () => addToCollection(it.card, it) }, svg(icons.edit, 16)),
  );
}
