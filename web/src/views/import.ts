/**
 * Import: a file (or pasted text) → preview with matched cards → one tap. Collectr, Card Ladder, TCGplayer, PSA lists,
 * our own export and any spreadsheet with Name / Set / Nummer columns. The user only ever corrects rows that are unsure.
 */
import type { CardSummary, Collection } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr, debounce } from "../lib/dom.ts";
import { api, HttpError, invalidate, type ImportPreviewPublic, type ImportRowPublic } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { empty, field, modal, placeholder, section, upgradePrompt, forgetCollections, LANG_OPTIONS } from "../components/ui.ts";
import { navigate } from "../lib/router.ts";
import { tr } from "../lib/i18n.ts";

const SOURCES: Array<{ id: string; name: string; how: string[] }> = [
  { id: "collectr", name: "Collectr", how: ["In der Collectr-App: Portfolio öffnen → Menü (⋯) → „Export“ → CSV.", "Die Datei kommt per Mail oder in die Dateien-App – hier auswählen oder hineinziehen."] },
  { id: "cardladder", name: "Card Ladder", how: ["Auf cardladder.com anmelden → „Collection“ → Export (CSV).", "Grades und Kaufpreise werden übernommen – Preise in USD rechnen wir in Euro um."] },
  { id: "tcgplayer", name: "TCGplayer", how: ["TCGplayer-App oder Website: Collection → Export CSV.", "Spalten „Product Name“, „Set Name“, „Number“, „Printing“ und „Condition“ werden erkannt."] },
  { id: "psa", name: "PSA-Zertifikate", how: ["Eine Liste von PSA-Zertifikatsnummern – eine pro Zeile oder als Spalte „Cert“.", "Wir holen Karte, Set und Note direkt von PSA (Public API) und ordnen sie dem Katalog zu."] },
  { id: "sammlerwert", name: "Sammlerwert-Export", how: ["Die CSV aus Sammlung → Verwalten → „CSV exportieren“ – z. B. aus einem anderen Konto.", "Enthält Karten-IDs, daher immer eindeutig."] },
  { id: "generic", name: "Andere Tabelle", how: ["Jede CSV/TSV mit Kopfzeile: mindestens „Name“ und „Set“ oder „Nummer“ (z. B. 199/165).", "Optional: Anzahl, Zustand, Sprache, Grading, Kaufpreis, Datum, Notizen. Excel: als CSV speichern."] },
];

export async function importView(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  if (!state.user) { navigate("/login?next=/import", true); return h("div"); }
  const [caps, cols] = await Promise.all([api.importCapabilities().catch(() => ({ psa: false, sources: [], maxRows: 2000 })), api.collections().then((r) => r.items).catch(() => [] as Collection[])]);
  const root = h("div", { class: "page import-page" });
  let source: string | null = query.get("source");
  let preview: ImportPreviewPublic | null = null;
  const chosen = new Map<number, CardSummary | null>(); // row line → overridden card (null = excluded)
  const include = new Set<number>();

  // ---------- step 1: source ----------
  const srcGrid = h("div", { class: "src-grid" });
  const how = h("div", { class: "src-how", hidden: true });
  const drawSources = () => {
    clear(srcGrid);
    for (const s of SOURCES) srcGrid.append(h("button", { class: `src-card${source === s.id ? " active" : ""}`, onClick: () => {
      source = source === s.id ? null : s.id;
      if (!langTouched) langSel.value = source === "collectr" || source === "cardladder" || source === "tcgplayer" || source === "psa" ? "en" : "de"; // US apps hold mostly English cards
      drawSources();
    } }, h("strong", null, tr(s.name)), s.id === "psa" && !caps.psa ? h("small", { class: "muted" }, "bald") : null));
    const s = SOURCES.find((x) => x.id === source);
    how.hidden = !s;
    if (s) how.replaceChildren(h("div", null, h("ol", null, ...s.how.map((t) => h("li", null, tr(t)))), s.id === "psa" && !caps.psa ? h("p", { class: "muted small" }, tr("PSA-Abfragen werden freigeschaltet, sobald der PSA-API-Schlüssel hinterlegt ist. Listen mit Name + Nummer funktionieren jetzt schon.")) : null));
  };
  // ---------- step 2: file / paste + options ----------
  const file = h("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain", hidden: true }) as HTMLInputElement;
  const drop = h("div", { class: "dropzone", tabindex: 0, role: "button", "aria-label": tr("Datei auswählen") }, svg(icons.upload, 28), h("strong", null, tr("Datei hierher ziehen oder antippen")), h("span", { class: "muted small" }, tr("CSV oder TSV · bis 3 MB · max. 2.000 Zeilen")));
  const paste = h("textarea", { rows: 5, placeholder: tr("… oder Tabelle hier einfügen (erste Zeile = Spaltennamen)\nName,Set,Nummer,Anzahl\nGlurak-ex,151,199/165,1") });
  const pasteWrap = h("details", { class: "paste-wrap" }, h("summary", null, tr("Text einfügen statt Datei")), paste, h("button", { class: "btn ghost sm", onClick: () => run(paste.value) }, tr("Vorschau")));
  const langSel = h("select", null, ...[["de", tr("Deutsch")], ["en", tr("Englisch")], ...LANG_OPTIONS.filter(([v]) => v !== "de" && v !== "en")].map(([v, t]) => h("option", { value: v }, tr(t))));
  const collSel = h("select", null, ...cols.map((c) => h("option", { value: String(c.id), selected: query.get("c") ? Number(query.get("c")) === c.id : c.isDefault }, c.name))) as HTMLSelectElement;
  const merge = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const options = h("div", { class: "row three" }, field(tr("Sprache, wenn nicht angegeben"), langSel, tr("Collectr/Card Ladder sind meist englische Karten.")), cols.length > 1 ? field(tr("In Sammlung"), collSel) : null, h("label", { class: "check field-check" }, merge, tr(" Gleiche Karten zusammenfassen (Anzahl erhöhen)")));

  drawSources();
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files?.[0]; if (f) readFile(f); });
  file.addEventListener("change", () => { const f = file.files?.[0]; file.value = ""; if (f) readFile(f); });
  let langTouched = false;
  langSel.addEventListener("change", () => { langTouched = true; if (lastText) run(lastText); });

  let lastText = "";
  async function readFile(f: File) {
    if (f.size > 3_000_000) return toast("Datei zu groß (max. 3 MB).", "error");
    if (/\.xlsx?$/i.test(f.name)) return toast("Bitte die Excel-Datei zuerst als CSV speichern (Datei → Speichern unter → CSV UTF-8).", "error");
    const buf = await f.arrayBuffer();
    let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (text.includes(String.fromCharCode(0xfffd))) text = new TextDecoder("windows-1252").decode(buf); // old Excel exports
    run(text);
  }

  // ---------- step 3: preview ----------
  const result = h("div", { class: "import-result" });
  async function run(text: string) {
    if (!text.trim()) return toast("Nichts zu importieren.", "error");
    lastText = text;
    // A bare list of cert numbers → synthesize a header so the parser sees a column.
    if (source === "psa" && !/[a-z]/i.test(text.split(/\r?\n/)[0] ?? "")) text = `Cert\n${text}`;
    result.replaceChildren(h("p", { class: "muted" }, tr("Lese und ordne zu …")));
    result.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      preview = await api.importPreview(text, source ?? undefined, langSel.value);
      chosen.clear(); include.clear();
      for (const r of preview.rows) if (r.status === "ok" || r.status === "unsure") include.add(r.line);
      drawPreview();
    } catch (e) {
      result.replaceChildren(empty(tr("Das hat nicht geklappt"), (e as Error).message));
    }
  }

  let filter: "all" | "ok" | "unsure" | "none" = "all";
  function drawPreview() {
    if (!preview) return;
    const p = preview;
    const srcName = tr(SOURCES.find((s) => s.id === p.source)?.name ?? p.source);
    const chip = (k: typeof filter, text: string, n: number, cls = "") => h("button", { class: `chip ${cls}${filter === k ? " active" : ""}`, onClick: () => { filter = k; drawPreview(); } }, `${text} ${n}`);
    const head = h("div", { class: "import-head" },
      h("div", null, h("h2", null, tr("{pstatstotal} Zeilen erkannt", { pstatstotal: p.stats.total })), h("p", { class: "muted small" }, `Format: ${srcName} · Spalten: ${Object.values(p.columns).join(", ") || "–"}${p.psaLookups ? ` · ${p.psaLookups} PSA-Abfragen` : ""}`)),
      h("div", { class: "chips" }, chip("all", tr("Alle"), p.stats.total), chip("ok", tr("Sicher"), p.stats.ok, "ok"), chip("unsure", tr("Prüfen"), p.stats.unsure, "warn"), chip("none", tr("Nicht gefunden"), p.stats.none + p.stats.skip, "bad")));
    const rows = p.rows.filter((r) => filter === "all" || (filter === "none" ? r.status === "none" || r.status === "skip" : r.status === filter));
    const list = h("div", { class: "import-rows" }, ...rows.map(rowEl));
    const n = [...include].length, qty = p.rows.filter((r) => include.has(r.line)).reduce((s, r) => s + r.parsed.quantity, 0);
    const go = h("button", { class: "btn primary lg", disabled: !n, onClick: commit }, svg(icons.check, 18), tr(" {qty} Karten importieren", { qty }));
    result.replaceChildren(h("div", null, head, p.stats.unsure ? h("p", { class: "muted small" }, tr("„Prüfen“: der Treffer ist wahrscheinlich, aber nicht sicher – tippe auf die Karte, um eine andere zu wählen.")) : null, list, h("div", { class: "import-foot" }, h("span", { class: "muted" }, tr("{n} von {pstatstotal} Zeilen ausgewählt", { n, pstatstotal: p.stats.total })), go)));
  }

  function cardOf(r: ImportRowPublic): CardSummary | null { return chosen.has(r.line) ? chosen.get(r.line)! : r.match?.card ?? null; }

  function rowEl(r: ImportRowPublic): HTMLElement {
    const card = cardOf(r);
    const inc = h("input", { type: "checkbox", checked: include.has(r.line), disabled: !card, "aria-label": tr("Importieren") }) as HTMLInputElement;
    inc.addEventListener("change", () => { if (inc.checked) include.add(r.line); else include.delete(r.line); drawPreview(); });
    const i = r.input, pr = r.parsed;
    const src = [i.name, i.set, i.number ? `#${i.number}` : null, i.setCode].filter(Boolean).join(" · ") || (i.cert ? tr("PSA #{icert}", { icert: i.cert }) : tr("(leer)"));
    const meta = [label.language(pr.language), pr.variant !== "normal" ? label.variant(pr.variant) : null, pr.gradingCompany ? `${pr.gradingCompany} ${pr.grade ?? ""}` : label.condition(pr.condition), pr.quantity > 1 ? `${pr.quantity}×` : null, pr.purchasePriceEur != null ? tr("Kauf {fmteurprpurc}", { fmteurprpurc: fmt.eur(pr.purchasePriceEur) }) : null].filter(Boolean).join(" · ");
    const status = chosen.has(r.line) ? "ok" : r.status;
    const conf = r.match && !chosen.has(r.line) ? r.match.confidence : chosen.get(r.line) ? 1 : null;
    const target = card
      ? h("button", { class: "import-card", onClick: () => pick(r) }, imgOr(cardImage(card), () => placeholder(card), { width: 44, height: 61 }), h("span", null, h("b", null, cardName(card)), h("small", { class: "muted" }, `${card.setNameDe ?? card.setNameEn ?? card.setId} · #${card.localId}`)), h("em", null, fmt.eur(card.valueDe)))
      : h("button", { class: "import-card none", onClick: () => pick(r) }, svg(icons.search, 18), h("span", null, h("b", null, tr("Karte wählen")), h("small", { class: "muted" }, r.problem ?? tr("Nicht gefunden"))));
    return h("div", { class: `import-row ${status}` },
      inc,
      h("div", { class: "import-src" }, h("span", { class: "line muted" }, tr("Zeile {rline}", { rline: r.line })), h("b", null, src), h("small", { class: "muted" }, meta)),
      h("span", { class: "arrow" }, "→"),
      target,
      conf != null ? h("span", { class: `badge conf-${conf >= 0.75 ? "high" : conf >= 0.45 ? "mid" : "low"}`, title: r.match?.reasons.join(", ") }, `${Math.round(conf * 100)} %`) : null);
  }

  /** Choose a different card: alternatives first, then a live search. */
  function pick(r: ImportRowPublic) {
    const body = h("div", { class: "form" });
    const q = h("input", { type: "search", class: "search-input", placeholder: tr("Karte suchen – Name oder Nummer"), value: r.input.name ?? r.input.number ?? "" });
    const list = h("div", { class: "scan-alt-list" });
    const choose = (c: CardSummary | null) => { chosen.set(r.line, c); if (c) include.add(r.line); else include.delete(r.line); close(); drawPreview(); };
    const draw = (cards: CardSummary[], title: string) => {
      list.replaceChildren(h("p", { class: "muted small" }, title), ...cards.map((c) => h("button", { class: "scan-alt", onClick: () => choose(c) },
        imgOr(cardImage(c), () => placeholder(c), { width: 48, height: 67 }), h("span", null, h("b", null, cardName(c)), h("small", { class: "muted" }, ` #${c.localId} · ${c.setNameDe ?? c.setNameEn ?? ""}`)), h("em", null, fmt.eur(c.valueDe)))));
    };
    const alts = [r.match?.card, ...r.alternatives].filter((c): c is CardSummary => !!c);
    if (alts.length) draw(alts, tr("Vorschläge")); else list.append(h("p", { class: "muted small" }, tr("Keine Vorschläge – bitte suchen.")));
    const search = debounce(async () => { const t = q.value.trim(); if (t.length < 2) return; try { draw((await api.search(t, { limit: 12 })).items, tr("Suche „{t}“", { t })); } catch { /* ignore */ } }, 250);
    q.addEventListener("input", search);
    body.append(h("p", { class: "muted small" }, tr("Zeile {rline}: {rinputnameri}", { rline: r.line, rinputnameri: [r.input.name, r.input.set, r.input.number].filter(Boolean).join(" · ") })), q, list,
      h("div", { class: "actions" }, h("button", { class: "btn ghost", onClick: () => choose(null) }, tr("Zeile überspringen"))));
    const close = modal(tr("Karte zuordnen"), body);
    if (!alts.length) { setTimeout(() => q.focus(), 60); search(); }
  }

  async function commit() {
    if (!preview) return;
    const rows = preview.rows.filter((r) => include.has(r.line) && cardOf(r)).map((r) => ({ cardId: cardOf(r)!.id, ...r.parsed }));
    const btn = result.querySelector(".import-foot .btn") as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = tr("Importiere …"); }
    try {
      const r = await api.importCommit({ rows, collectionId: cols.length ? Number(collSel.value) : undefined, merge: merge.checked, source: preview.source });
      invalidate(); forgetCollections();
      document.dispatchEvent(new CustomEvent("collection:changed"));
      result.replaceChildren(empty(tr("Import abgeschlossen"), `${r.imported} Karten neu, ${r.merged} zu vorhandenen Positionen addiert${r.skipped ? `, ${r.skipped} übersprungen` : ""}. Die Marktwerte sind sofort da.`,
        h("div", { class: "actions-row center" }, h("a", { class: "btn primary", href: `/sammlung?c=${r.collectionId}` }, tr("Zur Sammlung")), h("button", { class: "btn ghost", onClick: () => { preview = null; lastText = ""; result.replaceChildren(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, tr("Weitere Datei")))));
    } catch (e) {
      if (e instanceof HttpError && e.status === 402) upgradePrompt(e.message); else toast((e as Error).message, "error");
      drawPreview();
    }
  }

  root.append(
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Import")), h("h1", null, tr("Sammlung mitbringen")), h("p", { class: "muted" }, tr("Collectr, Card Ladder, TCGplayer, PSA-Listen oder jede Tabelle – Datei rein, Vorschau prüfen, fertig. Nichts wird ohne dein OK gespeichert.")))),
    section(tr("1 · Woher kommen die Daten?"), srcGrid, how),
    section(tr("2 · Datei"), drop, file, pasteWrap, options),
    result,
  );
  return root;
}
