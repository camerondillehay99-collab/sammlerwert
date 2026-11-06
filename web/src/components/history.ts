/**
 * Price-history panel for the card page – the comparison tool collectors come for.
 *   · ranges 1M / 3M / 6M / 1J / MAX     · series toggles (Marktwert DE, Cardmarket, TCGplayer EN per variant)
 *   · condition / grade selector that scales the curves (estimate until real sales exist)
 *   · real sales plotted as dots      · range stats: change, low / high, data points
 */
import type { CardDetail, PriceSeries } from "../../../shared/types.ts";
import { h, fmt, label } from "../lib/dom.ts";
import { lineChart, type Series } from "../lib/chart.ts";
import { safeGet, safeSet } from "../lib/store.ts";
import { tr } from "../lib/i18n.ts";

export const RANGES: Array<[key: string, days: number | null, label: string]> = [["1m", 30, "1M"], ["3m", 91, "3M"], ["6m", 182, "6M"], ["1y", 365, "1J"], ["max", null, "MAX"]];
const COLORS: Record<string, string> = { sammlerwert: "var(--c-brand)", cardmarket: "var(--c-blue)", tcgplayer: "var(--c-violet)" };

/** Which real sales to plot as dots: all, one raw condition rung, or one grade. */
type SalesFilter = { kind: "all"; label: string } | { kind: "raw"; code: string; cardmarket: string[]; label: string } | { kind: "graded"; company: string; grade: number; label: string };

export function historyPanel(card: CardDetail): HTMLElement {
  const root = h("section", { class: "panel history" });
  const series = card.series ?? [];
  const hasData = series.some((s) => s.points.length >= 2) || card.sales.length > 0;
  let range = safeGet("sw-range") ?? "1y";
  // Auto-widen the initial range to the narrowest one that actually holds ≥2 points (a card whose history is still
  // importing would otherwise open on an empty chart); an explicit click afterwards is always respected.
  const pointsSince = (days: number | null) => { const min = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : ""; return new Set(series.flatMap((s) => s.points.map(([d]) => d)).filter((d) => d >= min)).size; };
  if (pointsSince(RANGES.find((r) => r[0] === range)?.[1] ?? null) < 2) {
    const from = Math.max(0, RANGES.findIndex((r) => r[0] === range));
    range = RANGES.slice(from).find(([, days]) => pointsSince(days) >= 2)?.[0] ?? "max";
  }
  const hidden = new Set<string>((safeGet("sw-series-off") ?? "").split("|").filter(Boolean));
  // Default view: the primary Sammlerwert curve plus TCGplayer for the card's main variant; other variants off until toggled.
  const primaryTcg = series.filter((s) => s.source === "tcgplayer").sort((a, b) => b.points.length - a.points.length)[0];
  for (const s of series) if (s.source === "tcgplayer" && s !== primaryTcg && !safeGet("sw-series-off")) hidden.add(s.key);
  let filter: SalesFilter = { kind: "all", label: tr("Alle Verkäufe") };

  // Sales filter: the rungs/grades that actually have sales for this card.
  const filterOptions: SalesFilter[] = [
    { kind: "all", label: tr("Alle Verkäufe") },
    ...card.conditions.filter((c) => c.n > 0 || c.value != null).map((c) => ({ kind: "raw" as const, code: c.code, cardmarket: c.cardmarket as string[], label: `${c.label} (${c.code})` })),
    ...card.graded.map((g) => ({ kind: "graded" as const, company: g.company, grade: g.grade, label: `${g.company} ${g.grade}` })),
  ];
  const scaleSel = h("select", { class: "sel-sm", "aria-label": tr("Verkäufe filtern") },
    ...filterOptions.map((o) => h("option", { value: filterKey(o) }, o.label))) as HTMLSelectElement;
  scaleSel.addEventListener("change", () => { filter = filterOptions.find((o) => filterKey(o) === scaleSel.value) ?? filter; draw(); });
  if (filterOptions.length <= 1) scaleSel.hidden = true;

  const rangeBar = h("div", { class: "seg ranges", role: "tablist" });
  const toggles = h("div", { class: "chips series-toggles" });
  const stats = h("div", { class: "history-stats" });
  const chartBox = h("div", { class: "chart-box" });
  const note = h("p", { class: "muted small history-note" });

  function minDate(): string | undefined {
    const days = RANGES.find((r) => r[0] === range)?.[1];
    return days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : undefined;
  }
  function draw() {
    rangeBar.replaceChildren(...RANGES.map(([k, , l]) => h("button", { class: k === range ? "active" : "", role: "tab", "aria-selected": String(k === range), onClick: () => { range = k; safeSet("sw-range", k); draw(); } }, l)));
    const visible: Series[] = series.filter((s) => !hidden.has(s.key)).map((s) => ({ name: seriesLabel(s), color: COLORS[s.source] ?? "var(--c-muted)", dashed: s.source === "cardmarket", points: s.points.map(([date, v]) => ({ date, value: v })) }));
    const f = filter;
    const sales = card.sales.filter((s) => f.kind === "all" ? true : f.kind === "graded" ? s.gradingCompany === f.company && s.grade === f.grade : !s.gradingCompany && !!s.condition && f.cardmarket.includes(s.condition))
      .map((s) => ({ date: s.soldAt.slice(0, 10), value: s.priceEur, source: `${label.listingType(s.listingType)} · ${label.marketplace(s.source)}` }));
    if (sales.length && !hidden.has("sales")) visible.push({ name: tr("Verkäufe"), color: "var(--c-amber)", dots: true, points: sales });
    chartBox.replaceChildren(lineChart(visible, { height: 260, formatY: (n) => fmt.eurCompact(n), minDate: minDate(), emptyText: hasData ? tr("Keine Datenpunkte in diesem Zeitraum.") : tr("Die Historie füllt sich: TCGplayer-Preise seit Februar 2024 werden gerade importiert, Cardmarket wächst täglich.") }));
    toggles.replaceChildren(
      ...series.map((s) => h("button", { class: `chip toggle ${hidden.has(s.key) ? "off" : ""}`, style: { "--chip": COLORS[s.source] ?? "var(--c-muted)" }, "aria-pressed": String(!hidden.has(s.key)), onClick: () => { hidden.has(s.key) ? hidden.delete(s.key) : hidden.add(s.key); safeSet("sw-series-off", [...hidden].join("|")); draw(); } }, h("i"), seriesLabel(s), h("small", null, ` ${s.points.length}`))),
      ...(card.sales.length ? [h("button", { class: `chip toggle ${hidden.has("sales") ? "off" : ""}`, style: { "--chip": "var(--c-amber)" }, onClick: () => { hidden.has("sales") ? hidden.delete("sales") : hidden.add("sales"); draw(); } }, h("i"), tr("Verkäufe"), h("small", null, ` ${card.sales.length}`))] : []),
    );
    // Range stats from the first visible line series.
    const lead = visible.find((v) => !v.dots && v.points.length);
    stats.replaceChildren();
    if (lead) {
      const md = minDate();
      const pts = lead.points.filter((p) => !md || p.date >= md);
      if (pts.length >= 2) {
        const first = pts[0]!, last = pts[pts.length - 1]!;
        const vals = pts.map((p) => p.value), lo = Math.min(...vals), hi = Math.max(...vals), ch = first.value ? last.value / first.value - 1 : null;
        stats.append(
          stat(tr("Veränderung"), h("span", { class: `trend ${ch == null ? "" : ch >= 0 ? "up" : "down"}` }, fmt.pct(ch)), `${fmt.eur(first.value)} → ${fmt.eur(last.value)}`),
          stat(tr("Tief"), fmt.eur(lo), pts.find((p) => p.value === lo)!.date), stat(tr("Hoch"), fmt.eur(hi), pts.find((p) => p.value === hi)!.date),
          stat(tr("Datenpunkte"), fmt.int(pts.length), tr("seit {fmtdatefirst}", { fmtdatefirst: fmt.date(first.date) })),
        );
      }
    }
    note.textContent = tr("Punkte = echte Verkäufe (Auktion / Sofortkauf). Linien = Marktpreise als Referenz: TCGplayer = englischer Markt (USD, tageweise in EUR umgerechnet); Cardmarket = Preisguide aller Sprachen; Marktpreis Deutsch = Cardmarket × gelernter Sprachfaktor.");
  }
  draw();
  root.append(
    h("div", { class: "history-head" }, h("h2", { class: "panel-title" }, tr("Preisverlauf")), h("div", { class: "history-controls" }, scaleSel, rangeBar)),
    stats, chartBox, toggles, note,
  );
  return root;
}

const filterKey = (o: SalesFilter) => (o.kind === "all" ? "all" : o.kind === "raw" ? `raw:${o.code}` : `g:${o.company}:${o.grade}`);
function stat(k: string, v: string | HTMLElement, sub: string): HTMLElement { return h("div", { class: "hstat" }, h("span", null, k), h("b", null, v), h("small", { class: "muted" }, sub)); }
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
