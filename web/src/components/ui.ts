import type { CardDetail, CardSummary, CollectionItem, PriceQuote } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, trendClass, toast, imgOr } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { navigate } from "../lib/router.ts";

export function cardTile(card: CardSummary, opts: { value?: number | null; sub?: string; trend?: number | null; onClick?: () => void } = {}): HTMLElement {
  const img = cardImage(card);
  const value = opts.value !== undefined ? opts.value : card.valueDe;
  const trend = opts.trend !== undefined ? opts.trend : card.trend30;
  return h("a", { class: "tile", href: `/karte/${encodeURIComponent(card.id)}`, onClick: opts.onClick ? (e: Event) => { e.preventDefault(); opts.onClick!(); } : null },
    h("div", { class: "tile-img" }, imgOr(img, () => placeholder(card), { alt: cardName(card), width: 245, height: 342 })),
    h("div", { class: "tile-body" },
      h("div", { class: "tile-title" }, h("strong", null, cardName(card)), h("span", { class: "num" }, `#${card.localId}`)),
      h("div", { class: "tile-sub" }, opts.sub ?? card.setNameDe ?? card.setNameEn ?? ""),
      h("div", { class: "tile-price" }, h("b", null, fmt.eur(value)), trend != null ? h("span", { class: `trend ${trendClass(trend)}` }, fmt.pct(trend)) : null),
    ),
  );
}

export function placeholder(card: Pick<CardSummary, "nameDe" | "nameEn" | "localId">): HTMLElement {
  return h("div", { class: "ph" }, h("span", null, (cardName(card)).slice(0, 1)), h("small", null, `#${card.localId}`));
}

export function confidenceBadge(c: number | null | undefined): HTMLElement {
  const lvl = c == null ? "none" : c >= 0.75 ? "high" : c >= 0.45 ? "mid" : "low";
  return h("span", { class: `badge conf-${lvl}`, title: c == null ? "Keine Bewertung" : `Konfidenz ${(c * 100).toFixed(0)} %` }, `Konfidenz: ${label.confidence(c)}`);
}

export function trendPill(n: number | null | undefined, text = ""): HTMLElement {
  return h("span", { class: `trend ${trendClass(n)}` }, n == null ? "–" : svg(n >= 0 ? icons.up : icons.down, 14), ` ${fmt.pct(n)}${text}`);
}

export function statCard(title: string, value: string, sub?: HTMLElement | string | null, kind = ""): HTMLElement {
  return h("div", { class: `stat ${kind}` }, h("span", { class: "stat-title" }, title), h("strong", { class: "stat-value" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);
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
      h("header", { class: "modal-head" }, h("h2", null, title), h("button", { class: "icon-btn", "aria-label": "Schließen", onClick: close }, svg(icons.close))),
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
  for (const [v, t] of options) s.appendChild(h("option", { value: v, selected: v === value }, t));
  return s;
}

export const LANG_OPTIONS: Array<[string, string]> = [["de", "Deutsch"], ["en", "Englisch"], ["jp", "Japanisch"], ["fr", "Französisch"], ["it", "Italienisch"], ["es", "Spanisch"], ["other", "Andere"]];
export const COND_OPTIONS: Array<[string, string]> = [["NM", "Near Mint"], ["MT", "Mint"], ["EX", "Excellent"], ["GD", "Good"], ["LP", "Light Played"], ["PL", "Played"], ["PO", "Poor"]];
export const GRADER_OPTIONS: Array<[string, string]> = [["", "Ungraded"], ["PSA", "PSA"], ["BGS", "BGS"], ["CGC", "CGC"], ["GSG", "GSG"], ["AP", "AP"], ["TAG", "TAG"], ["ACE", "ACE"], ["OTHER", "Andere"]];
export function variantOptions(variants: Record<string, boolean>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (variants.normal !== false) out.push(["normal", "Normal"]);
  if (variants.holo) out.push(["holo", "Holo"]);
  if (variants.reverse) out.push(["reverse", "Reverse Holo"]);
  if (variants.firstEdition) out.push(["firstEdition", "1. Edition"]);
  if (!out.length) out.push(["normal", "Normal"]);
  return out;
}

export function requireLogin(): boolean {
  if (state.user) return true;
  toast("Bitte melde dich an, um deine Sammlung zu verwalten.", "error");
  navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
  return false;
}

/** Add-to-collection sheet. */
export function addToCollection(card: CardDetail | CardSummary, existing?: CollectionItem): void {
  if (!requireLogin()) return;
  const variants = "variants" in card ? card.variants : {};
  const form = h("form", { class: "form" });
  const lang = select("language", LANG_OPTIONS, existing?.language ?? "de");
  const variant = select("variant", variantOptions(variants), existing?.variant ?? (variants.normal === false && variants.holo ? "holo" : "normal"));
  const cond = select("condition", COND_OPTIONS, existing?.condition ?? "NM");
  const grader = select("gradingCompany", GRADER_OPTIONS, existing?.gradingCompany ?? "");
  const grade = h("input", { name: "grade", type: "number", step: "0.5", min: "1", max: "10", placeholder: "10", value: existing?.grade ?? "" });
  const cert = h("input", { name: "certNo", placeholder: "Zertifikat-Nr.", value: existing?.certNo ?? "" });
  const gradeRow = h("div", { class: "row", hidden: !existing?.gradingCompany }, field("Note", grade), field("Zertifikat", cert));
  grader.addEventListener("change", () => (gradeRow.hidden = !grader.value));
  const qty = h("input", { name: "quantity", type: "number", min: "1", max: "999", value: existing?.quantity ?? 1 });
  const price = h("input", { name: "purchasePriceEur", type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "0,00", value: existing?.purchasePriceEur ?? "" });
  const date = h("input", { name: "purchasedAt", type: "date", value: existing?.purchasedAt?.slice(0, 10) ?? "" });
  const notes = h("textarea", { name: "notes", rows: 2, placeholder: "Herkunft, Lagerort, Besonderheiten …", value: existing?.notes ?? "" });
  const submit = h("button", { class: "btn primary", type: "submit" }, existing ? "Speichern" : "Zur Sammlung hinzufügen");
  form.append(
    h("div", { class: "card-mini" }, cardImage(card) ? h("img", { src: cardImage(card)!, alt: "" }) : null, h("div", null, h("strong", null, cardName(card)), h("div", { class: "muted" }, `#${card.localId} · ${card.setNameDe ?? card.setNameEn ?? ""}`))),
    h("div", { class: "row" }, field("Sprache", lang), field("Variante", variant)),
    h("div", { class: "row" }, field("Zustand", cond), field("Grading", grader)),
    gradeRow,
    h("div", { class: "row three" }, field("Anzahl", qty), field("Kaufpreis (Stück)", price), field("Gekauft am", date)),
    field("Notizen", notes),
    h("div", { class: "actions" }, existing ? h("button", { class: "btn danger ghost", type: "button", onClick: async () => { if (!confirm("Karte aus der Sammlung entfernen?")) return; await api.deleteItem(existing.id); invalidate(); close(); toast("Entfernt."); document.dispatchEvent(new CustomEvent("collection:changed")); } }, svg(icons.trash, 16), " Entfernen") : null, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const body: Record<string, unknown> = {
      cardId: card.id, language: lang.value, variant: variant.value, condition: cond.value,
      gradingCompany: grader.value || null, grade: grader.value ? Number(grade.value) || null : null, certNo: cert.value || null,
      quantity: Number(qty.value) || 1, purchasePriceEur: price.value ? Number(price.value) : null, purchasedAt: date.value || null, notes: notes.value || null,
    };
    try {
      if (existing) await api.updateItem(existing.id, body); else await api.addItem(body);
      invalidate(); close();
      toast(existing ? "Gespeichert." : "Zur Sammlung hinzugefügt.");
      document.dispatchEvent(new CustomEvent("collection:changed"));
    } catch (err) {
      submit.disabled = false;
      if (err instanceof HttpError && err.status === 402) { close(); upgradePrompt(err.message); } else toast((err as Error).message, "error");
    }
  });
  const close = modal(existing ? "Karte bearbeiten" : "Karte hinzufügen", form);
}

export function upgradePrompt(message: string) {
  const body = h("div", { class: "form" }, h("p", null, message), h("a", { class: "btn primary", href: "/tarife" }, "Tarife ansehen"));
  const close = modal("Upgrade nötig", body);
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
  const url = h("input", { name: "url", type: "url", placeholder: "Link zum Angebot (optional)" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Verkauf melden");
  form.append(
    h("p", { class: "muted" }, "Gemeldete Verkäufe fließen mit geringerem Gewicht in den Marktwert ein und werden auf Plausibilität geprüft. Danke, dass du die deutsche Datenbasis besser machst!"),
    h("div", { class: "row" }, field("Verkaufspreis (ohne Versand)", price), field("Verkauft am", date)),
    h("div", { class: "row" }, field("Sprache", lang), field("Variante", variant)),
    h("div", { class: "row" }, field("Zustand", cond), field("Grading", grader)),
    h("div", { class: "row" }, field("Note (falls graded)", grade), field("Quelle", url)),
    h("div", { class: "actions" }, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); submit.disabled = true;
    try {
      const updated = await api.reportSale(card.id, { priceEur: Number(price.value), soldAt: date.value, language: lang.value, variant: variant.value, condition: cond.value, gradingCompany: grader.value || null, grade: grader.value ? Number(grade.value) || null : null, url: url.value || null });
      invalidate("/api/cards"); close(); toast("Danke! Verkauf gespeichert."); onDone(updated);
    } catch (err) { submit.disabled = false; toast((err as Error).message, "error"); }
  });
  const close = modal("Verkauf melden", form);
}

export function quoteRow(q: PriceQuote): HTMLElement {
  return h("div", { class: "quote" },
    h("div", { class: "quote-head" }, h("span", { class: "chip" }, label.language(q.language)), h("span", { class: "chip ghost" }, label.variant(q.variant))),
    h("div", { class: "quote-value" }, h("strong", null, fmt.eur(q.value)), trendPill(q.trend30, " / 30 T.")),
    h("div", { class: "quote-range muted" }, q.low != null && q.high != null ? `Spanne ${fmt.eur(q.low)} – ${fmt.eur(q.high)}` : ""),
    h("div", { class: "quote-meta" }, confidenceBadge(q.confidence), h("span", { class: "muted" }, q.nSales30d ? `${q.nSales30d} Verkäufe / 30 T.` : label.method(q.method))),
  );
}
