/**
 * Explore / search: filter rail (desktop) or filter sheet (mobile), grid or list view, every filter in the URL.
 * Catalogue filters (set, rarity, category, price range, has-price) run on the server; ownership filters use the
 * signed-in user's collection and watchlist ids.
 */
import type { CardSummary, CatalogFacets, SetSummary } from "../../../shared/types.ts";
import { h, svg, icons, debounce, clear, fmt, label, cardImage, cardName, imgOr, trendClass } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { cardTile, empty, spinner, modal, placeholder, confidenceBadge } from "../components/ui.ts";
import { hoverToggle } from "../components/hover.ts";
import { reveal } from "../lib/fx.ts";
import { state } from "../lib/store.ts";
import { tr, getEdition } from "../lib/i18n.ts";

type Own = "" | "owned" | "missing" | "watch";
interface Filters { q: string; set: string; sort: string; rarity: string; category: string; min: string; max: string; priced: boolean; own: Own; view: "grid" | "list"; price: "de" | "en" }

const PRICE_CHIPS: Array<[string, string, string]> = [["< 1 €", "", "1"], ["1 – 10 €", "1", "10"], ["10 – 50 €", "10", "50"], ["50 – 200 €", "50", "200"], ["> 200 €", "200", ""]];

export async function search(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const [sets, facets] = await Promise.all([api.sets().then((r) => r.items), api.facets().catch(() => ({ rarities: [], categories: [] } as CatalogFacets))]);
  const f: Filters = { q: query.get("q") ?? "", set: query.get("set") ?? "", sort: query.get("sort") ?? "relevance", rarity: query.get("rarity") ?? "", category: query.get("category") ?? "", min: query.get("min") ?? "", max: query.get("max") ?? "",
    priced: query.get("priced") === "1", own: (query.get("own") as Own) || "", view: query.get("view") === "list" ? "list" : "grid", price: query.get("price") === "en" ? "en" : getEdition() === "en" ? "en" : "de" };
  const root = h("div", { class: "page explore" });
  const input = h("input", { type: "search", class: "search-input", placeholder: tr("Karte suchen – z. B. „Glurak ex“, „Pikachu 25/102“, „Mewtu 151“"), value: f.q, autofocus: true, autocomplete: "off", enterkeyhint: "search" });
  const results = h("div", { class: "tiles" });
  const meta = h("p", { class: "muted result-meta" });
  const more = h("button", { class: "btn ghost", hidden: true }, tr("Mehr laden"));
  const active = h("div", { class: "chips active-filters" });
  let offset = 0, total = 0, items: CardSummary[] = [], seq = 0;
  let owned: Set<string> | null = null, watch: Set<string> | null = null;

  async function ownership(kind: Own): Promise<string[] | null> {
    if (!kind || !state.user) return null;
    if (kind === "watch") { watch ??= new Set((await api.watchlist()).items.map((w) => w.cardId)); return [...watch]; }
    owned ??= new Set((await api.items()).items.map((i) => i.cardId));
    return kind === "owned" ? [...owned] : null;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (f.q) p.set("q", f.q); if (f.set) p.set("set", f.set); if (f.sort !== "relevance") p.set("sort", f.sort); if (f.rarity) p.set("rarity", f.rarity); if (f.category) p.set("category", f.category);
    if (f.min) p.set("min", f.min); if (f.max) p.set("max", f.max); if (f.priced) p.set("priced", "1"); if (f.own) p.set("own", f.own); if (f.view === "list") p.set("view", "list"); if (f.price === "en") p.set("price", "en");
    history.replaceState(null, "", `/suche${p.toString() ? "?" + p : ""}`);
  }
  const hasFilter = () => !!(f.q || f.set || f.rarity || f.category || f.min || f.max || f.priced || f.own);

  async function run(append = false) {
    const my = ++seq;
    syncUrl(); renderActive();
    if (!append) { offset = 0; items = []; clear(results); results.appendChild(spinner()); }
    if (!hasFilter()) { clear(results); meta.textContent = ""; more.hidden = true; results.appendChild(hint()); return; }
    try {
      const idList = await ownership(f.own);
      if (f.own && !state.user) { clear(results); results.appendChild(empty(tr("Anmelden"), tr("Besitz-Filter brauchen deine Sammlung – bitte melde dich an."), h("a", { class: "btn primary", href: "/login?next=/suche" }, tr("Anmelden")))); meta.textContent = ""; more.hidden = true; return; }
      let r: { items: CardSummary[]; total: number };
      const base = { set: f.set || null, sort: f.sort, rarity: f.rarity || null, category: f.category || null, min: f.min || null, max: f.max || null, priced: f.priced };
      if (idList) {
        // Ownership filters: the user's ids in pages of 48 (server limit 90 per request) – the catalogue filters still apply.
        const page = idList.slice(offset, offset + 48);
        r = page.length ? await api.search(f.q, { ...base, ids: page, limit: 48 }) : { items: [], total: 0 };
        r.total = idList.length;
        if (my !== seq) return;
        if (!append) clear(results);
        items = append ? items.concat(r.items) : r.items; offset += 48; total = r.total;
      } else {
        r = await api.search(f.q, { ...base, limit: 48, offset });
        if (my !== seq) return;
        if (!append) clear(results);
        let list = r.items;
        if (f.own === "missing" && owned) list = list.filter((c) => !owned!.has(c.id));
        items = append ? items.concat(list) : list; offset += r.items.length; total = r.total;
        r = { items: list, total: r.total };
      }
      if (!items.length && !append) results.appendChild(empty(tr("Nichts gefunden"), tr("Versuche den deutschen oder englischen Namen, die Kartennummer (z. B. 199/165) oder lockere die Filter.")));
      results.append(...r.items.map((c) => f.view === "list" ? listRow(c, f.price) : cardTile(c, { value: f.price === "en" ? c.valueEn : c.valueDe })));
      if (!append) reveal(results, f.view === "list" ? ".lrow" : ".tile");
      meta.textContent = f.own === "missing" ? tr("{n} angezeigt", { n: fmt.int(items.length) }) : tr("{totaltoLocal} Treffer", { totaltoLocal: fmt.int(total) });
      more.hidden = offset >= total;
    } catch (e) { clear(results); results.appendChild(empty(tr("Fehler"), (e as Error).message)); }
  }
  const rerun = () => { run(); };
  input.addEventListener("input", debounce(() => { f.q = input.value.trim(); run(); }, 180));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); f.q = input.value.trim(); run(); } });
  more.addEventListener("click", () => run(true));

  // ---- filter rail ----
  function rail(): HTMLElement {
    const setSel = h("select", { "aria-label": tr("Set") }, h("option", { value: "" }, tr("Alle Sets")), ...groupSets(sets)) as HTMLSelectElement; setSel.value = f.set;
    setSel.addEventListener("change", () => { f.set = setSel.value; rerun(); });
    const raritySel = h("select", { "aria-label": tr("Seltenheit") }, h("option", { value: "" }, tr("Alle Seltenheiten")), ...facets.rarities.map((r) => h("option", { value: r.value }, `${r.value} (${fmt.int(r.n)})`))) as HTMLSelectElement; raritySel.value = f.rarity;
    raritySel.addEventListener("change", () => { f.rarity = raritySel.value; rerun(); });
    const catSel = h("select", { "aria-label": tr("Kategorie") }, h("option", { value: "" }, tr("Alle Kategorien")), ...facets.categories.map((c) => h("option", { value: c.value }, `${c.value} (${fmt.int(c.n)})`))) as HTMLSelectElement; catSel.value = f.category;
    catSel.addEventListener("change", () => { f.category = catSel.value; rerun(); });
    const min = h("input", { type: "number", inputmode: "decimal", min: "0", placeholder: tr("von"), value: f.min, "aria-label": tr("Mindestpreis") });
    const max = h("input", { type: "number", inputmode: "decimal", min: "0", placeholder: tr("bis"), value: f.max, "aria-label": tr("Höchstpreis") });
    const applyPrice = debounce(() => { f.min = min.value; f.max = max.value; rerun(); }, 300);
    min.addEventListener("input", applyPrice); max.addEventListener("input", applyPrice);
    const priceChips = h("div", { class: "chips" }, ...PRICE_CHIPS.map(([t, a, b]) => h("button", { class: `chip ghost ${f.min === a && f.max === b ? "on" : ""}`, onClick: () => { f.min = a; f.max = b; min.value = a; max.value = b; rerun(); refresh(); } }, t)));
    const priced = h("input", { type: "checkbox", checked: f.priced }); priced.addEventListener("change", () => { f.priced = priced.checked; rerun(); });
    const ownSeg = seg<Own>([["", tr("Alle")], ["owned", tr("In Sammlung")], ["missing", tr("Fehlt mir")], ["watch", tr("Watchlist")]], f.own, (v) => { f.own = v; rerun(); });
    const priceSeg = seg<"de" | "en">([["de", tr("Deutsch")], ["en", tr("Englisch")]], f.price, (v) => { f.price = v; rerun(); });
    return h("div", { class: "rail-body" },
      group(tr("Besitz"), ownSeg),
      group(tr("Preis anzeigen"), priceSeg),
      group(tr("Preis (€)"), h("div", { class: "range-inputs" }, min, h("span", { class: "muted" }, "–"), max), priceChips),
      group(tr("Set"), setSel), group(tr("Seltenheit"), raritySel), group(tr("Kategorie"), catSel),
      group("", h("label", { class: "check" }, priced, h("span", null, tr("Nur Karten mit Preis")))),
      h("button", { class: "btn ghost sm", onClick: () => reset() }, svg(icons.close, 14), tr(" Filter zurücksetzen")),
    );
  }
  const railEl = h("aside", { class: "rail" }, h("h2", { class: "rail-title" }, svg(icons.filter, 16), tr(" Filter")), rail());
  function refresh() { railEl.replaceChildren(h("h2", { class: "rail-title" }, svg(icons.filter, 16), tr(" Filter")), rail()); }
  function reset() { Object.assign(f, { set: "", rarity: "", category: "", min: "", max: "", priced: false, own: "" }); refresh(); run(); }

  function renderActive() {
    const chips: HTMLElement[] = [];
    const chip = (text: string, clearFn: () => void) => chips.push(h("button", { class: "chip active-chip", onClick: () => { clearFn(); refresh(); run(); } }, text, svg(icons.close, 12)));
    if (f.set) chip(sets.find((s) => s.id === f.set)?.nameDe ?? f.set, () => { f.set = ""; });
    if (f.rarity) chip(f.rarity, () => { f.rarity = ""; });
    if (f.category) chip(f.category, () => { f.category = ""; });
    if (f.min || f.max) chip(`${f.min || "0"} – ${f.max || "∞"} €`, () => { f.min = ""; f.max = ""; });
    if (f.priced) chip(tr("mit Preis"), () => { f.priced = false; });
    if (f.own) chip({ owned: tr("In Sammlung"), missing: tr("Fehlt mir"), watch: tr("Watchlist"), "": "" }[f.own], () => { f.own = ""; });
    active.replaceChildren(...chips, chips.length > 1 ? h("button", { class: "chip ghost", onClick: reset }, tr("Alle entfernen")) : "");
  }

  const sortSel = h("select", { class: "sort-select", "aria-label": tr("Sortierung") }, ...[["relevance", tr("Relevanz")], ["value", tr("Wert ↓")], ["trend", tr("Trend 30 T. ↓")], ["newest", tr("Neueste Sets")], ["name", tr("Name A–Z")], ["number", tr("Nummer")]].map(([v, t]) => h("option", { value: v }, t))) as HTMLSelectElement;
  sortSel.value = f.sort; sortSel.addEventListener("change", () => { f.sort = sortSel.value; run(); });
  const viewSeg = seg<"grid" | "list">([["grid", tr("Raster")], ["list", tr("Liste")]], f.view, (v) => { f.view = v; results.className = v === "list" ? "lrows" : "tiles"; run(); });
  results.className = f.view === "list" ? "lrows" : "tiles";
  const filterBtn = h("button", { class: "btn ghost filter-btn", onClick: () => { const body = rail(); const close = modal(tr("Filter"), h("div", null, body, h("div", { class: "actions" }, h("button", { class: "btn primary full", onClick: () => close() }, tr("Anwenden"))))); } }, svg(icons.filter, 16), tr(" Filter"));

  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Katalog")), h("h1", null, tr("Entdecken"))), h("div", { class: "head-actions" }, hoverToggle())),
    h("div", { class: "search-bar" }, h("div", { class: "search-wrap" }, svg(icons.search, 20), input), filterBtn, sortSel, viewSeg),
    h("div", { class: "explore-grid" }, railEl, h("div", { class: "explore-main" }, active, meta, results, h("div", { class: "center" }, more))),
  );
  run();
  return root;
}

function group(title: string, ...kids: HTMLElement[]): HTMLElement { return h("div", { class: "rail-group" }, title ? h("span", { class: "rail-label" }, title) : null, ...kids); }
function seg<T extends string>(opts: Array<[T, string]>, value: T, onChange: (v: T) => void): HTMLElement {
  const el = h("div", { class: "seg wrap" });
  for (const [v, t] of opts) el.appendChild(h("button", { class: v === value ? "active" : "", onClick: () => { onChange(v); el.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === t)); } }, t));
  return el;
}

function listRow(c: CardSummary, price: "de" | "en"): HTMLElement {
  const v = price === "en" ? c.valueEn : c.valueDe;
  return h("a", { class: "lrow", href: `/karte/${encodeURIComponent(c.id)}` },
    imgOr(cardImage(c), () => placeholder(c), { alt: cardName(c), width: 60, height: 84 }),
    h("div", { class: "lrow-body" }, h("strong", null, cardName(c)), h("span", { class: "muted" }, `${c.setNameDe ?? c.setNameEn ?? ""} · #${c.localId}${c.rarity ? ` · ${c.rarity}` : ""}`)),
    h("div", { class: "lrow-conf" }, confidenceBadge(c.confidenceDe)),
    h("div", { class: "lrow-value" }, h("b", null, fmt.eur(v)), h("span", { class: `trend ${trendClass(c.trend30)}` }, fmt.pct(c.trend30))),
  );
}

function hint(): HTMLElement {
  const quick = ["Glurak", "Pikachu", "Mewtu ex", "Evoli", "Lugia", "Mew ex 151", "Nachtara", "Umbreon"];
  return h("div", { class: "empty soft" }, h("p", null, tr("Tipp: Deutsche Namen funktionieren genauso wie englische. Nummern wie „199/165“ finden alle Karten mit dieser Nummer – oder filtere links nach Set, Seltenheit und Preis.")),
    h("div", { class: "chips" }, ...quick.map((q) => h("button", { class: "chip", onClick: () => navigate(`/suche?q=${encodeURIComponent(q)}`) }, q))));
}

export function groupSets(sets: SetSummary[]): HTMLElement[] {
  const groups = new Map<string, SetSummary[]>();
  for (const s of sets) { const k = s.seriesName ?? tr("Weitere"); (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); }
  return [...groups].map(([name, list]) => h("optgroup", { label: name }, ...list.map((s) => h("option", { value: s.id }, `${s.nameDe ?? s.nameEn ?? s.id}${s.releaseDate ? ` (${s.releaseDate.slice(0, 4)})` : ""}`))));
}
export { label };
