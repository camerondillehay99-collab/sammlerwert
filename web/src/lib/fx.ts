/**
 * Desktop interaction layer – everything here is pointer:fine only and respects prefers-reduced-motion.
 *   tilt()        3D tilt + moving gloss on card tiles that follows the cursor
 *   countUp()     numbers roll from 0 to their value when a stat enters the viewport
 *   tip(el, text) rich hover tooltip (also keyboard-focusable)
 *   crosshair()   hover readout on SVG line charts
 *   reveal()      staggered fade-up for lists/grids as they scroll into view
 * Phones get none of this (no hover), which keeps the mobile bundle's work to zero.
 */
import { locale } from "./i18n.ts";

export const fine = () => matchMedia("(hover: hover) and (pointer: fine)").matches;
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const fxOn = () => fine() && !reduced();

/** Perspective tilt with a gloss highlight that tracks the pointer. Max 7° so it feels physical, not gimmicky. */
export function tilt(el: HTMLElement, max = 7) {
  if (!fxOn()) return;
  el.classList.add("tilt");
  let raf = 0;
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      el.style.setProperty("--rx", `${((0.5 - py) * max * 2).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${((px - 0.5) * max * 2).toFixed(2)}deg`);
      el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    });
  });
  el.addEventListener("pointerleave", () => { cancelAnimationFrame(raf); el.style.removeProperty("--rx"); el.style.removeProperty("--ry"); });
}

let io: IntersectionObserver | null = null;
const onVisible = new WeakMap<Element, () => void>();
function observe(el: Element, fn: () => void) {
  if (!("IntersectionObserver" in window)) { fn(); return; }
  io ??= new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { io!.unobserve(en.target); onVisible.get(en.target)?.(); onVisible.delete(en.target); } }, { threshold: 0, rootMargin: "0px 0px -8% 0px" });
  onVisible.set(el, fn); io.observe(el);
}

/** Roll a formatted number up from zero. `format` renders the final text (currency, percent, …). */
export function countUp(el: HTMLElement, value: number, format: (n: number) => string, ms = 700) {
  const final = format(value);
  if (!fxOn() || !Number.isFinite(value) || Math.abs(value) < 1e-9) { el.textContent = final; return; }
  el.textContent = format(0);
  observe(el, () => {
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      el.textContent = k < 1 ? format(value * e) : final;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Tooltip: shows on hover and keyboard focus, positioned above (flips below near the top edge). */
export function tip(el: HTMLElement, text: string): HTMLElement {
  el.dataset.tip = text;
  el.classList.add("has-tip");
  if (!el.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT)$/.test(el.tagName)) el.tabIndex = 0;
  el.addEventListener("pointerenter", () => { const r = el.getBoundingClientRect(); el.classList.toggle("tip-below", r.top < 70); });
  return el;
}

/** Staggered appear for the children of a grid/list as it scrolls into view. */
export function reveal(container: HTMLElement, selector = ":scope > *", stagger = 28) {
  if (!fxOn()) return;
  const kids = [...container.querySelectorAll<HTMLElement>(selector)].slice(0, 40);
  for (const k of kids) k.classList.add("pre-reveal");
  let done = false;
  const go = () => { if (done) return; done = true; kids.forEach((k, i) => { k.style.transitionDelay = `${i * stagger}ms`; k.classList.add("revealed"); setTimeout(() => { k.classList.remove("pre-reveal", "revealed"); k.style.transitionDelay = ""; }, 700 + i * stagger); }); };
  observe(container, go);
  setTimeout(go, 1200); // never leave content hidden (e.g. observer quirks, background tabs)
}

export interface ChartPoint { x: number; y: number; date: string; value: number; series: string; color: string }
/** Crosshair + readout for lineChart(): nearest point by x, all series at that date. */
export function crosshair(svg: SVGSVGElement, points: ChartPoint[], format: (n: number) => string, bounds: { padL: number; padR: number; padT: number; padB: number; W: number; H: number }) {
  if (!fine() || !points.length) return;
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g"); g.setAttribute("class", "chart-hover"); g.style.display = "none";
  const line = document.createElementNS(NS, "line"); line.setAttribute("class", "chart-cross"); line.setAttribute("y1", String(bounds.padT)); line.setAttribute("y2", String(bounds.H - bounds.padB));
  const dots = document.createElementNS(NS, "g");
  const box = document.createElementNS(NS, "foreignObject"); box.setAttribute("width", "170"); box.setAttribute("height", "90");
  const html = document.createElement("div"); html.className = "chart-tip"; box.appendChild(html);
  g.append(line, dots, box); svg.appendChild(g);
  const byX = new Map<number, ChartPoint[]>();
  for (const p of points) (byX.get(Math.round(p.x)) ?? byX.set(Math.round(p.x), []).get(Math.round(p.x))!).push(p);
  const xs = [...byX.keys()].sort((a, b) => a - b);
  const toSvgX = (clientX: number) => { const r = svg.getBoundingClientRect(); return ((clientX - r.left) / r.width) * bounds.W; };
  svg.addEventListener("pointermove", (e) => {
    const x = toSvgX(e.clientX);
    let best = xs[0]!, d = Infinity;
    for (const cx of xs) { const dd = Math.abs(cx - x); if (dd < d) { d = dd; best = cx; } }
    const pts = byX.get(best)!;
    g.style.display = "";
    line.setAttribute("x1", String(best)); line.setAttribute("x2", String(best));
    dots.replaceChildren(...pts.map((p) => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", String(p.x)); c.setAttribute("cy", String(p.y)); c.setAttribute("r", "4.5"); c.setAttribute("fill", p.color); c.setAttribute("class", "chart-dot"); return c; }));
    const date = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "short", year: "numeric" }).format(new Date(pts[0]!.date));
    html.replaceChildren(Object.assign(document.createElement("b"), { textContent: date }), ...pts.map((p) => { const row = document.createElement("span"); row.innerHTML = `<i style="background:${p.color}"></i>${p.series} <b>${format(p.value)}</b>`; return row; }));
    const bx = best + 12 + 170 > bounds.W ? best - 182 : best + 12;
    box.setAttribute("x", String(Math.max(0, bx))); box.setAttribute("y", String(bounds.padT));
  });
  svg.addEventListener("pointerleave", () => { g.style.display = "none"; });
}
