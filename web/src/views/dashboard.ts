import type { PortfolioSummary } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, trendClass, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { lineChart, donut, palette } from "../lib/chart.ts";
import { state } from "../lib/store.ts";
import { cardTile, confidenceBadge, empty, section, statCard, trendPill, placeholder } from "../components/ui.ts";
import { hoverToggle } from "../components/hover.ts";
import { safeGet, safeSet } from "../lib/store.ts";
import { landing } from "./landing.ts";
import { tr } from "../lib/i18n.ts";

const RANGES: Array<[string, number | null, string]> = [["1d", 1, "1T"], ["7d", 7, "7T"], ["1m", 30, "1M"], ["3m", 91, "3M"], ["6m", 182, "6M"], ["max", null, "MAX"]];

export async function dashboard(): Promise<HTMLElement> {
  if (!state.user) return landing();
  const [p, movers] = await Promise.all([api.portfolio(), api.movers("de").catch(() => ({ up: [], down: [] }))]);
  const root = h("div", { class: "page" });
  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Portfolio")), h("h1", null, `Hallo${state.user.name ? `, ${state.user.name}` : ""}`)),
      h("div", { class: "head-actions" }, hoverToggle(), h("a", { class: "btn primary", href: "/suche" }, svg(icons.plus, 18), tr(" Karte hinzufügen")))),
    h("div", { class: "stats" },
      statCard(tr("Gesamtwert"), { n: p.totalValue, format: fmt.eurCompact }, h("span", null, p.change30d == null ? h("span", { class: "muted" }, tr("Wert-Historie startet heute")) : trendPill(p.change30d, " / 30 T."), p.unvaluedCount ? h("span", { class: "muted" }, ` · ${tr("{n} ohne Comp", { n: p.unvaluedCount })}`) : null), "featured", tr("Summe über alle Karten (Menge × Wert). Wert = letzter Verkauf (Comp) derselben Note bzw. desselben Zustands; rohe NM-Karten ohne Comp nach Markttrend; alles andere bleibt unbewertet.")),
      statCard(tr("Einstand"), { n: p.totalCost, format: fmt.eurCompact }, p.totalCost ? h("span", { class: `trend ${trendClass(p.totalValue - p.totalCost)}` }, `${p.totalValue - p.totalCost >= 0 ? "+" : ""}${fmt.eur(p.totalValue - p.totalCost)} (${fmt.pct(p.totalCost ? p.totalValue / p.totalCost - 1 : null)})`) : h("span", { class: "muted" }, tr("Kaufpreise erfassen für Gewinn/Verlust"))),
      statCard(tr("Karten"), { n: p.itemCount, format: (n) => fmt.int(Math.round(n)) }, h("span", { class: "muted" }, tr("{pcardCount} Positionen", { pcardCount: p.cardCount }))),
      statCard(tr("Deutsch-Anteil"), p.totalValue ? `${Math.round(((p.byLanguage.find((l) => l.language === "de")?.value ?? 0) / p.totalValue) * 100)} %` : "–", h("span", { class: "muted" }, tr("des Portfoliowerts"))),
    ),
  );

  if (!p.cardCount) {
    root.append(empty(tr("Deine Sammlung ist noch leer"), tr("Suche eine Karte – auf Deutsch, z. B. „Glurak ex 199“ – und füge sie mit Sprache, Zustand und Kaufpreis hinzu. Der Marktwert kommt automatisch."), h("a", { class: "btn primary", href: "/suche" }, tr("Erste Karte suchen"))));
    if (movers.up.length) root.append(moversPanel(movers));
    return root;
  }

  const chartPanel = valuePanel(p);
  const insights = section(tr("Insights"), h("div", { class: "insights" }, ...p.insights.map((i) => h(i.cardId ? "a" : "div", { class: `insight ${i.kind}`, href: i.cardId ? `/karte/${encodeURIComponent(i.cardId)}` : null },
    svg(i.kind === "up" ? icons.up : i.kind === "down" ? icons.down : i.kind === "warn" ? icons.warn : icons.info, 18), h("div", null, h("strong", null, i.title), h("p", null, i.text))))));
  root.append(h("div", { class: "grid-2" }, chartPanel, insights));

  const parts = p.byLanguage.map((l, i) => ({ value: l.value, color: palette[i % palette.length]!, label: label.language(l.language) }));
  const kinds = (p.byKind ?? []).map((k, i) => ({ value: k.value, count: k.count, color: k.kind === "raw" ? "var(--c-muted)" : palette[(i + 1) % palette.length]!, label: k.kind === "raw" ? tr("Roh (ungraded)") : k.kind }));
  const breakdown = section(tr("Aufteilung"),
    h("h3", { class: "sub" }, tr("Roh vs. bewertet")),
    kinds.length ? h("div", null, h("div", { class: "hbar" }, ...kinds.map((k) => h("i", { style: { width: `${p.totalValue ? (k.value / p.totalValue) * 100 : 0}%`, background: k.color }, title: `${k.label}: ${fmt.eurCompact(k.value)}` }))),
      h("ul", { class: "legend inline" }, ...kinds.map((k) => h("li", null, h("i", { style: { background: k.color } }), h("span", null, `${k.label} · ${k.count}`), h("b", null, fmt.eurCompact(k.value)))))) : null,
    h("h3", { class: "sub" }, tr("Nach Sprache")),
    h("div", { class: "breakdown" }, donut(parts, 128), h("ul", { class: "legend" }, ...parts.map((pt) => h("li", null, h("i", { style: { background: pt.color } }), h("span", null, pt.label), h("b", null, fmt.eurCompact(pt.value)))))),
    h("h3", { class: "sub" }, tr("Nach Set")),
    h("ul", { class: "ranked" }, ...p.bySet.slice(0, 6).map((s) => h("li", null, h("a", { href: `/sets/${encodeURIComponent(s.setId)}` }, s.setName), h("span", { class: "muted" }, tr("{scount} Karten", { scount: s.count })), h("b", null, fmt.eurCompact(s.value))))),
  );
  const top = section(tr("Wertvollste Karten"), h("div", { class: "holdings" }, ...p.topHoldings.map((it) => { const v = (it.currentValue ?? 0) * it.quantity; const share = p.totalValue ? v / p.totalValue : 0; return h("a", { class: "holding", href: `/karte/${encodeURIComponent(it.cardId)}` },
    imgOr(cardImage(it.card), () => placeholder(it.card)),
    h("div", { class: "holding-body" }, h("strong", null, cardName(it.card)), h("span", { class: "muted" }, `#${it.card.localId} · ${label.language(it.language)} · ${label.condition(it.condition)}${it.gradingCompany ? ` · ${it.gradingCompany} ${it.grade}` : ""}${it.quantity > 1 ? ` · ${it.quantity}×` : ""}`),
      h("div", { class: "share" }, h("i", { style: { width: `${Math.max(2, share * 100)}%` } }), h("small", { class: "muted" }, tr("{pct} des Portfolios", { pct: fmt.pct(share, false) })))),
    h("div", { class: "holding-value" }, h("b", null, fmt.eur(v)), trendPill(it.quote?.trend30))); })));
  root.append(h("div", { class: "grid-2" }, top, breakdown));

  if (p.movers.length) root.append(section(tr("Bewegung in deiner Sammlung (30 Tage)"), h("div", { class: "tiles" }, ...p.movers.map((m) => cardTile(m.item.card, { value: m.item.currentValue, trend: m.change30, sale: false, sub: `${label.language(m.item.language)} · ${label.condition(m.item.condition)}` })))));
  root.append(moversPanel(movers));
  return root;
}

/** Big value + range selector (1T … MAX) with the matching change and a hover-readout chart. */
function valuePanel(p: PortfolioSummary): HTMLElement {
  let range = safeGet("sw-prange") ?? "1m";
  const hist = [...p.history].sort((a, b) => a.date.localeCompare(b.date));
  const head = h("div", { class: "value-head" });
  const chartBox = h("div", { class: "chart-box" });
  const bar = h("div", { class: "seg ranges", role: "tablist" });
  const draw = () => {
    const days = RANGES.find((r) => r[0] === range)?.[1];
    const minDate = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : undefined;
    const pts = minDate ? hist.filter((x) => x.date >= minDate) : hist;
    const base = minDate ? (hist.filter((x) => x.date < minDate).at(-1) ?? pts[0]) : pts[0];
    const last = hist.at(-1);
    const ch = base && last && base.value ? last.value / base.value - 1 : null;
    const diff = base && last ? last.value - base.value : null;
    head.replaceChildren(h("div", null, h("span", { class: "eyebrow" }, tr("Gesamtwert")), h("b", { class: "value-big" }, fmt.eur(p.totalValue))),
      h("div", { class: "value-change" }, ch == null || pts.length < 2 ? h("span", { class: "muted" }, tr("Wert-Historie startet heute")) : [trendPill(ch, ""), h("span", { class: `trend ${diff! >= 0 ? "up" : "down"}` }, `${diff! >= 0 ? "+" : ""}${fmt.eur(diff)}`), h("small", { class: "muted" }, RANGES.find((r) => r[0] === range)?.[2] ?? "")]));
    bar.replaceChildren(...RANGES.map(([k, , l]) => h("button", { class: k === range ? "active" : "", role: "tab", onClick: () => { range = k; safeSet("sw-prange", k); draw(); } }, l)));
    chartBox.replaceChildren(lineChart([{ name: "Portfolio", points: p.history, color: "var(--c-brand)" }], { formatY: (n) => fmt.eurCompact(n), minDate, emptyText: tr("Deine Wert-Historie startet heute und wächst mit jedem Tag.") }));
  };
  draw();
  return h("section", { class: "panel" }, h("div", { class: "history-head" }, h("h2", { class: "panel-title" }, tr("Wertentwicklung")), bar), head, chartBox);
}

export function moversPanel(m: { up: Array<{ card: Parameters<typeof cardTile>[0]; value: number; trend: number }>; down: Array<{ card: Parameters<typeof cardTile>[0]; value: number; trend: number }> }): HTMLElement {
  return section(tr("Markt: Deutsche Karten in Bewegung"),
    h("div", { class: "grid-2" },
      h("div", null, h("h3", { class: "sub up" }, svg(icons.up, 16), tr(" Aufsteiger")), h("div", { class: "tiles small" }, ...m.up.slice(0, 6).map((x) => cardTile(x.card, { value: x.value, trend: x.trend, sale: false })))),
      h("div", null, h("h3", { class: "sub down" }, svg(icons.down, 16), tr(" Absteiger")), h("div", { class: "tiles small" }, ...m.down.slice(0, 6).map((x) => cardTile(x.card, { value: x.value, trend: x.trend, sale: false })))),
    ),
    h("a", { class: "link", href: "/markt" }, tr("Zum Marktüberblick →")));
}

export type { PortfolioSummary };
