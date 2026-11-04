// Public read-only view of a shared collection (/s/:token): cards and market values, nothing private.
import { h, svg, icons, fmt, label, cardImage, cardName, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { empty, placeholder, trendPill } from "../components/ui.ts";
import { tr } from "../lib/i18n.ts";

export async function sharedView(params: Record<string, string>): Promise<HTMLElement> {
  let data: Awaited<ReturnType<typeof api.shared>>;
  try { data = await api.shared(params.token!); }
  catch (e) { return h("div", { class: "page narrow" }, empty(tr("Nicht gefunden"), (e as Error).message, h("a", { class: "btn primary", href: "/" }, tr("Zur Startseite")))); }
  const items = [...data.items].sort((a, b) => (b.currentValue ?? 0) * b.quantity - (a.currentValue ?? 0) * a.quantity);
  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Geteilte Sammlung von {datacollecti}", { datacollecti: data.collection.owner })), h("h1", null, data.collection.name), data.collection.description ? h("p", { class: "muted" }, data.collection.description) : null),
      !state.user ? h("a", { class: "btn primary", href: "/registrieren" }, tr("Eigene Sammlung starten")) : null),
    h("div", { class: "stats compact" },
      h("div", { class: "stat featured" }, h("span", { class: "stat-title" }, tr("Gesamtwert")), h("strong", { class: "stat-value" }, fmt.eurCompact(data.totalValue))),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, tr("Karten")), h("strong", { class: "stat-value" }, `${data.cardCount}`)),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, tr("Positionen")), h("strong", { class: "stat-value" }, `${items.length}`))),
    items.length ? h("div", { class: "items" }, ...items.map((it) => h("div", { class: "item" },
      h("a", { class: "item-img", href: `/karte/${encodeURIComponent(it.cardId)}` }, imgOr(cardImage(it.card), () => placeholder(it.card))),
      h("div", { class: "item-body" }, h("a", { class: "item-title", href: `/karte/${encodeURIComponent(it.cardId)}` }, h("strong", null, cardName(it.card)), h("span", { class: "num" }, `#${it.card.localId}`)),
        h("div", { class: "muted small" }, `${it.card.setNameDe ?? it.card.setNameEn ?? ""} · ${label.language(it.language)} · ${label.variant(it.variant)} · ${it.gradingCompany ? `${it.gradingCompany} ${it.grade ?? ""}` : label.condition(it.condition)}${it.quantity > 1 ? ` · ${it.quantity}×` : ""}`)),
      h("div", { class: "item-values" }, h("b", null, fmt.eur(it.currentValue != null ? it.currentValue * it.quantity : null)), h("div", { class: "small" }, trendPill(it.trend30))))))
      : empty(tr("Noch leer"), tr("In dieser Sammlung liegen noch keine Karten.")),
    h("p", { class: "muted small center" }, svg(icons.info, 12), tr(" Marktwerte: Sammlerwert, deutsche Verkäufe + Cardmarket-Preisguide. "), h("a", { href: "/methodik" }, tr("Methodik"))));
}
