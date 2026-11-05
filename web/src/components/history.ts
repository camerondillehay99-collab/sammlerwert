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

type Scale = { kind: "raw"; code: string; mult: number; label: string } | { kind: "graded"; company: string; grade: number; mult: number; label: string };

export function historyPanel(card: CardDetail): HTMLElement {
  const root = h("section", { class: "panel history" });
  const series = card.series ?? [];
  const hasData = series.some((s) => s.points.length >= 2) || card.sales.length > 0;
  let range = safeGet("sw-range") ?? "1y";
  const hidden = new Set<string>((safeGet("sw-series-off") ?? "").split("|").filter(Boolean));
  // Default view: the primary Sammlerwert curve plus TCGplayer for the card's main variant; other variants off until toggled.
  const primaryTcg = series.filter((s) => s.source === "tcgplayer").sort((a, b) => b.points.length - a.points.length)[0];
  for (const s of series) if (s.source === "tcgplayer" && s !== primaryTcg && !safeGet("sw-series-off")) hidden.add(s.key);
  let scale: Scale = { kind: "raw", code: "NM", mult: 1, label: "Near Mint" };

  const nm = card.conditions.find((c) => c.code === "NM")?.value ?? null;
  const scaleOptions: Scale[] = [
    ...card.conditions.map((c) => ({ kind: "raw" as const, code: c.code, mult: c.multiplier, label: `${c.label} (${c.code})` })),
    ...card.graded.filter((g) => nm).map((g) => ({ kind: "graded" as const, company: g.company, grade: g.grade, mult: nm ? g.value / nm : 1, label: `${g.company} ${g.grade}` })),
  ];
  const scaleSel = h("select", { class: "sel-sm", "aria-label": tr("Zustand oder Bewertung") },
    h("optgroup", { label: tr("Zustand (roh)") }, ...scaleOptions.filter((o) => o.kind === "raw").map((o) => h("option", { value: scaleKey(o) }, o.label))),
    scaleOptions.some((o) => o.kind === "graded") ? h("optgroup", { label: tr("Bewertet") }, ...scaleOptions.filter((o) => o.kind === "graded").map((o) => h("option", { value: scaleKey(o) }, o.label))) : null) as HTMLSelectElement;
  scaleSel.addEventListener("change", () => { scale = scaleOptions.find((o) => scaleKey(o) === scaleSel.value) ?? scale; draw(); });

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
    const mult = scale.mult;
    const visible: Series[] = series.filter((s) => !hidden.has(s.key)).map((s) => ({ name: seriesLabel(s), color: COLORS[s.source] ?? "var(--c-muted)", dashed: s.source === "cardmarket", points: s.points.map(([date, v]) => ({ date, value: Math.round(v * mult * 100) / 100 })) }));
    const sales = card.sales.filter((s) => scale.kind === "graded" ? s.gradingCompany === scale.company && s.grade === scale.grade : !s.gradingCompany).map((s) => ({ date: s.soldAt.slice(0, 10), value: s.priceEur }));
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
    note.textContent = scale.kind === "raw" && scale.code === "NM" ? tr("Kurven in Near Mint. TCGplayer = englischer Markt (USD, tageweise in EUR umgerechnet); Cardmarket = alle Sprachen; Marktwert Deutsch = Cardmarket × gelernter Sprachfaktor.")
      : scale.kind === "raw" ? tr("{scalelabel}: Kurven aus dem NM-Verlauf × {mult} geschätzt, bis genug Verkäufe in diesem Zustand vorliegen.", { scalelabel: scale.label, mult: `${Math.round(scale.mult * 100)} %` })
      : tr("{scalelabel}: Kurven × {mult} des Rohwerts – Schätzung aus dem Aufschlag dieser Bewertung; echte Verkäufe als Punkte.", { scalelabel: scale.label, mult: `${Math.round(scale.mult * 100)} %` });
  }
  draw();
  root.append(
    h("div", { class: "history-head" }, h("h2", { class: "panel-title" }, tr("Preisverlauf")), h("div", { class: "history-controls" }, scaleSel, rangeBar)),
    stats, chartBox, toggles, note,
  );
  return root;
}

const scaleKey = (o: Scale) => (o.kind === "raw" ? `raw:${o.code}` : `g:${o.company}:${o.grade}`);
function stat(k: string, v: string | HTMLElement, sub: string): HTMLElement { return h("div", { class: "hstat" }, h("span", null, k), h("b", null, v), h("small", { class: "muted" }, sub)); }
export function seriesLabel(s: PriceSeries): string {
  if (s.source === "sammlerwert") return tr("Marktwert Deutsch");
  if (s.source === "cardmarket") return `Cardmarket · ${label.variant(s.variant)}`;
  return `TCGplayer EN · ${label.variant(s.variant)}`;
}

/** Condition ladder + graded grid: what the card is worth in every state collectors trade in. */
export function valueLadders(card: CardDetail): HTMLElement {
  const conds = h("div", { class: "ladder" }, ...card.conditions.map((c) => h("div", { class: `rung ${c.method}` },
    h("span", { class: "rung-code" }, c.code), h("span", { class: "rung-label" }, c.label, h("small", { class: "muted" }, ` · ${c.cardmarket.join("/")}`)),
    h("b", null, fmt.eur(c.value)), h("small", { class: "muted" }, c.method === "sales" ? tr("{n} Verkäufe", { n: c.n }) : tr("geschätzt")))));
  const byCompany = new Map<string, typeof card.graded>();
  for (const g of card.graded) (byCompany.get(g.company) ?? byCompany.set(g.company, []).get(g.company)!).push(g);
  const graded = h("div", { class: "graded-grid" }, ...[...byCompany].map(([company, list]) => h("div", { class: "grader" },
    h("div", { class: "grader-head" }, h("span", { class: `chip grader-${company.toLowerCase()}` }, company)),
    ...list.map((g) => h("div", { class: `grade ${g.method}` }, h("span", null, g.grade), h("b", null, fmt.eur(g.value)), g.method === "sales" ? h("small", { class: "muted" }, tr("{gn} Verk.", { gn: g.n })) : h("small", { class: "muted" }, tr("Schätzung")))))));
  return h("div", { class: "ladders" },
    h("div", null, h("h3", { class: "sub" }, tr("Nach Zustand")), card.conditions.some((c) => c.value != null) ? conds : h("p", { class: "muted" }, tr("Noch kein Rohwert – die Leiter erscheint, sobald ein Preis vorliegt."))),
    h("div", null, h("h3", { class: "sub" }, tr("Bewertet (PSA · BGS · CGC · TAG)")), card.graded.length ? graded : h("p", { class: "muted" }, tr("Noch keine bewerteten Werte."))),
    h("p", { class: "muted small" }, tr("„geschätzt“ / „Schätzung“ = aus dem Near-Mint-Wert mit typischen Abschlägen bzw. Aufschlägen abgeleitet. Sobald echte Verkäufe (eBay, Community) in einem Zustand oder einer Note vorliegen, ersetzt deren zeitgewichteter Median die Schätzung.")),
  );
}
