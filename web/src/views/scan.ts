/**
 * Scanner: live viewfinder with a card-shaped frame → one tap → the card, its German value, grades and sales.
 * The camera stream stays open between scans so the next card is one tap away. Falls back to the native
 * camera/file picker where getUserMedia is unavailable (older browsers, desktop without camera).
 */
import type { CardDetail, CollectionItem, ScanResultPublic, ScanCandidatePublic } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { addToCollection, confidenceBadge, placeholder, trendPill, section } from "../components/ui.ts";
import { qrSvg } from "../lib/qr.ts";

/** The scanner is a phone feature: it needs the rear camera and one hand. Desktop gets a QR code that opens the same page on the phone. */
export const isPhone = () => matchMedia("(max-width: 760px)").matches;

function desktopHint(): HTMLElement {
  const url = `${location.origin}/scan`;
  const qr = h("div", { class: "qr-box" }); qr.innerHTML = qrSvg(url, 180);
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Scanner"), h("h1", null, "Scannen geht am Handy"),
      h("p", { class: "muted" }, "Der Kartenscanner nutzt die Handykamera: Karte in den Rahmen halten, ein Tipp – Wert, Grades und letzte Verkäufe. Am Desktop gibt es stattdessen die Suche und den Import."))),
    section("Auf dem Handy öffnen", h("div", { class: "qr-row" }, qr, h("div", null, h("p", null, "Kamera des Handys auf den Code richten – Sammlerwert öffnet direkt den Scanner. Als App installieren: im Browser „Zum Home-Bildschirm“."), h("p", { class: "muted small" }, url)))),
    h("div", { class: "actions-row" }, h("a", { class: "btn primary", href: "/suche" }, svg(icons.search, 16), " Karte suchen"), h("a", { class: "btn ghost", href: "/import" }, svg(icons.download, 16), " Sammlung importieren")));
}

let stream: MediaStream | null = null;
function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }

export async function scanView(): Promise<HTMLElement> {
  if (!isPhone()) return desktopHint();
  const root = h("div", { class: "page scan-page" });
  const video = h("video", { class: "scan-video", playsinline: "", autoplay: "", muted: "" }) as HTMLVideoElement;
  video.setAttribute("playsinline", ""); video.muted = true;
  const frame = h("div", { class: "scan-frame" }, h("i", { class: "c tl" }), h("i", { class: "c tr" }), h("i", { class: "c bl" }), h("i", { class: "c br" }));
  const hint = h("p", { class: "scan-hint" }, "Karte in den Rahmen halten – Nummer unten lesbar");
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true }) as HTMLInputElement;
  const shutter = h("button", { class: "scan-shutter", "aria-label": "Karte scannen" }, h("span"));
  const gallery = h("button", { class: "scan-side", "aria-label": "Foto auswählen", onClick: () => file.click() }, svg(icons.image, 22));
  const torch = h("button", { class: "scan-side", "aria-label": "Licht", hidden: true }, svg(icons.sun, 22));
  const stage = h("div", { class: "scan-stage" }, video, frame, hint, h("div", { class: "scan-controls" }, gallery, shutter, torch));
  const result = h("div", { class: "scan-result", hidden: true });
  root.append(h("header", { class: "page-head scan-head" }, h("div", null, h("p", { class: "eyebrow" }, "Scanner"), h("h1", null, "Karte scannen"),
    h("p", { class: "muted" }, "Foto → Karte erkannt → deutscher Marktwert, Grades und letzte Verkäufe."))), stage, result, file);

  let busy = false;
  const setBusy = (b: boolean, text = "") => { busy = b; shutter.classList.toggle("busy", b); hint.textContent = b ? text : "Karte in den Rahmen halten – Nummer unten lesbar"; };

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { stage.classList.add("no-camera"); hint.textContent = "Keine Kamera verfügbar – Foto auswählen."; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream; await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
      if (caps.torch) { torch.hidden = false; let on = false; torch.onclick = () => { on = !on; track!.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => {}); torch.classList.toggle("on", on); }; }
    } catch { stage.classList.add("no-camera"); hint.textContent = "Kamera nicht freigegeben – Foto auswählen."; }
  }

  /** Crop the frame region from the live video (plus a margin), downscale, JPEG. ~150–300 kB on a phone. */
  function captureFrame(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return resolve(null);
      const r = frame.getBoundingClientRect(), s = video.getBoundingClientRect();
      // video is object-fit: cover – map the frame rect back to video pixels
      const scale = Math.max(s.width / vw, s.height / vh);
      const offX = (s.width - vw * scale) / 2, offY = (s.height - vh * scale) / 2;
      const m = 0.06;
      const x = Math.max(0, (r.left - s.left - offX) / scale - vw * m * 0.3), y = Math.max(0, (r.top - s.top - offY) / scale - vh * m * 0.3);
      const w = Math.min(vw - x, r.width / scale * (1 + m)), hh = Math.min(vh - y, r.height / scale * (1 + m));
      const target = 1100, k = Math.min(1, target / Math.max(w, hh));
      const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(hh * k);
      c.getContext("2d")!.drawImage(video, x, y, w, hh, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b), "image/jpeg", 0.86);
    });
  }

  async function downscaleFile(f: File): Promise<Blob> {
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) return f;
    const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b ?? f), "image/jpeg", 0.86));
  }

  async function recognise(blob: Blob) {
    if (busy) return;
    setBusy(true, "Erkenne Karte …");
    if (navigator.vibrate) navigator.vibrate(15);
    try {
      const r = await api.scan(blob);
      renderResult(r);
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : "Erkennung fehlgeschlagen – bitte noch einmal versuchen.";
      toast(msg, "error");
      if (e instanceof HttpError && e.code === "scan_unavailable") { result.hidden = false; result.replaceChildren(h("p", { class: "muted" }, msg)); }
    } finally { setBusy(false); }
  }

  shutter.addEventListener("click", async () => { const b = await captureFrame(); if (b) recognise(b); else file.click(); });
  file.addEventListener("change", async () => { const f = file.files?.[0]; file.value = ""; if (f) recognise(await downscaleFile(f)); });

  function renderResult(r: ScanResultPublic) {
    result.hidden = false; clear(result);
    const f = r.facts;
    const read = [f.name, f.number ? `#${f.number}${f.total ? `/${f.total}` : ""}` : null, f.language ? label.language(f.language) : null, f.finish && f.finish !== "normal" ? label.variant(f.finish) : null, f.gradingCompany ? `${f.gradingCompany} ${f.grade}` : null].filter(Boolean).join(" · ");
    if (!r.best) {
      result.append(h("div", { class: "scan-card" }, h("h2", null, "Keine Karte erkannt"), h("p", { class: "muted" }, read ? `Gelesen: ${read}` : "Der Text auf der Karte war nicht lesbar."),
        h("p", { class: "muted small" }, "Tipp: Karte flach, Nummer unten im Bild, kein Spiegeln. Oder über die Suche eingeben."),
        h("a", { class: "btn ghost", href: `/suche?q=${encodeURIComponent(f.name ?? f.number ?? "")}` }, "In der Suche öffnen")));
      result.scrollIntoView({ behavior: "smooth", block: "start" }); return;
    }
    const box = h("div", { class: "scan-card" });
    result.append(box);
    box.append(h("p", { class: "muted small" }, `Gelesen: ${read || "–"} · ${(r.ms / 1000).toFixed(1)} s`));
    renderCandidate(box, r.best, r.confidence, true, r);
    if (r.alternatives.length) box.append(h("details", { class: "scan-alts", open: r.confidence < 0.6 ? true : null },
      h("summary", null, r.confidence < 0.6 ? "Nicht sicher – meinst du eine dieser Karten?" : "Nicht richtig? Alternativen"),
      h("div", { class: "scan-alt-list" }, ...r.alternatives.map((a) => h("button", { class: "scan-alt", onClick: () => { clear(box); box.append(h("p", { class: "muted small" }, `Gelesen: ${read}`)); renderCandidate(box, a, null, true, r); } },
        imgOr(cardImage(a.card), () => placeholder(a.card), { width: 48, height: 67 }), h("span", null, h("b", null, cardName(a.card)), h("small", { class: "muted" }, ` #${a.card.localId} · ${a.card.setNameDe ?? a.card.setNameEn ?? ""}`)), h("em", null, fmt.eur(a.card.valueDe)))))));
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderCandidate(box: HTMLElement, c: ScanCandidatePublic, confidence: number | null, loadDetail: boolean, r: ScanResultPublic) {
    const card = c.card;
    const head = h("div", { class: "scan-hit" },
      imgOr(cardImage(card), () => placeholder(card), { width: 110, height: 153 }),
      h("div", { class: "scan-hit-body" },
        h("p", { class: "eyebrow" }, `${card.setNameDe ?? card.setNameEn ?? card.setId} · #${card.localId}${card.rarity ? ` · ${card.rarity}` : ""}`),
        h("h2", null, cardName(card)),
        h("div", { class: "price-big" }, h("strong", null, fmt.eur(card.valueDe)), card.trend30 != null ? trendPill(card.trend30, " / 30 T.") : null),
        h("div", { class: "scan-badges" }, confidenceBadge(card.confidenceDe), confidence != null ? h("span", { class: `badge conf-${confidence >= 0.75 ? "high" : confidence >= 0.45 ? "mid" : "low"}` }, `Erkennung ${(confidence * 100).toFixed(0)} %`) : null)));
    // Add → the button becomes an "in your collection" control with quantity and remove, so a mis-tap is one tap away from undone.
    const f = r.facts;
    const prefill = { language: (f.language ?? undefined) as CollectionItem["language"] | undefined, variant: (f.finish && f.finish !== "normal" ? f.finish : undefined) as CollectionItem["variant"] | undefined, gradingCompany: (f.gradingCompany ?? undefined) as CollectionItem["gradingCompany"] | undefined, grade: f.grade ?? undefined, certNo: f.cert ?? undefined };
    const addBtn = h("button", { class: "btn primary" }, svg(icons.plus, 16), " Zur Sammlung");
    const slot = h("span", { class: "scan-add-slot" }, addBtn);
    const drawOwned = (item: CollectionItem) => {
      const minus = h("button", { class: "btn ghost sm", "aria-label": item.quantity > 1 ? "Eins weniger" : "Entfernen", onClick: async () => {
        try {
          if (item.quantity > 1) { item = (await api.updateItem(item.id, { quantity: item.quantity - 1 })).item; drawOwned(item); }
          else { await api.deleteItem(item.id); slot.replaceChildren(addBtn); toast("Aus der Sammlung entfernt."); }
          invalidate(); document.dispatchEvent(new CustomEvent("collection:changed"));
        } catch (e) { toast((e as Error).message, "error"); }
      } }, svg(item.quantity > 1 ? icons.minus : icons.trash, 14));
      const plus = h("button", { class: "btn ghost sm", "aria-label": "Eins mehr", onClick: async () => { try { item = (await api.updateItem(item.id, { quantity: item.quantity + 1 })).item; invalidate(); drawOwned(item); } catch (e) { toast((e as Error).message, "error"); } } }, svg(icons.plus, 14));
      const edit = h("button", { class: "btn ghost sm", onClick: () => addToCollection(card, item) }, svg(icons.edit, 14), " Details");
      slot.replaceChildren(h("span", { class: "owned-pill" }, svg(icons.check, 14), ` In Sammlung · ${item.quantity}×`), minus, plus, edit);
    };
    addBtn.addEventListener("click", () => addToCollection(card, undefined, { source: "scan", prefill, onSaved: drawOwned }));
    const psaChip = f.cert && f.gradingCompany === "PSA" ? h("button", { class: "chip", onClick: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
      try { const p = await api.psaCert(f.cert!); toast(p.best && p.best.card.id !== card.id ? `PSA sagt ${cardName(p.best.card)} #${p.best.card.localId} – ${p.cert.gradeText ?? ""}` : `PSA bestätigt: ${p.cert.subject ?? ""} ${p.cert.gradeText ?? ""} · Pop ${p.cert.totalPopulation ?? "?"}`); if (p.cert.grade != null) prefill.grade = p.cert.grade; }
      catch (err) { toast((err as Error).message, "error"); }
      b.disabled = false;
    } }, svg(icons.shield, 12), ` PSA #${f.cert} prüfen`) : null;
    const actions = h("div", { class: "actions-row" },
      slot,
      h("a", { class: "btn ghost", href: `/karte/${encodeURIComponent(card.id)}` }, "Alle Details"),
      h("button", { class: "btn ghost", onClick: () => { result.hidden = true; clear(result); window.scrollTo({ top: 0, behavior: "smooth" }); } }, svg(icons.camera, 16), " Nächste Karte"),
      psaChip);
    const more = h("div", { class: "scan-more" }, h("p", { class: "muted small" }, "Lade Verkäufe …"));
    box.append(head, actions, more);
    if (loadDetail) api.card(card.id).then((d) => more.replaceChildren(...detailBlocks(d))).catch(() => more.replaceChildren());
  }

  function detailBlocks(d: CardDetail): HTMLElement[] {
    const out: HTMLElement[] = [];
    const de = d.prices.filter((p) => p.language === "de");
    const en = d.prices.find((p) => p.language === "en");
    if (de.length) out.push(h("div", { class: "scan-quotes" }, ...de.map((q) => h("div", { class: "scan-quote" }, h("span", null, label.variant(q.variant)), h("b", null, fmt.eur(q.value)), h("small", { class: "muted" }, q.low != null ? `${fmt.eur(q.low)} – ${fmt.eur(q.high)}` : label.method(q.method)))),
      en?.value != null ? h("div", { class: "scan-quote" }, h("span", null, "Englisch"), h("b", null, fmt.eur(en.value)), h("small", { class: "muted" }, "Vergleich")) : null));
    if (d.graded.length) out.push(h("div", { class: "scan-graded" }, ...d.graded.slice(0, 4).map((g) => h("span", { class: "chip", title: g.method === "sales" ? `${g.n} Verkäufe` : "Schätzung" }, `${g.company} ${g.grade}: ${fmt.eur(g.value)}${g.method === "multiplier" ? " ~" : ""}`))));
    out.push(h("h3", null, d.sales.length ? `Letzte Verkäufe (${Math.min(d.sales.length, 8)} von ${d.sales.length})` : "Letzte Verkäufe"));
    if (d.sales.length) out.push(h("ul", { class: "scan-sales" }, ...d.sales.slice(0, 8).map((s) => h("li", null,
      h("span", null, fmt.date(s.soldAt)), h("b", null, fmt.eur(s.priceEur)),
      h("small", { class: "muted" }, `${label.language(s.language)}${s.gradingCompany ? ` · ${s.gradingCompany} ${s.grade}` : s.condition ? ` · ${label.condition(s.condition)}` : ""}`),
      s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", "aria-label": "Verkauf ansehen" }, svg(icons.external, 12)) : null))));
    else out.push(h("p", { class: "muted small" }, "Noch keine Verkäufe erfasst – der Wert basiert auf dem Cardmarket-Preisguide."));
    return out;
  }

  // lifecycle: start the camera now, stop it when the user navigates away
  startCamera();
  const obs = new MutationObserver(() => { if (!document.body.contains(root)) { stopCamera(); obs.disconnect(); } });
  obs.observe(document.getElementById("outlet") ?? document.body, { childList: true });
  return root;
}
