/**
 * Sales building blocks shared by the Sales page and the card page – modelled on how the trade reads comps:
 *   · a sale row = listing title, where it sold, date sold, sale type, price
 *   · sales stats over a range = growth, real change, start / current, count, average, low, high
 *   · population report = total, gems, gem rate, per-grade breakdown
 */
import type { CardSummary, Population, SaleRecord } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, imgOr } from "../lib/dom.ts";
import { placeholder } from "./ui.ts";
import { tr } from "../lib/i18n.ts";

export type SaleLike = SaleRecord & { card?: CardSummary };

/** The listing title as it sold; community reports without a title get a descriptive one built from the card. */
export function saleTitle(s: SaleLike, card?: CardSummary | null): string {
  if (s.title) return s.title;
  const c = s.card ?? card;
  const grade = s.gradingCompany ? `${s.gradingCompany} ${s.grade ?? ""}`.trim() : s.condition ? label.condition(s.condition) : label.variant(s.variant);
  return c ? `${cardName(c)} #${c.localId} · ${c.setNameDe ?? c.setNameEn ?? ""} · ${label.language(s.language)} · ${grade}` : grade;
}

/** "EBAY.DE", "FANATICS COLLECT", "COMMUNITY" – the marketplace line above the title. */
export function saleSource(s: SaleLike): string {
  const m = label.marketplace(s.source).toUpperCase();
  return s.verified || s.source === "import" ? m : `${m} · ${tr("UNGEPRÜFT")}`;
}

/** Card-Ladder-style row: thumbnail · source + title · Date Sold · Type · Price. */
export function saleRow(s: SaleLike, opts: { card?: CardSummary | null; showCard?: boolean } = {}): HTMLElement {
  const card = s.card ?? opts.card ?? null;
  const href = card ? `/karte/${encodeURIComponent(card.id)}` : null;
  const grade = s.gradingCompany ? h("span", { class: `chip grader-${s.gradingCompany.toLowerCase()}` }, `${s.gradingCompany} ${s.grade ?? ""}`) : h("span", { class: "chip ghost" }, s.condition ? label.condition(s.condition) : tr("Roh"));
  const titleEl = h("strong", { class: "sale-title" }, saleTitle(s, card));
  const body = h("div", { class: "sale-body" },
    h("span", { class: "sale-src" }, saleSource(s)),
    s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", class: "sale-link" }, titleEl, " ", svg(icons.external, 12)) : titleEl,
    h("div", { class: "sale-meta" }, grade, opts.showCard !== false && card ? h("a", { class: "muted", href: href! }, `${cardName(card)} · ${card.setNameDe ?? card.setNameEn ?? ""} #${card.localId}`) : null, h("span", { class: "muted" }, label.language(s.language))));
  const img = card ? h("a", { class: "sale-img", href: href! }, imgOr(cardImage(card), () => placeholder(card), { alt: cardName(card), width: 56, height: 78, loading: "lazy" })) : h("div", { class: "sale-img" });
  return h("div", { class: "sale" }, img, body, h("div", { class: "sale-cols" },
    h("div", { class: "sale-col" }, h("span", { class: "sale-k" }, tr("Verkauft am")), h("b", null, fmt.date(s.soldAt))),
    h("div", { class: "sale-col" }, h("span", { class: "sale-k" }, tr("Verkaufsart")), h("b", { class: `sale-type sale-${s.listingType}` }, label.listingType(s.listingType))),
    h("div", { class: "sale-col price" }, h("span", { class: "sale-k" }, tr("Preis")), h("b", null, fmt.eur(s.priceEur)))));
}

export interface SalesStats { n: number; start: SaleRecord; current: SaleRecord; growth: number | null; change: number; avg: number; low: SaleRecord; high: SaleRecord }

/** Stats over the sales in a range (oldest → newest): what Card Ladder shows next to its sales chart. */
export function salesStats(sales: SaleRecord[], minDate?: string): SalesStats | null {
  const inRange = sales.filter((s) => !minDate || s.soldAt.slice(0, 10) >= minDate).sort((a, b) => a.soldAt.localeCompare(b.soldAt) || a.id - b.id);
  if (!inRange.length) return null;
  const start = inRange[0]!, current = inRange[inRange.length - 1]!;
  const prices = inRange.map((s) => s.priceEur);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const low = inRange.reduce((m, s) => (s.priceEur < m.priceEur ? s : m), start), high = inRange.reduce((m, s) => (s.priceEur > m.priceEur ? s : m), start);
  return { n: inRange.length, start, current, growth: start.priceEur ? current.priceEur / start.priceEur - 1 : null, change: current.priceEur - start.priceEur, avg, low, high };
}

export function salesStatsGrid(st: SalesStats | null): HTMLElement {
  const cell = (k: string, v: string | HTMLElement, sub?: string) => h("div", { class: "sstat" }, h("span", null, k), h("b", null, v), sub ? h("small", { class: "muted" }, sub) : null);
  if (!st) return h("div", { class: "sales-stats empty" }, cell(tr("Anzahl Verkäufe"), "0"), cell(tr("Durchschnitt"), "–"), cell(tr("Tief"), "–"), cell(tr("Hoch"), "–"));
  return h("div", { class: "sales-stats" },
    cell(tr("Wachstumsrate"), h("span", { class: `trend ${st.growth == null ? "" : st.growth >= 0 ? "up" : "down"}` }, fmt.pct(st.growth))),
    cell(tr("Veränderung"), h("span", { class: `trend ${st.change >= 0 ? "up" : "down"}` }, `${st.change >= 0 ? "+" : ""}${fmt.eur(st.change)}`)),
    cell(tr("Startpreis"), fmt.eur(st.start.priceEur), fmt.date(st.start.soldAt)),
    cell(tr("Aktueller Preis"), fmt.eur(st.current.priceEur), fmt.date(st.current.soldAt)),
    cell(tr("Anzahl Verkäufe"), fmt.int(st.n)),
    cell(tr("Durchschnitt"), fmt.eur(st.avg)),
    cell(tr("Tief"), fmt.eur(st.low.priceEur), fmt.date(st.low.soldAt)),
    cell(tr("Hoch"), fmt.eur(st.high.priceEur), fmt.date(st.high.soldAt)));
}

const COMPANIES: Array<Population["company"]> = ["PSA", "CGC", "BGS", "SGC", "TAG"];

/** Population report block: grader tabs, totals, gem rate and the per-grade bars; companies without data say so. */
export function populationBlock(pops: Population[], opts: { onRequest?: () => void } = {}): HTMLElement {
  const root = h("div", { class: "pop" });
  let active = pops[0]?.company ?? "PSA";
  const tabs = h("div", { class: "chips pop-tabs" });
  const body = h("div", { class: "pop-body" });
  const draw = () => {
    tabs.replaceChildren(...COMPANIES.map((c) => { const has = pops.some((p) => p.company === c); return h("button", { class: `chip ${c === active ? "" : "ghost"} grader-${c.toLowerCase()} ${has ? "" : "dim"}`, "aria-pressed": String(c === active), onClick: () => { active = c; draw(); } }, c); }));
    const p = pops.find((x) => x.company === active);
    if (!p) {
      body.replaceChildren(h("p", { class: "muted" }, active === "PSA"
        ? tr("Noch kein PSA-Population-Report für diese Karte. PSA liefert ihn, sobald eine PSA-Zertifikatsnummer dieser Karte bekannt ist – z. B. aus deiner Sammlung, einem PSA-Import oder einer Zertifikatsprüfung.")
        : tr("{company} veröffentlicht seine Population nur als Webseite ohne Schnittstelle – Daten erscheinen hier, sobald ein Import vorliegt.", { company: active })));
      if (active === "PSA" && opts.onRequest) body.appendChild(h("button", { class: "btn ghost", onClick: opts.onRequest }, tr("PSA-Zertifikat angeben")));
      return;
    }
    const max = Math.max(1, ...p.grades.map(([, n]) => n));
    body.replaceChildren(
      h("div", { class: "pop-kpis" },
        h("div", { class: "pop-kpi" }, h("span", null, tr("Gesamtpopulation")), h("b", null, fmt.int(p.total))),
        h("div", { class: "pop-kpi" }, h("span", null, tr("Gem Mint ({company} 10)", { company: p.company })), h("b", null, fmt.int(p.gems))),
        h("div", { class: "pop-kpi" }, h("span", null, tr("Gem-Rate")), h("b", null, fmt.pct(p.gemRate, false)))),
      h("div", { class: "pop-grades" }, ...p.grades.map(([g, n]) => h("div", { class: "pop-row" },
        h("span", { class: "pop-g" }, g === "auth" ? tr("Auth.") : g === "q" ? "Q" : g), h("i", { style: { width: `${Math.max(2, (n / max) * 100)}%` } }), h("b", null, fmt.int(n)), h("small", { class: "muted" }, p.total ? fmt.pct(n / p.total, false) : "")))),
      h("p", { class: "muted small" }, p.description ? `${p.description} · ` : "", tr("Stand {date}", { date: fmt.date(p.fetchedAt) }), p.specId ? ` · Spec ${p.specId}` : ""));
  };
  draw();
  root.append(tabs, body);
  return root;
}
