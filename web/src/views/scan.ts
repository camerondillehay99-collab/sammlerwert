/**
 * Scanner – a phone feature built for speed:
 *   · full-bleed viewfinder with a card frame; auto-capture fires when a card is held still (or tap the shutter)
 *   · several captures can be in flight at once; each result lands in a tray at the bottom, duplicates merge into ×n
 *   · confident hits go straight to the tray, uncertain ones open a small sheet to confirm or pick an alternative
 *   · one tap adds the whole tray to a collection (one request). Owned cards are marked so you don't double-add.
 * Desktop gets a QR code that opens this page on the phone (no webcam ergonomics, no rear camera).
 */
import type { CardSummary, CollectionItem, Collection, ScanResultPublic, ScanCandidatePublic } from "../../../shared/types.ts";
import { h, svg, icons, fmt, label, cardImage, cardName, clear, toast, imgOr } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { state } from "../lib/store.ts";
import { navigate } from "../lib/router.ts";
import { addToCollection, confidenceBadge, placeholder, section, modal, upgradePrompt, forgetCollections, field, LANG_OPTIONS, CONDITION_OPTIONS } from "../components/ui.ts";
import { qrSvg } from "../lib/qr.ts";
import { tr } from "../lib/i18n.ts";

/** The scanner is a phone feature: it needs the rear camera and one hand. Desktop gets a QR code that opens the same page on the phone. */
export const isPhone = () => matchMedia("(max-width: 760px)").matches;

function desktopHint(): HTMLElement {
  const url = `${location.origin}/scan`;
  const qr = h("div", { class: "qr-box" }); qr.innerHTML = qrSvg(url, 180);
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Scanner")), h("h1", null, tr("Scannen geht am Handy")),
      h("p", { class: "muted" }, tr("Der Kartenscanner nutzt die Handykamera: Karte in den Rahmen halten, mehrere Karten hintereinander, dann alles auf einmal in die Sammlung. Am Desktop gibt es stattdessen die Suche und den Import.")))),
    section(tr("Auf dem Handy öffnen"), h("div", { class: "qr-row" }, qr, h("div", null, h("p", null, tr("Kamera des Handys auf den Code richten – Sammlerwert öffnet direkt den Scanner. Als App installieren: im Browser „Zum Home-Bildschirm“.")), h("p", { class: "muted small" }, url)))),
    h("div", { class: "actions-row" }, h("a", { class: "btn primary", href: "/suche" }, svg(icons.search, 16), tr(" Karte suchen")), h("a", { class: "btn ghost", href: "/import" }, svg(icons.download, 16), tr(" Sammlung importieren"))));
}

// ------------------------------------------------------------------------------------------------
interface TrayEntry {
  key: string; card: CardSummary; quantity: number; confidence: number | null; result: ScanResultPublic;
  prefill: { language?: CollectionItem["language"]; variant?: CollectionItem["variant"]; gradingCompany?: CollectionItem["gradingCompany"]; grade?: number; certNo?: string };
  el?: HTMLElement;
}

let stream: MediaStream | null = null;
function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
const buzz = (ms: number | number[]) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

export async function scanView(): Promise<HTMLElement> {
  if (!isPhone()) return desktopHint();
  const root = h("div", { class: "scan-page" });

  // ---------- viewfinder ----------
  const video = h("video", { class: "scan-video", playsinline: "", autoplay: "", muted: "" }) as HTMLVideoElement;
  video.setAttribute("playsinline", ""); video.muted = true;
  const frame = h("div", { class: "scan-frame" }, h("i", { class: "c tl" }), h("i", { class: "c tr" }), h("i", { class: "c bl" }), h("i", { class: "c br" }), h("i", { class: "laser" }));
  const hint = h("p", { class: "scan-hint" }, tr("Karte in den Rahmen – sie wird automatisch erkannt"));
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, hidden: true }) as HTMLInputElement;
  const shutter = h("button", { class: "scan-shutter", "aria-label": tr("Karte scannen") }, h("span"), h("i", { class: "ring" }));
  const gallery = h("button", { class: "scan-side", "aria-label": tr("Fotos auswählen"), onClick: () => file.click() }, svg(icons.image, 22));
  const autoBtn = h("button", { class: "scan-chip on", "aria-pressed": "true" }, svg(icons.spark, 14), tr(" Auto"));
  const torch = h("button", { class: "scan-chip", hidden: true, "aria-pressed": "false" }, svg(icons.sun, 14), tr(" Licht"));
  const zoom = h("button", { class: "scan-chip", hidden: true }, "1×");
  const counter = h("span", { class: "scan-counter", hidden: true }, "0");
  const trayBtn = h("button", { class: "scan-side", "aria-label": tr("Erkannte Karten"), onClick: () => openTray() }, svg(icons.cards, 22), counter);
  const topbar = h("div", { class: "scan-top" }, autoBtn, torch, zoom, h("span", { class: "grow" }), h("button", { class: "scan-chip", onClick: () => navigate("/suche") }, svg(icons.search, 14), tr(" Suche")));
  const stage = h("div", { class: "scan-stage" }, video, h("div", { class: "scan-dim" }), frame, topbar, hint);

  // ---------- tray ----------
  const tray: TrayEntry[] = [];
  const trayStrip = h("div", { class: "scan-tray", hidden: true });
  const addAll = h("button", { class: "btn primary scan-addall", hidden: true, onClick: () => commitTray() });
  const controls = h("div", { class: "scan-controls" }, gallery, shutter, trayBtn);
  root.append(stage, trayStrip, addAll, controls, file);

  // owned cards (for the "already in collection" marker)
  const owned = new Map<string, number>();
  if (state.user) api.items().then((r) => { for (const it of r.items) owned.set(it.cardId, (owned.get(it.cardId) ?? 0) + it.quantity); }).catch(() => {});

  let inflight = 0;
  const setHint = (t: string, cls = "") => { hint.textContent = t; hint.className = `scan-hint ${cls}`; };
  const updateShutter = () => { shutter.classList.toggle("busy", inflight > 0); shutter.dataset.n = inflight ? String(inflight) : ""; };

  // ---------- camera ----------
  let track: MediaStreamTrack | null = null;
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { stage.classList.add("no-camera"); setHint("Keine Kamera verfügbar – Fotos auswählen.", "warn"); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream; await video.play().catch(() => {});
      track = stream.getVideoTracks()[0] ?? null;
      const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean; zoom?: { min: number; max: number } };
      if (caps.torch) { torch.hidden = false; let on = false; torch.onclick = () => { on = !on; track!.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => {}); torch.classList.toggle("on", on); torch.setAttribute("aria-pressed", String(on)); }; }
      if (caps.zoom && caps.zoom.max >= 2) { zoom.hidden = false; let z = 1; zoom.onclick = () => { z = z >= 2 ? 1 : z + 0.5; track!.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => {}); zoom.textContent = `${z}×`; }; }
      startWatch();
    } catch { stage.classList.add("no-camera"); setHint("Kamera nicht freigegeben – Fotos auswählen.", "warn"); }
  }

  /** Crop the frame region from the live video (plus a margin), downscale, JPEG. ~150–300 kB on a phone. */
  function captureFrame(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return resolve(null);
      const r = frame.getBoundingClientRect(), s = video.getBoundingClientRect();
      const scale = Math.max(s.width / vw, s.height / vh); // object-fit: cover
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

  // ---------- auto-capture: fire when the frame holds still and shows something card-like ----------
  let auto = true, watching = false, lastSig: Float32Array | null = null, stillSince = 0, armed = true, lastAutoAt = 0;
  const probe = document.createElement("canvas"); probe.width = 24; probe.height = 32;
  const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  autoBtn.addEventListener("click", () => { auto = !auto; autoBtn.classList.toggle("on", auto); autoBtn.setAttribute("aria-pressed", String(auto)); setHint(auto ? tr("Karte in den Rahmen – sie wird automatisch erkannt") : tr("Auslöser antippen, um zu scannen")); frame.classList.remove("locked"); });
  function startWatch() {
    if (watching) return; watching = true;
    const tick = () => {
      if (!stream || !document.body.contains(root)) { watching = false; return; }
      if (auto && video.videoWidth) {
        const r = frame.getBoundingClientRect(), s = video.getBoundingClientRect();
        const scale = Math.max(s.width / video.videoWidth, s.height / video.videoHeight);
        const offX = (s.width - video.videoWidth * scale) / 2, offY = (s.height - video.videoHeight * scale) / 2;
        const sx = (r.left - s.left - offX) / scale, sy = (r.top - s.top - offY) / scale, sw = r.width / scale, sh = r.height / scale;
        try {
          pctx.drawImage(video, sx, sy, sw, sh, 0, 0, probe.width, probe.height);
          const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
          const sig = new Float32Array(probe.width * probe.height);
          let sum = 0, sum2 = 0;
          for (let i = 0; i < sig.length; i++) { const l = (d[i * 4]! * 0.299 + d[i * 4 + 1]! * 0.587 + d[i * 4 + 2]! * 0.114) / 255; sig[i] = l; sum += l; sum2 += l * l; }
          const mean = sum / sig.length, variance = sum2 / sig.length - mean * mean;
          let diff = 0;
          if (lastSig) { for (let i = 0; i < sig.length; i++) diff += Math.abs(sig[i]! - lastSig[i]!); diff /= sig.length; }
          lastSig = sig;
          const now = performance.now();
          const still = lastSig && diff < 0.035, present = variance > 0.012; // blank wall/table has almost no variance
          if (still && present) {
            if (!stillSince) stillSince = now;
            frame.classList.toggle("locked", now - stillSince > 250);
            if (armed && now - stillSince > 650 && now - lastAutoAt > 2500 && inflight < 2) { armed = false; lastAutoAt = now; shoot(); }
          } else { stillSince = 0; frame.classList.remove("locked"); if (diff > 0.08) armed = true; } // re-arm once the card moved away
        } catch { /* drawImage can throw before the first frame */ }
      }
      setTimeout(tick, 180);
    };
    tick();
  }

  async function shoot() {
    const b = await captureFrame();
    if (!b) { file.click(); return; }
    buzz(12);
    frame.classList.add("flash"); setTimeout(() => frame.classList.remove("flash"), 220);
    recognise(b);
  }
  shutter.addEventListener("click", () => { armed = false; shoot(); });
  file.addEventListener("change", async () => { const fs = [...(file.files ?? [])]; file.value = ""; for (const f of fs) recognise(await downscaleFile(f)); });

  async function downscaleFile(f: File): Promise<Blob> {
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) return f;
    const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b ?? f), "image/jpeg", 0.86));
  }

  // ---------- recognition (several in flight) ----------
  async function recognise(blob: Blob) {
    inflight++; updateShutter();
    setHint(inflight > 1 ? tr("{inflight} Karten werden erkannt …", { inflight }) : tr("Erkenne Karte …"), "busy");
    const pending = pendingTile();
    try {
      const r = await api.scan(blob);
      pending.remove();
      handleResult(r);
    } catch (e) {
      pending.remove();
      const msg = e instanceof HttpError ? e.message : tr("Erkennung fehlgeschlagen – bitte noch einmal.");
      if (e instanceof HttpError && e.status === 402) upgradePrompt(e.message); else toast(msg, "error");
    } finally {
      inflight--; updateShutter();
      if (!inflight) setHint(auto ? tr("Nächste Karte in den Rahmen") : tr("Auslöser antippen für die nächste Karte"));
    }
  }

  function handleResult(r: ScanResultPublic) {
    const f = r.facts;
    if (!r.best) {
      buzz([30, 40, 30]);
      const read = [f.name, f.number ? `#${f.number}` : null].filter(Boolean).join(" ");
      toast(read ? tr("Nicht gefunden: „{read}“ – über die Suche eingeben?", { read }) : tr("Keine Karte erkannt – Nummer unten ins Bild."), "error", read ? { label: tr("Suchen"), onClick: () => navigate(`/suche?q=${encodeURIComponent(read)}`) } : undefined);
      return;
    }
    if (r.confidence >= 0.72 || !r.alternatives.length) { buzz(25); addToTray(r.best, r, r.confidence); }
    else { buzz([20, 30, 20]); confirmSheet(r); }
  }

  function prefillOf(r: ScanResultPublic): TrayEntry["prefill"] {
    const f = r.facts;
    return { language: (f.language ?? undefined) as CollectionItem["language"] | undefined, variant: (f.finish && f.finish !== "normal" ? f.finish : undefined) as CollectionItem["variant"] | undefined,
      gradingCompany: (f.gradingCompany ?? undefined) as CollectionItem["gradingCompany"] | undefined, grade: f.grade ?? undefined, certNo: f.cert ?? undefined };
  }

  function addToTray(c: ScanCandidatePublic, r: ScanResultPublic, confidence: number | null) {
    const prefill = prefillOf(r);
    const key = `${c.card.id}|${prefill.language ?? "de"}|${prefill.variant ?? "normal"}|${prefill.gradingCompany ?? ""}${prefill.grade ?? ""}`;
    const existing = tray.find((t) => t.key === key && !t.prefill.certNo);
    if (existing) { existing.quantity++; drawTray(existing.key); toast(`${cardName(c.card)} – jetzt ${existing.quantity}× in der Liste.`); return; }
    const entry: TrayEntry = { key, card: c.card, quantity: 1, confidence, result: r, prefill };
    tray.unshift(entry);
    drawTray(key);
    const own = owned.get(c.card.id);
    toast(`${cardName(c.card)} · ${fmt.eur(c.card.valueDe)}${own ? ` · bereits ${own}× in deiner Sammlung` : ""}`);
  }

  function pendingTile(): HTMLElement {
    const t = h("div", { class: "tray-tile pending" }, h("span", { class: "spinner" }));
    trayStrip.hidden = false; trayStrip.prepend(t);
    return t;
  }

  function drawTray(highlightKey?: string) {
    const n = tray.reduce((s, t) => s + t.quantity, 0), total = tray.reduce((s, t) => s + (t.card.valueDe ?? 0) * t.quantity, 0);
    counter.hidden = !n; counter.textContent = String(n);
    addAll.hidden = !n; addAll.replaceChildren(svg(icons.check, 16), tr(" {n} {n1KarteKarte} hinzufügen", { n, n1KarteKarte: n === 1 ? tr("Karte") : tr("Karten") }), h("small", null, ` · ${fmt.eur(total)}`));
    const pend = [...trayStrip.querySelectorAll(".tray-tile.pending")];
    clear(trayStrip); trayStrip.hidden = !n && !pend.length;
    root.classList.toggle("has-tray", n > 0);
    for (const p of pend) trayStrip.append(p);
    for (const t of tray) {
      const tile = h("button", { class: `tray-tile${t.key === highlightKey ? " pop" : ""}`, onClick: () => entrySheet(t) },
        imgOr(cardImage(t.card), () => placeholder(t.card), { width: 54, height: 75 }),
        t.quantity > 1 ? h("b", { class: "qty" }, `×${t.quantity}`) : null,
        owned.has(t.card.id) ? h("i", { class: "own", title: tr("bereits in der Sammlung") }, svg(icons.check2, 10)) : null,
        t.confidence != null && t.confidence < 0.72 ? h("i", { class: "unsure" }, "?") : null,
        h("span", null, fmt.eur(t.card.valueDe)));
      t.el = tile; trayStrip.append(tile);
    }
  }

  // ---------- sheets ----------
  function candidateRow(c: ScanCandidatePublic, onPick: () => void): HTMLElement {
    return h("button", { class: "scan-alt", onClick: onPick },
      imgOr(cardImage(c.card), () => placeholder(c.card), { width: 48, height: 67 }),
      h("span", null, h("b", null, cardName(c.card)), h("small", { class: "muted" }, `#${c.card.localId} · ${c.card.setNameDe ?? c.card.setNameEn ?? ""}`)),
      h("em", null, fmt.eur(c.card.valueDe)));
  }

  /** Uncertain hit: show best + alternatives, one tap picks. */
  function confirmSheet(r: ScanResultPublic) {
    const f = r.facts;
    const read = [f.name, f.number ? `#${f.number}${f.total ? `/${f.total}` : ""}` : null, f.language ? label.language(f.language) : null].filter(Boolean).join(" · ");
    const body = h("div", { class: "form" });
    const pick = (c: ScanCandidatePublic, conf: number | null) => { close(); addToTray(c, r, conf); };
    body.append(h("p", { class: "muted small" }, tr("Gelesen: {read} · Erkennung {rconfidence1} %", { read: read || "–", rconfidence1: (r.confidence * 100).toFixed(0) })),
      h("div", { class: "scan-alt-list" }, candidateRow(r.best!, () => pick(r.best!, r.confidence)), ...r.alternatives.map((a) => candidateRow(a, () => pick(a, 1)))),
      h("div", { class: "actions" }, h("button", { class: "btn ghost", onClick: () => { close(); navigate(`/suche?q=${encodeURIComponent(f.name ?? f.number ?? "")}`); } }, tr("Suchen")), h("button", { class: "btn ghost", onClick: () => close() }, tr("Verwerfen"))));
    const close = modal(tr("Welche Karte ist es?"), body);
  }

  /** Tray entry: details, quantity, variant/language, alternatives, remove. */
  function entrySheet(t: TrayEntry) {
    const c = t.card, r = t.result;
    const qty = h("b", null, String(t.quantity));
    const langSel = h("select", null, ...LANG_OPTIONS.map(([v, txt]) => h("option", { value: v, selected: (t.prefill.language ?? "de") === v }, tr(txt)))) as HTMLSelectElement;
    const varSel = h("select", null, ...[["normal", tr("Normal")], ["holo", tr("Holo")], ["reverse", tr("Reverse Holo")], ["firstEdition", tr("1. Edition")], ["promo", tr("Promo")]].map(([v, txt]) => h("option", { value: v, selected: (t.prefill.variant ?? "normal") === v }, txt))) as HTMLSelectElement;
    const condSel = h("select", null, ...CONDITION_OPTIONS.map(([v, txt]) => h("option", { value: v, selected: v === "NM" }, tr(txt)))) as HTMLSelectElement;
    langSel.addEventListener("change", () => { t.prefill.language = langSel.value as CollectionItem["language"]; });
    varSel.addEventListener("change", () => { t.prefill.variant = varSel.value as CollectionItem["variant"]; });
    const own = owned.get(c.id);
    const body = h("div", { class: "form" },
      h("div", { class: "scan-hit" }, imgOr(cardImage(c), () => placeholder(c), { width: 96, height: 134 }),
        h("div", { class: "scan-hit-body" }, h("p", { class: "eyebrow" }, `${c.setNameDe ?? c.setNameEn ?? c.setId} · #${c.localId}${c.rarity ? ` · ${c.rarity}` : ""}`), h("h2", null, cardName(c)),
          h("div", { class: "price-big" }, h("strong", null, fmt.eur(c.valueDe))),
          h("div", { class: "scan-badges" }, confidenceBadge(c.confidenceDe), t.confidence != null ? h("span", { class: `badge conf-${t.confidence >= 0.75 ? "high" : t.confidence >= 0.45 ? "mid" : "low"}` }, tr("Erkennung {tconfidence1} %", { tconfidence1: (t.confidence * 100).toFixed(0) })) : null, own ? h("span", { class: "chip ok" }, tr("{own}× in Sammlung", { own })) : null))),
      h("div", { class: "row three" }, field(tr("Sprache"), langSel), field(tr("Variante"), varSel), field(tr("Zustand"), condSel)),
      h("div", { class: "qty-row" }, h("span", null, tr("Anzahl")), h("span", { class: "qty-step" }, h("button", { onClick: () => { if (t.quantity > 1) { t.quantity--; qty.textContent = String(t.quantity); drawTray(); } } }, svg(icons.minus, 14)), qty, h("button", { onClick: () => { t.quantity++; qty.textContent = String(t.quantity); drawTray(); } }, svg(icons.plus, 14)))),
      r.alternatives.length ? h("details", { class: "scan-alts" }, h("summary", null, tr("Falsche Karte? Alternativen")), h("div", { class: "scan-alt-list" }, ...r.alternatives.map((a) => candidateRow(a, () => { t.card = a.card; t.confidence = 1; t.key = `${a.card.id}|${t.prefill.language ?? "de"}|${t.prefill.variant ?? "normal"}`; close(); drawTray(t.key); })))) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn ghost danger", onClick: () => { tray.splice(tray.indexOf(t), 1); close(); drawTray(); } }, svg(icons.trash, 14), tr(" Entfernen")),
        h("a", { class: "btn ghost", href: `/karte/${encodeURIComponent(c.id)}` }, tr("Alle Details")),
        h("button", { class: "btn primary", onClick: () => close() }, tr("Fertig"))));
    (condSel as HTMLSelectElement).addEventListener("change", () => { (t as TrayEntry & { condition?: string }).condition = condSel.value; });
    const close = modal(tr("Erkannte Karte"), body);
  }

  function openTray() {
    if (!tray.length) { toast("Noch keine Karte erkannt – Karte in den Rahmen halten."); return; }
    const list = h("div", { class: "scan-alt-list" }, ...tray.map((t) => h("button", { class: "scan-alt", onClick: () => { close(); entrySheet(t); } },
      imgOr(cardImage(t.card), () => placeholder(t.card), { width: 48, height: 67 }), h("span", null, h("b", null, cardName(t.card)), h("small", { class: "muted" }, `#${t.card.localId} · ${label.language(t.prefill.language ?? "de")}${t.prefill.variant ? ` · ${label.variant(t.prefill.variant)}` : ""}${t.quantity > 1 ? ` · ${t.quantity}×` : ""}`)), h("em", null, fmt.eur((t.card.valueDe ?? 0) * t.quantity)))));
    const total = tray.reduce((s, t) => s + (t.card.valueDe ?? 0) * t.quantity, 0);
    const close = modal(tr("Erkannte Karten · {fmteurtotal}", { fmteurtotal: fmt.eur(total) }), h("div", { class: "form" }, list, h("div", { class: "actions" }, h("button", { class: "btn ghost danger", onClick: () => { tray.length = 0; close(); drawTray(); } }, tr("Liste leeren")), h("button", { class: "btn primary", onClick: () => { close(); commitTray(); } }, tr("{trayreducest} hinzufügen", { trayreducest: tray.reduce((s, t) => s + t.quantity, 0) })))));
  }

  /** Everything in the tray → one request. Signed-out users get the login first (the tray survives in sessionStorage). */
  async function commitTray() {
    if (!tray.length) return;
    if (!state.user) { try { sessionStorage.setItem("scan-tray", JSON.stringify(tray.map((t) => ({ ...t, el: undefined })))); } catch { /* ignore */ } navigate("/login?next=/scan"); return; }
    let cols: Collection[] = [];
    try { cols = (await api.collections()).items; } catch { /* default collection */ }
    const go = async (collectionId?: number) => {
      addAll.disabled = true;
      try {
        const res = await api.addItems({ collectionId, source: "scan", items: tray.map((t) => ({ cardId: t.card.id, quantity: t.quantity, language: t.prefill.language, variant: t.prefill.variant, condition: (t as TrayEntry & { condition?: string }).condition, gradingCompany: t.prefill.gradingCompany, grade: t.prefill.grade, certNo: t.prefill.certNo })) });
        invalidate(); forgetCollections(); document.dispatchEvent(new CustomEvent("collection:changed"));
        for (const t of tray) owned.set(t.card.id, (owned.get(t.card.id) ?? 0) + t.quantity);
        buzz([20, 40, 20]);
        tray.length = 0; drawTray();
        toast(`${res.quantity} ${res.quantity === 1 ? tr("Karte") : tr("Karten")} gespeichert${res.merged ? ` (${res.merged} zu vorhandenen addiert)` : ""}.`, "ok", { label: tr("Zur Sammlung"), onClick: () => navigate(`/sammlung?c=${res.collectionId}`) });
      } catch (e) {
        if (e instanceof HttpError && e.status === 402) upgradePrompt(e.message); else toast((e as Error).message, "error");
      } finally { addAll.disabled = false; }
    };
    if (cols.length <= 1) return go(cols[0]?.id);
    const body = h("div", { class: "menu-list" }, ...cols.map((c) => h("button", { class: "menu-item", onClick: () => { close(); go(c.id); } }, svg(icons.folder, 18), h("span", null, c.name, h("small", { class: "muted" }, tr(" · {cquantity} Karten", { cquantity: c.quantity }))))));
    const close = modal(tr("In welche Sammlung?"), body);
  }

  // restore a tray that was parked for login
  try { const saved = sessionStorage.getItem("scan-tray"); if (saved && state.user) { sessionStorage.removeItem("scan-tray"); for (const t of JSON.parse(saved) as TrayEntry[]) tray.push(t); drawTray(); if (tray.length) setTimeout(() => commitTray(), 300); } } catch { /* ignore */ }

  // lifecycle: start the camera now, stop it when the user navigates away
  startCamera();
  document.body.classList.add("scanning");
  const obs = new MutationObserver(() => { if (!document.body.contains(root)) { stopCamera(); document.body.classList.remove("scanning"); obs.disconnect(); } });
  obs.observe(document.getElementById("outlet") ?? document.body, { childList: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); else if (document.body.contains(root) && !stream) startCamera(); });
  return root;
}

/** Still used by the card page and the collection list: the existing add/edit dialog. */
export { addToCollection };
