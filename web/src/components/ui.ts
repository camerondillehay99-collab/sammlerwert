import { CONDITION_LABELS } from "../../../shared/types.ts";
import type { CardDetail, CardSummary, Collection, CollectionItem, PriceQuote } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, trendClass, toast, imgOr } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { navigate } from "../lib/router.ts";
import { tilt, tip, countUp } from "../lib/fx.ts";
import { tr } from "../lib/i18n.ts";
import { attachSnapshot } from "./hover.ts";

export function cardTile(card: CardSummary, opts: { value?: number | null; sub?: string; trend?: number | null; onClick?: () => void; snapshot?: boolean } = {}): HTMLElement {
  const img = cardImage(card);
  const value = opts.value !== undefined ? opts.value : card.valueDe;
  const trend = opts.trend !== undefined ? opts.trend : card.trend30;
  const trendEl = trend != null ? tip(h("span", { class: `trend ${trendClass(trend)}` }, fmt.pct(trend)), tr("Veränderung des Marktwerts in den letzten 30 Tagen")) : null;
  const el = h("a", { class: "tile", href: `/karte/${encodeURIComponent(card.id)}`, onClick: opts.onClick ? (e: Event) => { e.preventDefault(); opts.onClick!(); } : null },
    h("div", { class: "tile-img" }, imgOr(img, () => placeholder(card), { alt: cardName(card), width: 245, height: 342 }), h("i", { class: "gloss" }),
      h("div", { class: "tile-hover" }, confidenceBadge(card.confidenceDe), card.rarity ? h("span", { class: "badge" }, card.rarity) : null)),
    h("div", { class: "tile-body" },
      h("div", { class: "tile-title" }, h("strong", null, cardName(card)), h("span", { class: "num" }, `#${card.localId}`)),
      h("div", { class: "tile-sub" }, opts.sub ?? card.setNameDe ?? card.setNameEn ?? ""),
      h("div", { class: "tile-price" }, h("b", null, fmt.eur(value)), trendEl),
    ),
  );
  tilt(el);
  if (opts.snapshot !== false) attachSnapshot(el, card);
  return el;
}

export function placeholder(card: Pick<CardSummary, "nameDe" | "nameEn" | "localId">): HTMLElement {
  return h("div", { class: "ph" }, h("span", null, (cardName(card)).slice(0, 1)), h("small", null, `#${card.localId}`));
}

const CONF_TIP: Record<string, string> = { high: "Mehrere aktuelle Verkäufe stimmen mit dem Preisguide überein.", mid: "Preisguide mit gelerntem Sprachfaktor oder nur wenige Verkäufe.", low: "Nur Preisguide ohne deutschen Faktor – oder nur Angebote.", none: "Noch keine Bewertung – zu wenig Daten." };
export function confidenceBadge(c: number | null | undefined): HTMLElement {
  const lvl = c == null ? "none" : c >= 0.75 ? "high" : c >= 0.45 ? "mid" : "low";
  const el = h("span", { class: `badge conf-${lvl}` }, tr("Konfidenz: {labelconfide}", { labelconfide: label.confidence(c) }));
  return tip(el, `${c == null ? tr("Keine Bewertung") : tr("Konfidenz {c100toFixed0} %", { c100toFixed0: (c * 100).toFixed(0) })} · ${tr(CONF_TIP[lvl]!)}`);
}

export function trendPill(n: number | null | undefined, text = ""): HTMLElement {
  return h("span", { class: `trend ${trendClass(n)}` }, n == null ? "–" : svg(n >= 0 ? icons.up : icons.down, 14), ` ${fmt.pct(n)}${text}`);
}

/** `value` may be a number with a formatter – then it counts up when it scrolls into view (desktop). `hint` becomes a tooltip on the title. */
export function statCard(title: string, value: string | { n: number; format: (n: number) => string }, sub?: HTMLElement | string | null, kind = "", hint?: string): HTMLElement {
  const v = h("strong", { class: "stat-value" }, typeof value === "string" ? value : value.format(value.n));
  if (typeof value !== "string") countUp(v, value.n, value.format);
  const t = h("span", { class: "stat-title" }, title);
  if (hint) tip(t, hint);
  return h("div", { class: `stat ${kind}` }, t, v, sub ? h("div", { class: "stat-sub" }, sub) : null);
}

export function empty(title: string, text: string, action?: HTMLElement): HTMLElement {
  return h("div", { class: "empty" }, h("h2", null, title), h("p", null, text), action ?? null);
}

export function spinner(): HTMLElement { return h("div", { class: "spinner-wrap" }, h("div", { class: "spinner" })); }

export function section(title: string, ...children: (Element | null)[]): HTMLElement {
  return h("section", { class: "panel" }, h("h2", { class: "panel-title" }, title), ...children);
}

/** Modal / bottom sheet. Returns close(). */
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean } = {}): () => void {
  const root = h("div", { class: "modal-root", role: "dialog", "aria-modal": "true", "aria-label": title });
  const close = () => { root.classList.remove("in"); setTimeout(() => root.remove(), 160); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  root.append(
    h("div", { class: "modal-backdrop", onClick: close }),
    h("div", { class: `modal ${opts.wide ? "wide" : ""}` },
      h("header", { class: "modal-head" }, h("h2", null, title), h("button", { class: "icon-btn", "aria-label": tr("Schließen"), onClick: close }, svg(icons.close))),
      h("div", { class: "modal-body" }, body)),
  );
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("in"));
  document.addEventListener("keydown", onKey);
  return close;
}

export function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", null, labelText), input, hint ? h("small", null, hint) : null);
}

export function select(name: string, options: Array<[string, string]>, value?: string): HTMLSelectElement {
  const s = h("select", { name });
  for (const [v, t] of options) s.appendChild(h("option", { value: v, selected: v === value }, tr(t)));
  return s;
}

export const CONDITION_OPTIONS: Array<[string, string]> = Object.entries(CONDITION_LABELS);
export const LANG_OPTIONS: Array<[string, string]> = [["de", "Deutsch"], ["en", "Englisch"], ["jp", "Japanisch"], ["fr", "Französisch"], ["it", "Italienisch"], ["es", "Spanisch"], ["other", "Andere"]];
export const COND_OPTIONS: Array<[string, string]> = [["NM", "Near Mint"], ["MT", "Mint"], ["EX", "Excellent"], ["GD", "Good"], ["LP", "Light Played"], ["PL", "Played"], ["PO", "Poor"]];
export const GRADER_OPTIONS: Array<[string, string]> = [["", "Ungraded"], ["PSA", "PSA"], ["BGS", "BGS"], ["CGC", "CGC"], ["GSG", "GSG"], ["AP", "AP"], ["TAG", "TAG"], ["ACE", "ACE"], ["OTHER", "Andere"]];
export function variantOptions(variants: Record<string, boolean>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (variants.normal !== false) out.push(["normal", tr("Normal")]);
  if (variants.holo) out.push(["holo", tr("Holo")]);
  if (variants.reverse) out.push(["reverse", tr("Reverse Holo")]);
  if (variants.firstEdition) out.push(["firstEdition", tr("1. Edition")]);
  if (!out.length) out.push(["normal", tr("Normal")]);
  return out;
}

export function requireLogin(): boolean {
  if (state.user) return true;
  toast("Bitte melde dich an, um deine Sammlung zu verwalten.", "error");
  navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
  return false;
}

export interface AddOptions { collections?: Collection[]; collectionId?: number | null; source?: string; onSaved?: (item: CollectionItem) => void; prefill?: Partial<Pick<CollectionItem, "language" | "variant" | "condition" | "gradingCompany" | "grade" | "certNo">> }

let collectionsCache: { at: number; items: Collection[] } | null = null;
async function loadCollections(): Promise<Collection[]> {
  if (collectionsCache && Date.now() - collectionsCache.at < 30_000) return collectionsCache.items;
  try { const items = (await api.collections()).items; collectionsCache = { at: Date.now(), items }; return items; } catch { return []; }
}
export function forgetCollections() { collectionsCache = null; }

/** Add-to-collection / edit sheet. No browser dialogs: deleting is a two-tap button inside the sheet. */
export function addToCollection(card: CardDetail | CardSummary, existing?: CollectionItem, opts: AddOptions = {}): void {
  if (!requireLogin()) return;
  const variants = "variants" in card ? card.variants : {};
  const pre = opts.prefill ?? {};
  const form = h("form", { class: "form" });
  const lang = select("language", LANG_OPTIONS, existing?.language ?? pre.language ?? "de");
  const variant = select("variant", variantOptions(variants), existing?.variant ?? pre.variant ?? (variants.normal === false && variants.holo ? "holo" : "normal"));
  const cond = select("condition", COND_OPTIONS, existing?.condition ?? pre.condition ?? "NM");
  const grader = select("gradingCompany", GRADER_OPTIONS, existing?.gradingCompany ?? pre.gradingCompany ?? "");
  const grade = h("input", { name: "grade", type: "number", step: "0.5", min: "1", max: "10", placeholder: "10", inputmode: "decimal", value: existing?.grade ?? pre.grade ?? "" });
  const cert = h("input", { name: "certNo", placeholder: tr("Zertifikat-Nr."), inputmode: "numeric", value: existing?.certNo ?? pre.certNo ?? "" });
  const psaBtn = h("button", { class: "btn ghost sm", type: "button", hidden: true, title: tr("Karte und Note bei PSA nachschlagen") }, svg(icons.shield, 14), tr(" PSA prüfen"));
  const gradeRow = h("div", { class: "row", hidden: !(existing?.gradingCompany ?? pre.gradingCompany) }, field(tr("Note"), grade), field(tr("Zertifikat"), h("div", { class: "input-row" }, cert, psaBtn)));
  const syncPsa = () => { psaBtn.hidden = grader.value !== "PSA"; };
  grader.addEventListener("change", () => { gradeRow.hidden = !grader.value; syncPsa(); }); syncPsa();
  psaBtn.addEventListener("click", async () => {
    psaBtn.disabled = true;
    try {
      const r = await api.psaCert(cert.value);
      if (r.cert.grade != null) grade.value = String(r.cert.grade);
      const same = r.best && r.best.card.id === card.id;
      toast(same ? tr("PSA bestätigt: {rcertsubject} {rcertgradeTe}", { rcertsubject: r.cert.subject ?? "", rcertgradeTe: r.cert.gradeText ?? "" }) : r.best ? tr("PSA sagt: {rcertsubject} ({rcertbrand}) – das sieht nach {cardNamerbes} #{rbestcardloc} aus.", { rcertsubject: r.cert.subject ?? "", rcertbrand: r.cert.brand ?? "", cardNamerbes: cardName(r.best.card), rbestcardloc: r.best.card.localId }) : tr("PSA: {rcertsubject} {rcertgradeTe}", { rcertsubject: r.cert.subject ?? "", rcertgradeTe: r.cert.gradeText ?? "" }));
    } catch (e) { toast((e as Error).message, "error"); }
    psaBtn.disabled = false;
  });
  const qty = h("input", { name: "quantity", type: "number", min: "1", max: "999", inputmode: "numeric", value: existing?.quantity ?? 1 });
  const price = h("input", { name: "purchasePriceEur", type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "0,00", value: existing?.purchasePriceEur ?? "" });
  const date = h("input", { name: "purchasedAt", type: "date", value: existing?.purchasedAt?.slice(0, 10) ?? "" });
  const notes = h("textarea", { name: "notes", rows: 2, placeholder: tr("Herkunft, Lagerort, Besonderheiten …"), value: existing?.notes ?? "" });
  const collSel = h("select", { name: "collectionId" }) as HTMLSelectElement;
  const collField = field(tr("Sammlung"), collSel); collField.hidden = true;
  const submit = h("button", { class: "btn primary", type: "submit" }, existing ? tr("Speichern") : tr("Zur Sammlung hinzufügen"));
  const removeBtn = existing ? h("button", { class: "btn danger ghost", type: "button" }, svg(icons.trash, 16), tr(" Entfernen")) : null;
  removeBtn?.addEventListener("click", () => {
    const yes = h("button", { class: "btn danger", type: "button", onClick: async () => { try { await api.deleteItem(existing!.id); invalidate(); close(); toast("Entfernt."); document.dispatchEvent(new CustomEvent("collection:changed")); } catch (e) { toast((e as Error).message, "error"); } } }, tr("Ja, entfernen"));
    const no = h("button", { class: "btn ghost", type: "button", onClick: () => box.replaceWith(removeBtn!) }, tr("Abbrechen"));
    const box = h("span", { class: "confirm-inline" }, yes, no);
    removeBtn!.replaceWith(box);
  });
  form.append(
    h("div", { class: "card-mini" }, cardImage(card) ? h("img", { src: cardImage(card)!, alt: "" }) : null, h("div", null, h("strong", null, cardName(card)), h("div", { class: "muted" }, `#${card.localId} · ${card.setNameDe ?? card.setNameEn ?? ""}`))),
    h("div", { class: "row" }, field(tr("Sprache"), lang), field(tr("Variante"), variant)),
    h("div", { class: "row" }, field(tr("Zustand"), cond), field(tr("Grading"), grader)),
    gradeRow,
    h("div", { class: "row three" }, field(tr("Anzahl"), qty), field(tr("Kaufpreis (Stück)"), price), field(tr("Gekauft am"), date)),
    collField,
    field(tr("Notizen"), notes),
    h("div", { class: "actions" }, removeBtn, submit),
  );
  (async () => {
    const cols = opts.collections ?? (await loadCollections());
    if (cols.length > 1) {
      const cur = existing?.collectionId ?? opts.collectionId ?? cols.find((c) => c.isDefault)?.id ?? cols[0]!.id;
      collSel.replaceChildren(...cols.map((c) => h("option", { value: String(c.id), selected: c.id === cur }, c.name)));
      collField.hidden = false;
    }
  })();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const body: Record<string, unknown> = {
      cardId: card.id, language: lang.value, variant: variant.value, condition: cond.value,
      gradingCompany: grader.value || null, grade: grader.value ? Number(grade.value) || null : null, certNo: cert.value || null,
      quantity: Number(qty.value) || 1, purchasePriceEur: price.value ? Number(price.value) : null, purchasedAt: date.value || null, notes: notes.value || null,
      collectionId: collField.hidden ? (opts.collectionId ?? undefined) : Number(collSel.value), source: existing ? undefined : opts.source ?? "manual",
    };
    try {
      const r = existing ? await api.updateItem(existing.id, body) : await api.addItem(body);
      invalidate(); forgetCollections(); close();
      toast(existing ? tr("Gespeichert.") : tr("Zur Sammlung hinzugefügt."));
      document.dispatchEvent(new CustomEvent("collection:changed"));
      opts.onSaved?.(r.item);
    } catch (err) {
      submit.disabled = false;
      if (err instanceof HttpError && err.status === 402) { close(); upgradePrompt(err.message); } else toast((err as Error).message, "error");
    }
  });
  const close = modal(existing ? tr("Karte bearbeiten") : tr("Karte hinzufügen"), form);
}

export function upgradePrompt(message: string) {
  const body = h("div", { class: "form" }, h("p", null, message), h("a", { class: "btn primary", href: "/tarife" }, tr("Tarife ansehen")));
  const close = modal(tr("Upgrade nötig"), body);
  body.querySelector("a")!.addEventListener("click", close);
}

/** Community sale report. */
export function reportSale(card: CardDetail, onDone: (c: CardDetail) => void): void {
  if (!requireLogin()) return;
  const form = h("form", { class: "form" });
  const lang = select("language", LANG_OPTIONS, "de");
  const variant = select("variant", variantOptions(card.variants), card.variants.normal === false && card.variants.holo ? "holo" : "normal");
  const cond = select("condition", COND_OPTIONS, "NM");
  const grader = select("gradingCompany", GRADER_OPTIONS, "");
  const grade = h("input", { name: "grade", type: "number", step: "0.5", min: "1", max: "10", placeholder: "10" });
  const price = h("input", { name: "priceEur", type: "number", step: "0.01", min: "0.01", required: true, inputmode: "decimal", placeholder: "z. B. 42,50" });
  const date = h("input", { name: "soldAt", type: "date", value: new Date().toISOString().slice(0, 10), required: true });
  const url = h("input", { name: "url", type: "url", placeholder: tr("Link zum Angebot (optional)") });
  const submit = h("button", { class: "btn primary", type: "submit" }, tr("Verkauf melden"));
  form.append(
    h("p", { class: "muted" }, tr("Gemeldete Verkäufe fließen mit geringerem Gewicht in den Marktwert ein und werden auf Plausibilität geprüft. Danke, dass du die deutsche Datenbasis besser machst!")),
    h("div", { class: "row" }, field(tr("Verkaufspreis (ohne Versand)"), price), field(tr("Verkauft am"), date)),
    h("div", { class: "row" }, field(tr("Sprache"), lang), field(tr("Variante"), variant)),
    h("div", { class: "row" }, field(tr("Zustand"), cond), field(tr("Grading"), grader)),
    h("div", { class: "row" }, field(tr("Note (falls graded)"), grade), field(tr("Quelle"), url)),
    h("div", { class: "actions" }, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); submit.disabled = true;
    try {
      const updated = await api.reportSale(card.id, { priceEur: Number(price.value), soldAt: date.value, language: lang.value, variant: variant.value, condition: cond.value, gradingCompany: grader.value || null, grade: grader.value ? Number(grade.value) || null : null, url: url.value || null });
      invalidate("/api/cards"); close(); toast("Danke! Verkauf gespeichert."); onDone(updated);
    } catch (err) { submit.disabled = false; toast((err as Error).message, "error"); }
  });
  const close = modal(tr("Verkauf melden"), form);
}

export function quoteRow(q: PriceQuote): HTMLElement {
  return h("div", { class: "quote" },
    h("div", { class: "quote-head" }, h("span", { class: "chip" }, label.language(q.language)), h("span", { class: "chip ghost" }, label.variant(q.variant))),
    h("div", { class: "quote-value" }, h("strong", null, fmt.eur(q.value)), trendPill(q.trend30, " / 30 T.")),
    h("div", { class: "quote-range muted" }, q.low != null && q.high != null ? tr("Spanne {fmteurqlow} – {fmteurqhigh}", { fmteurqlow: fmt.eur(q.low), fmteurqhigh: fmt.eur(q.high) }) : ""),
    h("div", { class: "quote-meta" }, confidenceBadge(q.confidence), h("span", { class: "muted" }, q.nSales30d ? tr("{qnSales30d} Verkäufe / 30 T.", { qnSales30d: q.nSales30d }) : label.method(q.method))),
  );
}
