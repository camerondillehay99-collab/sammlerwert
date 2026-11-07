/**
 * Card page, laid out the way Card Ladder presents a card:
 *   header   – name, set, profile chips (all sales / raw rung / grade), last sold price + date, Sammlerwert value, population
 *   investment – when the viewer owns the card: investment, current value, potential profit, ROI, cert
 *   sales    – stats + sales line chart with own purchases marked, then the sale rows (source · title · date · type · price)
 *   profile  – card facts and the population report (PSA live; CGC/BGS/SGC/TAG when imported)
 *   comps    – last sold per condition rung and per grade; market references (Cardmarket guide, quotes) last
 */
import type { CardDetail, CollectionItem, PricePoint, SaleRecord } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr, saleBadge } from "../lib/dom.ts";
import { api, invalidate } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { addToCollection, confidenceBadge, empty, field, modal, quoteRow, reportSale, section, trendPill, placeholder, requireLogin } from "../components/ui.ts";
import { salesPanel, valueLadders, filterOptions, filterSales, filterKey, type SalesFilter, type Purchase } from "../components/history.ts";
import { saleRow, populationBlock } from "../components/sales.ts";
import { tr } from "../lib/i18n.ts";

export async function cardView(params: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const [card, owned, hlt] = await Promise.all([api.card(params.id!), state.user ? api.items().then((r) => r.items.filter((i) => i.cardId === params.id)).catch(() => [] as CollectionItem[]) : Promise.resolve([] as CollectionItem[]), api.health().catch(() => null)]);
  const root = h("div", { class: "page card-page" });
  let current = card;
  const render = () => { clear(root); root.append(...build(current, owned, query, (c) => { current = c; render(); }, !!hlt?.compsOnDemand)); };
  render();
  return root;
}

function build(card: CardDetail, owned: CollectionItem[], query: URLSearchParams, update: (c: CardDetail) => void, compsOnDemand = false): HTMLElement[] {
  const img = cardImage(card, "high");
  const de = card.prices.filter((p) => p.language === "de");
  const en = card.prices.filter((p) => p.language === "en");
  const primaryDe = de.find((p) => p.variant === primaryVariant(card)) ?? de[0] ?? null;
  const primaryEn = en.find((p) => p.variant === primaryVariant(card)) ?? en[0] ?? null;
  const others = card.prices.filter((p) => p.language !== "de" && p.language !== "en");

  // Profile = which sales we look at. Opens on the viewer's own grade when they hold a graded copy, else on all sales.
  const options = filterOptions(card);
  const ownedGraded = owned.find((i) => i.gradingCompany && i.grade != null);
  // Default profile: the viewer's own grade, else the profile with the most sales (mixing PSA 10 and raw copies in one
  // curve says nothing), else all sales.
  const busiest = options.filter((o) => o.kind !== "all").map((o) => ({ o, n: filterSales(card.sales, o).length })).sort((a, b) => b.n - a.n)[0];
  const wanted = query.get("profil") ?? (ownedGraded ? `g:${ownedGraded.gradingCompany}:${ownedGraded.grade}` : busiest && busiest.n >= 3 && options.length > 2 ? filterKey(busiest.o) : "all");
  let filter: SalesFilter = options.find((o) => filterKey(o) === wanted) ?? options[0]!;
  const purchases: Purchase[] = owned.filter((i) => i.purchasePriceEur != null && i.purchasedAt).map((i) => ({ date: i.purchasedAt!.slice(0, 10), value: i.purchasePriceEur!, label: tr("Mein Kauf") + (i.gradingCompany ? ` · ${i.gradingCompany} ${i.grade}` : ` · ${label.condition(i.condition)}`) }));

  const head = h("header", { class: "page-head card-head" },
    h("div", null,
      h("p", { class: "eyebrow" }, h("a", { href: `/sets/${encodeURIComponent(card.setId)}` }, card.setNameDe ?? card.setNameEn ?? card.setId), ` · #${card.localId}${card.rarity ? ` · ${card.rarity}` : ""}`),
      h("h1", null, cardName(card)),
      card.nameEn && card.nameEn !== card.nameDe ? h("p", { class: "muted" }, tr("Englisch: {cardnameEn}", { cardnameEn: card.nameEn })) : null),
    h("div", { class: "head-actions" },
      h("button", { class: "btn ghost", onClick: () => { if (!requireLogin()) return; api.watch(card.id, "de").then(() => toast("Zur Watchlist hinzugefügt.")).catch((e) => toast(e.message, "error")); } }, svg(icons.eye, 18), tr(" Beobachten")),
      h("button", { class: "btn primary", onClick: () => addToCollection(card) }, svg(icons.plus, 18), tr(" Zur Sammlung"))),
  );

  // ---- profile chips + KPIs (react to the selected profile) ----
  const chips = h("div", { class: "chips profile-chips" });
  const kpis = h("div", { class: "kpis" });
  const compsStrip = h("div", { class: "comps-strip" });
  const panel = salesPanel(card, { filter: () => filter, purchases });
  const rowsBox = h("div", { class: "sales-list" });
  const rowsHead = h("div", { class: "section-head" });
  let showAll = false;

  /** "Refresh eBay sales" – logged-in users pull the latest sold items of this card (server-side budget; no-op when not configured). */
  function refreshButton(): HTMLElement | null {
    if (!state.user || !compsOnDemand) return null;
    const btn = h("button", { class: "btn ghost", onClick: async () => {
      btn.disabled = true;
      try {
        const r = await api.refreshComps(card.id);
        if (r.refreshed) { toast(r.sales ? tr("{n} eBay-Verkäufe geladen.", { n: r.sales }) : tr("Keine neuen eBay-Verkäufe gefunden.")); invalidate("/api/cards/"); invalidate("/api/market/sales"); update(await api.card(card.id)); }
        else toast(r.reason === "fresh" ? tr("Die eBay-Verkäufe dieser Karte sind aktuell (höchstens 2 Tage alt).") : r.reason === "budget" ? tr("Das Tageskontingent für Sofort-Abrufe ist aufgebraucht – die Karte wird heute Nacht aktualisiert.") : tr("Verkaufsdaten-Abruf ist derzeit nicht verfügbar."), r.reason === "fresh" ? "ok" : "error");
      } catch (e) { toast((e as Error).message, "error"); }
      btn.disabled = false;
    } }, svg(icons.refresh, 16), tr(" eBay-Verkäufe aktualisieren"));
    return btn;
  }

  function drawProfile() {
    chips.replaceChildren(...options.map((o) => h("button", { class: `chip ${filterKey(o) === filterKey(filter) ? "" : "ghost"} ${o.kind === "graded" ? `grader-${o.company.toLowerCase()}` : ""}`, "aria-pressed": String(filterKey(o) === filterKey(filter)), onClick: () => { filter = o; const p = new URLSearchParams(location.search); if (o.kind === "all") p.delete("profil"); else p.set("profil", filterKey(o)); history.replaceState(null, "", `${location.pathname}${p.size ? `?${p}` : ""}`); drawProfile(); panel.redraw(); } }, o.label)));
    const sales = filterSales(card.sales, filter);
    const last = sales[0] ?? null;
    const recent = sales.filter((s) => Date.parse(s.soldAt) >= Date.now() - 180 * 86_400_000).map((s) => s.priceEur).sort((a, b) => a - b);
    const median = recent.length >= 2 ? (recent.length % 2 ? recent[(recent.length - 1) / 2]! : (recent[recent.length / 2 - 1]! + recent[recent.length / 2]!) / 2) : null;
    const value = median ?? last?.priceEur ?? null;
    const pop = card.populations.find((p) => p.company === (filter.kind === "graded" ? filter.company : "PSA")) ?? card.populations[0];
    const f = filter;
    const popGrade = f.kind === "graded" && pop ? pop.grades.find(([g]) => Number(g) === f.grade)?.[1] ?? null : null;
    kpis.replaceChildren(
      kpi(tr("Zuletzt verkauft"), last ? h("span", null, fmt.eur(last.priceEur), " ", saleBadge(last.listingType)) : "–", last ? `${label.marketplace(last.source)} · ${label.language(last.language)}` : tr("noch kein Verkauf erfasst"), "main"),
      kpi(tr("Verkauft am"), last ? fmt.date(last.soldAt) : "–", last ? fmt.rel(last.soldAt) : ""),
      kpi(tr("Sammlerwert-Wert"), value != null ? fmt.eur(value) : "–", median != null ? tr("Median · {n} Verkäufe in 180 T.", { n: recent.length }) : last ? tr("letzter Verkauf") : tr("ohne Comp"), "", tr("Median der echten Verkäufe dieses Profils in den letzten 180 Tagen; bei nur einem Verkauf dessen Preis. Keine Schätzung.")),
      kpi(tr("Population"), pop ? fmt.int(popGrade ?? pop.total) : "–", pop ? (popGrade != null ? tr("{company} {grade} · gesamt {total}", { company: pop.company, grade: String(f.kind === "graded" ? f.grade : ""), total: fmt.int(pop.total) }) : tr("{company} gesamt · Gem-Rate {rate}", { company: pop.company, rate: fmt.pct(pop.gemRate, false) })) : tr("PSA-Report folgt mit erstem Zertifikat")),
      ...(ownedGraded?.certNo ? [kpi(tr("Zertifikat"), h("a", { href: ownedGraded.gradingCompany === "PSA" ? `https://www.psacard.com/cert/${encodeURIComponent(ownedGraded.certNo)}` : "#", target: "_blank", rel: "noopener" }, ownedGraded.certNo, " ", svg(icons.external, 12)), `${ownedGraded.gradingCompany} ${ownedGraded.grade}`)] : []),
    );
    compsStrip.replaceChildren(...sales.slice(1, 6).map((s) => h("span", { class: "comp" }, h("b", null, fmt.eur(s.priceEur)), h("small", null, ` ${s.gradingCompany ? `${s.gradingCompany} ${s.grade}` : s.condition ? s.condition : label.variant(s.variant)} · ${label.listingType(s.listingType)} · ${fmt.date(s.soldAt)}`))));
    compsStrip.hidden = sales.length < 2;
    drawRows(sales);
  }
  function drawRows(sales: SaleRecord[]) {
    const link = h("a", { class: "link", href: `/verkaeufe?card=${encodeURIComponent(card.id)}${filter.kind === "graded" ? `&grader=${filter.company}&grade=${filter.grade}` : filter.kind === "raw" ? "&graded=0" : ""}` }, tr("Alle Verkäufe"), svg(icons.chevron, 14));
    rowsHead.replaceChildren(h("h3", { class: "sub" }, sales.length ? tr("{n} Verkäufe", { n: sales.length }) : tr("Verkäufe")), link);
    clear(rowsBox);
    if (!sales.length) { rowsBox.append(h("p", { class: "muted" }, tr("Noch keine Verkäufe für dieses Profil erfasst. eBay-Verkäufe (eBay.de und eBay.com, deutsch, englisch und japanisch) werden laufend eingelesen; eigene Verkäufe kannst du jederzeit melden.")), h("div", { class: "actions-row" }, refreshButton(), h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, svg(icons.flag, 16), tr(" Verkauf melden")))); return; }
    const shown = showAll ? sales : sales.slice(0, 10);
    rowsBox.append(...shown.map((s) => saleRow(s, { card, showCard: false })));
    if (sales.length > shown.length) rowsBox.append(h("div", { class: "center" }, h("button", { class: "btn ghost", onClick: () => { showAll = true; drawRows(sales); } }, tr("Alle {n} anzeigen", { n: sales.length }))));
  }
  drawProfile();

  const hero = h("div", { class: "card-hero" },
    h("div", { class: "card-art" }, imgOr(img, () => placeholder(card), { alt: cardName(card), width: 600, height: 825, loading: "eager" }),
      card.image == null && card.imageEn ? h("small", { class: "muted" }, tr("Englischer Scan – kein deutscher Scan verfügbar")) : null),
    h("div", { class: "card-prices" },
      chips, kpis, compsStrip,
      primaryDe ? h("div", { class: "price-ref" },
        h("span", { class: "eyebrow" }, tr("Marktpreis Deutsch (Referenz)"), ` · ${label.variant(primaryDe.variant)}`),
        h("div", { class: "price-row" }, h("b", null, fmt.eur(primaryDe.value)), trendPill(primaryDe.trend30, " / 30 T."), confidenceBadge(primaryDe.confidence),
          primaryEn && primaryEn.value != null && primaryDe.value != null && primaryEn.value !== primaryDe.value ? h("span", { class: "muted small" }, `${tr("Englisch")} ${fmt.eur(primaryEn.value)}`) : null),
        h("p", { class: "method muted" }, `Basis: ${label.method(primaryDe.method)} · `, h("a", { href: "/methodik" }, tr("Methodik")))) : null,
      h("div", { class: "actions-row" }, refreshButton(), h("button", { class: "btn ghost", onClick: () => reportSale(card, update) }, svg(icons.flag, 16), tr(" Verkauf melden")),
        h("a", { class: "btn ghost", href: `/verkaeufe?card=${encodeURIComponent(card.id)}` }, tr("Alle Verkäufe"), svg(icons.chevron, 14))),
    ),
  );

  // ---- investment (owner only) ----
  const qty = owned.reduce((s, i) => s + i.quantity, 0);
  const invested = owned.reduce((s, i) => s + (i.purchasePriceEur ?? 0) * i.quantity, 0);
  const valueNow = owned.reduce((s, i) => s + (i.currentValue ?? 0) * i.quantity, 0);
  const valued = owned.filter((i) => i.currentValue != null).reduce((s, i) => s + i.quantity, 0);
  const investment = owned.length ? section(tr("Investment"), h("div", { class: "invest-grid" },
    kpi(tr("Gesamtinvestition"), fmt.eur(invested), tr("{n} Exemplar(e) in deiner Sammlung", { n: qty })),
    kpi(tr("Aktueller Wert"), valued ? fmt.eur(valueNow) : "–", valued < qty ? tr("{n} ohne Comp", { n: qty - valued }) : owned.some((i) => i.valueBasis === "market") ? tr("Marktpreis-Basis") : tr("Comp-Basis")),
    kpi(tr("Potenzieller Gewinn"), valued ? h("span", { class: `trend ${valueNow - invested >= 0 ? "up" : "down"}` }, `${valueNow - invested >= 0 ? "+" : ""}${fmt.eur(valueNow - invested)}`) : "–", ""),
    kpi(tr("Potenzielle Rendite"), valued && invested ? h("span", { class: `trend ${valueNow >= invested ? "up" : "down"}` }, fmt.pct(valueNow / invested - 1)) : "–", ""),
  ), h("div", { class: "owned-list" }, ...owned.map((i) => h("div", { class: "owned-row" },
    h("span", null, i.gradingCompany ? h("span", { class: `chip grader-${i.gradingCompany.toLowerCase()}` }, `${i.gradingCompany} ${i.grade}`) : h("span", { class: "chip ghost" }, label.condition(i.condition)), ` ${label.language(i.language)} · ${label.variant(i.variant)}${i.quantity > 1 ? ` · ${i.quantity}×` : ""}`),
    h("span", { class: "muted" }, i.purchasePriceEur != null ? `${tr("gekauft")} ${fmt.eur(i.purchasePriceEur)}${i.purchasedAt ? ` · ${fmt.date(i.purchasedAt)}` : ""}` : tr("kein Kaufpreis")),
    h("b", null, i.currentValue != null ? fmt.eur(i.currentValue) : "–"),
    h("button", { class: "btn ghost small", onClick: () => addToCollection(card, i) }, tr("Bearbeiten")))))) : null;

  // ---- sales block ----
  const salesBlock = h("div", { class: "sales-block" }, panel, rowsHead, rowsBox);

  // ---- profile: facts + population ----
  const popBlock = populationBlock(card.populations, { onRequest: () => requestPopulation(card, update) });
  const profile = section(tr("Profil"), h("div", { class: "profile-grid" },
    h("dl", { class: "dl" },
      dd(tr("Set"), h("a", { href: `/sets/${encodeURIComponent(card.setId)}` }, card.setNameDe ?? card.setNameEn ?? card.setId)), dd(tr("Nummer"), card.localId), dd(tr("Seltenheit"), card.rarity ?? "–"),
      dd(tr("Kategorie"), card.category ?? "–"), card.hp ? dd("KP", String(card.hp)) : null, card.types.length ? dd(tr("Typ"), card.types.join(", ")) : null,
      dd(tr("Illustrator"), card.illustrator ?? "–"), dd(tr("Varianten"), Object.entries(card.variants).filter(([, v]) => v).map(([k]) => label.variant(k)).join(", ") || "–"),
      dd(tr("Cardmarket-Zuordnung"), card.cmProductId ? `${card.cmMatchMethod === "tcgdex" ? "exakt" : tr("per Name")} (#${card.cmProductId})` : "offen"),
      dd("TCGplayer", card.tcgpProductId ? h("a", { href: `https://www.tcgplayer.com/product/${card.tcgpProductId}`, target: "_blank", rel: "noopener" }, `#${card.tcgpProductId} `, svg(icons.external, 12)) : "–"), dd(tr("Katalog-ID"), card.id)),
    h("div", null, h("h3", { class: "sub" }, tr("Population")), popBlock)));

  const ladders = section(tr("Comps nach Zustand & Bewertung"), valueLadders(card));
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

  const market = section(tr("Marktreferenz"),
    card.guide ? h("div", { class: "guide" },
        h("div", { class: "guide-head" }, h("span", null, tr("Cardmarket-Preisguide")), h("small", { class: "muted" }, tr("alle Sprachen · {fmtdatecardg}", { fmtdatecardg: fmt.date(card.guide.date) }))),
        h("div", { class: "guide-grid" }, gv(tr("Trend"), card.guide.trend), gv(tr("Ø 1 Tag"), card.guide.avg1), gv(tr("Ø 7 Tage"), card.guide.avg7), gv(tr("Ø 30 Tage"), card.guide.avg30), gv(tr("Ab"), card.guide.low),
          card.guide.foilTrend != null ? gv(tr("Reverse Trend"), card.guide.foilTrend) : null, card.guide.foilAvg30 != null ? gv(tr("Reverse Ø 30"), card.guide.foilAvg30) : null),
        card.cmUrl ? h("a", { class: "link", href: card.cmUrl, target: "_blank", rel: "noopener" }, tr("Deutsche Angebote auf Cardmarket "), svg(icons.external, 14)) : null) : null,
    card.prices.length ? h("div", { class: "quotes" }, ...[...de, ...en, ...others].map(quoteRow)) : h("p", { class: "muted" }, tr("Noch keine Bewertungen.")),
    h("p", { class: "muted small" }, tr("Marktpreise sind Referenzwerte (Preisguide, Trend) – keine Verkäufe. Der Wert einer Karte richtet sich nach den echten Verkäufen oben.")));

  return [head, hero, ...(investment ? [investment] : []), salesBlock, profile, ladders, ...(graded ? [graded] : []), market];
}

function kpi(k: string, v: string | HTMLElement, sub: string, cls = "", tip?: string): HTMLElement {
  return h("div", { class: `kpi ${cls}` }, h("span", { class: "kpi-k" }, k, tip ? h("span", { class: "has-tip tip-below", tabindex: "0", "data-tip": tip }, svg(icons.info, 12)) : null), h("b", null, v), sub ? h("small", { class: "muted" }, sub) : null);
}

/** Ask for a PSA cert number of this card; one PSA call resolves cert → spec → population. */
function requestPopulation(card: CardDetail, update: (c: CardDetail) => void) {
  if (!requireLogin()) return;
  const cert = h("input", { inputmode: "numeric", placeholder: "z. B. 12345678", autocomplete: "off" }) as HTMLInputElement;
  const msg = h("p", { class: "muted small" }, tr("Die Zertifikatsnummer steht auf dem PSA-Label. Sie wird nicht gespeichert, nur die PSA-Spec der Karte."));
  const btn = h("button", { class: "btn primary", onClick: async () => {
    btn.setAttribute("disabled", "true");
    try { await api.requestPopulation(card.id, cert.value); toast(tr("Population-Report geladen.")); close(); invalidate("/api/cards/"); update(await api.card(card.id)); }
    catch (e) { toast((e as Error).message, "error"); btn.removeAttribute("disabled"); }
  } }, tr("Report laden"));
  const close = modal(tr("PSA-Population laden"), h("div", { class: "form" }, field(tr("PSA-Zertifikatsnummer dieser Karte"), cert), msg, h("div", { class: "actions-row" }, btn)));
  setTimeout(() => cert.focus(), 50);
}

function gv(lbl: string, v: number | null): HTMLElement | null { return v == null ? null : h("div", null, h("span", null, lbl), h("b", null, fmt.eur(v))); }
function dd(k: string, v: string | HTMLElement): HTMLElement { return h("div", null, h("dt", null, k), h("dd", null, v)); }
export function primaryVariant(card: CardDetail): string {
  if (card.variants.normal !== false && (card.variants.normal || !card.variants.holo)) return "normal";
  if (card.variants.holo) return "holo";
  return card.prices[0]?.variant ?? "normal";
}
export type { PricePoint };
export { empty };
