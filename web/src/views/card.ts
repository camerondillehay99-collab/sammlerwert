import type { CardDetail, PricePoint } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr, saleBadge } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { addToCollection, confidenceBadge, empty, quoteRow, reportSale, section, trendPill, placeholder, requireLogin } from "../components/ui.ts";
import { historyPanel, valueLadders } from "../components/history.ts";
import { tr } from "../lib/i18n.ts";

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
      card.nameEn && card.nameEn !== card.nameDe ? h("p", { class: "muted" }, tr("Englisch: {cardnameEn}", { cardnameEn: card.nameEn })) : null),
    h("div", { class: "head-actions" },
      h("button", { class: "btn ghost", onClick: () => { if (!requireLogin()) return; api.watch(card.id, "de").then(() => toast("Zur Watchlist hinzugefügt.")).catch((e) => toast(e.message, "error")); } }, svg(icons.eye, 18), tr(" Beobachten")),
      h("button", { class: "btn primary", onClick: () => addToCollection(card) }, svg(icons.plus, 18), tr(" Zur Sammlung"))),
  );

  // Comps first: the newest real sale is the number the trade quotes. Market prices (Cardmarket trend, TCGplayer) are
  // reference lines, clearly labelled as such – nothing on this page is a multiplier estimate.
  const last = card.sales[0] ?? null;
  const compBlock = last
    ? h("div", { class: "price-main sold" },
        h("span", { class: "eyebrow" }, tr("Zuletzt verkauft")),
        h("div", { class: "price-big" }, h("strong", null, fmt.eur(last.priceEur)), saleBadge(last.listingType)),
        h("div", { class: "price-sub" }, h("span", { class: "muted" }, `${fmt.date(last.soldAt)} · ${label.marketplace(last.source)} · ${label.language(last.language)} · ${last.gradingCompany ? `${last.gradingCompany} ${last.grade}` : last.condition ? label.condition(last.condition) : label.variant(last.variant)}`),
          last.url ? h("a", { href: last.url, target: "_blank", rel: "noopener" }, tr("Angebot "), svg(icons.external, 12)) : null),
        card.sales.length > 1 ? h("div", { class: "comps-strip" }, ...card.sales.slice(1, 6).map((s) => h("span", { class: "comp" }, h("b", null, fmt.eur(s.priceEur)), h("small", null, ` ${s.gradingCompany ? `${s.gradingCompany} ${s.grade}` : s.condition ? s.condition : label.variant(s.variant)} · ${label.listingType(s.listingType)} · ${fmt.date(s.soldAt)}`)))) : null)
    : h("div", { class: "price-main sold empty" },
        h("span", { class: "eyebrow" }, tr("Zuletzt verkauft")),
        h("div", { class: "price-big" }, h("strong", { class: "muted" }, "–")),
        h("p", { class: "muted" }, tr("Noch kein Verkauf erfasst. Verkäufe von eBay werden laufend eingelesen, sobald der Datenzugang aktiv ist – wertvolle und beobachtete Karten zuerst.")));

  const hero = h("div", { class: "card-hero" },
    h("div", { class: "card-art" }, imgOr(img, () => placeholder(card), { alt: cardName(card), width: 600, height: 825, loading: "eager" }),
      card.image == null && card.imageEn ? h("small", { class: "muted" }, tr("Englischer Scan – kein deutscher Scan verfügbar")) : null),
    h("div", { class: "card-prices" },
      compBlock,
      primaryDe ? h("div", { class: "price-ref" },
        h("span", { class: "eyebrow" }, tr("Marktpreis Deutsch (Referenz)"), ` · ${label.variant(primaryDe.variant)}`),
        h("div", { class: "price-row" }, h("b", null, fmt.eur(primaryDe.value)), trendPill(primaryDe.trend30, " / 30 T."), confidenceBadge(primaryDe.confidence)),
        h("p", { class: "method muted" }, `Basis: ${label.method(primaryDe.method)}${primaryDe.nSales90d ? ` · ${primaryDe.nSales90d} Verkäufe in 90 Tagen` : ""} · `, h("a", { href: "/methodik" }, tr("Methodik")))) : null,
      primaryEn && primaryEn.value != null && primaryDe && (primaryEn.value !== primaryDe.value || primaryEn.method !== primaryDe.method) ? h("div", { class: "price-compare" }, h("span", null, tr("Englisch")), h("b", null, fmt.eur(primaryEn.value)), primaryDe?.value && primaryEn.value ? h("span", { class: `trend ${primaryDe.value >= primaryEn.value ? "up" : "down"}` }, tr("Deutsch {fmtpctprimar}", { fmtpctprimar: fmt.pct(primaryDe.value / primaryEn.value - 1) })) : null) : null,
      card.guide ? h("div", { class: "guide" },
        h("div", { class: "guide-head" }, h("span", null, tr("Cardmarket-Preisguide")), h("small", { class: "muted" }, tr("alle Sprachen · {fmtdatecardg}", { fmtdatecardg: fmt.date(card.guide.date) }))),
        h("div", { class: "guide-grid" }, gv(tr("Trend"), card.guide.trend), gv(tr("Ø 1 Tag"), card.guide.avg1), gv(tr("Ø 7 Tage"), card.guide.avg7), gv(tr("Ø 30 Tage"), card.guide.avg30), gv(tr("Ab"), card.guide.low),
          card.guide.foilTrend != null ? gv(tr("Reverse Trend"), card.guide.foilTrend) : null, card.guide.foilAvg30 != null ? gv(tr("Reverse Ø 30"), card.guide.foilAvg30) : null),
        card.cmUrl ? h("a", { class: "link", href: card.cmUrl, target: "_blank", rel: "noopener" }, tr("Deutsche Angebote auf Cardmarket "), svg(icons.external, 14)) : null) : null,
      h("div", { class: "actions-row" }, h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, svg(icons.flag, 16), tr(" Verkauf melden"))),
    ),
  );

  const chart = historyPanel(card);
  const ladders = section(tr("Comps nach Zustand & Bewertung"), valueLadders(card));

  const quotes = section(tr("Alle Bewertungen"), card.prices.length ? h("div", { class: "quotes" }, ...[...de, ...en, ...others].map(quoteRow)) : h("p", { class: "muted" }, tr("Noch keine Bewertungen.")));

  const sales = section(`Letzte Verkäufe${card.sales.length ? ` (${card.sales.length})` : ""}`, card.sales.length
    ? h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, tr("Datum")), h("th", null, tr("Preis")), h("th", null, tr("Verkaufsart")), h("th", null, tr("Sprache")), h("th", null, tr("Variante / Zustand")), h("th", null, tr("Marktplatz")))),
        h("tbody", null, ...card.sales.map((s) => h("tr", null, h("td", null, fmt.date(s.soldAt)), h("td", null, h("b", null, fmt.eur(s.priceEur))), h("td", null, saleBadge(s.listingType)), h("td", null, label.language(s.language)),
          h("td", null, `${label.variant(s.variant)}${s.condition ? ` · ${label.condition(s.condition)}` : ""}${s.gradingCompany ? ` · ${s.gradingCompany} ${s.grade}` : ""}`),
          h("td", null, s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, label.marketplace(s.source), " ", svg(icons.external, 12)) : label.marketplace(s.source), s.verified ? h("span", { class: "chip ok", title: "verifiziert" }, "✓") : h("span", { class: "chip ghost", title: tr("von einem Nutzer gemeldet, noch nicht geprüft") }, tr("Community")))))))
    : h("div", null, h("p", { class: "muted" }, tr("Noch keine Verkäufe für diese Karte erfasst. Verkäufe von eBay werden laufend eingelesen – wertvolle und beobachtete Karten zuerst.")), h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, tr("Verkauf melden"))));

  const gradedSales = card.graded;
  const graded = gradedSales.length ? section(tr("Bewertete Verkäufe im Detail"),
        h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, tr("Grade")), h("th", null, tr("Zuletzt verkauft")), h("th", null, tr("Verkaufsart")), h("th", null, tr("Median 180 T.")), h("th", null, tr("Spanne")), h("th", null, tr("Verkäufe")))),
          h("tbody", null, ...gradedSales.map((g) => h("tr", null,
            h("td", null, h("b", null, `${g.company} ${g.grade}`)),
            h("td", null, h("b", null, fmt.eur(g.value)), h("small", { class: "muted" }, ` ${g.lastSoldAt ? fmt.date(g.lastSoldAt) : ""}`)),
            h("td", null, saleBadge(g.lastListingType), h("small", { class: "muted" }, ` ${label.marketplace(g.lastSource)}`)),
            h("td", null, g.median != null ? fmt.eur(g.median) : "–"),
            h("td", null, g.low != null ? `${fmt.eur(g.low)} – ${fmt.eur(g.high)}` : "–"),
            h("td", null, tr("{gn} ({gn90} in 90 T.)", { gn: g.n, gn90: g.n90 })))))),
        h("p", { class: "muted small" }, tr("Nur echte Verkäufe. Median = zeitgewichtet über 180 Tage, Ausreißer entfernt."))) : null;

  const details = section(tr("Details"), h("dl", { class: "dl" },
    dd(tr("Set"), h("a", { href: `/sets/${encodeURIComponent(card.setId)}` }, card.setNameDe ?? card.setNameEn ?? card.setId)), dd(tr("Nummer"), card.localId), dd(tr("Seltenheit"), card.rarity ?? "–"),
    dd(tr("Kategorie"), card.category ?? "–"), card.hp ? dd("KP", String(card.hp)) : null, card.types.length ? dd(tr("Typ"), card.types.join(", ")) : null,
    dd(tr("Illustrator"), card.illustrator ?? "–"), dd(tr("Varianten"), Object.entries(card.variants).filter(([, v]) => v).map(([k]) => label.variant(k)).join(", ") || "–"),
    dd(tr("Cardmarket-Zuordnung"), card.cmProductId ? `${card.cmMatchMethod === "tcgdex" ? "exakt" : tr("per Name")} (#${card.cmProductId})` : "offen"),
    dd("TCGplayer", card.tcgpProductId ? h("a", { href: `https://www.tcgplayer.com/product/${card.tcgpProductId}`, target: "_blank", rel: "noopener" }, `#${card.tcgpProductId} `, svg(icons.external, 12)) : "–"), dd(tr("Katalog-ID"), card.id)));

  return [head, hero, chart, ladders, h("div", { class: "grid-2" }, quotes, details), ...(graded ? [graded] : []), sales];
}

function gv(lbl: string, v: number | null): HTMLElement | null { return v == null ? null : h("div", null, h("span", null, lbl), h("b", null, fmt.eur(v))); }
function dd(k: string, v: string | HTMLElement): HTMLElement { return h("div", null, h("dt", null, k), h("dd", null, v)); }
export function primaryVariant(card: CardDetail): string {
  if (card.variants.normal !== false && (card.variants.normal || !card.variants.holo)) return "normal";
  if (card.variants.holo) return "holo";
  return card.prices[0]?.variant ?? "normal";
}
export type { PricePoint };
