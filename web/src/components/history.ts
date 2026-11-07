/**
 * Sales panel for the card page – Card-Ladder-style: the sales of the selected profile (all / one raw condition / one
 * grade) drawn as a line with a marker per sale, the viewer's own purchases as squares, market prices (TCGplayer,
 * Cardmarket, Marktwert DE) as optional reference lines, ranges 1M / 3M / 6M / 1J / MAX, linear or log scale, and the
 * range stats (growth, change, start / current, count, average, low, high) computed from real sales only.
 */
import type { CardDetail, PriceSeries, SaleRecord } from "../../../shared/types.ts";
import { h, fmt, label } from "../lib/dom.ts";
import { lineChart, type Series } from "../lib/chart.ts";
import { safeGet, safeSet } from "../lib/store.ts";
import { tr } from "../lib/i18n.ts";
import { salesStats, salesStatsGrid } from "./sales.ts";

export const RANGES: Array<[key: string, days: number | null, label: string]> = [["1m", 30, "1M"], ["3m", 91, "3M"], ["6m", 182, "6M"], ["1y", 365, "1J"], ["max", null, "MAX"]];
const COLORS: Record<string, string> = { sammlerwert: "var(--c-brand)", cardmarket: "var(--c-blue)", tcgplayer: "var(--c-violet)" };

/** Which sales make up the profile: all, one raw condition rung, or one grade. */
export type SalesFilter = { kind: "all"; label: string } | { kind: "raw"; code: string; cardmarket: string[]; label: string } | { kind: "graded"; company: string; grade: number; label: string };
export const filterKey = (o: SalesFilter) => (o.kind === "all" ? "all" : o.kind === "raw" ? `raw:${o.code}` : `g:${o.company}:${o.grade}`);
export function filterSales(sales: SaleRecord[], f: SalesFilter): SaleRecord[] {
  return sales.filter((s) => f.kind === "all" ? true : f.kind === "graded" ? s.gradingCompany === f.company && s.grade === f.grade : !s.gradingCompany && !!s.condition && f.cardmarket.includes(s.condition));
}
/** The profiles a card offers: every rung / grade that has at least one sale. */
export function filterOptions(card: CardDetail): SalesFilter[] {
  return [
    { kind: "all", label: tr("Alle Verkäufe") },
    ...card.conditions.filter((c) => c.n > 0 || c.value != null).map((c) => ({ kind: "raw" as const, code: c.code, cardmarket: c.cardmarket as string[], label: `${c.label} (${c.code})` })),
    ...card.graded.map((g) => ({ kind: "graded" as const, company: g.company, grade: g.grade, label: `${g.company} ${g.grade}` })),
  ];
}

export interface Purchase { date: string; value: number; label: string }

export function salesPanel(card: CardDetail, opts: { filter: () => SalesFilter; purchases?: Purchase[] }): HTMLElement & { redraw: () => void } {
  const root = h("section", { class: "panel sales-panel" }) as HTMLElement & { redraw: () => void };
  const series = card.series ?? [];
  let range = safeGet("sw-range") ?? "3m";
  let scale: "linear" | "log" = (safeGet("sw-scale") as "linear" | "log") || "linear";
  const salesDates = (days: number | null) => { const min = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : ""; return card.sales.filter((s) => s.soldAt.slice(0, 10) >= min).length; };
  const pointsSince = (days: number | null) => { const min = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : ""; return new Set(series.flatMap((s) => s.points.map(([d]) => d)).filter((d) => d >= min)).size; };
  // Open on the narrowest range that shows something real: ≥2 sales, else ≥2 reference points.
  const enough = (days: number | null) => salesDates(days) >= 2 || (card.sales.length === 0 && pointsSince(days) >= 2);
  if (!enough(RANGES.find((r) => r[0] === range)?.[1] ?? null)) range = RANGES.slice(Math.max(0, RANGES.findIndex((r) => r[0] === range))).find(([, d]) => enough(d))?.[0] ?? "max";
  // Reference lines are off while real sales exist (they would dwarf a sparse sales line); on when nothing else is there.
  const hidden = new Set<string>((safeGet("sw-series-off") ?? "").split("|").filter(Boolean));
  if (!safeGet("sw-series-off")) { const primaryTcg = series.filter((s) => s.source === "tcgplayer").sort((a, b) => b.points.length - a.points.length)[0]; for (const s of series) if (card.sales.length || (s.source === "tcgplayer" && s !== primaryTcg)) hidden.add(s.key); }

  const rangeBar = h("div", { class: "seg ranges", role: "tablist" });
  const scaleSel = h("select", { class: "sel-sm", "aria-label": tr("Skala") }, h("option", { value: "linear" }, tr("Linear")), h("option", { value: "log" }, tr("Logarithmisch"))) as HTMLSelectElement;
  scaleSel.value = scale; scaleSel.addEventListener("change", () => { scale = scaleSel.value as typeof scale; safeSet("sw-scale", scale); draw(); });
  const toggles = h("div", { class: "chips series-toggles" });
  const stats = h("div", { class: "sales-stats-box" });
  const chartBox = h("div", { class: "chart-box" });
  const note = h("p", { class: "muted small history-note" });
  const minDate = () => { const days = RANGES.find((r) => r[0] === range)?.[1]; return days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : undefined; };

  function draw() {
    rangeBar.replaceChildren(...RANGES.map(([k, , l]) => h("button", { class: k === range ? "active" : "", role: "tab", "aria-selected": String(k === range), onClick: () => { range = k; safeSet("sw-range", k); draw(); } }, l)));
    const f = opts.filter();
    const sales = filterSales(card.sales, f);
    const visible: Series[] = [];
    if (sales.length && !hidden.has("sales")) visible.push({ name: f.kind === "all" ? tr("Verkäufe") : f.label, color: "var(--c-up)", markers: true, bridge: true, points: [...sales].sort((a, b) => a.soldAt.localeCompare(b.soldAt)).map((s) => ({ date: s.soldAt.slice(0, 10), value: s.priceEur, source: `${label.listingType(s.listingType)} · ${label.marketplace(s.source)}${s.gradingCompany ? ` · ${s.gradingCompany} ${s.grade}` : s.condition ? ` · ${s.condition}` : ""}` })) });
    for (const s of series) if (!hidden.has(s.key)) visible.push({ name: seriesLabel(s), color: COLORS[s.source] ?? "var(--c-muted)", dashed: true, noArea: true, points: s.points.map(([date, v]) => ({ date, value: v })) });
    if (opts.purchases?.length) visible.push({ name: tr("Mein Kauf"), color: "var(--c-amber)", dots: true, shape: "square", points: opts.purchases.map((p) => ({ date: p.date, value: p.value, source: p.label })) });
    const md = minDate();
    chartBox.replaceChildren(lineChart(visible, { height: 280, formatY: (n) => (n >= 100 ? fmt.eur(n, 0) : fmt.eur(n)), minDate: md, scale, emptyText: card.sales.length ? tr("Keine Verkäufe in diesem Zeitraum.") : tr("Noch kein Verkauf erfasst – sobald echte Verkäufe vorliegen, erscheint hier ihre Kurve. Referenzlinien (TCGplayer, Cardmarket) lassen sich unten einblenden.") }));
    toggles.replaceChildren(
      ...(sales.length ? [h("button", { class: `chip toggle ${hidden.has("sales") ? "off" : ""}`, style: { "--chip": "var(--c-up)" }, onClick: () => { hidden.has("sales") ? hidden.delete("sales") : hidden.add("sales"); draw(); } }, h("i"), tr("Verkäufe"), h("small", null, ` ${sales.length}`))] : []),
      ...series.map((s) => h("button", { class: `chip toggle ${hidden.has(s.key) ? "off" : ""}`, style: { "--chip": COLORS[s.source] ?? "var(--c-muted)" }, "aria-pressed": String(!hidden.has(s.key)), onClick: () => { hidden.has(s.key) ? hidden.delete(s.key) : hidden.add(s.key); safeSet("sw-series-off", [...hidden].join("|")); draw(); } }, h("i"), seriesLabel(s), h("small", null, ` ${s.points.length}`))),
    );
    stats.replaceChildren(salesStatsGrid(salesStats(sales, md)));
    note.textContent = tr("Grüne Linie und Punkte = echte Verkäufe des gewählten Profils (Auktion, Sofortkauf, Preisvorschlag). Gestrichelt = Marktpreise als Referenz: TCGplayer = englischer Markt (USD, tageweise in EUR), Cardmarket = Preisguide aller Sprachen, Marktwert Deutsch = Cardmarket × gelernter Sprachfaktor. Quadrate = deine Käufe.");
  }
  root.redraw = draw;
  draw();
  root.append(
    h("div", { class: "history-head" }, h("h2", { class: "panel-title" }, tr("Verkäufe")), h("div", { class: "history-controls" }, rangeBar, scaleSel)),
    h("div", { class: "sales-layout" }, stats, chartBox),
    toggles, note,
  );
  return root;
}

export function seriesLabel(s: PriceSeries): string {
  if (s.source === "sammlerwert") return tr("Marktwert Deutsch");
  if (s.source === "cardmarket") return `Cardmarket · ${label.variant(s.variant)}`;
  return `TCGplayer EN · ${label.variant(s.variant)}`;
}

/** Comps by condition and by grade: the last real sale in every bucket collectors trade in – empty when none exists. */
export function valueLadders(card: CardDetail): HTMLElement {
  const compMeta = (date: string | null, type: string | null, source: string | null, n: number) =>
    h("small", { class: "muted" }, date ? `${label.listingType(type)} · ${label.marketplace(source)} · ${fmt.date(date)}${n > 1 ? ` · ${tr("{n} Verkäufe", { n })}` : ""}` : tr("kein Verkauf erfasst"));
  const conds = h("div", { class: "ladder" }, ...card.conditions.map((c) => h("div", { class: `rung ${c.method}` },
    h("span", { class: "rung-code" }, c.code), h("span", { class: "rung-label" }, c.label, h("small", { class: "muted" }, ` · ${c.cardmarket.join("/")}`)),
    h("b", null, c.value != null ? fmt.eur(c.value) : "–"), compMeta(c.lastSoldAt, c.lastListingType, c.lastSource, c.n))));
  const byCompany = new Map<string, typeof card.graded>();
  for (const g of card.graded) (byCompany.get(g.company) ?? byCompany.set(g.company, []).get(g.company)!).push(g);
  const graded = h("div", { class: "graded-grid" }, ...[...byCompany].map(([company, list]) => h("div", { class: "grader" },
    h("div", { class: "grader-head" }, h("span", { class: `chip grader-${company.toLowerCase()}` }, company)),
    ...list.map((g) => h("div", { class: "grade sales" }, h("span", null, g.grade), h("b", null, fmt.eur(g.value)), h("small", { class: "muted" }, `${label.listingType(g.lastListingType)} · ${g.lastSoldAt ? fmt.date(g.lastSoldAt) : ""}`))))));
  return h("div", { class: "ladders" },
    h("div", null, h("h3", { class: "sub" }, tr("Nach Zustand")), conds),
    h("div", null, h("h3", { class: "sub" }, tr("Bewertet (PSA · BGS · CGC · TAG)")), card.graded.length ? graded : h("p", { class: "muted" }, tr("Noch kein Verkauf einer bewerteten Karte erfasst."))),
    h("p", { class: "muted small" }, tr("Nur echte Verkäufe – keine Schätzungen. Jede Zeile zeigt den letzten Verkauf in diesem Zustand bzw. dieser Note mit Verkaufsart und Marktplatz; die Historie oben zeigt alle Verkäufe als Punkte.")),
  );
}
