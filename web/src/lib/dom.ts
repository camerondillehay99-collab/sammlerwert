// Tiny DOM toolkit: hyperscript, formatters, helpers. No framework – the app stays < 60 KB.
import type { CardSummary, Language, Variant } from "../../../shared/types.ts";
import { CONDITION_LABELS, LANGUAGE_LABELS, VARIANT_LABELS } from "../../../shared/types.ts";

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement;
export function h(tag: string, props: Props = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = String(v);
      else if (k in el && k !== "list" && k !== "form") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function svg(path: string, size = 20, cls = ""): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("width", String(size)); el.setAttribute("height", String(size));
  el.setAttribute("fill", "none"); el.setAttribute("stroke", "currentColor"); el.setAttribute("stroke-width", "1.8");
  el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = path;
  return el;
}

export const icons = {
  home: `<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>`,
  cards: `<rect x="3" y="5" width="12" height="16" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v12"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  sets: `<path d="M4 7h16M4 12h16M4 17h10"/>`,
  market: `<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  up: `<path d="M7 17 17 7"/><path d="M8 7h9v9"/>`,
  down: `<path d="M7 7l10 10"/><path d="M17 8v9H8"/>`,
  star: `<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1 6.1L12 17.1 6.5 20l1-6.1L3 9.5l6.2-.9z"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  back: `<path d="m15 18-6-6 6-6"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>`,
  warn: `<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>`,
  check: `<path d="m5 12 5 5L20 7"/>`,
  external: `<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>`,
  eye: `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  trash: `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`,
  edit: `<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m13 7 4 4"/>`,
  moon: `<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>`,
  image: `<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-7 7"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  logout: `<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/>`,
  camera: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  shield: `<path d="M12 3 5 6v5c0 4.5 3 8.6 7 10 4-1.4 7-5.5 7-10V6z"/>`,
  spark: `<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>`,
  filter: `<path d="M3 5h18l-7 8v6l-4 2v-8z"/>`,
  download: `<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>`,
  flag: `<path d="M5 21V4h11l-1 4h5l-2 6H9"/>`,
};

export const fmt = {
  eur: (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? "–" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
  eurCompact: (n: number | null | undefined) => n == null ? "–" : n >= 10000 ? new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n) : fmt.eur(n),
  pct: (n: number | null | undefined, signed = true) => n == null || !Number.isFinite(n) ? "–" : `${signed && n > 0 ? "+" : ""}${(n * 100).toFixed(1).replace(".", ",")} %`,
  int: (n: number | null | undefined) => n == null ? "–" : new Intl.NumberFormat("de-DE").format(n),
  date: (iso: string | null | undefined) => iso ? new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(parseDate(iso)) : "–",
  dateShort: (iso: string) => new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short" }).format(parseDate(iso)),
  rel: (iso: string | null | undefined) => {
    if (!iso) return "–";
    const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    if (d < 1) return "heute"; if (d < 2) return "gestern"; if (d < 30) return `vor ${Math.floor(d)} Tagen`; if (d < 365) return `vor ${Math.floor(d / 30)} Monaten`;
    return `vor ${Math.floor(d / 365)} Jahren`;
  },
};

/** Date-only strings are calendar dates, not UTC instants – keep them on the right day in every timezone. */
export function parseDate(s: string): Date { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s); }

export const label = {
  language: (l: string) => LANGUAGE_LABELS[l as Language] ?? l,
  variant: (v: string) => VARIANT_LABELS[v as Variant] ?? v,
  condition: (c: string) => CONDITION_LABELS[c as keyof typeof CONDITION_LABELS] ?? c,
  confidence: (c: number | null | undefined) => c == null ? "keine Daten" : c >= 0.75 ? "hoch" : c >= 0.45 ? "mittel" : "niedrig",
  method: (m: string) => ({
    "sales+guide": "Verkäufe + Cardmarket-Preisguide", sales_only: "Nur Verkäufe", "guide×language_factor": "Cardmarket-Preisguide, sprachbereinigt",
    guide_only: "Cardmarket-Preisguide (alle Sprachen)", listings_only: "Nur aktive Angebote", none: "Keine Daten",
  } as Record<string, string>)[m.replace("+listings", "")] ?? m,
};

export function cardImage(card: Pick<CardSummary, "image" | "imageEn">, quality: "low" | "high" = "low"): string | null {
  const base = card.image ?? card.imageEn;
  return base ? `${base}/${quality}.webp` : null;
}

/** <img> that swaps itself for a placeholder when the scan is missing or offline. */
export function imgOr(src: string | null, fallback: () => HTMLElement, attrs: Record<string, unknown> = {}): HTMLElement {
  if (!src) return fallback();
  const img = h("img", { src, alt: "", loading: "lazy", decoding: "async", ...attrs });
  // CDN hiccups and blockers are the usual cause of a failed scan: retry once after a pause, then try the PNG
  // rendition, and only then show the placeholder.
  let attempt = 0;
  img.addEventListener("error", () => {
    attempt++;
    if (attempt === 1) setTimeout(() => { img.src = `${src}?r=1`; }, 1500);
    else if (attempt === 2 && src.endsWith(".webp")) img.src = src.replace(/\.webp$/, ".png");
    else img.replaceWith(fallback());
  });
  return img;
}

export function cardName(card: Pick<CardSummary, "nameDe" | "nameEn">) { return card.nameDe ?? card.nameEn ?? "Unbenannt"; }

export function trendClass(n: number | null | undefined) { return n == null ? "" : n > 0.005 ? "up" : n < -0.005 ? "down" : "flat"; }

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>;
  return ((...a: never[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

export function clear(el: HTMLElement) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(message: string, kind: "ok" | "error" = "ok") {
  const el = document.getElementById("toast")!;
  el.textContent = message; el.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}
