/**
 * "Interaktiv" – the hover market snapshot. With the toggle on, resting the pointer on any card tile opens a
 * floating card: 1-year sparkline, latest vs. previous price, 1Y range, 30-day / 1Y change, the last data points
 * with their source, and a link to the full history. Phones get the same card as a bottom sheet from the ⓘ chip.
 * Snapshots come from /api/cards/:id/snapshot (edge-cached, ≤ 60 points) and are memoised per session.
 */
import { h, svg, icons, fmt, cardName } from "../lib/dom.ts";
import { sparkline } from "../lib/chart.ts";
import { fine } from "../lib/fx.ts";
import { safeGet, safeSet } from "../lib/store.ts";
import { tr } from "../lib/i18n.ts";
import type { CardSummary } from "../../../shared/types.ts";

export interface Snapshot {
  cardId: string; source: "tcgplayer" | "cardmarket" | "sammlerwert"; label: string; currency: "EUR";
  value: number | null; prev: number | null; change: number | null; change30: number | null; change1y: number | null;
  low1y: number | null; high1y: number | null; n: number; first: string | null; last: string | null;
  spark: Array<[string, number]>; recent: Array<{ date: string; value: number; source: string }>;
}

let enabled = safeGet("sw-hover") !== "0";
const listeners = new Set<(on: boolean) => void>();
export const hoverEnabled = () => enabled;
export function setHover(on: boolean) { enabled = on; safeSet("sw-hover", on ? "1" : "0"); for (const l of listeners) l(on); if (!on) hide(); }

/** The on/off control for page heads. */
export function hoverToggle(): HTMLElement {
  const btn = h("button", { class: "toggle-btn", role: "switch", "aria-checked": String(enabled), title: tr("Beim Überfahren einer Karte Preis-Snapshot mit Verlauf einblenden") },
    h("span", { class: "toggle-track" }, h("i")), h("span", null, tr("Interaktiv")));
  const sync = (on: boolean) => { btn.setAttribute("aria-checked", String(on)); };
  listeners.add(sync);
  btn.addEventListener("click", () => setHover(!enabled));
  return btn;
}

const cache = new Map<string, Promise<Snapshot>>();
export function snapshot(cardId: string): Promise<Snapshot> {
  let p = cache.get(cardId);
  if (!p) { p = fetch(`/api/cards/${encodeURIComponent(cardId)}/snapshot`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<Snapshot>; }); cache.set(cardId, p); p.catch(() => cache.delete(cardId)); }
  return p;
}

let pop: HTMLElement | null = null, current: string | null = null, timer = 0;
function hide() { clearTimeout(timer); pop?.remove(); pop = null; current = null; }

function body(card: CardSummary, s: Snapshot): HTMLElement {
  const up = (n: number | null) => (n == null ? "" : n >= 0 ? "up" : "down");
  const src: Record<string, string> = { tcgplayer: "TCGplayer EN", cardmarket: "Cardmarket", sammlerwert: tr("Marktwert DE") };
  return h("div", { class: "snap" },
    h("div", { class: "snap-head" }, h("strong", null, cardName(card)), h("span", { class: "muted" }, `#${card.localId} · ${card.setNameDe ?? card.setNameEn ?? ""}`)),
    s.value == null ? h("p", { class: "muted" }, tr("Noch keine Preisdaten für diese Karte.")) : h("div", null,
      h("div", { class: "snap-main" },
        h("div", null, h("span", { class: "eyebrow" }, src[s.source] ?? s.source), h("b", { class: "snap-value" }, fmt.eur(s.value)),
          h("span", { class: `trend ${up(s.change)}` }, s.prev != null ? `${fmt.pct(s.change)} · ${tr("zuvor")} ${fmt.eur(s.prev)}` : "")),
        h("div", { class: "snap-spark" }, sparkline(s.spark.map(([date, value]) => ({ date, value })), s.change1y != null && s.change1y < 0 ? "var(--c-down)" : "var(--c-up)", 140, 44), h("small", { class: "muted" }, s.spark.length >= 2 ? tr("{n} Punkte · 1 Jahr", { n: s.spark.length }) : ""))),
      h("div", { class: "snap-grid" },
        cell(tr("30 Tage"), h("span", { class: `trend ${up(s.change30)}` }, fmt.pct(s.change30))), cell(tr("1 Jahr"), h("span", { class: `trend ${up(s.change1y)}` }, fmt.pct(s.change1y))),
        cell(tr("Tief 1J"), fmt.eur(s.low1y)), cell(tr("Hoch 1J"), fmt.eur(s.high1y))),
      s.recent.length ? h("div", { class: "snap-recent" }, h("span", { class: "eyebrow" }, tr("Letzte Datenpunkte")),
        ...s.recent.map((r) => h("div", { class: "snap-row" }, h("span", null, fmt.date(r.date)), h("b", null, fmt.eur(r.value)), h("small", { class: "muted" }, src[r.source] ?? r.source)))) : null,
      h("div", { class: "snap-foot muted" }, tr("Seit {fmtdatesfirst} · {sn} Tage · Karte öffnen für den vollen Verlauf", { fmtdatesfirst: fmt.date(s.first), sn: fmt.int(s.n) }))),
  );
}
const cell = (k: string, v: string | HTMLElement) => h("div", null, h("span", { class: "muted" }, k), h("b", null, v));

/** Attach to a tile: hover (desktop, when enabled) or the ⓘ chip (any device). */
export function attachSnapshot(tile: HTMLElement, card: CardSummary) {
  const chip = h("button", { class: "snap-chip", "aria-label": tr("Preis-Snapshot"), onClick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openSheet(card); } }, svg(icons.market, 14));
  tile.querySelector(".tile-img")?.appendChild(chip);
  if (!fine()) return;
  tile.addEventListener("pointerenter", () => {
    if (!enabled) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => show(tile, card), 220);
  });
  tile.addEventListener("pointerleave", (e) => {
    clearTimeout(timer);
    const to = (e as PointerEvent).relatedTarget as Node | null;
    if (pop && to && pop.contains(to)) return;
    hide();
  });
}

async function show(tile: HTMLElement, card: CardSummary) {
  if (current === card.id) return;
  hide(); current = card.id;
  const el = h("div", { class: "snap-pop", role: "dialog", "aria-label": tr("Preis-Snapshot") }, h("div", { class: "snap-loading" }, h("div", { class: "spinner" })));
  el.addEventListener("pointerleave", hide);
  document.body.appendChild(el); pop = el;
  place(el, tile);
  try {
    const s = await snapshot(card.id);
    if (pop !== el) return;
    el.replaceChildren(body(card, s), h("a", { class: "snap-link", href: `/karte/${encodeURIComponent(card.id)}` }, tr("Vollen Verlauf öffnen"), svg(icons.external, 12)));
    place(el, tile);
  } catch { if (pop === el) el.replaceChildren(h("p", { class: "muted" }, tr("Snapshot nicht verfügbar."))); }
}

function place(el: HTMLElement, tile: HTMLElement) {
  const r = tile.getBoundingClientRect(), w = 320, m = 12;
  const left = r.right + m + w <= window.innerWidth ? r.right + m : r.left - m - w >= 0 ? r.left - m - w : Math.max(m, window.innerWidth - w - m);
  const hgt = el.offsetHeight || 300;
  const top = Math.min(Math.max(m, r.top), window.innerHeight - hgt - m);
  el.style.left = `${left + window.scrollX}px`; el.style.top = `${top + window.scrollY}px`;
}

function openSheet(card: CardSummary) {
  const root = h("div", { class: "modal-root in" });
  const close = () => root.remove();
  const sheet = h("div", { class: "modal snap-sheet" }, h("div", { class: "snap-loading" }, h("div", { class: "spinner" })));
  root.append(h("div", { class: "modal-backdrop", onClick: close }), sheet);
  document.body.appendChild(root);
  snapshot(card.id).then((s) => sheet.replaceChildren(h("header", { class: "modal-head" }, h("h2", null, tr("Preis-Snapshot")), h("button", { class: "icon-btn", "aria-label": tr("Schließen"), onClick: close }, svg(icons.close))),
    h("div", { class: "modal-body" }, body(card, s), h("a", { class: "btn primary full", href: `/karte/${encodeURIComponent(card.id)}`, onClick: close }, tr("Vollen Verlauf öffnen")))))
    .catch(() => sheet.replaceChildren(h("div", { class: "modal-body" }, h("p", { class: "muted" }, tr("Snapshot nicht verfügbar.")))));
}
