// Lightweight SVG charts: line chart with multiple series, sparkline, donut. Theme colours via CSS variables.
import type { PricePoint } from "../../../shared/types.ts";
import { crosshair, type ChartPoint } from "./fx.ts";
import { locale, tr } from "./i18n.ts";

const NS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export interface Series { name: string; points: PricePoint[]; color: string; dashed?: boolean; /** scatter instead of a line (e.g. single sales) */ dots?: boolean }

/** Longest hole (days) a line bridges before it is split into segments. */
const GAP_DAYS = 45;

export function lineChart(series: Series[], opts: { height?: number; formatY?: (n: number) => string; emptyText?: string; minDate?: string } = {}): SVGSVGElement {
  const W = 640, H = opts.height ?? 240, padL = 56, padR = 12, padT = 12, padB = 28;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  if (opts.minDate) series = series.map((s) => ({ ...s, points: s.points.filter((p) => p.date >= opts.minDate!) }));
  const all = series.flatMap((s) => s.points);
  if (all.length < 2 || new Set(all.map((p) => p.date)).size < 2) {
    const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-empty" });
    t.textContent = opts.emptyText ?? tr("Noch zu wenige Datenpunkte – die Historie wächst täglich.");
    svg.appendChild(t);
    return svg;
  }
  const xs = all.map((p) => new Date(p.date).getTime()), ys = all.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 *= 0.9; y1 *= 1.1; }
  const yPad = (y1 - y0) * 0.1; y0 = Math.max(0, y0 - yPad); y1 += yPad;
  const X = (t: number) => padL + ((t - x0) / Math.max(1, x1 - x0)) * (W - padL - padR);
  const Y = (v: number) => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB);
  const fy = opts.formatY ?? ((n: number) => n.toFixed(0));

  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4, y = Y(v);
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "chart-grid" }));
    const t = el("text", { x: padL - 8, y: y + 4, "text-anchor": "end", class: "chart-label" }); t.textContent = fy(v); svg.appendChild(t);
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const tms = x0 + ((x1 - x0) * i) / ticks;
    const t = el("text", { x: X(tms), y: H - 8, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle", class: "chart-label" });
    t.textContent = new Intl.DateTimeFormat(locale(), x1 - x0 > 300 * 86_400_000 ? { month: "short", year: "2-digit" } : { day: "2-digit", month: "short" }).format(new Date(tms)); svg.appendChild(t);
  }
  const hover: ChartPoint[] = [];
  let areaDone = false;
  series.forEach((s) => {
    const pts = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length < 1) return;
    for (const p of pts) hover.push({ x: X(new Date(p.date).getTime()), y: Y(p.value), date: p.date, value: p.value, series: s.name, color: s.color });
    if (s.dots) {
      for (const p of pts) svg.appendChild(el("circle", { cx: X(new Date(p.date).getTime()), cy: Y(p.value), r: 3.2, fill: s.color, opacity: 0.85, class: "chart-sale" }));
      return;
    }
    // Break the line where the data has a hole longer than GAP_DAYS (history still importing, delisted product) instead of
    // drawing a misleading straight bridge; the area fill follows the same segments.
    const d = pts.map((p, i) => `${i && new Date(p.date).getTime() - new Date(pts[i - 1]!.date).getTime() <= GAP_DAYS * 86_400_000 ? "L" : "M"}${X(new Date(p.date).getTime()).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
    if (!areaDone && pts.length > 1) {
      areaDone = true;
      const segs = d.split(" M").map((seg, i) => (i ? "M" : "") + seg).filter((seg) => seg.includes("L"));
      const area = el("path", { d: segs.map((seg) => { const m = seg.match(/^M([\d.]+),[\d.]+(?:.*L([\d.]+),[\d.]+)$/); return m ? `${seg} L${m[2]},${Y(y0)} L${m[1]},${Y(y0)} Z` : ""; }).join(" "), fill: s.color, opacity: 0.08 });
      svg.appendChild(area);
    }
    // Points without a neighbour inside GAP_DAYS would vanish from a split line – draw them as dots.
    const near = (a: PricePoint, b: PricePoint | undefined) => !!b && Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) <= GAP_DAYS * 86_400_000;
    pts.forEach((p, i) => { if (!near(p, pts[i - 1]) && !near(p, pts[i + 1])) svg.appendChild(el("circle", { cx: X(new Date(p.date).getTime()), cy: Y(p.value), r: 2.6, fill: s.color })); });
    svg.appendChild(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.2, "stroke-dasharray": s.dashed ? "5 5" : "", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const last = pts[pts.length - 1]!;
    svg.appendChild(el("circle", { cx: X(new Date(last.date).getTime()), cy: Y(last.value), r: 3.5, fill: s.color }));
    if (pts.length === 1) svg.appendChild(el("circle", { cx: X(new Date(last.date).getTime()), cy: Y(last.value), r: 6, fill: s.color, opacity: 0.25 }));
  });
  crosshair(svg, hover, fy, { padL, padR, padT, padB, W, H });
  return svg;
}

export function sparkline(points: PricePoint[], color = "currentColor", w = 96, hgt = 28): SVGSVGElement {
  const svg = el("svg", { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: "spark" });
  if (points.length < 2) return svg;
  const ys = points.map((p) => p.value), y0 = Math.min(...ys), y1 = Math.max(...ys) || 1;
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * (w - 2) + 1).toFixed(1)},${(hgt - 2 - ((p.value - y0) / Math.max(1e-9, y1 - y0)) * (hgt - 4)).toFixed(1)}`).join(" ");
  svg.appendChild(el("path", { d, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round" }));
  return svg;
}

export function donut(parts: Array<{ value: number; color: string; label: string }>, size = 120): SVGSVGElement {
  const svg = el("svg", { viewBox: "0 0 42 42", width: size, height: size, class: "donut" });
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let offset = 25;
  for (const p of parts) {
    const pct = (p.value / total) * 100;
    const c = el("circle", { cx: 21, cy: 21, r: 15.9, fill: "transparent", stroke: p.color, "stroke-width": 5, "stroke-dasharray": `${pct} ${100 - pct}`, "stroke-dashoffset": offset });
    const t = el("title"); t.textContent = `${p.label}: ${pct.toFixed(0)} %`; c.appendChild(t);
    svg.appendChild(c);
    offset -= pct;
  }
  return svg;
}

export const palette = ["var(--c-brand)", "var(--c-blue)", "var(--c-violet)", "var(--c-teal)", "var(--c-amber)", "var(--c-pink)", "var(--c-muted)"];
