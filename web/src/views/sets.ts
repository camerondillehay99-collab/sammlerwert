import type { SetSummary } from "../../../shared/types.ts";
import { h, fmt, cardName, imgOr } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { cardTile, empty, section } from "../components/ui.ts";
import { reveal } from "../lib/fx.ts";
import { tr } from "../lib/i18n.ts";

export async function sets(): Promise<HTMLElement> {
  const all = (await api.sets()).items.filter((s) => s.cardsLoaded > 0 || (s.cardCountOfficial ?? 0) > 0);
  const owned = state.user ? await ownedBySet() : new Map<string, Set<string>>();
  const groups = new Map<string, SetSummary[]>();
  for (const s of all) { const k = s.seriesName ?? tr("Weitere"); (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); }
  const root = h("div", { class: "page" }, h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Katalog")), h("h1", null, tr("Sets")))));
  for (const [name, list] of groups) {
    const grid = h("div", { class: "set-grid" }, ...list.map((s) => setCard(s, owned.get(s.id)?.size ?? 0)));
    root.append(section(name, grid)); reveal(grid, ".set-card", 18);
  }
  return root;
}

function setCard(s: SetSummary, ownedCount: number): HTMLElement {
  const total = s.cardCountOfficial ?? s.cardCountTotal ?? s.cardsLoaded;
  const pct = total ? Math.min(100, Math.round((ownedCount / total) * 100)) : 0;
  return h("a", { class: "set-card", href: `/sets/${encodeURIComponent(s.id)}` },
    imgOr(s.logo ? `${s.logo}.webp` : null, () => h("div", { class: "set-logo-ph" }, s.abbreviation ?? s.id.toUpperCase())),
    h("div", { class: "set-body" }, h("strong", null, s.nameDe ?? s.nameEn ?? s.id), h("span", { class: "muted small" }, `${s.releaseDate ? s.releaseDate.slice(0, 4) + " · " : ""}${total ?? "?"} Karten${s.abbreviation ? ` · ${s.abbreviation}` : ""}`),
      ownedCount ? h("div", { class: "progress", title: `${ownedCount} von ${total}` }, h("i", { style: { width: `${pct}%` } }), h("span", null, `${ownedCount}/${total} · ${pct} %`)) : null),
  );
}

export async function setView(params: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const sort = query.get("sort") ?? "number";
  const { set, cards } = await api.set(params.id!, sort);
  const owned = state.user ? (await ownedBySet()).get(set.id) ?? new Set<string>() : new Set<string>();
  const total = cards.reduce((s, c) => s + (c.valueDe ?? 0), 0);
  const sortSel = h("select", null, ...[["number", tr("Nummer")], ["value", tr("Wert ↓")], ["trend", tr("Trend ↓")], ["name", tr("Name")]].map(([v, t]) => h("option", { value: v, selected: v === sort }, t)));
  sortSel.addEventListener("change", () => { location.href = `/sets/${encodeURIComponent(set.id)}?sort=${sortSel.value}`; });
  const onlyMissing = h("label", { class: "check" }, h("input", { type: "checkbox" }), tr(" nur fehlende"));
  const grid = h("div", { class: "tiles" });
  const draw = () => {
    const miss = (onlyMissing.firstChild as HTMLInputElement).checked;
    grid.replaceChildren(...cards.filter((c) => !miss || !owned.has(c.id)).map((c) => { const t = cardTile(c); if (owned.has(c.id)) t.classList.add("owned"); return t; }));
    reveal(grid, ".tile");
    if (!grid.children.length) grid.appendChild(empty(tr("Komplett!"), tr("Du besitzt jede Karte dieses Sets.")));
  };
  onlyMissing.addEventListener("change", draw);
  draw();
  return h("div", { class: "page" },
    h("header", { class: "page-head" },
      h("div", null, h("p", { class: "eyebrow" }, h("a", { href: "/sets" }, tr("Sets")), ` · ${set.seriesName ?? ""}`), h("h1", null, set.nameDe ?? set.nameEn ?? set.id),
        h("p", { class: "muted" }, `${set.releaseDate ? fmt.date(set.releaseDate) + " · " : ""}${set.cardCountOfficial ?? cards.length} Karten${set.abbreviation ? ` · ${set.abbreviation}` : ""} · Gesamtwert aller Karten (DE): ${fmt.eurCompact(total)}`)),
      set.logo ? h("img", { class: "set-hero-logo", src: `${set.logo}.webp`, alt: "" }) : null),
    state.user ? h("div", { class: "stats compact" }, h("div", { class: "stat" }, h("span", { class: "stat-title" }, tr("Im Besitz")), h("strong", { class: "stat-value" }, `${owned.size} / ${set.cardCountOfficial ?? cards.length}`)),
      h("div", { class: "stat" }, h("span", { class: "stat-title" }, tr("Fortschritt")), h("strong", { class: "stat-value" }, `${Math.round((owned.size / Math.max(1, set.cardCountOfficial ?? cards.length)) * 100)} %`))) : null,
    h("div", { class: "search-bar" }, sortSel, state.user ? onlyMissing : null),
    grid,
  );
}

async function ownedBySet(): Promise<Map<string, Set<string>>> {
  const m = new Map<string, Set<string>>();
  try { for (const it of (await api.items()).items) (m.get(it.card.setId) ?? m.set(it.card.setId, new Set()).get(it.card.setId)!).add(it.cardId); } catch { /* not logged in */ }
  return m;
}
export { cardName };
