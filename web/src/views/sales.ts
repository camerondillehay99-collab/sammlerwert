/**
 * Sales page – every recorded sale across the catalogue, the way Card Ladder lays it out:
 * search over listing titles, a filter panel (grader, grade, raw condition, set, language, sale type, marketplace,
 * minimum price), result count with removable filter chips, a value line when one card is filtered, sort by date or
 * price, list or grid, and rows of "source · title · date sold · type · price".
 */
import type { SaleFeedItem, SetSummary } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, clear, cardName, cardImage, imgOr } from "../lib/dom.ts";
import { api, type SalesFeedQuery } from "../lib/api.ts";
import { empty, placeholder, spinner } from "../components/ui.ts";
import { saleRow, saleTitle, saleSource } from "../components/sales.ts";
import { groupSets } from "./search.ts";
import { tr } from "../lib/i18n.ts";
import { safeGet, safeSet } from "../lib/store.ts";

const GRADERS = ["PSA", "BGS", "CGC", "TAG"];
const GRADES: Record<string, string[]> = { PSA: ["10", "9", "8", "7", "6", "5"], BGS: ["10", "9.5", "9", "8.5", "8"], CGC: ["10", "9.5", "9", "8.5", "8"], TAG: ["10", "9.5", "9", "8.5"] };
const CONDITIONS = ["MT", "NM", "EX", "GD", "LP", "PL", "PO"];
const TYPES: Array<[string, string]> = [["", "Alle Verkaufsarten"], ["auction", "Auktion"], ["fixed_price", "Sofortkauf"], ["best_offer", "Preisvorschlag"]];
const SOURCES: Array<[string, string]> = [["", "Alle Marktplätze"], ["ebay_de", "eBay.de"], ["ebay", "eBay"], ["fanatics", "Fanatics Collect"], ["heritage", "Heritage Auctions"], ["alt", "Alt"], ["cardmarket", "Cardmarket"], ["user", "Community"], ["import", "Import"]];
const LANGS: Array<[string, string]> = [["", "Alle Sprachen"], ["de", "Deutsch"], ["en", "Englisch"], ["jp", "Japanisch"], ["fr", "Französisch"], ["it", "Italienisch"], ["es", "Spanisch"]];
const MINS: Array<[string, string]> = [["", "Jeder Preis"], ["10", "≥ 10 €"], ["50", "≥ 50 €"], ["200", "≥ 200 €"], ["1000", "≥ 1.000 €"]];

type F = { q: string; grader: string; grade: string; condition: string; graded: "" | "1" | "0"; set: string; card: string; lang: string; type: string; source: string; min: string; sort: "date" | "price"; dir: "asc" | "desc" };

export async function salesView(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const sets = await api.sets().then((r) => r.items).catch(() => [] as SetSummary[]);
  const g = (k: string) => query.get(k) ?? "";
  const f: F = { q: g("q"), grader: g("grader"), grade: g("grade"), condition: g("condition"), graded: (g("graded") as F["graded"]) || "", set: g("set"), card: g("card"), lang: g("lang"), type: g("type"), source: g("source"), min: g("min"),
    sort: g("sort") === "price" ? "price" : "date", dir: g("dir") === "asc" ? "asc" : "desc" };
  let view: "list" | "grid" = (safeGet("sw-sales-view") as "list" | "grid") || "list";
  let panelOpen = false, offset = 0, total = 0;

  const page = h("div", { class: "page sales-page" });
  const search = h("input", { class: "search-input", type: "search", placeholder: tr("Angebotstitel durchsuchen"), value: f.q, "aria-label": tr("Angebotstitel durchsuchen") }) as HTMLInputElement;
  let t: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value.trim(); run(); }, 280); });
  const filterBtn = h("button", { class: "btn ghost", "aria-expanded": "false", onClick: () => { panelOpen = !panelOpen; panel.hidden = !panelOpen; filterBtn.setAttribute("aria-expanded", String(panelOpen)); filterBtn.classList.toggle("active", panelOpen); } }, svg(icons.filter, 16), tr(" Filter"));
  const sortSel = h("select", { class: "sel-sm", "aria-label": tr("Sortierung") }, h("option", { value: "date" }, tr("Verkaufsdatum")), h("option", { value: "price" }, tr("Preis"))) as HTMLSelectElement;
  sortSel.value = f.sort; sortSel.addEventListener("change", () => { f.sort = sortSel.value as F["sort"]; run(); });
  const dirBtn = h("button", { class: "icon-btn", "aria-label": tr("Richtung umkehren"), title: tr("Richtung umkehren"), onClick: () => { f.dir = f.dir === "desc" ? "asc" : "desc"; run(); } }, svg(icons.arrowDown, 18));
  const viewSeg = h("div", { class: "seg", role: "group", "aria-label": tr("Ansicht") },
    h("button", { class: view === "list" ? "active" : "", "aria-label": tr("Liste"), onClick: () => { view = "list"; safeSet("sw-sales-view", view); render(); } }, svg(icons.list, 16)),
    h("button", { class: view === "grid" ? "active" : "", "aria-label": tr("Raster"), onClick: () => { view = "grid"; safeSet("sw-sales-view", view); render(); } }, svg(icons.grid, 16)));

  const panel = h("div", { class: "sales-filters", hidden: true });
  const meta = h("div", { class: "sales-meta" });
  const valueLine = h("div", { class: "sales-value", hidden: true });
  const list = h("div", { class: "sales-list" });
  const more = h("button", { class: "btn ghost", hidden: true, onClick: () => run(true) }, tr("Mehr laden"));
  let items: SaleFeedItem[] = [];

  const sync = () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v && !(k === "sort" && v === "date") && !(k === "dir" && v === "desc")) p.set(k, v); history.replaceState(null, "", `/verkaeufe${p.size ? `?${p}` : ""}`); };

  function filters() {
    const chip = (on: boolean, text: string, onClick: () => void, cls = "") => h("button", { class: `chip ${on ? "" : "ghost"} ${cls}`, "aria-pressed": String(on), onClick }, text);
    const kind = h("div", { class: "chips" },
      chip(!f.grader && !f.graded, tr("Alle"), () => { f.grader = ""; f.grade = ""; f.graded = ""; f.condition = ""; run(); }),
      chip(f.graded === "0", tr("Roh"), () => { f.grader = ""; f.grade = ""; f.graded = "0"; run(); }),
      ...GRADERS.map((gr) => chip(f.grader === gr, gr, () => { f.grader = gr; f.graded = ""; f.grade = ""; f.condition = ""; run(); }, `grader-${gr.toLowerCase()}`)));
    const grades = f.grader ? h("div", { class: "chips" }, chip(!f.grade, tr("Alle Noten"), () => { f.grade = ""; run(); }), ...(GRADES[f.grader] ?? []).map((gr) => chip(f.grade === gr, `${f.grader} ${gr}`, () => { f.grade = gr; run(); }))) : null;
    const conds = f.graded === "0" ? h("div", { class: "chips" }, chip(!f.condition, tr("Jeder Zustand"), () => { f.condition = ""; run(); }), ...CONDITIONS.map((c) => chip(f.condition === c, `${c} · ${label.condition(c)}`, () => { f.condition = c; run(); }))) : null;
    const types = h("div", { class: "chips" }, ...TYPES.map(([v, l]) => chip(f.type === v, tr(l), () => { f.type = v; run(); }, `sale-${v || "all"}`)));
    const sel = (lbl: string, opts: Array<[string, string]>, cur: string, set: (v: string) => void) => { const s = h("select", { "aria-label": lbl }, ...opts.map(([v, l]) => h("option", { value: v, selected: v === cur }, tr(l)))) as HTMLSelectElement; s.addEventListener("change", () => { set(s.value); run(); }); return s; };
    const setSel = h("select", { "aria-label": tr("Set") }, h("option", { value: "" }, tr("Alle Sets")), ...groupSets(sets)) as HTMLSelectElement; setSel.value = f.set; setSel.addEventListener("change", () => { f.set = setSel.value; run(); });
    panel.replaceChildren(
      h("div", { class: "fgroup" }, h("span", { class: "flabel" }, tr("Bewertung")), kind, grades, conds),
      h("div", { class: "fgroup" }, h("span", { class: "flabel" }, tr("Verkaufsart")), types),
      h("div", { class: "fgroup selects" }, setSel, sel(tr("Sprache"), LANGS, f.lang, (v) => (f.lang = v)), sel(tr("Marktplatz"), SOURCES, f.source, (v) => (f.source = v)), sel(tr("Mindestpreis"), MINS, f.min, (v) => (f.min = v))));
  }

  function activeChips(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const add = (text: string, clear: () => void) => out.push(h("button", { class: "chip active-chip", onClick: () => { clear(); run(); } }, text, svg(icons.close, 12)));
    if (f.q) add(`„${f.q}“`, () => { f.q = ""; search.value = ""; });
    if (f.grader) add(f.grade ? `${f.grader} ${f.grade}` : f.grader, () => { f.grader = ""; f.grade = ""; });
    if (f.graded === "0") add(f.condition ? `${tr("Roh")} · ${label.condition(f.condition)}` : tr("Roh"), () => { f.graded = ""; f.condition = ""; });
    if (f.type) add(label.listingType(f.type), () => (f.type = ""));
    if (f.source) add(label.marketplace(f.source), () => (f.source = ""));
    if (f.lang) add(label.language(f.lang), () => (f.lang = ""));
    if (f.min) add(`≥ ${fmt.eur(Number(f.min), 0)}`, () => (f.min = ""));
    if (f.set) add(sets.find((s) => s.id === f.set)?.nameDe ?? sets.find((s) => s.id === f.set)?.nameEn ?? f.set, () => (f.set = ""));
    if (f.card) add(items[0]?.card ? cardName(items[0].card) : f.card, () => (f.card = ""));
    return out;
  }

  function render() {
    viewSeg.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", (i === 0) === (view === "list")));
    list.className = view === "list" ? "sales-list" : "sales-grid";
    clear(list);
    if (!items.length) { list.appendChild(empty(tr("Keine Verkäufe gefunden"), f.q || f.grader || f.set || f.card || f.type || f.source ? tr("Mit diesen Filtern gibt es noch keinen erfassten Verkauf.") : tr("Hier erscheinen echte Verkäufe mit Note bzw. Zustand, Verkaufsart (Auktion / Sofortkauf / Preisvorschlag), Marktplatz und Preis – eBay.de und eBay.com, deutsche, englische und japanische Karten, bis zu drei Jahre zurück; Community-Meldungen landen sofort hier."))); return; }
    list.append(...items.map((s) => (view === "list" ? saleRow(s, { showCard: !f.card }) : saleCard(s))));
  }

  async function run(append = false) {
    sync(); filters();
    if (!append) { offset = 0; items = []; clear(list); list.appendChild(spinner()); }
    const q: SalesFeedQuery = { q: f.q || null, grader: f.grader || null, grade: f.grade || null, condition: f.condition || null, set: f.set || null, card: f.card || null, lang: f.lang || null, graded: f.graded || null, min: f.min || null, type: f.type || null, source: f.source || null, sort: f.sort, dir: f.dir, limit: 50, offset };
    try {
      const r = await api.salesFeed(q);
      total = r.total; offset += r.items.length;
      items = append ? [...items, ...r.items] : r.items;
      const chips = activeChips();
      meta.replaceChildren(h("b", null, tr("{n} Ergebnisse", { n: fmt.int(total) })), ...chips);
      if (chips.length) meta.appendChild(h("button", { class: "chip ghost", onClick: () => { Object.assign(f, { q: "", grader: "", grade: "", condition: "", graded: "", set: "", card: "", lang: "", type: "", source: "", min: "" }); search.value = ""; run(); } }, tr("Zurücksetzen")));
      if (r.summary && f.card) {
        const v = r.summary.median ?? r.summary.last;
        valueLine.hidden = false;
        valueLine.replaceChildren(h("span", { class: "sv-label" }, tr("Sammlerwert-Wert")), h("b", null, v != null ? fmt.eur(v) : "–"),
          h("span", { class: "has-tip tip-below muted", tabindex: "0", "data-tip": tr("Median der gefilterten Verkäufe der letzten 180 Tage; bei nur einem Verkauf dessen Preis. Keine Schätzung – nur echte Verkäufe.") }, svg(icons.info, 14)));
        if (r.summary.n180) valueLine.appendChild(h("small", { class: "muted" }, tr("{n} Verkäufe in 180 Tagen · zuletzt {date}", { n: r.summary.n180, date: fmt.date(r.summary.lastAt) })));
        valueLine.appendChild(h("a", { class: "btn ghost small", href: `/karte/${encodeURIComponent(f.card)}` }, tr("Zur Karte"), svg(icons.chevron, 14)));
      } else valueLine.hidden = true;
      render();
      more.hidden = offset >= total;
    } catch (e) { clear(list); list.appendChild(empty(tr("Fehler"), (e as Error).message)); }
  }

  page.append(
    h("header", { class: "page-head" }, h("div", null, h("h1", { class: "big" }, tr("Verkäufe"))), h("div", { class: "head-actions" }, viewSeg)),
    h("div", { class: "sales-bar" }, h("div", { class: "search-bar" }, svg(icons.search, 18), search), filterBtn, h("div", { class: "sort-box" }, sortSel, dirBtn)),
    panel, meta, valueLine, list, h("div", { class: "center" }, more));
  run();
  return page;
}

/** Grid tile for the sales page: picture, title, date · type, price. */
function saleCard(s: SaleFeedItem): HTMLElement {
  return h("a", { class: "sale-tile", href: s.url ?? `/karte/${encodeURIComponent(s.cardId)}`, target: s.url ? "_blank" : undefined, rel: s.url ? "noopener" : undefined },
    h("div", { class: "sale-tile-img" }, imgOr(cardImage(s.card), () => placeholder(s.card), { alt: cardName(s.card), width: 160, height: 220, loading: "lazy" })),
    h("span", { class: "sale-src" }, saleSource(s)),
    h("strong", null, saleTitle(s)),
    h("div", { class: "sale-tile-foot" }, h("span", { class: "muted" }, `${fmt.date(s.soldAt)} · ${label.listingType(s.listingType)}`), h("b", null, fmt.eur(s.priceEur))));
}
