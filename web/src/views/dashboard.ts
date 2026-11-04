import type { PortfolioSummary } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, trendClass, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { lineChart, donut, palette } from "../lib/chart.ts";
import { state } from "../lib/store.ts";
import { cardTile, confidenceBadge, empty, section, statCard, trendPill, placeholder } from "../components/ui.ts";
import { landing } from "./landing.ts";

export async function dashboard(): Promise<HTMLElement> {
  if (!state.user) return landing();
  const [p, movers] = await Promise.all([api.portfolio(), api.movers("de").catch(() => ({ up: [], down: [] }))]);
  const root = h("div", { class: "page" });
  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Portfolio"), h("h1", null, `Hallo${state.user.name ? `, ${state.user.name}` : ""}`)),
      h("a", { class: "btn primary", href: "/suche" }, svg(icons.plus, 18), " Karte hinzufügen")),
    h("div", { class: "stats" },
      statCard("Gesamtwert", fmt.eurCompact(p.totalValue), p.change30d == null ? h("span", { class: "muted" }, "Wert-Historie startet heute") : trendPill(p.change30d, " / 30 T."), "featured"),
      statCard("Einstand", fmt.eurCompact(p.totalCost), p.totalCost ? h("span", { class: `trend ${trendClass(p.totalValue - p.totalCost)}` }, `${p.totalValue - p.totalCost >= 0 ? "+" : ""}${fmt.eur(p.totalValue - p.totalCost)} (${fmt.pct(p.totalCost ? p.totalValue / p.totalCost - 1 : null)})`) : h("span", { class: "muted" }, "Kaufpreise erfassen für Gewinn/Verlust")),
      statCard("Karten", `${fmt.int(p.itemCount)}`, h("span", { class: "muted" }, `${p.cardCount} Positionen`)),
      statCard("Deutsch-Anteil", p.totalValue ? `${Math.round(((p.byLanguage.find((l) => l.language === "de")?.value ?? 0) / p.totalValue) * 100)} %` : "–", h("span", { class: "muted" }, "des Portfoliowerts")),
    ),
  );

  if (!p.cardCount) {
    root.append(empty("Deine Sammlung ist noch leer", "Suche eine Karte – auf Deutsch, z. B. „Glurak ex 199“ – und füge sie mit Sprache, Zustand und Kaufpreis hinzu. Der Marktwert kommt automatisch.", h("a", { class: "btn primary", href: "/suche" }, "Erste Karte suchen")));
    if (movers.up.length) root.append(moversPanel(movers));
    return root;
  }

  const chartPanel = section("Wertentwicklung", lineChart([{ name: "Portfolio", points: p.history, color: "var(--c-brand)" }], { formatY: (n) => fmt.eurCompact(n), emptyText: "Deine Wert-Historie startet heute und wächst mit jedem Tag." }));
  const insights = section("Insights", h("div", { class: "insights" }, ...p.insights.map((i) => h(i.cardId ? "a" : "div", { class: `insight ${i.kind}`, href: i.cardId ? `/karte/${encodeURIComponent(i.cardId)}` : null },
    svg(i.kind === "up" ? icons.up : i.kind === "down" ? icons.down : i.kind === "warn" ? icons.warn : icons.info, 18), h("div", null, h("strong", null, i.title), h("p", null, i.text))))));
  root.append(h("div", { class: "grid-2" }, chartPanel, insights));

  const parts = p.byLanguage.map((l, i) => ({ value: l.value, color: palette[i % palette.length]!, label: label.language(l.language) }));
  const breakdown = section("Aufteilung",
    h("div", { class: "breakdown" }, donut(parts, 128), h("ul", { class: "legend" }, ...parts.map((pt) => h("li", null, h("i", { style: { background: pt.color } }), h("span", null, pt.label), h("b", null, fmt.eurCompact(pt.value)))))),
    h("h3", { class: "sub" }, "Nach Set"),
    h("ul", { class: "ranked" }, ...p.bySet.slice(0, 6).map((s) => h("li", null, h("a", { href: `/sets/${encodeURIComponent(s.setId)}` }, s.setName), h("span", { class: "muted" }, `${s.count} Karten`), h("b", null, fmt.eurCompact(s.value))))),
  );
  const top = section("Wertvollste Karten", h("div", { class: "holdings" }, ...p.topHoldings.map((it) => h("a", { class: "holding", href: `/karte/${encodeURIComponent(it.cardId)}` },
    imgOr(cardImage(it.card), () => placeholder(it.card)),
    h("div", { class: "holding-body" }, h("strong", null, cardName(it.card)), h("span", { class: "muted" }, `#${it.card.localId} · ${label.language(it.language)} · ${label.condition(it.condition)}${it.gradingCompany ? ` · ${it.gradingCompany} ${it.grade}` : ""}${it.quantity > 1 ? ` · ${it.quantity}×` : ""}`), confidenceBadge(it.quote?.confidence)),
    h("div", { class: "holding-value" }, h("b", null, fmt.eur((it.currentValue ?? 0) * it.quantity)), trendPill(it.quote?.trend30))))));
  root.append(h("div", { class: "grid-2" }, top, breakdown));

  if (p.movers.length) root.append(section("Bewegung in deiner Sammlung (30 Tage)", h("div", { class: "tiles" }, ...p.movers.map((m) => cardTile(m.item.card, { value: m.item.currentValue, trend: m.change30, sub: `${label.language(m.item.language)} · ${label.condition(m.item.condition)}` })))));
  root.append(moversPanel(movers));
  return root;
}

export function moversPanel(m: { up: Array<{ card: Parameters<typeof cardTile>[0]; value: number; trend: number }>; down: Array<{ card: Parameters<typeof cardTile>[0]; value: number; trend: number }> }): HTMLElement {
  return section("Markt: Deutsche Karten in Bewegung",
    h("div", { class: "grid-2" },
      h("div", null, h("h3", { class: "sub up" }, svg(icons.up, 16), " Aufsteiger"), h("div", { class: "tiles small" }, ...m.up.slice(0, 6).map((x) => cardTile(x.card, { value: x.value, trend: x.trend })))),
      h("div", null, h("h3", { class: "sub down" }, svg(icons.down, 16), " Absteiger"), h("div", { class: "tiles small" }, ...m.down.slice(0, 6).map((x) => cardTile(x.card, { value: x.value, trend: x.trend })))),
    ),
    h("a", { class: "link", href: "/markt" }, "Zum Marktüberblick →"));
}

export type { PortfolioSummary };
