import type { CardSummary, SetSummary } from "../../../shared/types.ts";
import { h, svg, icons, debounce, clear, fmt } from "../lib/dom.ts";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { cardTile, empty, spinner } from "../components/ui.ts";
import { reveal } from "../lib/fx.ts";
import { tr } from "../lib/i18n.ts";

export async function search(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const sets = (await api.sets()).items;
  const root = h("div", { class: "page" });
  const input = h("input", { type: "search", class: "search-input", placeholder: tr("Karte suchen – z. B. „Glurak ex“, „Pikachu 25/102“, „Mewtu 151“"), value: query.get("q") ?? "", autofocus: true, autocomplete: "off", enterkeyhint: "search" });
  const setSel = h("select", { class: "set-select", "aria-label": tr("Set") }, h("option", { value: "" }, tr("Alle Sets")), ...groupSets(sets));
  setSel.value = query.get("set") ?? "";
  const sortSel = h("select", { class: "sort-select", "aria-label": tr("Sortierung") }, ...[["relevance", tr("Relevanz")], ["value", tr("Wert ↓")], ["trend", tr("Trend 30 T. ↓")], ["newest", tr("Neueste Sets")], ["name", tr("Name A–Z")], ["number", tr("Nummer")]].map(([v, t]) => h("option", { value: v }, t)));
  sortSel.value = query.get("sort") ?? "relevance";
  const results = h("div", { class: "tiles" });
  const meta = h("p", { class: "muted result-meta" });
  const more = h("button", { class: "btn ghost", hidden: true }, tr("Mehr laden"));
  let offset = 0, total = 0, items: CardSummary[] = [];

  async function run(append = false) {
    const q = input.value.trim();
    if (!append) { offset = 0; items = []; clear(results); results.appendChild(spinner()); }
    const params = new URLSearchParams(); if (q) params.set("q", q); if (setSel.value) params.set("set", setSel.value); if (sortSel.value !== "relevance") params.set("sort", sortSel.value);
    history.replaceState(null, "", `/suche${params.toString() ? "?" + params : ""}`);
    if (!q && !setSel.value) { clear(results); meta.textContent = ""; more.hidden = true; results.appendChild(hint()); return; }
    try {
      const r = await api.search(q, { set: setSel.value || null, sort: sortSel.value, limit: 48, offset });
      if (!append) clear(results);
      total = r.total; items = append ? items.concat(r.items) : r.items; offset = items.length;
      if (!r.items.length && !append) results.appendChild(empty(tr("Nichts gefunden"), tr("Versuche den deutschen oder englischen Namen, die Kartennummer (z. B. 199/165) oder wähle ein Set.")));
      const fresh = r.items.map((c) => cardTile(c)); results.append(...fresh);
      if (!append) reveal(results, ".tile");
      meta.textContent = tr("{totaltoLocal} Treffer", { totaltoLocal: fmt.int(total) });
      more.hidden = offset >= total;
    } catch (e) { clear(results); results.appendChild(empty(tr("Fehler"), (e as Error).message)); }
  }
  input.addEventListener("input", debounce(() => run(), 180));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  setSel.addEventListener("change", () => run());
  sortSel.addEventListener("change", () => run());
  more.addEventListener("click", () => run(true));

  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Katalog")), h("h1", null, tr("Suche")))),
    h("div", { class: "search-bar" }, h("div", { class: "search-wrap" }, svg(icons.search, 20), input), setSel, sortSel),
    meta, results, h("div", { class: "center" }, more),
  );
  run();
  return root;
}

function hint(): HTMLElement {
  const quick = ["Glurak", "Pikachu", "Mewtu ex", "Evoli", "Lugia", "Mew ex 151", "Nachtara", "Umbreon"];
  return h("div", { class: "empty soft" }, h("p", null, tr("Tipp: Deutsche Namen funktionieren genauso wie englische. Nummern wie „199/165“ finden alle Karten mit dieser Nummer.")),
    h("div", { class: "chips" }, ...quick.map((q) => h("button", { class: "chip", onClick: () => navigate(`/suche?q=${encodeURIComponent(q)}`) }, q))));
}

export function groupSets(sets: SetSummary[]): HTMLElement[] {
  const groups = new Map<string, SetSummary[]>();
  for (const s of sets) { const k = s.seriesName ?? tr("Weitere"); (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); }
  return [...groups].map(([name, list]) => h("optgroup", { label: name }, ...list.map((s) => h("option", { value: s.id }, `${s.nameDe ?? s.nameEn ?? s.id}${s.releaseDate ? ` (${s.releaseDate.slice(0, 4)})` : ""}`))));
}
