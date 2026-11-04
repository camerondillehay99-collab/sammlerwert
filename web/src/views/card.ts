import type { CardDetail, PricePoint } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { lineChart } from "../lib/chart.ts";
import { state } from "../lib/store.ts";
import { addToCollection, confidenceBadge, empty, quoteRow, reportSale, section, trendPill, placeholder, requireLogin } from "../components/ui.ts";

export async function cardView(params: Record<string, string>): Promise<HTMLElement> {
  let card = await api.card(params.id!);
  const root = h("div", { class: "page card-page" });
  const render = () => { clear(root); root.append(...build(card, (c) => { card = c; render(); })); };
  render();
  return root;
}

function build(card: CardDetail, update: (c: CardDetail) => void): HTMLElement[] {
  const img = cardImage(card, "high");
  const de = card.prices.filter((p) => p.language === "de");
  const en = card.prices.filter((p) => p.language === "en");
  const primaryDe = de.find((p) => p.variant === primaryVariant(card)) ?? de[0] ?? null;
  const primaryEn = en.find((p) => p.variant === primaryVariant(card)) ?? en[0] ?? null;
  const others = card.prices.filter((p) => p.language !== "de" && p.language !== "en");

  const head = h("header", { class: "page-head" },
    h("div", null,
      h("p", { class: "eyebrow" }, h("a", { href: `/sets/${encodeURIComponent(card.setId)}` }, card.setNameDe ?? card.setNameEn ?? card.setId), ` · #${card.localId}${card.rarity ? ` · ${card.rarity}` : ""}`),
      h("h1", null, cardName(card)),
      card.nameEn && card.nameEn !== card.nameDe ? h("p", { class: "muted" }, `Englisch: ${card.nameEn}`) : null),
    h("div", { class: "head-actions" },
      h("button", { class: "btn ghost", onClick: () => { if (!requireLogin()) return; api.watch(card.id, "de").then(() => toast("Zur Watchlist hinzugefügt.")).catch((e) => toast(e.message, "error")); } }, svg(icons.eye, 18), " Beobachten"),
      h("button", { class: "btn primary", onClick: () => addToCollection(card) }, svg(icons.plus, 18), " Zur Sammlung")),
  );

  const hero = h("div", { class: "card-hero" },
    h("div", { class: "card-art" }, imgOr(img, () => placeholder(card), { alt: cardName(card), width: 600, height: 825, loading: "eager" }),
      card.image == null && card.imageEn ? h("small", { class: "muted" }, "Englischer Scan – kein deutscher Scan verfügbar") : null),
    h("div", { class: "card-prices" },
      h("div", { class: "price-main" },
        h("span", { class: "eyebrow" }, "Marktwert Deutsch", primaryDe ? ` · ${label.variant(primaryDe.variant)}` : ""),
        h("div", { class: "price-big" }, h("strong", null, fmt.eur(primaryDe?.value)), primaryDe ? trendPill(primaryDe.trend30, " / 30 T.") : null),
        primaryDe ? h("div", { class: "price-sub" }, confidenceBadge(primaryDe.confidence), h("span", { class: "muted" }, primaryDe.low != null ? `Spanne ${fmt.eur(primaryDe.low)} – ${fmt.eur(primaryDe.high)}` : "")) : h("p", { class: "muted" }, card.cmProductId ? "Noch kein Marktwert berechnet." : "Diese Karte ist noch keinem Cardmarket-Produkt zugeordnet. Die Zuordnung läuft im Hintergrund."),
        primaryDe ? h("p", { class: "method muted" }, `Basis: ${label.method(primaryDe.method)}${primaryDe.nSales90d ? ` · ${primaryDe.nSales90d} Verkäufe in 90 Tagen` : ""} · `, h("a", { href: "/methodik" }, "Methodik")) : null),
      primaryEn && primaryEn.value != null && primaryDe && (primaryEn.value !== primaryDe.value || primaryEn.method !== primaryDe.method) ? h("div", { class: "price-compare" }, h("span", null, "Englisch"), h("b", null, fmt.eur(primaryEn.value)), primaryDe?.value && primaryEn.value ? h("span", { class: `trend ${primaryDe.value >= primaryEn.value ? "up" : "down"}` }, `Deutsch ${fmt.pct(primaryDe.value / primaryEn.value - 1)}`) : null) : null,
      card.guide ? h("div", { class: "guide" },
        h("div", { class: "guide-head" }, h("span", null, "Cardmarket-Preisguide"), h("small", { class: "muted" }, `alle Sprachen · ${fmt.date(card.guide.date)}`)),
        h("div", { class: "guide-grid" }, gv("Trend", card.guide.trend), gv("Ø 1 Tag", card.guide.avg1), gv("Ø 7 Tage", card.guide.avg7), gv("Ø 30 Tage", card.guide.avg30), gv("Ab", card.guide.low),
          card.guide.foilTrend != null ? gv("Reverse Trend", card.guide.foilTrend) : null, card.guide.foilAvg30 != null ? gv("Reverse Ø 30", card.guide.foilAvg30) : null),
        card.cmUrl ? h("a", { class: "link", href: card.cmUrl, target: "_blank", rel: "noopener" }, "Deutsche Angebote auf Cardmarket ", svg(icons.external, 14)) : null) : null,
      h("div", { class: "actions-row" }, h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, svg(icons.flag, 16), " Verkauf melden")),
    ),
  );

  const ownHistory = card.history.filter((p) => !p.source && p.language === "de" && p.variant === primaryVariant(card));
  const cmHistory = card.history.filter((p) => p.source === "cardmarket");
  const series = [];
  if (ownHistory.length) series.push({ name: "Marktwert Deutsch", points: ownHistory, color: "var(--c-brand)" });
  if (cmHistory.length) series.push({ name: "Cardmarket Trend (alle Sprachen)", points: cmHistory, color: "var(--c-blue)", dashed: true });
  const chart = section("Preisverlauf", lineChart(series, { formatY: (n) => fmt.eurCompact(n), emptyText: "Der Preisverlauf baut sich ab heute täglich auf." }),
    h("div", { class: "legend inline" }, ...series.map((s) => h("span", null, h("i", { style: { background: s.color } }), s.name))));

  const quotes = section("Alle Bewertungen", card.prices.length ? h("div", { class: "quotes" }, ...[...de, ...en, ...others].map(quoteRow)) : h("p", { class: "muted" }, "Noch keine Bewertungen."));

  const sales = section(`Letzte Verkäufe${card.sales.length ? ` (${card.sales.length})` : ""}`, card.sales.length
    ? h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, "Datum"), h("th", null, "Preis"), h("th", null, "Sprache"), h("th", null, "Variante / Zustand"), h("th", null, "Quelle"))),
        h("tbody", null, ...card.sales.map((s) => h("tr", null, h("td", null, fmt.date(s.soldAt)), h("td", null, h("b", null, fmt.eur(s.priceEur))), h("td", null, label.language(s.language)),
          h("td", null, `${label.variant(s.variant)}${s.condition ? ` · ${label.condition(s.condition)}` : ""}${s.gradingCompany ? ` · ${s.gradingCompany} ${s.grade}` : ""}`),
          h("td", null, s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, sourceLabel(s.source), " ", svg(icons.external, 12)) : sourceLabel(s.source), s.verified ? h("span", { class: "chip ok", title: "verifiziert" }, "✓") : null)))))
    : h("div", null, h("p", { class: "muted" }, "Noch keine Verkäufe für diese Karte erfasst. Verkäufe von eBay.de werden laufend eingelesen – wertvolle und beobachtete Karten zuerst."), h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, "Verkauf melden")));

  const graded = section("Bewertete Karten (PSA · CGC · BGS)", card.graded.length
    ? h("div", null,
        h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, "Grade"), h("th", null, "Wert"), h("th", null, "Spanne"), h("th", null, "Verkäufe"), h("th", null, "Letzter Verkauf"))),
          h("tbody", null, ...card.graded.map((g) => h("tr", null,
            h("td", null, h("b", null, `${g.company} ${g.grade}`)),
            h("td", null, h("b", null, fmt.eur(g.value)), g.method === "multiplier" ? h("span", { class: "chip", title: "Keine Verkäufe dieser Bewertung erfasst – Schätzung aus dem Rohwert" }, "Schätzung") : null),
            h("td", null, g.low != null ? `${fmt.eur(g.low)} – ${fmt.eur(g.high)}` : "–"),
            h("td", null, g.method === "sales" ? `${g.n} (${g.n90} in 90 T.)` : "–"),
            h("td", null, g.lastSoldAt ? fmt.date(g.lastSoldAt) : "–"))))),
        h("p", { class: "muted small" }, "Werte mit Verkäufen: zeitgewichteter Median echter Verkäufe dieser Bewertung (180 Tage, Ausreißer entfernt). „Schätzung“ = Rohwert × typischer Aufschlag, bis Verkäufe vorliegen."))
    : h("p", { class: "muted" }, "Noch keine Verkäufe bewerteter Exemplare erfasst."));

  const details = section("Details", h("dl", { class: "dl" },
    dd("Set", h("a", { href: `/sets/${encodeURIComponent(card.setId)}` }, card.setNameDe ?? card.setNameEn ?? card.setId)), dd("Nummer", card.localId), dd("Seltenheit", card.rarity ?? "–"),
    dd("Kategorie", card.category ?? "–"), card.hp ? dd("KP", String(card.hp)) : null, card.types.length ? dd("Typ", card.types.join(", ")) : null,
    dd("Illustrator", card.illustrator ?? "–"), dd("Varianten", Object.entries(card.variants).filter(([, v]) => v).map(([k]) => label.variant(k)).join(", ") || "–"),
    dd("Cardmarket-Zuordnung", card.cmProductId ? `${card.cmMatchMethod === "tcgdex" ? "exakt" : "per Name"} (#${card.cmProductId})` : "offen"), dd("Katalog-ID", card.id)));

  return [head, hero, chart, h("div", { class: "grid-2" }, quotes, details), graded, sales];
}

function gv(lbl: string, v: number | null): HTMLElement | null { return v == null ? null : h("div", null, h("span", null, lbl), h("b", null, fmt.eur(v))); }
function dd(k: string, v: string | HTMLElement): HTMLElement { return h("div", null, h("dt", null, k), h("dd", null, v)); }
function sourceLabel(s: string) { return ({ ebay_de: "eBay.de", ebay: "eBay", cardmarket: "Cardmarket", user: "Community", import: "Import" } as Record<string, string>)[s] ?? s; }
export function primaryVariant(card: CardDetail): string {
  if (card.variants.normal !== false && (card.variants.normal || !card.variants.holo)) return "normal";
  if (card.variants.holo) return "holo";
  return card.prices[0]?.variant ?? "normal";
}
export type { PricePoint };
